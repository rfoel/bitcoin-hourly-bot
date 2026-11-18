import type { CreateOrderBody, Currency, FuturEvent, Position } from "futuur";

import { enabledAssets } from "./assets.js";
import type { Asset } from "./assets.js";
import { listSides, parsePriceToBeat, sdk, walletBalance } from "./bet.js";
import { fairValue, shortVolatility } from "./edge.js";
import {
  credit,
  listPendingRounds,
  loadLedger,
  putRound,
  release,
  reserve,
  updateRound,
} from "./rounds.js";
import type { Ledger, RoundRecord, RoundStep } from "./rounds.js";
import { marketIdOf, profitOf, toWagers } from "./settle.js";
import { allocate, planOrder, planSell } from "./plan.js";

/**
 * Bets Futuur's "Up or Down" markets in their last seconds: Bitcoin, Ethereum and
 * Solana, at 5 minutes, 15 minutes, 1 hour and daily (src/assets.ts) — each market with
 * its own bankroll.
 *
 * Fires once per 5-minute window, a minute before the close. Every timeframe closes on
 * a 5-minute boundary, so each run plays the markets that close at this one: the 5-minute
 * ones always, the 15-minute ones on the quarter hour, the hourly ones on the hour, and
 * the daily ones at 12:00 PM ET. They close at the same instant, so one invocation plays
 * them side by side. For every market it settles the rounds that have resolved since
 * the last run, then at each FIVEMIN_CHECKPOINTS look before the close reads the
 * Binance price the market settles against and decides.
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
  /**
   * Seconds before the close to look at the market, earliest first: at each one the bot
   * may buy, top up or sell. Defaults to the single FIVEMIN_DECIDE_AT look.
   */
  checkpoints: checkpointsOf(process.env.FIVEMIN_CHECKPOINTS ?? process.env.FIVEMIN_DECIDE_AT ?? "15"),
  /** Too close to the close to place an order safely. */
  latestAt: num("FIVEMIN_LATEST_AT", 4),
  /** Minimum margin between the model probability and the price paid, per level. */
  minEdge: num("FIVEMIN_MIN_EDGE", 0.05),
  /** Skip when the favoured side's probability is below this. */
  minProb: num("FIVEMIN_MIN_PROB", 0.7),
  /** Share of the bankroll one round may stake. 1 = all-in allowed. */
  maxFraction: num("FIVEMIN_MAX_FRACTION", 1),
  /** Multiplier on the Kelly stake. 1 = full Kelly; 0.5 = half, the usual hedge against a mis-estimated probability. */
  kelly: num("FIVEMIN_KELLY", 0.5),
  /** Inflates realised volatility: crypto's tails over 10s are fatter than a walk's. Calibrate with scripts/backtest-5min.mjs. */
  volMult: num("FIVEMIN_VOL_MULT", 1.5),
  /** Smallest stake worth placing. */
  minStake: num("FIVEMIN_MIN_STAKE", 10),
  dryRun: (process.env.FIVEMIN_DRY_RUN ?? "false") === "true",
});

type Config = ReturnType<typeof config>;

/**
 * How long before the decision to fetch volatility and touch both books. Besides the
 * numbers, it opens the TLS connections to Binance and Futuur, so the reads after the
 * wake ride warm sockets instead of paying for handshakes in the last seconds.
 */
const WARM_LEAD_MS = 3_000;

const FIVE_MINUTES = 5 * 60_000;

type Settled = { closesAt: string; status: string; pnl: number }[];

type Volatility = { sigma: number; samples: number };

/** Everything about an asset's round that can be known before the last seconds. */
interface Prepared {
  asset: Asset;
  /** Whether this market's timeframe can close at this window's close. */
  expected: boolean;
  settled: Settled;
  ledger: Ledger;
  event: FuturEvent | undefined;
}

type Ready = Prepared & { event: FuturEvent };

