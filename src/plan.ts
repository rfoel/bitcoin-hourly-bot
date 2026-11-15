import type { OrderBookLevel } from "futuur";

export interface Plan {
  shares: number;
  limit: number;
  cost: number;
  avgPrice: number;
  maxPrice: number;
  levels: number;
}

/**
 * Walks the ask ladder, cheapest first, buying only levels at least `minEdge` below
 * `prob`. The stake is capped by Kelly on the running average price — f = (p − q)/(1 − q)
 * — so it goes all-in only when that is what the edge justifies.
 */
export function planOrder(
  asks: OrderBookLevel[],
  prob: number,
  bankroll: number,
  cfg: { minEdge: number; kelly: number },
): Plan {
  const maxPrice = round2(prob - cfg.minEdge);
  let shares = 0;
  let cost = 0;
  let limit = 0;
  let levels = 0;

  for (const level of [...asks].sort((a, b) => a.price - b.price)) {
    if (level.price > maxPrice) break;

    // Cap from the average this level would leave us at — conservative, since the
    // average only rises as the walk goes on.
    const avgIfFull = (cost + level.price * level.total_shares) / (shares + level.total_shares);
    const kellyFraction = Math.min(1, Math.max(0, (prob - avgIfFull) / (1 - avgIfFull)));
    const cap = bankroll * kellyFraction * cfg.kelly;

    const take = Math.min(Math.floor(level.total_shares), Math.floor((cap - cost) / level.price));
    if (take < 1) break;

    shares += take;
    cost += take * level.price;
    limit = level.price;
    levels += 1;
  }

  return {
    shares,
    limit,
    cost: round2(cost),
    avgPrice: shares > 0 ? round4(cost / shares) : 0,
    maxPrice,
    levels,
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
