/**
 * The markets the 5-minute bot plays. Each is the same Futuur product on a different
 * Binance pair: "Up" if the pair's 5m candle closes at or above its open.
 *
 * Every asset has its own ledger and its own rounds, so one market's bankroll is never
 * staked on another. Bitcoin keeps the keys it had before the others existed.
 */
export interface Asset {
  key: string;
  /** As a person would say it. */
  name: string;
  /** Binance pair the market settles on. */
  symbol: string;
  /** Futuur category holding the 5-minute events. */
  category: number;
  /** Partition key of this asset's rounds. */
  roundPk: string;
  /** Sort key of this asset's ledger, under pk `FIVEMIN`. */
  ledgerSk: string;
}

const ALL: Asset[] = [
  // https://futuur.com/markets/bitcoin-5min
  { key: "btc", name: "Bitcoin", symbol: "BTCUSDT", category: 3728, roundPk: "ROUND5", ledgerSk: "STATE" },
  // https://futuur.com/markets/ethereum-5min
  { key: "eth", name: "Ethereum", symbol: "ETHUSDT", category: 3729, roundPk: "ROUND5#ETH", ledgerSk: "STATE#ETH" },
  // https://futuur.com/markets/solana-5min
  { key: "sol", name: "Solana", symbol: "SOLUSDT", category: 3731, roundPk: "ROUND5#SOL", ledgerSk: "STATE#SOL" },
];

export const DEFAULT_ASSET = ALL[0]!;

/** The assets FIVEMIN_ASSETS turns on, in the order above. All of them when unset. */
export function enabledAssets(): Asset[] {
  const raw = process.env.FIVEMIN_ASSETS;
  if (raw === undefined || raw.trim() === "") return ALL;

  const wanted = raw.split(",").map((key) => key.trim().toLowerCase()).filter(Boolean);
  const unknown = wanted.filter((key) => !ALL.some((asset) => asset.key === key));
  if (unknown.length > 0) throw new Error(`FIVEMIN_ASSETS has unknown assets: ${unknown.join(", ")}`);
  return ALL.filter((asset) => wanted.includes(asset.key));
}

export function assetOf(key: string | undefined): Asset | undefined {
  const wanted = key?.trim().toLowerCase();
  return ALL.find((asset) => asset.key === wanted);
}