export const handler = async () => {
  const cfg = config();
  const assets = enabledAssets();

  // Side by side: the waits overlap, so three assets take no longer than one. Each is
  // isolated — one asset failing must not cost the others their round.
  const failed = (asset: Asset, error: unknown) => {
    console.error("asset failed", { asset: asset.key, error });
    return { settled: [], round: null, error: error instanceof Error ? error.message : String(error) };
  };

  // Every timeframe closes on a 5-minute boundary; this run plays the one coming up.
  const windowClose = new Date(Math.ceil(Date.now() / FIVE_MINUTES) * FIVE_MINUTES);

  const prepared = await Promise.all(
    assets.map((asset) =>
      prepare(asset, cfg, asset.timeframe.closesAt(windowClose)).catch((error: unknown) =>
        failed(asset, error),
      ),
    ),
  );
  const ready = prepared.filter((p): p is Ready => "asset" in p && p.event !== undefined);

  // The wallet is shared and every asset bets at the same instant: split it now, in
  // proportion to each ledger, so no two assets can stake the same money.
  const wallet = ready.length
    ? await walletBalance(CURRENCY).catch((error: unknown) => {
        console.error("wallet balance unavailable", error);
        return null;
      })
    : null;
  const slices = allocate(wallet ?? 0, ready.map((p) => p.ledger.bankroll));

  // Every market of a coin decides at the same instant, so they share one estimate.
  const vols = new Map<string, Promise<Volatility | null>>();
  const volatilityOf = (asset: Asset) => {
    if (!vols.has(asset.symbol)) {
      vols.set(
        asset.symbol,
        shortVolatility(asset.symbol, { timeoutMs: 2_500 }).catch((error: unknown) => {
          console.error("volatility unavailable", { symbol: asset.symbol, error });
          return null;
        }),
      );
    }
    return vols.get(asset.symbol)!;
  };

  const results = await Promise.all(
    prepared.map((p) => {
      if (!("asset" in p)) return p;
      const i = ready.indexOf(p as Ready);
      if (i < 0) {
        // The daily market is looked for on every hour and is only there on one of them.
        if (p.expected && p.asset.timeframe.key !== "1d") {
          console.warn("no open event closing in the next few minutes", { asset: p.asset.key });
        }
        return finish(p.settled, null);
      }
      return play(ready[i]!, { wallet, slice: slices[i]! }, volatilityOf, cfg).catch((error: unknown) =>
        failed(p.asset, error),
      );
    }),
  );
  return Object.fromEntries(assets.map((asset, i) => [asset.key, results[i]]));
};

/**
 * Settle what resolved, then find the event and the bankroll to play it with. Every
 * market settles on every run — a daily round resolves hours before its next window —
 * but only those whose timeframe closes now look for an event.
 */
async function prepare(asset: Asset, cfg: Config, expected: boolean): Promise<Prepared> {
  await loadLedger(asset, cfg.budget);

  // Settle first: the previous round resolved about a minute after it closed, and
  // its payout is what this round gets to stake.
  const settled = await settlePending(asset).catch((error: unknown) => {
    console.error("settling failed", { asset: asset.key, error });
    return [];
  });
  // Read after settling, and final: nothing else touches this ledger until the bet.
  const [ledger, event] = await Promise.all([
    loadLedger(asset, cfg.budget),
    expected ? currentEvent(asset) : undefined,
  ]);
  return { asset, expected, settled, ledger, event };
}

/**
 * One market's round. The bot looks at the market at every checkpoint in its last
 * seconds (FIVEMIN_CHECKPOINTS, seconds before the close) and at each one, against the
 * model's probability at that moment:
 *
 *  - with nothing held, buys the side spot is on, at the levels with edge;
 *  - holding that side, tops the position up while the edge is there, under one Kelly
 *    cap for the whole position;
 *  - holding a side the bids now pay more for than it is worth — the price crossed the
 *    line, or the bids reprice above the model — sells to those bids.
 *
 * An earlier checkpoint is less certain but may find the ladder before it reprices; a
 * later one is surer and can still undo what an earlier one got wrong. Every look is
 * recorded in `steps`, so the checkpoints can be tuned on what the book really did.
 */
