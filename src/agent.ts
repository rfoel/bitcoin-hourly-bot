import Anthropic from "@anthropic-ai/sdk";
import type { Currency } from "futuur";

import { placeBet, resolveEvent, stakeFor, walletBalance } from "./bet.js";
import { costOf, listNotes, recordRun } from "./store.js";
import type { TokenUsage } from "./store.js";
import { buildTools } from "./tools.js";
import type { AgentContext } from "./tools.js";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * Time held back from the Lambda budget so the run can always finish cleanly:
 * the model gets one more turn to wrap up and the fallback still has room.
 */
const RESERVE_MS = 45_000;

// Switchable without a code change, and recorded on every run so cost and win rate
// can be compared across models rather than argued about.
const MODEL = process.env.AGENT_MODEL ?? "claude-opus-5";

/**
 * The agent's operating instructions. Kept as one frozen string so it caches —
 * everything that varies per run goes in the user turn instead.
 */
const SYSTEM = `You are trading the Futuur "Bitcoin Up or Down" hourly market with play money (OOM).

## The market

Each hourly event has a price to beat, stated in its title. It resolves on the hour:
"Up" wins if BTC is above the price to beat at close, "Down" wins if below. You bet by
buying shares of a side at a price between 0 and 1, which is that side's implied
probability. Each winning share pays 1. Buying "Down" at 0.34 pays 1 per share if BTC
closes below the price to beat, so it is profitable whenever the real chance of that is
better than 34%.

You are woken up roughly 15 minutes before the hour turns and you have a token budget
for the whole window. Betting closes at the stated time — after that nothing you do
matters, so treat seconds_to_close as a hard deadline.

## What you are actually looking for

An edge is a gap between the market's price and what you believe. The spot price
relative to the price to beat is the obvious input, but it is already in the market's
price — the market has seen it too. Ask instead whether the market's price is *wrong*:

- Spot sitting far above or below the price to beat with little time left is a strong
  signal, and the market usually prices it. Look for cases where it has not caught up.
- Spot within tens of dollars of the price to beat is close to a coin flip regardless
  of which side it happens to be on right now, because the three quote sources
  themselves disagree by that much. A confident price on a genuine coin flip is the
  market being wrong.
- Time matters: the same gap is far more decisive with 60 seconds left than with 14
  minutes left. Volatility has time to erase a small gap early in the window.

Passing is a real move. If nothing you can see says the market's price is wrong, do not
bet — a skipped hour costs nothing, and a bet at fair odds is a coin flip that pays a
fee. Say so plainly and finish.

## How to work the window

You have time, so use it: read the market and your own history, form a view, and then
decide whether to act now or wait for the price to move toward you. \`wait\` lets you
watch the gap develop and re-check closer to resolution, where the signal is strongest.
You can add to a position, and you can \`sell\` out of one when the move goes against
you rather than riding it to zero.

Before your first bet of the run, read get_history. Your settled results are the only
evidence you have about whether your reasoning has been working, and the notes are what
previous runs thought was worth remembering.

## The bankroll

You are managing one balance across many hours, and the objective is to grow it. That
makes survival the first constraint: the bankroll is the thing that lets you keep
playing, and a run of losses at large stakes ends the game regardless of how good the
next call would have been. Size so that being wrong several times in a row still leaves
you betting.

Two consequences worth holding onto:

- A bet at fair odds has zero edge and pays a fee, so it loses money on average. Volume
  is not progress. The number goes up by betting rarely and only where you can say what
  the market has priced wrong.
- Stake should track conviction, not boredom. The floor of the range is for a thin edge
  worth taking; the ceiling is for the rare case where the market's price is clearly
  wrong. Most hours should be near the floor or skipped entirely.

## Constraints

- Stake sizing is clamped in code by a minimum, a ceiling that is a share of your
  bankroll, and your balance. Asking for more than the ceiling gets you the ceiling,
  not an error — so size on conviction and let the clamp do its job.
- Every bet needs a one-or-two-sentence reason. It is stored and future runs read it,
  so make it a claim that can later be judged right or wrong, not a restatement of the
  numbers.
- Before you finish, write one note if this run taught you something a future run
  would act on. One sentence, 240 characters, stating the rule rather than the story
  behind it. Every future run reads every note, so a long one is a cost you pay
  forever. Skip it entirely if the run taught you nothing — an obvious note is worse
  than none.

Close with at most three sentences: what you did, why, and what you would watch next
time. Lead with the outcome. This is a log line, not a report — no headers, no
restating the numbers the tools already returned.`;

