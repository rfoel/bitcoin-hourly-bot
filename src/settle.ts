import { Futuur } from "futuur";
import type { Wager } from "futuur";

import { listPendingBets, settleBet, summarise, listBets } from "./store.js";
import type { BetRecord, BetStatus } from "./store.js";

const sdk = new Futuur({
  publicKey: process.env.FUTUUR_PUBLIC_KEY!,
  privateKey: process.env.FUTUUR_PRIVATE_KEY!,
  timeout: 15_000,
});

/**
 * Reconciles placed bets with their results, so the stats that drive staking are
 * based on what actually happened rather than what was intended. Runs a few
 * minutes past the hour, once the hourly events have resolved.
 */
export const handler = async () => {
  const pending = await listPendingBets();
  if (pending.length === 0) {
    console.log("nothing pending to settle");
    return { settled: 0, stillPending: 0 };
  }

  // One API call per event, not per bet — several bets can share an event.
  const wagersByEvent = new Map<number, Wager[]>();
  for (const eventId of new Set(pending.map((bet) => bet.eventId))) {
    wagersByEvent.set(eventId, await wagersFor(eventId).catch(() => []));
  }

  // Futuur aggregates every order on the same (market, position) into one wager, so
  // the wager's profit has to be divided among the bets that built it. Weighting by
  // each bet's share of the *group* rather than of the wager keeps the parts summing
  // to the whole even when an order never filled: three bets totalling 821 shares
  // against a 740-share wager would otherwise attribute 111% of the profit.
  const groupShares = new Map<number, number>();
  for (const bet of pending) {
    const wager = matchWager(wagersByEvent.get(bet.eventId) ?? [], bet);
    if (wager) groupShares.set(wager.id, (groupShares.get(wager.id) ?? 0) + bet.shares);
  }

  let settled = 0;
  let stillPending = 0;

  for (const bet of pending) {
    try {
      const wagers = wagersByEvent.get(bet.eventId) ?? [];
      const wager = matchWager(wagers, bet);
      const status = statusOf(wager, bet);

      if (!wager) {
        // Say what was actually on offer, so a mismatch is one log line to diagnose
        // rather than a guess between "no wager" and "wager we failed to match".
        console.warn("no wager matched this bet", {
          sk: bet.sk,
          want: { marketId: bet.marketId, position: bet.position },
          have: wagers.map((w) => ({
            id: w.id,
            market: w.market,
            marketId: marketIdOf(w.market),
            position: w.position,
            status: w.status,
            shares: w.shares,
          })),
        });
      }

      if (status === "pending") {
        stillPending += 1;
        continue;
      }

      const group = wager ? (groupShares.get(wager.id) ?? bet.shares) : 0;
      const weight = wager && group > 0 ? bet.shares / group : 0;
      const profit = wager ? profitOf(wager) : undefined;

      await settleBet(bet.sk, {
        status,
        wagerId: wager?.id,
        earnings: profit === undefined ? undefined : round2(profit * weight),
        roi: wager ? roiOf(wager) : undefined,
      });
      settled += 1;
      console.log("settled", {
        sk: bet.sk,
        orderId: bet.orderId,
        status,
        wagerId: wager?.id,
        weight: round2(weight),
        wagerProfit: profit,
      });
    } catch (error) {
      // A single unreadable event must not stop the rest of the reconciliation.
      console.error("could not settle", { sk: bet.sk, error });
      stillPending += 1;
    }
  }

  const stats = summarise(await listBets(200));
  console.log("stats after settling", stats);
  return { settled, stillPending, stats };
};

