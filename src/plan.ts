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
 *
 * `held` is a position already bought on this side earlier in the window: the Kelly cap
 * applies to the whole position, so topping it up never stakes more than one buy would.
 * The plan returned is only the new shares.
 */
export function planOrder(
  asks: Pick<OrderBookLevel, "price" | "total_shares">[],
  prob: number,
  bankroll: number,
  cfg: { minEdge: number; kelly: number },
  held: { shares: number; cost: number } = { shares: 0, cost: 0 },
): Plan {
  const maxPrice = round2(prob - cfg.minEdge);
  let shares = held.shares;
  let cost = held.cost;
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

  const bought = shares - held.shares;
  const spent = cost - held.cost;
  return {
    shares: bought,
    limit,
    cost: round2(spent),
    avgPrice: bought > 0 ? round4(spent / bought) : 0,
    maxPrice,
    levels,
  };
}

export interface SellPlan {
  shares: number;
  /** Lowest bid touched: the limit that crosses every level in the plan. */
  limit: number;
  proceeds: number;
  minPrice: number;
}

/**
 * Walks the bid ladder, highest first, selling held shares only to bids at least
 * `minEdge` above `prob` — where cashing out is worth more than holding to the close.
 * A side that is still likely to win is never sold cheap: if the bids sit below what
 * the shares are worth, the plan is empty and the position rides.
 */
export function planSell(
  bids: Pick<OrderBookLevel, "price" | "total_shares">[],
  prob: number,
  held: number,
  cfg: { minEdge: number },
): SellPlan {
  const minPrice = round2(prob + cfg.minEdge);
  let shares = 0;
  let proceeds = 0;
  let limit = 0;

  for (const level of [...bids].sort((a, b) => b.price - a.price)) {
    if (level.price < minPrice) break;
    const take = Math.min(Math.floor(level.total_shares), Math.floor(held - shares));
    if (take < 1) break;
    shares += take;
    proceeds += take * level.price;
    limit = level.price;
  }

  return { shares, limit, proceeds: round2(proceeds), minPrice };
}

/**
 * The wallet is shared by every asset, and they all bet at the same instant, so each
 * gets a slice of it in proportion to its own bankroll. When the wallet covers every
 * bankroll the slices are the bankrolls themselves; when it does not, no two assets
 * can count the same money.
 */
export function allocate(wallet: number, bankrolls: number[]): number[] {
  const positive = bankrolls.map((b) => Math.max(0, b));
  const total = positive.reduce((sum, b) => sum + b, 0);
  if (total <= 0 || wallet <= 0) return positive.map(() => 0);
  const scale = Math.min(1, wallet / total);
  return positive.map((b) => Math.floor(b * scale * 100) / 100);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
