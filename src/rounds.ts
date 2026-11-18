import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { Resource } from "sst";

import type { Asset } from "./assets.js";

/**
 * The bot's own records, in the same table as the hourly agent's. One ledger and one
 * set of rounds per market — a coin in a timeframe (see src/assets.ts for the keys):
 *
 *   pk `ROUND5`      sk `<betEndDate>`  — Bitcoin: one row per round, bet or skipped
 *   pk `ROUND5#ETH`  sk `<betEndDate>`  — the same for Ethereum (`#SOL` for Solana)
 *   pk `FIVEMIN`     sk `STATE`         — Bitcoin's bankroll ledger
 *   pk `FIVEMIN`     sk `STATE#ETH`     — Ethereum's (`STATE#SOL` for Solana)
 *   pk `ROUND#15M#BTC` sk `<betEndDate>` — the other timeframes (15M, 1H, 1D) and
 *   pk `FIVEMIN`     sk `STATE#15M#BTC` — coins, each with its rounds and its ledger
 *   pk `PENDING#<rounds pk>` sk `<betEndDate>` — a copy of each round still pending,
 *                                       so settling reads only those instead of days
 *                                       of rounds. Written and removed in the same
 *                                       transaction as the round's status change.
 *
 * Every round is written, including the ones it skipped and why, so the whole run
 * can be audited afterwards: what it saw, what it decided, what it paid, what came back.
 */
const ledgerKey = (asset: Asset) => ({ pk: "FIVEMIN", sk: asset.ledgerSk });
const pendingPk = (asset: Asset) => `PENDING#${asset.roundPk}`;

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const table = () => Resource.Memory.name;

export type RoundStatus =
  /** Order placed, waiting on the result. */
  | "pending"
  | "won"
  | "lost"
  /** Order placed but nothing filled, so nothing was at stake. */
  | "unfilled"
  /** Decided not to bet. `reason` says why. */
  | "skipped"
  /** Something broke. `error` says what. */
  | "failed";

export interface RoundRecord {
  pk: string;
  sk: string;
  /** Asset key. Absent on Bitcoin rounds written before there were other assets. */
  asset?: string;
  eventId: number;
  title: string;
  closesAt: string;
  status: RoundStatus;
  reason: string;
  error?: string;
  dryRun: boolean;

  /** When the decision was made, and how close to the close that was. */
  decidedAt?: string;
  secondsLeft?: number;
  /**
   * Seconds between the betting close and the settling price: 60 on the daily market,
   * absent elsewhere. The model priced secondsLeft plus this.
   */
  settleLagSec?: number;

  priceToBeat?: number;
  /**
   * The line as Binance has it — the candle's open, or the daily market's minute close —
   * which should equal priceToBeat.
   */
  binanceOpen?: number;
  spot?: number;
  gap?: number;
  /** Per-second volatility used, already inflated by FIVEMIN_VOL_MULT. */
  sigma?: number;
  sigmasAway?: number;
  probUp?: number;

  side?: "up" | "down";
  /** Model probability of the chosen side. */
  prob?: number;
  bestAsk?: number | null;
  /** Highest price the bot was willing to pay: prob − FIVEMIN_MIN_EDGE. */
  maxPrice?: number;

  shares?: number;
  limitPrice?: number;
  avgPrice?: number;
  /** Book-walk estimate; the settled P&L comes from Futuur's wager, not this. */
  cost?: number;
  bankrollBefore?: number;
  wallet?: number;
  /** This asset's slice of the shared wallet (src/plan.ts allocate). */
  walletShare?: number;

  orderId?: number;
  orderStatus?: string;
  sharesFilled?: number;

  /** How long the post-wake reads (candle, books) took, in ms. */
  readMs?: number;
  /** When the order request went out, and how close to the close that was. */
  orderSentAt?: string;
  secondsLeftAtOrder?: number;
  /** Round trip of the order request(s), in ms. */
  orderMs?: number;

