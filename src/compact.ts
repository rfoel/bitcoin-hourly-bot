/**
 * Keeps the note set short enough to hand the agent in full.
 *
 * Every run may write one note, and every run reads all of them, so the set grows
 * linearly while the value of reading it does not: after a day the notes are largely
 * the same rule restated against a different event. Left alone they outgrow what the
 * briefing injects, and the notes that fall out are the oldest — which are the
 * mechanical facts about the tools, the ones that never stop being true.
 *
 * Compaction is a judgement, not a filter: merging nineteen observations of one pattern
 * into one rule needs a model. So this asks Claude to rewrite the set, then checks the
 * answer hard before letting it replace anything. A compaction that fails validation
 * leaves the notes exactly as they were — losing accumulated knowledge is far worse
 * than paying for the tokens of an oversized note list for another hour.
 */

import Anthropic from "@anthropic-ai/sdk";

import { costOf, listNotes, replaceNotes } from "./store.js";
import type { NoteRecord, TokenUsage } from "./store.js";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/** Matches the hard limit on `write_note`, so a compacted note stays a legal note. */
const MAX_NOTE_LENGTH = 240;

const SYSTEM = `You are compacting the notebook of a trading agent that bets on an hourly
"Bitcoin Up or Down" market. The agent writes at most one note per hour and reads all of
them before every decision, so the notebook has to stay short enough to be worth reading.

You are rewriting the whole set. What matters is that no *rule* is lost — not that any
particular sentence survives. Notes accumulate as one pattern restated against a dozen
different events, and those should collapse into a single rule that states the pattern,
the conditions under which it held, and what to do about it.

Rules for the set you return:

- Merge notes that say the same thing. Keep the sharpest statement of the rule, and the
  numeric thresholds ($ amounts, time windows, price levels) that make it actionable.
- Drop the anecdote. Event numbers and one-off narrations are not rules. A specific
  observation is worth keeping only when it is the evidence a rule rests on.
- Keep every note that states a mechanical fact about the tools or the market's
  mechanics rather than a market pattern. Those do not age, and they are the ones that
  are cheapest to lose by accident.
- Do not invent rules, do not sharpen a hedge into a certainty, and do not carry over a
  win-rate figure unless the note you took it from stated it.
- Each note is one or two sentences and at most ${MAX_NOTE_LENGTH} characters.

Order the set least-durable first and most-durable last: market patterns that may stop
working at the start, mechanics that will always be true at the end. The agent reads the
list newest-first under a limit, and this ordering is what decides who survives.`;

interface CompactedNote {
  text: string;
  tags: string[];
}

export const handler = async () => {
  // Under the threshold the whole set still reaches the agent, so compaction would
  // spend tokens to lose nuance for nothing.
  const threshold = Number(process.env.COMPACT_THRESHOLD ?? "15");
  const notes = await listNotes(200);

  if (notes.length < threshold) {
    console.log("nothing to compact", { notes: notes.length, threshold });
    return { compacted: false, notes: notes.length, reason: "below threshold" };
  }

  const model = process.env.COMPACT_MODEL ?? "claude-sonnet-5";
  const before = charsIn(notes);

  let proposed: CompactedNote[];
  let usage: TokenUsage;
  try {
    ({ proposed, usage } = await propose(notes, model));
  } catch (error) {
    console.error("compaction did not produce a usable set, notes left alone", error);
    return { compacted: false, notes: notes.length, error: message(error) };
  }

  const rejection = reject(proposed, notes);
  if (rejection !== null) {
    console.error("compaction rejected, notes left alone", { rejection, proposed });
    return { compacted: false, notes: notes.length, error: rejection };
  }

  // Everything above this line is read-only, so a dry run exercises the whole judgement
  // — the model call and the validation — without betting the notebook on it.
  const dryRun = (process.env.COMPACT_DRY_RUN ?? "false") === "true";
  const written = dryRun ? proposed.map((note) => ({ ...note })) : await replaceNotes(proposed);
  const after = charsIn(written);
  const costUsd = costOf(model, usage);

  if (dryRun) {
    console.log("dry run, notes not replaced", {
      from: notes.length,
      to: written.length,
      chars: `${before} -> ${after}`,
      costUsd,
      proposed,
    });
    return { compacted: false, dryRun: true, from: notes.length, to: written.length };
  }

  console.log("notes compacted", {
    from: notes.length,
    to: written.length,
    chars: `${before} -> ${after}`,
    savedPerRun: before - after,
    costUsd,
    model,
  });

  return {
    compacted: true,
    from: notes.length,
    to: written.length,
    charsBefore: before,
    charsAfter: after,
    costUsd,
  };
};

