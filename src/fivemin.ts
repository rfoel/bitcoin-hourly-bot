import type { CreateOrderBody, Currency, FuturEvent, Position } from "futuur";

import { enabledAssets } from "./assets.js";
import type { Asset } from "./assets.js";
import { listSides, parsePriceToBeat, sdk, walletBalance } from "./bet.js";
import { fairValue, realisedVolatility } from "./edge.js";
import {
  listPendingRounds,
  loadLedger,
  putRound,
  release,
  reserve,
  updateRound,
} from "./rounds.js";
import type { RoundRecord } from "./rounds.js";
import { marketIdOf, profitOf, toWagers } from "./settle.js";
import { planOrder } from "./plan.js";
import type { Plan } from "./plan.js";

/**
 * Bets Futuur's "Up or Down — 5 min" markets in their last seconds: Bitcoin, Ethereum
 * and Solana (src/assets.ts), each with its own bankroll.
 *
 * Fires once per 5-minute window, a minute before the close. The assets' windows close
 * at the same instant, so one invocation plays them all side by side instead of one
 * Lambda each. For every asset it settles the rounds that have resolved since the last
 * run, sleeps until FIVEMIN_DECIDE_AT seconds before the close, then reads the Binance
 * candle the market settles against and decides.
 *
 * Why the end of the window: Futuur's book on these markets is a static ladder centred
 * on 0.50 (0.51 × 577, 0.52 × 1155, … up to 0.99) that does not reprice as the price
 * moves. Watched live on Bitcoin, it still asked 0.51 for "Up" with 10s left and spot
 * $62 above the line. With seconds left the side spot is on is close to decided, and
 * the ladder sells it at a coin-flip price. The closer to the close, the stronger that gap.
 *
 * The side's probability comes from the same driftless-walk model as the hourly bot,
 * with volatility inflated for safety. The bot buys only ask levels priced at least
 * FIVEMIN_MIN_EDGE below that probability, and sizes with Kelly on the running
 * average price — which goes all-in when the outcome is close to certain and bets
 * smaller, or nothing, when spot is near the line.
 */

/**
 * How far Futuur's line may sit from the Binance candle's open, as a share of the
 * price: about $1 on Bitcoin, and less than one tick on Solana.
 */
const LINE_TOLERANCE = 1.5e-5;

const CURRENCY = (process.env.FUTUUR_CURRENCY ?? "OOM") as Currency;
const CURRENCY_MODE = CURRENCY === "OOM" ? "play_money" : "real_money";

const config = () => ({
  /** Starting bankroll of each asset, read only the first time its ledger is created. */
  budget: num("FIVEMIN_BUDGET", 10_000),
  /** Seconds before the close to read the market and decide. */
  decideAt: num("FIVEMIN_DECIDE_AT", 15),
  /** Too close to the close to place an order safely. */
  latestAt: num("FIVEMIN_LATEST_AT", 4),
  /** Minimum margin between the model probability and the price paid, per level. */
  minEdge: num("FIVEMIN_MIN_EDGE", 0.05),
  /** Skip when the favoured side's probability is below this. */
  minProb: num("FIVEMIN_MIN_PROB", 0.7),
  /** Share of the bankroll one round may stake. 1 = all-in allowed. */
  maxFraction: num("FIVEMIN_MAX_FRACTION", 1),
  /** Multiplier on the Kelly stake. 1 = full Kelly. */
  kelly: num("FIVEMIN_KELLY", 1),
  /** Inflates realised volatility: crypto's tails over 10s are fatter than a walk's. */
  volMult: num("FIVEMIN_VOL_MULT", 1.5),
  /** Smallest stake worth placing. */
  minStake: num("FIVEMIN_MIN_STAKE", 10),
  dryRun: (process.env.FIVEMIN_DRY_RUN ?? "false") === "true",
});

type Config = ReturnType<typeof config>;

export const handler = async () => {
  const cfg = config();
  const assets = enabledAssets();

  // Side by side: the waits overlap, so three assets take no longer than one. Each is
  // isolated — one asset failing must not cost the others their round.
  const results = await Promise.all(
    assets.map((asset) =>
      play(asset, cfg).catch((error: unknown) => {
        console.error("asset failed", { asset: asset.key, error });
        return { settled: [], round: null, error: error instanceof Error ? error.message : String(error) };
      }),
    ),
  );
  return Object.fromEntries(assets.map((asset, i) => [asset.key, results[i]]));
};

