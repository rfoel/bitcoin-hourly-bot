/**
 * Polymarket's hourly "Bitcoin Up or Down" market, as a second opinion on the same hour.
 *
 * Futuur's hourly event and Polymarket's hourly event are the same question asked twice:
 * does BTC finish the hour above where it started. Polymarket resolves explicitly on the
 * Binance BTC/USDT 1h candle — open versus close — and trades against real money, with
 * an order book several times the depth of the play-money one on Futuur.
 *
 * That makes its price the best available estimate of the honest probability. The
 * driftless-walk number in `edge.ts` is a model; this one is what people are paying.
 * Where the two Futuur books disagree with it, the disagreement is the edge.
 *
 * The two markets are only the same question while they settle against the same line,
 * so `strike` compares Futuur's stated price to beat against the Binance hourly open
 * Polymarket will actually resolve on. When those diverge the quote is still reported,
 * but the divergence is reported louder — a comparison across different lines is worse
 * than no comparison, because it looks like an edge.
 */

import type { Direction } from "./bet.js";

const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";
const BINANCE_HOURLY =
  "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=2";

/** Anything slower than this is worth less than the seconds it costs near the close. */
const TIMEOUT_MS = 4_000;

/** How far Futuur's close may sit from a UTC hour before the hours are not the same. */
const ALIGNMENT_TOLERANCE_MS = 120_000;

/**
 * What an hour usually finishes having traded, from eleven consecutive hours sampled on
 * 2026-08-04: 18.6k, 22.4k, 23.3k, 25.5k, 26.6k, 30.1k, 31.1k, 38.4k, 39.6k, 51.0k, and
 * one 7.7k. Volume arrives late — the same hour showed $105 forty minutes out — so a
 * number read at :53 is close to final and can be judged against this.
 *
 * It is a reference point rather than a threshold, because low volume near the close has
 * two opposite meanings: nobody is quoting, or the hour is already decided and there is
 * nothing left to bet on. The model is given the figure and told to read it in context.
 */
const TYPICAL_HOUR_VOLUME = 25_000;

export interface PolymarketSide {
  direction: Direction;
  /** Best bid — what a seller receives. */
  bid: number | null;
  /** Best ask — what a buyer pays. */
  ask: number | null;
  mid: number | null;
}

export interface StrikeCheck {
  /** Open of the Binance 1h candle Polymarket resolves against. */
  binanceOpen: number;
  /** The line stated in the Futuur event's title. */
  futuurPriceToBeat: number;
  difference: number;
  /** True when the two venues are settling against effectively the same number. */
  aligned: boolean;
}

export interface PolymarketQuote {
  slug: string;
  /** Consensus probability of Up across both books, or null if neither quoted. */
  up: number | null;
  sides: PolymarketSide[];
  /** Traded volume on the hour, in dollars. Thin hours deserve less weight. */
  volume: number;
  liquidity: number;
  /** Traded volume as a share of what an hour usually finishes at. */
  volumeVersusTypical: number;
  strike: StrikeCheck | null;
}

/**
 * The Polymarket quote for the hour that ends at `closeMs`, or null when there is no
 * comparable market — an unaligned close, a missing event, or an unquoted book.
 *
 * Never throws: this is a second opinion, and a run that cannot reach Polymarket should
 * still trade on everything else it has.
 */