  /**
   * Shares sold back before the close, and what they brought — already credited to the
   * bankroll when sold. When present, `shares` is what was still held at the close and
   * `cost` everything bought, and the round settles on its own numbers rather than
   * Futuur's wager profit.
   */
  sharesSold?: number;
  proceeds?: number;
  /** Every look at the market in the window, and what the bot did on it. */
  steps?: RoundStep[];

  /** Filled in when the round settles. */
  resolution?: string | null;
  closePrice?: number;
  wagerId?: number;
  pnl?: number;
  bankrollAfter?: number;
  settledAt?: string;
}

export interface RoundStep {
  /** Seconds before the close. */
  secondsLeft: number;
  spot: number;
  probUp: number;
  /** Top of both books: best ask and best bid for each side. */
  upAsk: number | null;
  upBid: number | null;
  downAsk: number | null;
  downBid: number | null;
  action: "none" | "buy" | "sell";
  side?: "up" | "down";
  shares?: number;
  /** Cost of a buy, proceeds of a sell. */
  amount?: number;
  price?: number;
  orderId?: number;
  note?: string;
}

export interface Ledger {
  pk: string;
  sk: string;
  /** What the bot started with. */
  startedWith: number;
  /** OOM the bot may still stake: start + settled P&L − cost of open bets. */
  bankroll: number;
  settledPnl: number;
  bets: number;
  won: number;
  lost: number;
  startedAt: string;
  updatedAt: string;
}

/** The ledger as it stands, or null before the first run. Never creates it. */
export async function getLedger(asset: Asset): Promise<Ledger | null> {
  const found = await client.send(new GetCommand({ TableName: table(), Key: ledgerKey(asset) }));
  return (found.Item as Ledger | undefined) ?? null;
}

/** The ledger, created with `budget` the first time the bot ever runs. */
export async function loadLedger(asset: Asset, budget: number): Promise<Ledger> {
  const key = ledgerKey(asset);
  const found = await client.send(new GetCommand({ TableName: table(), Key: key }));
  if (found.Item) return found.Item as Ledger;

  const now = new Date().toISOString();
  const ledger: Ledger = {
    ...key,
    startedWith: budget,
    bankroll: budget,
    settledPnl: 0,
    bets: 0,
    won: 0,
    lost: 0,
    startedAt: now,
    updatedAt: now,
  };
  // Conditional, so two cold starts can never both seed it.
  await client
    .send(
      new PutCommand({
        TableName: table(),
        Item: ledger,
        ConditionExpression: "attribute_not_exists(pk)",
      }),
    )
    .catch(() => undefined);
  const again = await client.send(new GetCommand({ TableName: table(), Key: key }));
  return (again.Item as Ledger) ?? ledger;
}

/**
 * Holds a bet's cost out of the bankroll until it settles. A top-up of a position already
 * opened in the same window holds its cost too, but is not another bet.
 */
export async function reserve(asset: Asset, cost: number, { newBet = true } = {}): Promise<Ledger> {
  const result = await client.send(
    new UpdateCommand({
      TableName: table(),
      Key: ledgerKey(asset),
      UpdateExpression: "SET bankroll = bankroll - :cost, bets = bets + :one, updatedAt = :now",
      ExpressionAttributeValues: {
        ":cost": cost,
        ":one": newBet ? 1 : 0,
        ":now": new Date().toISOString(),
      },
      ReturnValues: "ALL_NEW",
    }),
  );
  return result.Attributes as Ledger;
}

/**
 * Credits what a sale before the close brought in, at once: the money is back in the
 * wallet, so it is back in the bankroll. Settling then releases only what is still held.
 */
export async function credit(asset: Asset, amount: number): Promise<Ledger> {
  const result = await client.send(
    new UpdateCommand({
      TableName: table(),
      Key: ledgerKey(asset),
      UpdateExpression: "SET bankroll = bankroll + :amount, updatedAt = :now",
      ExpressionAttributeValues: { ":amount": round2(amount), ":now": new Date().toISOString() },
      ReturnValues: "ALL_NEW",
    }),
  );
  return result.Attributes as Ledger;
}

/**
 * Releases a settled bet. The reserved cost comes back plus the profit, so the net
 * move is exactly the P&L Futuur reported — even when the fill differed from the
 * estimate that was reserved.
 */