/** One asset's round: settle what resolved, wait for the last seconds, decide, bet. */
async function play(asset: Asset, cfg: Config) {
  await loadLedger(asset, cfg.budget);

  // Settle first: the previous round resolved about a minute after it closed, and
  // its payout is what this round gets to stake.
  const settled = await settlePending(asset).catch((error: unknown) => {
    console.error("settling failed", { asset: asset.key, error });
    return [];
  });

  const event = await currentEvent(asset);
  if (!event) {
    console.warn("no open 5-minute event closing in the next few minutes", { asset: asset.key });
    return { settled, round: null };
  }

  const skip = (
    base: Pick<RoundRecord, "eventId" | "title" | "closesAt" | "dryRun">,
    reason: string,
    facts: Partial<RoundRecord> = {},
  ) => skipRound(asset, base, reason, facts);

  const closesAt = event.bet_end_date!;
  const close = Date.parse(closesAt);
  const base = { eventId: event.id, title: event.title, closesAt, dryRun: cfg.dryRun };
  // Set as soon as an order exists, so a failure after that point still records it.
  let placed: { orderId: number; orderStatus: string; side: "up" | "down" } | undefined;

  try {
    // Everything that does not need to be fresh is read before the wait.
    const vol = await realisedVolatility(asset.symbol).catch(() => null);
    const side = (direction: "up" | "down") => sideOf(event, direction);

    await sleepUntil(close - cfg.decideAt * 1000);

    const now = Date.now();
    const secondsLeft = (close - now) / 1000;
    if (secondsLeft < cfg.latestAt) {
      return finish(settled, await skip(base, `woke up too late, ${secondsLeft.toFixed(1)}s left`));
    }

    const [candle, wallet, current] = await Promise.all([
      binanceCandle(asset.symbol),
      walletBalance(CURRENCY).catch((error: unknown) => {
        console.error("wallet balance unavailable", error);
        return null;
      }),
      loadLedger(asset, cfg.budget),
    ]);

    const priceToBeat = lineOf(event);
    const spot = candle.close;
    const gap = round2(spot - priceToBeat);

    if (vol === null) {
      return finish(settled, await skip(base, "no volatility estimate", { priceToBeat, spot, gap }));
    }
    const sigma = Math.max(vol.sigma * cfg.volMult, 1e-6);
    const value = fairValue(spot, priceToBeat, secondsLeft, { sigma, samples: vol.samples });

    // Futuur resolves Up on close >= open, so a tie belongs to Up.
    const direction = spot >= priceToBeat ? "up" : "down";
    const prob = value.fair[direction];
    const chosen = side(direction);

    const facts = {
      decidedAt: new Date(now).toISOString(),
      secondsLeft: round2(secondsLeft),
      priceToBeat,
      binanceOpen: candle.open,
      spot,
      gap,
      sigma,
      sigmasAway: value.sigmasAway,
      probUp: value.fair.up,
      side: direction,
      prob,
      bankrollBefore: current.bankroll,
      wallet: wallet ?? undefined,
    } as const;

    // The line check: Futuur settles on the Binance 5m candle, so its price to beat
    // should be that candle's open. If not, spot is being compared with the wrong line.
    if (Math.abs(candle.open - priceToBeat) > priceToBeat * LINE_TOLERANCE) {
      return finish(
        settled,
        await skip(base, `line mismatch: Futuur ${priceToBeat} vs Binance open ${candle.open}`, facts),
      );
    }
    if (prob < cfg.minProb) {
      return finish(settled, await skip(base, `${direction} only ${pct(prob)} — too close to call`, facts));
    }

    const bankroll = Math.min(current.bankroll, wallet ?? 0) * cfg.maxFraction;
    if (bankroll < cfg.minStake) {
      return finish(
        settled,
        await skip(
          base,
          `nothing to stake: bankroll ${current.bankroll}, wallet ${wallet ?? "unavailable"}`,
          facts,
        ),
      );
    }

    const book = await sdk.getOrderBook(chosen.market.id, {
      currency_mode: CURRENCY_MODE,
      position: chosen.position,
    });
    const plan = planOrder(book.ask ?? [], prob, bankroll, cfg);
    const priced = { ...facts, bestAsk: book.ask?.[0]?.price ?? null, maxPrice: plan.maxPrice };

    if (plan.shares < 1 || plan.cost < cfg.minStake) {
      return finish(
        settled,
        await skip(
          base,
          `no edge: ${direction} at ${pct(prob)}, best ask ${priced.bestAsk ?? "—"}, ` +
            `willing to pay up to ${plan.maxPrice}, stake ${plan.cost}`,
          priced,
        ),
      );
    }

    const why =
      `${direction} — spot ${spot} is ${Math.abs(gap)} ${gap >= 0 ? "above" : "below"} ` +
      `${priceToBeat} with ${secondsLeft.toFixed(1)}s left (${pct(prob)}); ` +
      `buying ${plan.shares} at avg ${plan.avgPrice}, up to ${plan.limit}`;

    if (cfg.dryRun) {
      return finish(settled, await skip(base, `dry run, would bet: ${why}`, { ...priced, ...planned(plan) }));
    }

    const order = await placeOrder(event, chosen.market.id, chosen.position, plan);
    placed = { orderId: order.id, orderStatus: order.status, side: direction };
    const sharesFilled = Number(order.shares_filled ?? (order.status === "filled" ? plan.shares : 0));

    if (order.status === "canceled" && !(sharesFilled > 0)) {
      return finish(
        settled,
        await skip(base, `order canceled by Futuur, nothing charged — ${why}`, {
          ...priced,
          ...planned(plan),
          orderId: order.id,
          orderStatus: order.status,
        }),
      );
    }

    // Held out of the bankroll until the round settles, so the next round can never
    // stake money that is still riding on this one.
    const after = await reserve(asset, plan.cost);
    const round = await putRound(asset, {
      ...base,
      ...priced,
      ...planned(plan),
      status: "pending",
      reason: why,
      orderId: order.id,
      orderStatus: order.status,
      sharesFilled,
      bankrollAfter: after.bankroll,
    });
    console.log("bet placed", round);
    return finish(settled, round);
  } catch (error) {
    console.error("round failed", { asset: asset.key, error });
    const message = error instanceof Error ? error.message : String(error);
    // An order that went through is still at stake: record it as pending so the next
    // run settles it, rather than losing track of the money.
    const round = await putRound(asset, {
      ...base,
      ...(placed ?? {}),
      status: placed ? "pending" : "failed",
      reason: placed ? "order placed, but the run failed before recording it fully" : "error",
      error: message,
    });
    return finish(settled, round);
  }
}

