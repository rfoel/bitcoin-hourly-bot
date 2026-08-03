/**
 * A fair price for each side of an hourly market, computed rather than judged.
 *
 * The market is a digital option: "Up" pays 1 if BTC closes above the price to beat at
 * a known time. Treating BTC as a driftless random walk over the minutes that remain,
 * the probability of finishing above the line is
 *
 *   P(up) = Φ( ln(spot / line) / (σ √t) )
 *
 * with σ the per-second volatility of log returns and t the seconds left. Volatility
 * comes from the last hour of one-minute closes, so it reflects the regime the market
 * is actually in rather than a constant.
 *
 * This is the same question the model answers with judgement: is the book's price far
 * enough from the honest probability to be worth taking? Having it as a number means
 * the model can be checked against it, and eventually replaced by it.
 */

export interface FairValue {
  /** Per-second volatility of log returns, from realised one-minute moves. */
  sigma: number;
  /** Annualised, purely so the number is legible to a human. */
  sigmaAnnual: number;
  /** Candles the estimate is based on; below ~30 treat the estimate as weak. */
  samples: number;
  spot: number;
  priceToBeat: number;
  secondsLeft: number;
  /** How many standard deviations of remaining move separate spot from the line. */
  sigmasAway: number;
  fair: { up: number; down: number };
}

export interface SideEdge {
  direction: "up" | "down";
  fair: number;
  /** Best ask on the book — what a taker actually pays. */
  ask: number | null;
  /** fair − ask. Positive means the book is selling it below the honest probability. */
  edge: number | null;
}

const BINANCE_KLINES =
  "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=60";

/** Realised per-second volatility of log returns from the last hour of one-minute closes. */
export async function realisedVolatility(): Promise<{ sigma: number; samples: number }> {
  const response = await fetch(BINANCE_KLINES, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`klines HTTP ${response.status}`);

  const rows = (await response.json()) as unknown[];
  const closes = rows
    .map((row) => Number((row as unknown[])[4]))
    .filter((close) => Number.isFinite(close) && close > 0);

  if (closes.length < 10) throw new Error(`only ${closes.length} usable candles`);

  const returns = closes.slice(1).map((close, i) => Math.log(close / closes[i]!));
  const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
  const variance =
    returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (returns.length - 1);

  // Per-minute stdev scaled to per-second: variance is linear in time under a walk.
  return { sigma: Math.sqrt(variance / 60), samples: returns.length };
}

export function fairValue(
  spot: number,
  priceToBeat: number,
  secondsLeft: number,
  vol: { sigma: number; samples: number },
): FairValue {
  // Guard the degenerate cases: at the close, or with no volatility, the side that is
  // already ahead is certain, and Φ of ±∞ is exactly that.
  const spread = vol.sigma * Math.sqrt(Math.max(secondsLeft, 0));
  const distance = Math.log(spot / priceToBeat);
  const sigmasAway = spread > 0 ? distance / spread : distance > 0 ? Infinity : -Infinity;

  const up = clamp01(normalCdf(sigmasAway));

  return {
    sigma: vol.sigma,
    // 31,536,000 seconds a year — only for readability, nothing computes off it.
    sigmaAnnual: round(vol.sigma * Math.sqrt(31_536_000), 4),
    samples: vol.samples,
    spot,
    priceToBeat,
    secondsLeft,
    sigmasAway: Number.isFinite(sigmasAway) ? round(sigmasAway, 3) : sigmasAway,
    fair: { up: round(up, 4), down: round(1 - up, 4) },
  };
}

/** Fair value against what the book is actually charging, per side. */
export function edges(
  value: FairValue,
  asks: { up: number | null; down: number | null },
): SideEdge[] {
  return (["up", "down"] as const).map((direction) => {
    const ask = asks[direction];
    const fair = value.fair[direction];
    return {
      direction,
      fair,
      ask,
      edge: ask === null ? null : round(fair - ask, 4),
    };
  });
}

/**
 * Standard normal CDF via the Abramowitz & Stegun 7.1.26 error-function approximation.
 * Absolute error below 1.5e-7, which is far finer than the two decimals a book price
 * is quoted in.
 */
function normalCdf(x: number): number {
  if (!Number.isFinite(x)) return x > 0 ? 1 : 0;
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x);

  const t = 1 / (1 + 0.3275911 * z);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-z * z);

  return sign * y;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
