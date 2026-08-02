import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { Resource } from "sst";

/**
 * One table, two record kinds, partitioned by kind:
 *
 *   pk `BET`  sk `<betEndDate>#<orderId>`  — one row per order placed
 *   pk `NOTE` sk `<createdAt>#<id>`        — free-text strategy notes
 *
 * ISO timestamps sort lexicographically, so both partitions read newest-first
 * with a descending query and no index.
 */
const BET = "BET";
const NOTE = "NOTE";
const RUN = "RUN";

/**
 * Claude API list price per million tokens. Cache reads bill at 0.1x input and
 * 5-minute cache writes at 1.25x, so a run's cost is not `tokens x base rate`.
 */
const PRICING: Record<string, { input: number; output: number }> = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const table = () => Resource.Memory.name;

export type BetStatus = "pending" | "won" | "lost" | "cancelled" | "unknown";

export interface BetRecord {
  pk: string;
  sk: string;
  orderId: number;
  status: BetStatus;
  placedAt: string;
  eventId: number;
  eventSlug: string;
  betEndDate: string;
  marketId: number;
  position: string;
  label: string;
  strategy: string;
  reason: string;
  currency: string;
  shares: number;
  limitPrice: number | null;
  estimatedCost: number;
  budget: number;
  balanceBefore: number;
  spot?: { price: number; source: string; priceToBeat: number; direction: string };
  /** Filled in by the settle handler. */
  settledAt?: string;
  wagerId?: number;
  earnings?: number;
  roi?: number;
}

export interface NoteRecord {
  pk: string;
  sk: string;
  createdAt: string;
  text: string;
  tags: string[];
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** One agent invocation: what it decided, what it spent deciding it. */
export interface RunRecord {
  pk: string;
  sk: string;
  runAt: string;
  eventId: number;
  betEndDate: string;
  model: string;
  effort: string;
  iterations: number;
  usage: TokenUsage;
  /** USD, from the price table above. */
  costUsd: number;
  /** Order IDs placed during the run. Empty with no error means a deliberate pass. */
  orderIds: number[];
  stopReason: string | null;
  summary: string;
  /** Set when the loop itself failed, so a broken run never reads as a pass. */
  error?: string | null;
}

/** USD cost of one run, with cache reads and writes priced separately. */
export function costOf(model: string, usage: TokenUsage): number {
  const price = PRICING[model];
  if (!price) return 0;

  const perMillion =
    usage.input * price.input +
    usage.cacheRead * price.input * CACHE_READ_MULTIPLIER +
    usage.cacheWrite * price.input * CACHE_WRITE_MULTIPLIER +
    usage.output * price.output;

  // Four decimals: a run costs cents, and rounding to two would hide the difference
  // between a pass and a full deliberation.
  return Math.round((perMillion / 1_000_000) * 10_000) / 10_000;
}

export async function recordRun(
  run: Omit<RunRecord, "pk" | "sk" | "runAt" | "costUsd">,
): Promise<RunRecord> {
  const runAt = new Date().toISOString();
  const record: RunRecord = {
    ...run,
    pk: RUN,
    sk: `${runAt}#${run.eventId}`,
    runAt,
    costUsd: costOf(run.model, run.usage),
  };

  await client.send(new PutCommand({ TableName: table(), Item: record }));
  return record;
}

/** Newest runs first. */
export async function listRuns(limit = 50): Promise<RunRecord[]> {
  const result = await client.send(
    new QueryCommand({
      TableName: table(),
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": RUN },
      ScanIndexForward: false,
      Limit: limit,
    }),
  );
  return (result.Items ?? []) as RunRecord[];
}

export async function recordBet(
  bet: Omit<BetRecord, "pk" | "sk" | "status" | "placedAt"> & { placedAt?: string },
): Promise<BetRecord> {
  const placedAt = bet.placedAt ?? new Date().toISOString();
  const record: BetRecord = {
    ...bet,
    pk: BET,
    sk: `${bet.betEndDate}#${bet.orderId}`,
    status: "pending",
    placedAt,
  };

  await client.send(new PutCommand({ TableName: table(), Item: record }));
  return record;
}

/** Newest bets first. */
export async function listBets(limit = 50): Promise<BetRecord[]> {
  const result = await client.send(
    new QueryCommand({
      TableName: table(),
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": BET },
      ScanIndexForward: false,
      Limit: limit,
    }),
  );
  return (result.Items ?? []) as BetRecord[];
}

/**
 * Bets still waiting on a result. Bounded to a recent window so the query never
 * walks the whole partition — anything older than that has already been settled
 * or is never going to be.
 */
export async function listPendingBets(withinDays = 3): Promise<BetRecord[]> {
  const since = new Date(Date.now() - withinDays * 86_400_000).toISOString();
  const result = await client.send(
    new QueryCommand({
      TableName: table(),
      KeyConditionExpression: "pk = :pk AND sk >= :since",
      FilterExpression: "#status = :pending",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":pk": BET, ":since": since, ":pending": "pending" },
    }),
  );
  return (result.Items ?? []) as BetRecord[];
}

export async function settleBet(
  sk: string,
  outcome: { status: BetStatus; wagerId?: number; earnings?: number; roi?: number },
): Promise<void> {
  await client.send(
    new UpdateCommand({
      TableName: table(),
      Key: { pk: BET, sk },
      UpdateExpression:
        "SET #status = :status, settledAt = :settledAt, wagerId = :wagerId, earnings = :earnings, roi = :roi",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":status": outcome.status,
        ":settledAt": new Date().toISOString(),
        ":wagerId": outcome.wagerId ?? null,
        ":earnings": outcome.earnings ?? null,
        ":roi": outcome.roi ?? null,
      },
    }),
  );
}

