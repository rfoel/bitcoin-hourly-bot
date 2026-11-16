import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { Resource } from "sst";

import type { Asset } from "./assets.js";

/**
 * The 5-minute bot's own records, in the same table as the hourly ones. One ledger and
 * one set of rounds per asset (see src/assets.ts for each asset's keys):
 *
 *   pk `ROUND5`      sk `<betEndDate>`  — Bitcoin: one row per round, bet or skipped
 *   pk `ROUND5#ETH`  sk `<betEndDate>`  — the same for Ethereum (`#SOL` for Solana)
 *   pk `FIVEMIN`     sk `STATE`         — Bitcoin's bankroll ledger
 *   pk `FIVEMIN`     sk `STATE#ETH`     — Ethereum's (`STATE#SOL` for Solana)
 *
 * Every round is written, including the ones it skipped and why, so the whole run
 * can be audited afterwards: what it saw, what it decided, what it paid, what came back.
 */
const ledgerKey = (asset: Asset) => ({ pk: "FIVEMIN", sk: asset.ledgerSk });

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

  priceToBeat?: number;
  /** Open of the Binance 5m candle Futuur settles against — should equal priceToBeat. */
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

  orderId?: number;
  orderStatus?: string;
  sharesFilled?: number;

  /** Filled in when the round settles. */
  resolution?: string | null;
  closePrice?: number;
  wagerId?: number;
  pnl?: number;
  bankrollAfter?: number;
  settledAt?: string;
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

/** Holds a bet's cost out of the bankroll until it settles. */
export async function reserve(asset: Asset, cost: number): Promise<Ledger> {
  const result = await client.send(
    new UpdateCommand({
      TableName: table(),
      Key: ledgerKey(asset),
      UpdateExpression: "SET bankroll = bankroll - :cost, bets = bets + :one, updatedAt = :now",
      ExpressionAttributeValues: {
        ":cost": cost,
        ":one": 1,
        ":now": new Date().toISOString(),
      },
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
  await client.send(new PutCommand({ TableName: table(), Item: record }));
  return record;
}

export async function updateRound(
  asset: Asset,
  sk: string,
  fields: Partial<Omit<RoundRecord, "pk" | "sk">>,
): Promise<void> {
  const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return;

  await client.send(
    new UpdateCommand({
      TableName: table(),
      Key: { pk: asset.roundPk, sk },
      UpdateExpression: `SET ${entries.map((_, i) => `#k${i} = :v${i}`).join(", ")}`,
      ExpressionAttributeNames: Object.fromEntries(entries.map(([key], i) => [`#k${i}`, key])),
      ExpressionAttributeValues: Object.fromEntries(entries.map(([, value], i) => [`:v${i}`, value])),
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

/** Rounds still waiting on a result, bounded to the last two days. */
export async function listPendingRounds(asset: Asset): Promise<RoundRecord[]> {
  const since = new Date(Date.now() - 2 * 86_400_000).toISOString();
  const result = await client.send(
    new QueryCommand({
      TableName: table(),
      KeyConditionExpression: "pk = :pk AND sk >= :since",
      FilterExpression: "#status = :pending",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":pk": asset.roundPk, ":since": since, ":pending": "pending" },
    }),
  );
  return (result.Items ?? []) as RoundRecord[];
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
