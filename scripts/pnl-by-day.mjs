#!/usr/bin/env node
// Read-only: a market's rounds per day, to see when and why the gains changed.
//
//   node scripts/pnl-by-day.mjs <table> [asset=btc] [days=14]
//
// Per day: rounds, bets, win rate, average stake, P&L, average share of the wallet the
// market got, and the most common skip reasons. Bets are also split between windows that
// close on the quarter hour (where the 15m/1h/daily markets bet at the same instant and
// share the wallet) and the rest, so a drop that comes from the other timeframes shows.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";

const [table, asset = "btc", daysArg = "14"] = process.argv.slice(2);
if (!table) throw new Error("usage: node scripts/pnl-by-day.mjs <table> [asset] [days]");
const pk = { btc: "ROUND5", eth: "ROUND5#ETH", sol: "ROUND5#SOL" }[asset] ?? `ROUND#${asset.replace("-", "#").toUpperCase()}`;
const since = new Date(Date.now() - Number(daysArg) * 86_400_000).toISOString();

const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "sa-east-1" }));
const rounds = [];
let start;
do {
  const page = await db.send(new QueryCommand({
    TableName: table,
    KeyConditionExpression: "pk = :pk AND sk >= :since",
    ExpressionAttributeValues: { ":pk": pk, ":since": since },
    ExclusiveStartKey: start,
  }));
  rounds.push(...(page.Items ?? []));
  start = page.LastEvaluatedKey;
} while (start);

const byDay = new Map();
for (const r of rounds) {
  const day = r.closesAt.slice(0, 10);
  if (!byDay.has(day)) byDay.set(day, []);
  byDay.get(day).push(r);
}

const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const quarter = (r) => new Date(r.closesAt).getUTCMinutes() % 15 === 0;

console.log(`${asset} (${pk}), ${rounds.length} rounds since ${since.slice(0, 10)}\n`);
console.log("day         rounds bets  win%   avgStake      pnl   avgShare  stake@quarter stake@other  top skips");
for (const [day, rs] of [...byDay].sort()) {
  const bets = rs.filter((r) => r.status === "won" || r.status === "lost");
  const won = bets.filter((r) => r.status === "won").length;
  const pnl = bets.reduce((s, r) => s + (r.pnl ?? 0), 0);
  const skips = new Map();
  for (const r of rs.filter((r) => r.status === "skipped")) {
    const why = String(r.reason ?? "").replace(/[\d.,]+/g, "#").split(/[:—,]/)[0].trim();
    skips.set(why, (skips.get(why) ?? 0) + 1);
  }
  const top = [...skips].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([w, n]) => `${n}× ${w}`).join("; ");
  console.log(
    day,
    String(rs.length).padStart(6),
    String(bets.length).padStart(5),
    (bets.length ? (100 * won) / bets.length : 0).toFixed(1).padStart(6),
    avg(bets.map((r) => r.cost ?? 0)).toFixed(0).padStart(10),
    pnl.toFixed(0).padStart(9),
    avg(rs.filter((r) => r.walletShare !== undefined).map((r) => r.walletShare)).toFixed(0).padStart(10),
    avg(bets.filter(quarter).map((r) => r.cost ?? 0)).toFixed(0).padStart(14),
    avg(bets.filter((r) => !quarter(r)).map((r) => r.cost ?? 0)).toFixed(0).padStart(12),
    "", top,
  );
}