/** Claude's proposed replacement set, as structured output. */
async function propose(
  notes: NoteRecord[],
  model: string,
): Promise<{ proposed: CompactedNote[]; usage: TokenUsage }> {
  const listing = notes
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((note) => `- [${note.createdAt}] ${note.text}`)
    .join("\n");

  const message = await client.messages.create({
    model,
    max_tokens: 4_000,
    system: SYSTEM,
    tool_choice: { type: "tool", name: "save_notes" },
    tools: [
      {
        name: "save_notes",
        description: "Save the compacted notebook. This replaces the notes entirely.",
        input_schema: {
          type: "object",
          properties: {
            notes: {
              type: "array",
              description: "Least-durable first, most-durable last.",
              items: {
                type: "object",
                properties: {
                  text: { type: "string", maxLength: MAX_NOTE_LENGTH },
                  tags: { type: "array", items: { type: "string" } },
                },
                required: ["text", "tags"],
              },
            },
          },
          required: ["notes"],
        },
      },
    ],
    messages: [
      {
        role: "user",
        content:
          `${notes.length} notes, oldest first. Rewrite them as a shorter set that ` +
          `loses no rule.\n\n${listing}`,
      },
    ],
  });

  const usage: TokenUsage = {
    input: message.usage.input_tokens ?? 0,
    output: message.usage.output_tokens ?? 0,
    cacheRead: message.usage.cache_read_input_tokens ?? 0,
    cacheWrite: message.usage.cache_creation_input_tokens ?? 0,
  };

  const call = message.content.find((block) => block.type === "tool_use");
  if (!call) throw new Error(`no tool call in response (stop ${message.stop_reason})`);

  const proposed = (call.input as { notes?: unknown }).notes;
  if (!Array.isArray(proposed)) throw new Error("tool call carried no notes array");

  return {
    proposed: proposed.map((note) => ({
      text: String((note as CompactedNote).text ?? "").trim(),
      tags: Array.isArray((note as CompactedNote).tags)
        ? (note as CompactedNote).tags.map(String)
        : [],
    })),
    usage,
  };
}

/**
 * Why the proposed set cannot be trusted, or null when it can.
 *
 * What is being bought is tokens on every future run, so the test is characters saved
 * rather than notes removed: a rewrite that keeps the count but halves the length is a
 * real win, and one that drops three notes while restating the rest at the same length
 * is churn that costs nuance for nothing.
 *
 * The floor is the guard that matters. A model that returns three notes has not
 * compacted the notebook, it has thrown most of it away, and nobody finds out until the
 * agent starts repeating a mistake the notes used to prevent.
 */
function reject(proposed: CompactedNote[], current: NoteRecord[]): string | null {
  const floor = Math.max(4, Math.ceil(current.length / 3));

  if (proposed.length === 0) return "no notes returned";
  if (proposed.length < floor) {
    return `${proposed.length} notes is below the floor of ${floor} for ${current.length} inputs`;
  }
  if (proposed.length > current.length) {
    return `${proposed.length} notes is more than the ${current.length} it replaces`;
  }

  const long = proposed.filter((note) => note.text.length > MAX_NOTE_LENGTH);
  if (long.length > 0) return `${long.length} notes over ${MAX_NOTE_LENGTH} characters`;

  const empty = proposed.filter((note) => note.text.length < 20);
  if (empty.length > 0) return `${empty.length} notes are empty or near-empty`;

  // Below this the rewrite is not paying for the nuance it drops or the tokens it costs.
  const before = charsIn(current);
  const after = charsIn(proposed);
  if (after > before * 0.85) {
    return `${after} characters saves less than 15% against ${before} — not worth the rewrite`;
  }

  return null;
}

function charsIn(notes: { text: string }[]): number {
  return notes.reduce((sum, note) => sum + note.text.length, 0);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