/** The open event closing soonest, as long as it closes within this window. */
async function currentEvent(asset: Asset): Promise<FuturEvent | undefined> {
  const { results } = await sdk.listEvents({
    categories: [asset.category],
    currency_mode: CURRENCY_MODE,
    ordering: "bet_end_date",
    limit: 20,
  });
  const horizon = Date.now() + 6 * 60_000;
  return results
    .filter((e) => e.status === "open" && e.is_wagerable !== false && e.bet_end_date)
    .filter((e) => {
      const close = Date.parse(e.bet_end_date!);
      return close > Date.now() && close <= horizon;
    })
    .sort((a, b) => Date.parse(a.bet_end_date!) - Date.parse(b.bet_end_date!))
    .at(0);
}

/** The event's open price, which is the line it settles against. */
function lineOf(event: FuturEvent): number {
  const extra = (event as { event_extra_data?: { open_price?: unknown } }).event_extra_data;
  const open = Number(extra?.open_price);
  return Number.isFinite(open) && open > 0 ? open : parsePriceToBeat(event);
}

/** One market, "Up" long and "Down" short — matched by label, not assumed. */
function sideOf(event: FuturEvent, direction: "up" | "down") {
  const sides = listSides(event.markets, CURRENCY);
  const named = sides.find((s) => new RegExp(`^\\s*${direction}\\s*$`, "i").test(s.label));
  if (named) return named;
  if (sides.length === 0) throw new Error(`no ${CURRENCY} side on event ${event.id}`);
  const first = sides[0]!;
  return { ...first, position: (direction === "up" ? "long" : "short") as Position };
}

/**
 * The pair's Binance 5m candle in progress: its open is the market's line, its close
 * so far is the price the market will settle on if nothing else trades.
 */
async function binanceCandle(
  symbol: string,
): Promise<{ open: number; close: number; openTime: number }> {
  const response = await fetch(
    `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=5m&limit=1`,
    { signal: AbortSignal.timeout(3_000) },
  );
  if (!response.ok) throw new Error(`binance klines HTTP ${response.status}`);
  const [row] = (await response.json()) as unknown[][];
  const open = Number(row?.[1]);
  const close = Number(row?.[4]);
  if (!(open > 0) || !(close > 0)) throw new Error("unusable binance candle");
  return { open, close, openTime: Number(row![0]) };
}