export async function polymarketQuote(
  closeMs: number,
  futuurPriceToBeat?: number,
): Promise<PolymarketQuote | null> {
  const hour = Math.round(closeMs / 3_600_000) * 3_600_000;
  if (Math.abs(closeMs - hour) > ALIGNMENT_TOLERANCE_MS) {
    console.warn("futuur close is not on a UTC hour, no comparable polymarket hour", {
      close: new Date(closeMs).toISOString(),
    });
    return null;
  }

  const slug = slugForHourEnding(hour);

  try {
    const event = await getJson<GammaEvent[]>(`${GAMMA}/events?slug=${slug}`);
    const market = event?.[0]?.markets?.[0];
    if (!market) {
      console.warn("no polymarket event for slug", { slug });
      return null;
    }

    const outcomes = parseJsonArray(market.outcomes);
    const tokenIds = parseJsonArray(market.clobTokenIds);
    if (outcomes.length !== tokenIds.length || tokenIds.length === 0) {
      console.warn("polymarket outcomes and token ids do not line up", { slug });
      return null;
    }

    const [books, strike] = await Promise.all([
      Promise.all(tokenIds.map((id) => getJson<ClobBook>(`${CLOB}/book?token_id=${id}`))),
      futuurPriceToBeat === undefined
        ? Promise.resolve(null)
        : checkStrike(hour, futuurPriceToBeat).catch(() => null),
    ]);

    const sides: PolymarketSide[] = outcomes.map((outcome, i) => {
      const book = books[i];
      // Levels come back sorted with the touch last on both sides, but taking the
      // extremes rather than the last element survives that changing.
      const bid = best(book?.bids, Math.max);
      const ask = best(book?.asks, Math.min);
      return {
        direction: /down/i.test(outcome) ? "down" : "up",
        bid,
        ask,
        mid: bid === null || ask === null ? null : round((bid + ask) / 2, 4),
      };
    });

    const volume = Number(market.volume ?? 0);

    return {
      slug,
      up: consensusUp(sides),
      sides,
      volume,
      liquidity: Number(market.liquidity ?? 0),
      volumeVersusTypical: round(volume / TYPICAL_HOUR_VOLUME, 2),
      strike,
    };
  } catch (error) {
    console.warn("polymarket quote unavailable", error);
    return null;
  }
}

/**
 * Both books price the same event, so the "Down" book is a second reading of the same
 * number. Averaging the two mids uses whichever side is better quoted rather than
 * trusting a single thin book.
 */
function consensusUp(sides: PolymarketSide[]): number | null {
  const readings = sides
    .map((side) => (side.mid === null ? null : side.direction === "up" ? side.mid : 1 - side.mid))
    .filter((value): value is number => value !== null);

  if (readings.length === 0) return null;
  return round(readings.reduce((sum, value) => sum + value, 0) / readings.length, 4);
}

/** Futuur's stated line against the Binance hourly open Polymarket settles on. */
async function checkStrike(hourMs: number, futuurPriceToBeat: number): Promise<StrikeCheck> {
  const binanceOpen = await binanceHourOpen(hourMs);
  const difference = round(futuurPriceToBeat - binanceOpen, 2);
  return {
    binanceOpen,
    futuurPriceToBeat,
    difference,
    // A dollar on a sixty-thousand-dollar line is quoting noise; ten is a different
    // question, and at that point the two prices are not comparable.
    aligned: Math.abs(difference) <= 10,
  };
}

/** Open of the 1h Binance BTC/USDT candle that ends at `hourMs`. */
export async function binanceHourOpen(hourMs: number): Promise<number> {
  const rows = await getJson<unknown[][]>(BINANCE_HOURLY);
  const openTime = hourMs - 3_600_000;
  const candle = rows.find((row) => Number(row[0]) === openTime);
  if (!candle) throw new Error(`no 1h candle opening at ${new Date(openTime).toISOString()}`);

  const open = Number(candle[1]);
  if (!Number.isFinite(open) || open <= 0) throw new Error(`unusable candle open ${candle[1]}`);
  return open;
}

/**
 * Polymarket names the market after the Eastern-time hour the candle *opens*, so the
 * hour ending 12:00 UTC is "…-7am-et". Building the slug costs one request; searching
 * for it costs several, and the format has been stable across every hour checked.
 */
export function slugForHourEnding(hourMs: number): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    hour12: true,
  }).formatToParts(new Date(hourMs - 3_600_000));

  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "";

  return [
    "bitcoin-up-or-down",
    part("month").toLowerCase(),
    part("day"),
    part("year"),
    `${part("hour")}${part("dayPeriod").toLowerCase()}`,
    "et",
  ].join("-");
}

interface GammaEvent {
  markets?: {
    outcomes?: string;
    clobTokenIds?: string;
    volume?: string | number;
    liquidity?: string | number;
  }[];
}

interface ClobBook {
  bids?: { price: string; size: string }[];
  asks?: { price: string; size: string }[];
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${url} HTTP ${response.status}`);
  return (await response.json()) as T;
}

/** Gamma returns these list fields as JSON encoded inside a string. */
function parseJsonArray(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function best(
  levels: { price: string }[] | undefined,
  pick: (...values: number[]) => number,
): number | null {
  const prices = (levels ?? []).map((level) => Number(level.price)).filter(Number.isFinite);
  return prices.length === 0 ? null : round(pick(...prices), 4);
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