export async function putNote(text: string, tags: string[] = []): Promise<NoteRecord> {
  const createdAt = new Date().toISOString();
  const record: NoteRecord = {
    pk: NOTE,
    sk: `${createdAt}#${Math.random().toString(36).slice(2, 8)}`,
    createdAt,
    text,
    tags,
  };

  await client.send(new PutCommand({ TableName: table(), Item: record }));
  return record;
}

/** Newest notes first. */
export async function listNotes(limit = 50): Promise<NoteRecord[]> {
  const result = await client.send(
    new QueryCommand({
      TableName: table(),
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": NOTE },
      ScanIndexForward: false,
      Limit: limit,
    }),
  );
  return (result.Items ?? []) as NoteRecord[];
}

export interface Stats {
  bets: number;
  pending: number;
  won: number;
  lost: number;
  winRate: number | null;
  staked: number;
  /** Staked on settled bets only — the denominator ROI is meaningful against. */
  settledStaked: number;
  /** Earnings over settled stake. Win rate hides price; this does not. */
  roi: number | null;
  earnings: number;
  /** Per strategy, then per direction — this is what tells you what works. */
  byStrategy: Record<string, { settled: number; won: number; earnings: number }>;
  byDirection: Record<string, { settled: number; won: number; earnings: number }>;
}

export function summarise(bets: BetRecord[]): Stats {
  const stats: Stats = {
    bets: bets.length,
    pending: 0,
    won: 0,
    lost: 0,
    winRate: null,
    staked: 0,
    settledStaked: 0,
    roi: null,
    earnings: 0,
    byStrategy: {},
    byDirection: {},
  };

  for (const bet of bets) {
    stats.staked = round2(stats.staked + bet.estimatedCost);
    if (bet.status === "pending") {
      stats.pending += 1;
      continue;
    }
    if (bet.status !== "won" && bet.status !== "lost") continue;

    const won = bet.status === "won";
    // A loss forfeits the stake; a win reports its own earnings.
    const earnings = won ? (bet.earnings ?? 0) : -bet.estimatedCost;
    stats.settledStaked = round2(stats.settledStaked + bet.estimatedCost);

    stats[won ? "won" : "lost"] += 1;
    stats.earnings = round2(stats.earnings + earnings);

    bucket(stats.byStrategy, bet.strategy, won, earnings);
    bucket(stats.byDirection, bet.spot?.direction ?? bet.label, won, earnings);
  }

  const settled = stats.won + stats.lost;
  stats.winRate = settled === 0 ? null : round2(stats.won / settled);
  stats.roi =
    stats.settledStaked === 0 ? null : round4(stats.earnings / stats.settledStaked);
  return stats;
}

export interface Spend {
  runs: number;
  /** Runs where the agent deliberately placed nothing. */
  passes: number;
  costUsd: number;
  avgCostPerRun: number;
  /** Cost of deciding, divided by bets actually placed — passes are overhead too. */
  avgCostPerBet: number;
  iterations: number;
  usage: TokenUsage;
  /** Share of input tokens served from cache; low means the prefix is churning. */
  cacheHitRate: number | null;
  /** Runs whose loop failed outright. */
  failures: number;
  /**
   * How many of the most recent runs share one outcome, and which. A long streak of
   * either is a signal: repeated failure is a broken deploy, repeated passing is a
   * strategy that never fires. Both look like "nothing happening" on a dashboard.
   */
  streak: { outcome: "failed" | "passed" | "bet"; runs: number } | null;
}

export function summariseSpend(runs: RunRecord[]): Spend {
  const usage: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let costUsd = 0;
  let iterations = 0;
  let passes = 0;
  let orders = 0;

  for (const run of runs) {
    costUsd += run.costUsd;
    iterations += run.iterations;
    orders += run.orderIds.length;
    // A pass is a decision not to bet. A run that crashed placed nothing either, but
    // counting it as a pass is exactly how 38 failures read as normal operation.
    if (run.orderIds.length === 0 && !run.error) passes += 1;

    usage.input += run.usage.input;
    usage.output += run.usage.output;
    usage.cacheRead += run.usage.cacheRead;
    usage.cacheWrite += run.usage.cacheWrite;
  }

  const totalInput = usage.input + usage.cacheRead + usage.cacheWrite;

  return {
    runs: runs.length,
    passes,
    failures: runs.filter((run) => run.error).length,
    streak: streakOf(runs),
    costUsd: round4(costUsd),
    avgCostPerRun: runs.length === 0 ? 0 : round4(costUsd / runs.length),
    avgCostPerBet: orders === 0 ? 0 : round4(costUsd / orders),
    iterations,
    usage,
    cacheHitRate: totalInput === 0 ? null : round2(usage.cacheRead / totalInput),
  };
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** `runs` arrives newest-first, so the streak is however far the head repeats. */
function streakOf(runs: RunRecord[]): Spend["streak"] {
  if (runs.length === 0) return null;

  const outcomeOf = (run: RunRecord) =>
    run.error ? "failed" : run.orderIds.length === 0 ? "passed" : ("bet" as const);

  const outcome = outcomeOf(runs[0]!);
  let count = 0;
  for (const run of runs) {
    if (outcomeOf(run) !== outcome) break;
    count += 1;
  }
  return { outcome: outcome as "failed" | "passed" | "bet", runs: count };
}

function bucket(
  into: Record<string, { settled: number; won: number; earnings: number }>,
  key: string,
  won: boolean,
  earnings: number,
): void {
  const entry = (into[key] ??= { settled: 0, won: 0, earnings: 0 });
  entry.settled += 1;
  if (won) entry.won += 1;
  entry.earnings = round2(entry.earnings + earnings);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
