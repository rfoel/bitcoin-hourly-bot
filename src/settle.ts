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
  let settled = 0;
  let stillPending = 0;

  for (const bet of pending) {
    try {
      if (!wagersByEvent.has(bet.eventId)) {
        const { results } = await sdk.listWagers({
          event: bet.eventId,
          currency_mode: "",
          past_bets: true,
          limit: 100,
        });
        wagersByEvent.set(bet.eventId, results);
      }

      const wager = matchWager(wagersByEvent.get(bet.eventId) ?? [], bet);
      const status = statusOf(wager, bet);

      if (status === "pending") {
        stillPending += 1;
        continue;
      }

      await settleBet(bet.sk, {
        status,
        wagerId: wager?.id,
        earnings: wager ? Number(wager.earnings) : undefined,
        roi: wager ? Number(wager.roi) : undefined,
      });
      settled += 1;
      console.log("settled", { sk: bet.sk, orderId: bet.orderId, status });
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

/** Wagers reference their market by URL, so the id has to be pulled out of it. */
function matchWager(wagers: Wager[], bet: BetRecord): Wager | undefined {
  return wagers.find(
    (wager) =>
      marketIdOf(wager.market) === bet.marketId && wager.position === bet.position,
  );
}

function marketIdOf(marketUrl: string): number | undefined {
  const match = /\/markets\/(\d+)/.exec(marketUrl);
  return match ? Number(match[1]) : undefined;
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