/** Our own wagers on an event. */
async function wagersFor(eventId: number): Promise<Wager[]> {
  // `listWagers` is scoped to the authenticated user. `getEventWagers` returns the
  // whole event's wagers across every user — reading that as ours matched a
  // stranger's 17,600-share position against our 306-share bet.
  const wagers = await sdk
    .listWagers({ event: eventId, currency_mode: "", limit: 100 })
    .then(toWagers)
    .catch((error: unknown) => {
      console.warn("listWagers failed", { eventId, error });
      return [] as Wager[];
    });

  // Money fields, once per event: `earnings` and `roi` come back 0 on settled wagers,
  // so this is how we find out which field actually carries the payout.
  console.log("wagers for event", {
    eventId,
    mine: wagers.length,
    money: wagers.map((w) => ({
      id: w.id,
      status: w.status,
      shares: w.shares,
      total_amount: w.total_amount,
      active_purchases_amount: w.active_purchases_amount,
      amount_on_win: w.amount_on_win,
      amount_on_sell: w.amount_on_sell,
      last_profit: w.last_profit,
      earnings: w.earnings,
      roi: w.roi,
    })),
  });
  return wagers;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** `null` and `""` both become 0 through `Number()`, which is how a real payout read as zero. */
function numeric(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * A settled wager's profit. `earnings` and `roi` come back null on this API, so the
 * usable figure is `last_profit`, with `amount_on_win - total_amount` as the fallback
 * — they agree exactly (740 - 402.52 = 337.48 on wager 912901), and both are net of
 * fees, unlike deriving from our own recorded cost.
 */
function profitOf(wager: Wager): number | undefined {
  const reported = numeric(wager.last_profit);
  if (reported !== undefined) return reported;

  const cost = numeric(wager.total_amount);
  if (cost === undefined) return undefined;

  if (wager.status === "lost") return -cost;

  const payout = numeric(wager.amount_on_win);
  return payout === undefined ? undefined : round2(payout - cost);
}

function roiOf(wager: Wager): number | undefined {
  const reported = numeric(wager.roi);
  if (reported !== undefined) return reported;

  const cost = numeric(wager.total_amount);
  const profit = profitOf(wager);
  if (cost === undefined || profit === undefined || cost === 0) return undefined;
  return round2(profit / cost);
}

/**
 * The SDK types wager lists as a bare `Wager[]`, but the API can answer with a
 * paginated envelope — trusting the declared type threw `not iterable` and left every
 * bet unsettled. Accept either shape.
 */
function toWagers(value: unknown): Wager[] {
  if (Array.isArray(value)) return value as Wager[];

  const results = (value as { results?: unknown } | null)?.results;
  if (Array.isArray(results)) return results as Wager[];

  console.warn("unexpected wagers payload shape", {
    type: typeof value,
    keys: value && typeof value === "object" ? Object.keys(value) : null,
  });
  return [];
}

function matchWager(wagers: Wager[], bet: BetRecord): Wager | undefined {
  return wagers.find(
    (wager) => marketIdOf(wager.market) === bet.marketId && wager.position === bet.position,
  );
}

/**
 * The SDK types `wager.market` as a URL string, but the API can also nest the market
 * object. Both shapes appear, so read the id out of either — the URL-only version
 * silently produced `undefined` and no bet ever matched its wager.
 */
function marketIdOf(market: Wager["market"]): number | undefined {
  if (typeof market === "number") return market;

  if (typeof market === "string") {
    const match = /\/markets\/(\d+)/.exec(market);
    return match ? Number(match[1]) : undefined;
  }

  const id = (market as { id?: unknown } | null)?.id;
  return typeof id === "number" ? id : undefined;
}

/** Grace period after the market closes before a missing wager counts as unfilled. */
const UNFILLED_AFTER_MS = 30 * 60_000;

function statusOf(wager: Wager | undefined, bet: BetRecord): BetStatus {
  if (!wager) {
    // The order may still be sitting on the book, so only call it unfilled once
    // the market has been closed long enough that nothing more can happen.
    const closedFor = Date.now() - Date.parse(bet.betEndDate);
    return closedFor > UNFILLED_AFTER_MS ? "unknown" : "pending";
  }

  switch (wager.status) {
    case "won":
      return "won";
    case "lost":
      return "lost";
    case "cancelled":
    case "disabled":
      return "cancelled";
    default:
      // `purchased` and `sold` are still open positions as far as we care.
      return "pending";
  }
}