export const handler = async () => {
  const currency = (process.env.FUTUUR_CURRENCY ?? "OOM") as Currency;
  const budgetMs = Number(process.env.AGENT_BUDGET_MS ?? "840000");
  const deadline = Date.now() + Math.max(60_000, budgetMs - RESERVE_MS);

  const event = await resolveEvent(currency);
  const context: AgentContext = { currency, deadline, event, placed: [] };
  const tools = buildTools(context);

  const [notes, balance] = await Promise.all([
    listNotes(20).catch(() => []),
    walletBalance(currency).catch(() => null),
  ]);
  const secondsToClose = Math.round((Date.parse(event.bet_end_date!) - Date.now()) / 1000);
  const stake = balance === null ? null : stakeFor(balance);

  const opening =
    `Event #${event.id}: ${event.title}\n` +
    `Closes ${event.bet_end_date} — ${secondsToClose} seconds from now.\n` +
    `You have ${Math.round((deadline - Date.now()) / 1000)} seconds of working budget.\n` +
    (balance === null
      ? "Balance unavailable — call get_positions.\n"
      : `Bankroll: ${balance} ${currency}. Default stake ${stake!.amount}, ceiling ~${round2(
          balance * Number(process.env.FUTUUR_MAX_STAKE_FRACTION ?? "0.05"),
        )}.\n`) +
    "\n" +
    (notes.length === 0
      ? "No notes from previous runs yet.\n"
      : `Notes from previous runs, newest first:\n${notes
          .map((n) => `- [${n.createdAt}] ${n.text}`)
          .join("\n")}\n`) +
    `\nWork the window and decide. Passing is allowed.`;

  const runner = client.beta.messages.toolRunner({
    model: MODEL,
    max_tokens: 16_000,
    // Adaptive thinking is the default on Opus 5; set explicitly so the intent is
    // visible, and summarised so the reasoning lands in CloudWatch.
    thinking: { type: "adaptive", display: "summarized" },
    output_config: {
      effort: (process.env.AGENT_EFFORT ?? "high") as "low" | "medium" | "high" | "xhigh" | "max",
      // The model sees this counting down and paces itself. Set it near what a run
      // actually needs — a budget far above real usage reads as licence to spend.
      task_budget: { type: "tokens", total: Number(process.env.AGENT_TOKEN_BUDGET ?? "80000") },
    },
    // A safety classifier can decline a request; this re-runs it on Anthropic's
    // recommended fallback instead of returning a refusal and betting nothing.
    fallbacks: "default",
    betas: ["task-budgets-2026-03-13", "server-side-fallback-2026-07-01"],
    // Caches the growing conversation, not just the system prompt. Every turn resends
    // the whole history, so without this the same tool results are re-billed at full
    // price on each of the run's ~15 turns.
    cache_control: { type: "ephemeral" },
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: opening }],
    tools,
    max_iterations: Number(process.env.AGENT_MAX_ITERATIONS ?? "40"),
  });

  // Usage on the final message covers only that turn. Cost is the sum over every
  // turn of the loop, so the totals are accumulated while iterating.
  const usage: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let iterations = 0;
  let final: Anthropic.Beta.BetaMessage | null = null;
  let failed: unknown = null;

  try {
    for await (const message of runner) {
      iterations += 1;
      addUsage(usage, message.usage);
      final = message;
      if (message.stop_reason === "refusal") {
        console.error("agent request refused", message.stop_details);
        break;
      }
    }
  } catch (error) {
    failed = error;
    console.error("agent loop failed", error);
  }

  const summary = (final?.content ?? [])
    .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();

  // A run that deliberately passed is a valid outcome, so only fall back when the
  // loop never reached a decision.
  const stalled = failed !== null || final?.stop_reason === "refusal" || summary.length === 0;
  const fallback = context.placed.length === 0 && stalled ? await fallbackBet(context) : null;

  const run = await recordRun({
    eventId: event.id,
    betEndDate: event.bet_end_date!,
    model: MODEL,
    effort: process.env.AGENT_EFFORT ?? "high",
    iterations,
    usage,
    orderIds: context.placed.map((p) => p.orderId),
    stopReason: final?.stop_reason ?? (failed ? "error" : null),
    summary,
  }).catch((error: unknown) => {
    console.error("run not recorded", error);
    return null;
  });

  console.log("agent finished", {
    summary,
    placed: context.placed,
    iterations,
    usage,
    costUsd: run?.costUsd ?? costOf(MODEL, usage),
    stopReason: final?.stop_reason,
  });

  return finish(context, final, fallback, summary, run?.costUsd ?? costOf(MODEL, usage), usage);
};

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function addUsage(totals: TokenUsage, usage: Anthropic.Beta.BetaUsage): void {
  // When a fallback model runs, top-level usage covers only the attempt that
  // produced the message — the per-attempt breakdown is the whole bill.
  const attempts = usage.iterations ?? [];
  const sources = attempts.length > 0 ? attempts : [usage];

  for (const source of sources) {
    totals.input += source.input_tokens ?? 0;
    totals.output += source.output_tokens ?? 0;
    totals.cacheRead += source.cache_read_input_tokens ?? 0;
    totals.cacheWrite += source.cache_creation_input_tokens ?? 0;
  }
}

/**
 * Deterministic spot bet, used only when the agent could not run at all. Skipped
 * unless AGENT_FALLBACK is "true", because a silent automatic bet after a failure
 * is worse than no bet when nothing reasoned about it.
 */
async function fallbackBet(context: AgentContext) {
  if ((process.env.AGENT_FALLBACK ?? "true") !== "true") {
    console.warn("agent produced no bet and fallback is disabled");
    return null;
  }
  if (Date.parse(context.event.bet_end_date!) - Date.now() < 10_000) {
    console.warn("agent produced no bet and the market is about to close");
    return null;
  }

  return placeBet({ strategy: "spot" }).catch((error: unknown) => {
    console.error("fallback bet failed", error);
    return null;
  });
}

function finish(
  context: AgentContext,
  final: Anthropic.Beta.BetaMessage | null,
  fallback: unknown,
  summary = "",
  costUsd = 0,
  usage?: TokenUsage,
) {
  return {
    eventId: context.event.id,
    betEndDate: context.event.bet_end_date,
    placed: context.placed,
    summary,
    stopReason: final?.stop_reason ?? null,
    costUsd,
    usage: usage ?? null,
    fallback,
  };
}
