#!/usr/bin/env node
// Scores the computed fair-value model against the bets the agent actually placed.
//
//   node scripts/backtest-edge.mjs [dashboard-url]
//
// For each settled bet it rebuilds the volatility estimate from the one-minute candles
// that existed at bet time, prices both sides, and asks what a pure edge rule would
// have done — so "replace the model with code" is answered with the record rather than
// an opinion. Read-only; places nothing.
const BASE = process.argv[2] ?? "https://bitcoin.rfoel.dev";

const erf = (x) => {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * z);
  return (
    sign *
    (1 -
      ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
        0.254829592) *
        t *
        Math.exp(-z * z))
  );
};
const cdf = (x) => (Number.isFinite(x) ? 0.5 * (1 + erf(x / Math.SQRT2)) : x > 0 ? 1 : 0);

async function sigmaAt(endMs) {
  const url = `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=60&endTime=${endMs}`;
  const rows = await (await fetch(url)).json();
  const closes = rows.map((r) => Number(r[4])).filter((c) => c > 0);
  if (closes.length < 10) return null;

  const rets = closes.slice(1).map((c, i) => Math.log(c / closes[i]));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const varr = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(varr / 60);
}

const { bets } = await (await fetch(`${BASE}/bets?limit=200`)).json();
const settled = bets.filter(
  (b) => b.strategy === "claude" && (b.status === "won" || b.status === "lost") && b.spot,
);
console.log(`scoring ${settled.length} settled agent bets\n`);

const rows = [];
for (const bet of settled) {
  const placed = Date.parse(bet.placedAt);
  const secondsLeft = (Date.parse(bet.betEndDate) - placed) / 1000;
  const sigma = await sigmaAt(placed);
  if (!sigma) continue;

  const { price: spot, priceToBeat } = bet.spot;
  const up = cdf(Math.log(spot / priceToBeat) / (sigma * Math.sqrt(secondsLeft)));
  const side = /down/i.test(bet.label) ? "down" : "up";
  const fair = side === "down" ? 1 - up : up;

  rows.push({
    side,
    paid: bet.limitPrice,
    fair,
    // What the model thought the agent was getting: fair minus the price paid.
    edge: bet.limitPrice === null ? null : fair - bet.limitPrice,
    cost: bet.estimatedCost,
    pnl: bet.earnings ?? 0,
    won: bet.status === "won",
    secondsLeft,
  });
  await new Promise((r) => setTimeout(r, 120)); // stay well inside Binance's limits
}

const fmt = (n, d = 2) => (n === null ? "  —" : n.toFixed(d).padStart(7));
console.log("side  paid    fair   edge     cost      pnl  result");
for (const r of rows) {
  console.log(
    `${r.side.padEnd(5)}${fmt(r.paid)} ${fmt(r.fair)} ${fmt(r.edge)} ${fmt(r.cost)} ${fmt(
      r.pnl,
    )}  ${r.won ? "won" : "lost"}`,
  );
}

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const report = (label, subset) => {
  if (subset.length === 0) return console.log(`${label.padEnd(26)} no bets`);
  const cost = sum(subset.map((r) => r.cost));
  const pnl = sum(subset.map((r) => r.pnl));
  const wins = subset.filter((r) => r.won).length;
  console.log(
    `${label.padEnd(26)} n=${String(subset.length).padStart(2)}  ${wins}W-${
      subset.length - wins
    }L  cost ${cost.toFixed(0).padStart(5)}  pnl ${pnl >= 0 ? "+" : ""}${pnl.toFixed(
      0,
    )}  ROI ${((pnl / cost) * 100).toFixed(1)}%`,
  );
};

console.log("\n--- what the agent did ---");
report("all agent bets", rows);

console.log("\n--- filtered by the model's edge ---");
for (const threshold of [0, 0.05, 0.1, 0.15, 0.2]) {
  report(`edge >= ${threshold.toFixed(2)}`, rows.filter((r) => (r.edge ?? -1) >= threshold));
}

console.log("\n--- bets the model priced as bad ---");
report("edge < 0 (overpaid)", rows.filter((r) => (r.edge ?? 0) < 0));