async function play(
  { asset, settled, ledger, event }: Ready,
  funds: { wallet: number | null; slice: number },
  volatilityOf: (asset: Asset) => Promise<Volatility | null>,
  cfg: Config,
) {
  const timeframe = asset.timeframe;
  const closesAt = event.bet_end_date!;
  const close = Date.parse(closesAt);
  const base = { eventId: event.id, title: event.title, closesAt, dryRun: cfg.dryRun };

  // The position this window has built, kept current so a failure still records it.
  const pos = {
    side: undefined as "up" | "down" | undefined,
    /** Shares held now. */
    shares: 0,
    /** Cost of the shares held now, for the Kelly cap on a top-up. */
    heldCost: 0,
    /** Everything bought in the window, and what selling brought back. */
    cost: 0,
    sold: 0,
    proceeds: 0,
    buys: 0,
  };
  const steps: RoundStep[] = [];
  const actions: string[] = [];
  /** The first buy's facts, so a round's headline fields mean what they always did. */
  let first: Partial<RoundRecord> | undefined;
  let lastFacts: Partial<RoundRecord> = {};
  let lastSkip = "no checkpoint ran";
  let bankrollAfter: number | undefined;

  const positionFields = (): Partial<RoundRecord> => ({
    side: pos.side ?? first?.side,
    shares: pos.shares,
    cost: round2(pos.cost),
    avgPrice: pos.shares + pos.sold > 0 ? round4(pos.cost / (pos.shares + pos.sold)) : undefined,
    ...(pos.sold > 0 ? { sharesSold: pos.sold, proceeds: round2(pos.proceeds) } : {}),
    steps,
  });

  try {
    const sides = { up: sideOf(event, "up"), down: sideOf(event, "down") };
    const bookOf = (direction: "up" | "down") =>
      sdk.getOrderBook(sides[direction].market.id, {
        currency_mode: CURRENCY_MODE,
        position: sides[direction].position,
      });

    // Warm-up, a few seconds before the first look: volatility from the freshest
    // seconds, and a throwaway read of both books to open the connection to Futuur. The
    // daily line is a minute candle from yesterday, so it is checked now, off the hot path.
    await sleepUntil(close - cfg.checkpoints[0]! * 1000 - WARM_LEAD_MS);
    const [vol, , , minuteLine] = await Promise.all([
      volatilityOf(asset),
      bookOf("up").catch(() => null),
      bookOf("down").catch(() => null),
      timeframe.line === "minute-close"
        ? minuteClose(asset.symbol, event).catch((error: unknown) => {
            console.error("daily line unavailable", { asset: asset.key, error });
            return null;
          })
        : null,
    ]);
    if (vol === null) return finish(settled, await skipRound(asset, base, "no volatility estimate"));

    const sigma = Math.max(vol.sigma * cfg.volMult, 1e-6);
    const priceToBeat = lineOf(event);
    // Fixed for the window: what a sale brings back is not staked again in it.
    const bankroll = Math.min(ledger.bankroll, funds.slice) * cfg.maxFraction;

    for (const [i, at] of cfg.checkpoints.entries()) {
      await sleepUntil(close - at * 1000);

      const now = Date.now();
      const secondsLeft = (close - now) / 1000;
      // Woke up past this look (a late start): skip it rather than fire two looks back
      // to back. The last one always runs.
      if (i < cfg.checkpoints.length - 1 && secondsLeft < cfg.checkpoints[i + 1]! + 2) continue;
      if (secondsLeft < cfg.latestAt) {
        lastSkip = `woke up too late, ${secondsLeft.toFixed(1)}s left`;
        break;
      }

      // One round trip for everything fresh: the candle and both books.
      const [candle, upBook, downBook] = await Promise.all([
        binanceCandle(asset.symbol, timeframe.candle),
        bookOf("up"),
        bookOf("down"),
      ]);
      const books = { up: upBook, down: downBook };
      const readMs = Date.now() - now;

      const spot = candle.close;
      const gap = round2(spot - priceToBeat);
      // What Binance says the line is: the candle's own open, or for the daily market
      // the close of yesterday's 12:00 PM ET minute.
      const binanceLine = timeframe.line === "candle-open" ? candle.open : minuteLine;
      // The daily market settles on a minute candle that closes a minute after betting
      // does: price that minute as well as the seconds left.
      const value = fairValue(spot, priceToBeat, secondsLeft + timeframe.settleLagSec, {
        sigma,
        samples: vol.samples,
      });
      // Futuur resolves Up on close >= open, so a tie belongs to Up.
      const direction = spot >= priceToBeat ? "up" : "down";
      const prob = value.fair[direction];

      const step: RoundStep = {
        secondsLeft: round2(secondsLeft),
        spot,
        probUp: value.fair.up,
        upAsk: upBook.ask?.[0]?.price ?? null,
        upBid: upBook.bid?.[0]?.price ?? null,
        downAsk: downBook.ask?.[0]?.price ?? null,
        downBid: downBook.bid?.[0]?.price ?? null,
        action: "none",
      };
      steps.push(step);

      const facts = {
        decidedAt: new Date(now).toISOString(),
        secondsLeft: round2(secondsLeft),
        readMs,
        settleLagSec: timeframe.settleLagSec || undefined,
        priceToBeat,
        binanceOpen: binanceLine ?? undefined,
        spot,
        gap,
        sigma,
        sigmasAway: value.sigmasAway,
        probUp: value.fair.up,
        side: direction,
        prob,
        bankrollBefore: ledger.bankroll,
        wallet: funds.wallet ?? undefined,
        walletShare: funds.slice,
        bestAsk: books[direction].ask?.[0]?.price ?? null,
      } as const;
      lastFacts = facts;

      // The line check: Futuur's price to beat should be the Binance price the market
      // settles against. If not, spot is being compared with the wrong line. Nothing
      // is bought before it passes, so failing it means there is nothing to undo.
      if (binanceLine === null) {
        lastSkip = "could not read the line from Binance";
        break;
      }
      if (Math.abs(binanceLine - priceToBeat) > priceToBeat * LINE_TOLERANCE) {
        lastSkip = `line mismatch: Futuur ${priceToBeat} vs Binance ${binanceLine}`;
        break;
      }

      // Holding: sell whatever the bids pay more for than it is worth.
      if (pos.side && pos.shares > 0) {
        const held = pos.side;
        const worth = value.fair[held];
        const sell = planSell(books[held].bid ?? [], worth, pos.shares, cfg);
        if (sell.shares >= 1 && sell.proceeds >= cfg.minStake) {
          const what =
            `sold ${sell.shares} ${held} at ${secondsLeft.toFixed(1)}s for ~${sell.proceeds} ` +
            `(worth ${pct(worth)}, bids down to ${sell.limit})`;
          Object.assign(step, { action: "sell", side: held, price: sell.limit } as const);

          if (cfg.dryRun) {
            Object.assign(step, { shares: sell.shares, amount: sell.proceeds, note: "dry run" });
            pos.shares -= sell.shares;
            pos.sold += sell.shares;
            pos.proceeds += sell.proceeds;
          } else {
            const order = await placeOrder(asset, event, sides[held], {
              side: "ask",
              shares: sell.shares,
              price: sell.limit,
              tag: `s${at}`,
            });
            const filled = Math.min(pos.shares, Number(order.shares_filled ?? 0));
            const got = round2(order.proceeds ?? filled * sell.limit);
            Object.assign(step, { shares: filled, amount: got, orderId: order.id });
            if (filled > 0) {
              // Sold shares carry their share of the held cost away with them.
              pos.heldCost -= (pos.heldCost * filled) / pos.shares;
              pos.shares -= filled;
              pos.sold += filled;
              pos.proceeds += got;
              bankrollAfter = (await credit(asset, got)).bankroll;
            } else {
              step.note = `sell ${order.status}, nothing filled`;
            }
          }
          actions.push(what);
          if (pos.shares < 1) pos.side = undefined;
          continue;
        }
        if (direction !== held) {
          step.note = `holding ${held} against spot; bids below ${sell.minPrice}`;
          continue;
        }
      }

      if (prob < cfg.minProb) {
        lastSkip = `${direction} only ${pct(prob)} — too close to call`;
        continue;
      }
      // The slice is already at most this ledger's bankroll (src/plan.ts allocate).
      if (bankroll < cfg.minStake) {
        lastSkip =
          `nothing to stake: bankroll ${ledger.bankroll}, wallet ${funds.wallet ?? "unavailable"}, ` +
          `share ${funds.slice}`;
        break;
      }

      const held = pos.side === direction ? { shares: pos.shares, cost: pos.heldCost } : undefined;
      const plan = planOrder(books[direction].ask ?? [], prob, bankroll, cfg, held);
      if (plan.shares < 1 || plan.cost < cfg.minStake) {
        lastSkip =
          `no edge: ${direction} at ${pct(prob)}, best ask ${facts.bestAsk ?? "—"}, ` +
          `willing to pay up to ${plan.maxPrice}, stake ${plan.cost}`;
        continue;
      }

      const what =
        `${pos.buys === 0 ? "" : "added "}${direction} — spot ${spot} is ${Math.abs(gap)} ` +
        `${gap >= 0 ? "above" : "below"} ${priceToBeat} with ${secondsLeft.toFixed(1)}s left ` +
        `(${pct(prob)}); buying ${plan.shares} at avg ${plan.avgPrice}, up to ${plan.limit}`;
      Object.assign(step, { action: "buy", side: direction, price: plan.limit } as const);

      let filled = plan.shares;
      let paid = plan.cost;
      let order: Awaited<ReturnType<typeof placeOrder>> | undefined;
      let timed = {};
      if (cfg.dryRun) {
        step.note = "dry run";
      } else {
        const sentAt = Date.now();
        order = await placeOrder(asset, event, sides[direction], {
          side: "bid",
          shares: plan.shares,
          price: plan.limit,
          tag: `b${at}`,
        });
        timed = {
          orderSentAt: new Date(sentAt).toISOString(),
          secondsLeftAtOrder: round2((close - sentAt) / 1000),
          orderMs: Date.now() - sentAt,
        };
        filled = Number(order.shares_filled ?? (order.status === "filled" ? plan.shares : 0));
        step.orderId = order.id;
        if (!order.confirmed) step.note = `${order.status}, assumed filled as planned`;
        if (!(filled > 0)) {
          step.note = `buy ${order.status}, nothing filled`;
          lastSkip = `order ${order.status} by Futuur, nothing charged — ${what}`;
          continue;
        }
        // What the fill really cost when Futuur says, else the plan's share of it.
        paid = round2(order.proceeds ?? (plan.cost * filled) / plan.shares);
        // Held out of the bankroll until the round settles, so the next round can
        // never stake money that is still riding on this one.
        bankrollAfter = (await reserve(asset, paid, { newBet: pos.buys === 0 })).bankroll;
      }
      Object.assign(step, { shares: filled, amount: paid });

      if (!first) {
        first = {
          ...facts,
          maxPrice: plan.maxPrice,
          limitPrice: plan.limit,
          ...timed,
          orderId: order?.id,
          orderStatus: order?.status,
          sharesFilled: filled,
        };
      }
      pos.side = direction;
      pos.shares += filled;
      pos.heldCost += paid;
      pos.cost += paid;
      pos.buys += 1;
      actions.push(what);
    }

    if (pos.buys === 0) {
      return finish(settled, await skipRound(asset, base, lastSkip, { ...lastFacts, steps }));
    }
    if (cfg.dryRun) {
      return finish(
        settled,
        await skipRound(asset, base, `dry run, would: ${actions.join("; ")}`, {
          ...first,
          ...positionFields(),
        }),
      );
    }

    const round = await putRound(asset, {
      ...base,
      ...first,
      ...positionFields(),
      status: "pending",
      reason: actions.join("; "),
      bankrollAfter,
    });
    console.log("bet placed", round);
    return finish(settled, round);
  } catch (error) {
    console.error("round failed", { asset: asset.key, error });
    const message = error instanceof Error ? error.message : String(error);
    // A position that was bought — or an order that was sent and never answered, which
    // Futuur may still have filled — is at stake: record it as pending so the next run
    // settles it on Futuur's wager (or as unfilled if there is none), rather than lose
    // track of the money.
    const attempted = steps.findLast((step) => step.action === "buy");
    const atStake = pos.buys > 0 || attempted !== undefined;
    const round = await putRound(asset, {
      ...base,
      ...lastFacts,
      ...(first ?? {}),
      ...(pos.buys > 0 ? positionFields() : { side: attempted?.side, steps }),
      status: atStake ? "pending" : "failed",
      reason: atStake
        ? `run failed mid-window${actions.length ? ` after: ${actions.join("; ")}` : ", an order may have gone through"}`
        : "error",
      error: message,
      bankrollAfter,
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

interface ExtraData {
  /** 5m, 15m, 1h: the candle's open. */
  open_price?: unknown;
  /** Daily: the close of yesterday's 12:00 PM ET minute, and when that minute began. */
  price_1?: unknown;
  price_1_date?: unknown;
}

function extraOf(event: FuturEvent): ExtraData {
  return (event as { event_extra_data?: ExtraData }).event_extra_data ?? {};
}

/** The price the event settles against. */
function lineOf(event: FuturEvent): number {
  const extra = extraOf(event);
  for (const raw of [extra.open_price, extra.price_1]) {
    const line = Number(raw);
    if (Number.isFinite(line) && line > 0) return line;
  }
  return parsePriceToBeat(event);
}

/**
 * The daily market's line as Binance has it: the close of the 1-minute candle that
 * began at the event's `price_1_date` (12:00 PM ET the day before).
 */
async function minuteClose(symbol: string, event: FuturEvent): Promise<number> {
  const at = Date.parse(String(extraOf(event).price_1_date ?? ""));
  if (!Number.isFinite(at)) throw new Error(`event ${event.id} has no price_1_date`);
  const response = await fetch(
    `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1m&startTime=${at}&limit=1`,
    { signal: AbortSignal.timeout(3_000) },
  );
  if (!response.ok) throw new Error(`binance klines HTTP ${response.status}`);
  const [row] = (await response.json()) as unknown[][];
  if (Number(row?.[0]) !== at) throw new Error(`no 1m candle at ${new Date(at).toISOString()}`);
  const close = Number(row![4]);
  if (!(close > 0)) throw new Error("unusable binance candle");
  return close;
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
 * The pair's Binance candle in progress: its close so far is the price the market will
 * settle on if nothing else trades, and for 5m, 15m and 1h its open is the line.
 */
async function binanceCandle(
  symbol: string,
  interval: Asset["timeframe"]["candle"],
): Promise<{ open: number; close: number; openTime: number }> {
  const response = await fetch(
    `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=1`,
    { signal: AbortSignal.timeout(3_000) },
  );
  if (!response.ok) throw new Error(`binance klines HTTP ${response.status}`);
  const [row] = (await response.json()) as unknown[][];
  const open = Number(row?.[1]);
  const close = Number(row?.[4]);
  if (!(open > 0) || !(close > 0)) throw new Error("unusable binance candle");
  return { open, close, openTime: Number(row![0]) };
}

/**
 * A limit at the deepest level the plan touched, so it crosses and fills at once: a bid
 * to buy, or an ask to sell shares held. `tag` tells the orders of one window apart.
 */
async function placeOrder(
  asset: Asset,
  event: FuturEvent,
  chosen: { market: { id: number }; position: Position },
  order: { side: "bid" | "ask"; shares: number; price: number; tag: string },
) {
  const body: CreateOrderBody = {
    market: chosen.market.id,
    side: order.side,
    position: chosen.position,
    currency: CURRENCY,
    shares: order.shares,
    price: order.price,
    // gtc, not ioc: Futuur matches an ioc order before answering, which took 5–11s with
    // several orders in flight; gtc answers `processing` in ~0.5s. The plan only takes
    // levels that cross, and any rest that fills later is in the wager settling reads.
  };
  // The API can answer 200 with "canceled" and no fill; one retry, while there is time.
  // Event ids are unique across categories; the prefix only makes the key readable.
  const key = asset.timeframe.key === "5m" ? "5min" : asset.timeframe.key;
  const idempotencyKey = (attempt: number) => `${key}:${event.id}:${order.tag}:${attempt}`;
  let placed = await sdk.createOrder(body, { idempotencyKey: idempotencyKey(0) });
  if (placed.status === "canceled" && Date.parse(event.bet_end_date!) - Date.now() > 4_000) {
    console.warn("order came back canceled, retrying once", { orderId: placed.id });
    placed = await sdk.createOrder(body, { idempotencyKey: idempotencyKey(1) });
  }
  console.log("order", { id: placed.id, status: placed.status, filled: placed.shares_filled, body });
  // Futuur usually answers `processing` with nothing filled yet; the fill lands a moment
  // later. Polling for it in the last seconds slowed every other order down past 10s,
  // so assume it filled as planned — a crossing limit on a book just read does. A bet
  // counted that did not happen only holds money back until settling corrects it from
  // Futuur's wager; one missed would lose track of the money.
  if (placed.status === "processing" || placed.status === "open") {
    return { ...placed, shares_filled: order.shares, proceeds: null, confirmed: false };
  }
  return { ...placed, confirmed: true };
}

/**
 * Settles every pending round whose market has resolved. The P&L is Futuur's own
 * number off the wager, so the ledger tracks what was really paid and paid out.
 */
async function settlePending(asset: Asset): Promise<Settled> {
  const pending = await listPendingRounds(asset);
  const out: Settled = [];
  // The daily market's settling price is fixed a minute after betting closes.
  const lagMs = asset.timeframe.settleLagSec * 1000;

  for (const round of pending) {
    // A position sold off entirely before the close has nothing left to resolve.
    const soldOut = (round.sharesSold ?? 0) > 0 && !((round.shares ?? 0) > 0);
    if (soldOut) {
      if (Date.now() < Date.parse(round.closesAt)) continue;
      await settleSold(asset, round, null).then(
        (done) => out.push(done),
        (error: unknown) => console.error("could not settle round", { asset: asset.key, sk: round.sk, error }),
      );
      continue;
    }
    // Resolution lands about a minute after the settling price is fixed.
    if (Date.now() - Date.parse(round.closesAt) < 60_000 + lagMs) continue;

    try {
      const [wagers, event] = await Promise.all([
        sdk
          .listWagers({ event: round.eventId, currency_mode: "", limit: 50 })
          .then(toWagers),
        sdk.getEvent(round.eventId).catch(() => null),
      ]);
      const market = event?.markets?.[0];
      // Without the event's market there is no telling this round's wager from another
      // market's with the same position — with many markets settling at once, matching
      // on position alone booked one wager's profit to several rounds. Try again later.
      if (!market) {
        console.warn("event unavailable, settling later", { asset: asset.key, eventId: round.eventId });
        continue;
      }
      const position = round.side === "down" ? "short" : "long";
      const wager = wagers.find(
        (w) =>
          w.position === position &&
          marketIdOf(w.market) === market.id &&
          // Market ids are unique per event; this only catches a URL that says otherwise.
          (eventIdOf(w.event) ?? round.eventId) === round.eventId,
      );
      const resolution = (market as { resolution?: string | null } | undefined)?.resolution ?? null;
      const closePrice = Number(
        (event as { event_extra_data?: { close_price?: unknown } } | null)?.event_extra_data
          ?.close_price,
      );

      let status: "won" | "lost" | "unfilled";
      let pnl: number;

      if ((round.sharesSold ?? 0) > 0 && wager && (wager.status === "won" || wager.status === "lost")) {
        // Part of the position was sold before the close: Futuur's wager profit may or
        // may not count the sale, so settle on the round's own fills.
        out.push(await settleSold(asset, round, wager.status, wager.id));
        continue;
      } else if (wager?.status === "sold") {
        // Futuur has the whole wager sold, whatever the round recorded: nothing rides.
        console.warn("wager sold but round still holds shares", { asset: asset.key, sk: round.sk });
        out.push(await settleSold(asset, { ...round, shares: 0 }, null, wager.id));
        continue;
      } else if (wager && (wager.status === "won" || wager.status === "lost")) {
        status = wager.status;
        pnl = profitOf(wager) ?? (status === "lost" ? -(round.cost ?? 0) : 0);
      } else if (!wager && Date.now() - Date.parse(round.closesAt) > 15 * 60_000 + lagMs) {
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

/** The id in a wager's event, which the API gives as a resource URL. */
function eventIdOf(event: unknown): number | undefined {
  if (typeof event === "number") return event;
  if (typeof event === "string") {
    const match = /\/events\/(\d+)/.exec(event);
    return match ? Number(match[1]) : undefined;
  }
  const id = Number((event as { id?: unknown } | null)?.id);
  return Number.isFinite(id) ? id : undefined;
}

/**
 * Settles a round that sold some or all of its shares before the close. The sale's
 * proceeds were credited when it happened, so only the payout of the shares still held
 * comes back now; the P&L is everything: payout + proceeds − cost.
 */
async function settleSold(
  asset: Asset,
  round: RoundRecord,
  outcome: "won" | "lost" | null,
  wagerId?: number,
): Promise<Settled[number]> {
  const cost = round.cost ?? 0;
  const proceeds = round.proceeds ?? 0;
  const payout = outcome === "won" ? (round.shares ?? 0) : 0;
  const pnl = round2(payout + proceeds - cost);
  // Counted by what the round made, sold or not: a sale that cut a loss is still a loss.
  const status = pnl >= 0 ? "won" : "lost";

  const ledger = await release(asset, round2(cost - proceeds), pnl, status);
  await updateRound(asset, round.sk, {
    status,
    pnl,
    wagerId,
    bankrollAfter: ledger.bankroll,
    settledAt: new Date().toISOString(),
  });
  console.log("settled", { asset: asset.key, closesAt: round.closesAt, status, pnl, sold: true });
  return { closesAt: round.closesAt, status, pnl };
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

function checkpointsOf(raw: string): number[] {
  const seconds = [...new Set(raw.split(",").map((part) => Number(part.trim())))];
  if (seconds.length === 0 || seconds.some((s) => !Number.isFinite(s) || s <= 0)) {
    throw new Error(`FIVEMIN_CHECKPOINTS must be seconds before the close, got "${raw}"`);
  }
  return seconds.sort((a, b) => b - a);
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

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