export async function release(
  asset: Asset,
  reserved: number,
  pnl: number,
  outcome: "won" | "lost" | "unfilled",
): Promise<Ledger> {
  const counter = outcome === "won" ? "won" : outcome === "lost" ? "lost" : null;
  const result = await client.send(
    new UpdateCommand({
      TableName: table(),
      Key: ledgerKey(asset),
      UpdateExpression:
        "SET bankroll = bankroll + :back, settledPnl = settledPnl + :pnl, updatedAt = :now" +
        (counter ? `, ${counter} = ${counter} + :one` : ""),
      ExpressionAttributeValues: {
        ":back": round2(reserved + pnl),
        ":pnl": pnl,
        ":now": new Date().toISOString(),
        ...(counter ? { ":one": 1 } : {}),
      },
      ReturnValues: "ALL_NEW",
    }),
  );
  return result.Attributes as Ledger;
}

export async function putRound(
  asset: Asset,
  round: Omit<RoundRecord, "pk" | "sk" | "asset">,
): Promise<RoundRecord> {
  const record: RoundRecord = { ...round, pk: asset.roundPk, sk: round.closesAt, asset: asset.key };
  if (record.status !== "pending") {
    await client.send(new PutCommand({ TableName: table(), Item: record }));
    return record;
  }
  await client.send(
    new TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: table(), Item: record } },
        { Put: { TableName: table(), Item: { ...record, pk: pendingPk(asset) } } },
      ],
    }),
  );
  return record;
}

export async function updateRound(
  asset: Asset,
  sk: string,
  fields: Partial<Omit<RoundRecord, "pk" | "sk">>,
): Promise<void> {
  const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return;

  const update = {
    TableName: table(),
    Key: { pk: asset.roundPk, sk },
    UpdateExpression: `SET ${entries.map((_, i) => `#k${i} = :v${i}`).join(", ")}`,
    ExpressionAttributeNames: Object.fromEntries(entries.map(([key], i) => [`#k${i}`, key])),
    ExpressionAttributeValues: Object.fromEntries(entries.map(([, value], i) => [`:v${i}`, value])),
  };

  // Leaving "pending" clears the marker in the same write, so the two never disagree.
  if (fields.status === undefined || fields.status === "pending") {
    await client.send(new UpdateCommand(update));
    return;
  }
  await client.send(
    new TransactWriteCommand({
      TransactItems: [
        { Update: update },
        { Delete: { TableName: table(), Key: { pk: pendingPk(asset), sk } } },
      ],
    }),
  );
}

/** Newest rounds first. */
export async function listRounds(asset: Asset, limit = 100): Promise<RoundRecord[]> {
  const result = await client.send(
    new QueryCommand({
      TableName: table(),
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": asset.roundPk },
      ScanIndexForward: false,
      Limit: limit,
    }),
  );
  return (result.Items ?? []) as RoundRecord[];
}

/**
 * Rounds still waiting on a result: the pending markers, plus the last half hour of
 * rounds filtered on status, which covers any round written before markers existed.
 */
export async function listPendingRounds(asset: Asset): Promise<RoundRecord[]> {
  const since = new Date(Date.now() - 30 * 60_000).toISOString();
  const [markers, recent] = await Promise.all([
    client.send(
      new QueryCommand({
        TableName: table(),
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": pendingPk(asset) },
      }),
    ),
    client.send(
      new QueryCommand({
        TableName: table(),
        KeyConditionExpression: "pk = :pk AND sk >= :since",
        FilterExpression: "#status = :pending",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":pk": asset.roundPk, ":since": since, ":pending": "pending" },
      }),
    ),
  ]);

  const bySk = new Map<string, RoundRecord>();
  for (const item of [...(markers.Items ?? []), ...(recent.Items ?? [])]) {
    const round = { ...(item as RoundRecord), pk: asset.roundPk };
    bySk.set(round.sk, round);
  }
  return [...bySk.values()].sort((a, b) => a.sk.localeCompare(b.sk));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
