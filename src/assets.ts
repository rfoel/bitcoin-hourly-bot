/**
 * The markets the bot plays: Futuur's "Up or Down" products on Bitcoin, Ethereum and
 * Solana, each in four timeframes — 5 min, 15 min, 1 hour and daily. A market is one
 * coin in one timeframe, and it is the unit everything else works in: its own Futuur
 * category, its own ledger and its own rounds, so one market's bankroll is never staked
 * on another.
 *
 * How each timeframe settles, from the events' own resolution criteria:
 *
 *  - 5m, 15m, 1h: "Up" if the Binance candle of that interval, beginning when the event
 *    opens, closes at or above its open. Betting closes when the candle does.
 *  - daily: "Up" if the close of the Binance 1-minute candle at 12:00 PM ET today is at
 *    or above the close of the 1-minute candle at 12:00 PM ET yesterday. Betting closes
 *    at 12:00 PM ET — when that candle *opens* — so the price that settles the market
 *    is one minute after the last moment to bet. The model has to price that minute too.
 *
 * Every close falls on a 5-minute boundary, so the one 5-minute schedule plays them all.
 *
 * Bitcoin, Ethereum and Solana at 5 minutes keep the keys they had before the other
 * timeframes existed.
 */
export type Coin = "btc" | "eth" | "sol";

export interface Timeframe {
  key: "5m" | "15m" | "1h" | "1d";
  /** As the dashboard says it. */
  label: string;
  /** Length of one window, for the dashboard. The daily one is approximate across DST. */
  durationMs: number;
  /** The Binance candle read at decision time: its close so far is spot. */
  candle: "5m" | "15m" | "1h" | "1m";
  /**
   * How the event's line relates to Binance: the `candle`'s own open, or the close of
   * the 1-minute candle at the event's `price_1_date`.
   */
  line: "candle-open" | "minute-close";
  /** Seconds between the betting close and the moment the settling price is fixed. */
  settleLagSec: number;
  /** Whether a window closing at this instant can be one of this timeframe's closes. */
  closesAt: (close: Date) => boolean;
}

export const TIMEFRAMES: Timeframe[] = [
  {
    key: "5m",
    label: "5 min",
    durationMs: 5 * 60_000,
    candle: "5m",
    line: "candle-open",
    settleLagSec: 0,
    closesAt: () => true,
  },
  {
    key: "15m",
    label: "15 min",
    durationMs: 15 * 60_000,
    candle: "15m",
    line: "candle-open",
    settleLagSec: 0,
    closesAt: (close) => close.getUTCMinutes() % 15 === 0,
  },
  {
    key: "1h",
    label: "1 hora",
    durationMs: 60 * 60_000,
    candle: "1h",
    line: "candle-open",
    settleLagSec: 0,
    closesAt: (close) => close.getUTCMinutes() === 0,
  },
  {
    key: "1d",
    label: "Diário",
    durationMs: 24 * 60 * 60_000,
    candle: "1m",
    line: "minute-close",
    settleLagSec: 60,
    // 12:00 PM ET is 16:00 or 17:00 UTC depending on DST; look on every full hour
    // rather than encode the DST calendar. The event's own close time decides.
    closesAt: (close) => close.getUTCMinutes() === 0,
  },
];

export interface Asset {
  /** `btc`, `eth`, `sol` for 5 minutes; `btc-15m`, `eth-1h`, `sol-1d`… for the rest. */
  key: string;
  coin: Coin;
  /** The coin as a person would say it. */
  name: string;
  /** Binance pair the market settles on. */
  symbol: string;
  timeframe: Timeframe;
  /** Futuur category holding this coin's events in this timeframe. */
  category: number;
  /** Partition key of this market's rounds. */
  roundPk: string;
  /** Sort key of this market's ledger, under pk `FIVEMIN`. */
  ledgerSk: string;
}

const COINS: { coin: Coin; name: string; symbol: string; categories: Record<Timeframe["key"], number> }[] = [
  // https://futuur.com/markets/bitcoin-5min, bitcoin-15min, bitcoin-hourly, bitcoin-daily
  { coin: "btc", name: "Bitcoin", symbol: "BTCUSDT", categories: { "5m": 3728, "15m": 3733, "1h": 3702, "1d": 3689 } },
  { coin: "eth", name: "Ethereum", symbol: "ETHUSDT", categories: { "5m": 3729, "15m": 3735, "1h": 3730, "1d": 3736 } },
  { coin: "sol", name: "Solana", symbol: "SOLUSDT", categories: { "5m": 3731, "15m": 3734, "1h": 3732, "1d": 3737 } },
];

/** The keys the 5-minute markets had before there were other timeframes. */
const LEGACY_5M: Record<Coin, { roundPk: string; ledgerSk: string }> = {
  btc: { roundPk: "ROUND5", ledgerSk: "STATE" },
  eth: { roundPk: "ROUND5#ETH", ledgerSk: "STATE#ETH" },
  sol: { roundPk: "ROUND5#SOL", ledgerSk: "STATE#SOL" },
};

/** Every market, 5-minute ones first (so Bitcoin 5 min is the dashboard's `/`). */
const ALL: Asset[] = TIMEFRAMES.flatMap((timeframe) =>
  COINS.map(({ coin, name, symbol, categories }): Asset => {
    const tag = `${timeframe.key.toUpperCase()}#${coin.toUpperCase()}`;
    return {
      key: timeframe.key === "5m" ? coin : `${coin}-${timeframe.key}`,
      coin,
      name,
      symbol,
      timeframe,
      category: categories[timeframe.key],
      ...(timeframe.key === "5m" ? LEGACY_5M[coin] : { roundPk: `ROUND#${tag}`, ledgerSk: `STATE#${tag}` }),
    };
  }),
);

export const DEFAULT_ASSET = ALL[0]!;

/**
 * The markets FIVEMIN_ASSETS (coins) and FIVEMIN_TIMEFRAMES turn on, in the order
 * above. Every coin and every timeframe when unset.
 */
export function enabledAssets(): Asset[] {
  const coins = listOf("FIVEMIN_ASSETS", COINS.map((c) => c.coin));
  const timeframes = listOf("FIVEMIN_TIMEFRAMES", TIMEFRAMES.map((t) => t.key));
  return ALL.filter((asset) => coins.includes(asset.coin) && timeframes.includes(asset.timeframe.key));
}

export function assetOf(key: string | undefined): Asset | undefined {
  const wanted = key?.trim().toLowerCase();
  return ALL.find((asset) => asset.key === wanted);
}

function listOf(name: string, known: string[]): string[] {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return known;

  const wanted = raw.split(",").map((key) => key.trim().toLowerCase()).filter(Boolean);
  const unknown = wanted.filter((key) => !known.includes(key));
  if (unknown.length > 0) throw new Error(`${name} has unknown values: ${unknown.join(", ")}`);
  return wanted;
}