function planned(plan: Plan) {
  return { shares: plan.shares, limitPrice: plan.limit, avgPrice: plan.avgPrice, cost: plan.cost };
}

/** A limit at the deepest level the plan touched, so it crosses and fills at once. */
async function placeOrder(event: FuturEvent, market: number, position: Position, plan: Plan) {
  const body: CreateOrderBody = {
    market,
    side: "bid",
    position,
    currency: CURRENCY,
    shares: plan.shares,
    price: plan.limit,
  };
  // The API can answer 200 with "canceled" and no fill; one retry, while there is time.
  let order = await sdk.createOrder(body, { idempotencyKey: `5min:${event.id}:0` });
  if (order.status === "canceled" && Date.parse(event.bet_end_date!) - Date.now() > 4_000) {
    console.warn("order came back canceled, retrying once", { orderId: order.id });
    order = await sdk.createOrder(body, { idempotencyKey: `5min:${event.id}:1` });
  }
  console.log("order", { id: order.id, status: order.status, filled: order.shares_filled, body });
  return order;
}

/**
 * Settles every pending round whose market has resolved. The P&L is Futuur's own
 * number off the wager, so the ledger tracks what was really paid and paid out.
 */
async function settlePending(
  asset: Asset,
): Promise<{ closesAt: string; status: string; pnl: number }[]> {
  const pending = await listPendingRounds(asset);
  const out: { closesAt: string; status: string; pnl: number }[] = [];

  for (const round of pending) {
    // Resolution lands about a minute after the close.
    if (Date.now() - Date.parse(round.closesAt) < 60_000) continue;

    try {
      const [wagers, event] = await Promise.all([
        sdk
          .listWagers({ event: round.eventId, currency_mode: "", limit: 50 })
          .then(toWagers),
        sdk.getEvent(round.eventId).catch(() => null),
      ]);
      const market = event?.markets?.[0];
      const position = round.side === "down" ? "short" : "long";
      const wager = wagers.find(
        (w) => w.position === position && (market ? marketIdOf(w.market) === market.id : true),
      );
      const resolution = (market as { resolution?: string | null } | undefined)?.resolution ?? null;
      const closePrice = Number(
        (event as { event_extra_data?: { close_price?: unknown } } | null)?.event_extra_data
          ?.close_price,
      );

      let status: "won" | "lost" | "unfilled";
      let pnl: number;

      if (wager && (wager.status === "won" || wager.status === "lost")) {
        status = wager.status;
        pnl = profitOf(wager) ?? (status === "lost" ? -(round.cost ?? 0) : 0);
      } else if (!wager && Date.now() - Date.parse(round.closesAt) > 15 * 60_000) {
        // Nothing ever filled: nothing was at stake.
        status = "unfilled";
        pnl = 0;
      } else {
        continue;
      }

      pnl = round2(pnl);
      const ledger = await release(asset, round.cost ?? 0, pnl, status);
      await updateRound(asset, round.sk, {
        status,
        pnl,
        wagerId: wager?.id,
        resolution,
        closePrice: Number.isFinite(closePrice) ? closePrice : undefined,
        bankrollAfter: ledger.bankroll,
        settledAt: new Date().toISOString(),
      });
      console.log("settled", {
        asset: asset.key,
        closesAt: round.closesAt,
        status,
        pnl,
        bankroll: ledger.bankroll,
      });
      out.push({ closesAt: round.closesAt, status, pnl });
    } catch (error) {
      console.error("could not settle round", { asset: asset.key, sk: round.sk, error });
    }
  }
  return out;
}

async function skipRound(
  asset: Asset,
  base: Pick<RoundRecord, "eventId" | "title" | "closesAt" | "dryRun">,
  reason: string,
  facts: Partial<RoundRecord> = {},
): Promise<RoundRecord> {
  const round = await putRound(asset, { ...base, ...facts, status: "skipped", reason });
  console.log("skipped", round);
  return round;
}

function finish(settled: unknown, round: RoundRecord | null) {
  return { settled, round };
}

async function sleepUntil(at: number): Promise<void> {
  const ms = at - Date.now();
  if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number, got "${raw}"`);
  return value;
}

function pct(p: number): string {
  return `${(p * 100).toFixed(1)}%`;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

