#!/usr/bin/env node
// Scores the 5-minute bot's probability model against what the candles actually did.
//
//   node scripts/backtest-5min.mjs [asset=btc] [limit=300] [dashboard-url]
//
// For every recorded round with a decision (bets and skips alike) it rebuilds the
// volatility two ways at the moment the bot decided — the old one (an hour of 1m
// closes) and the new one (15 min of 1s closes, sampled every 5s) — prices the side
// spot was on under several FIVEMIN_VOL_MULT values, and checks it against the
// Binance 5m candle's real close. Read-only; places nothing.
//
// What to look at: the multiplier whose high-probability buckets are calibrated
// (predicted ≈ observed). A bucket that wins less often than predicted is where the
// bot overbets.
const [asset = "btc", limitArg = "300", BASE = "https://bitcoin.rfoel.dev"] = process.argv.slice(2);
const SYMBOL = { btc: "BTCUSDT", eth: "ETHUSDT", sol: "SOLUSDT" }[asset];
if (!SYMBOL) throw new Error(`unknown asset ${asset}`);
const MULTS = [1, 1.25, 1.5, 2];
const KLINES = "https://api.binance.com/api/v3/klines";

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

async function klines(interval, params) {
  const qs = new URLSearchParams({ symbol: SYMBOL, interval, ...params });
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${KLINES}?${qs}`);
    if (res.ok) return res.json();
    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
  }
  return null;
}

function sigmaOf(closes, secondsApart) {
  if (closes.length < 10) return null;
  const rets = closes.slice(1).map((c, i) => Math.log(c / closes[i]));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const v = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(v / secondsApart);
}

async function score(round) {
  const decided = Date.parse(round.decidedAt);
  const close = Date.parse(round.closesAt);
  const [hour, secs, five] = await Promise.all([
    klines("1m", { limit: "60", endTime: String(decided) }),
    klines("1s", { limit: "900", endTime: String(decided) }),
    klines("5m", { limit: "1", startTime: String(close - 300_000) }),
  ]);
  if (!hour || !secs || !five?.[0]) return null;

  const oldSigma = sigmaOf(hour.map((r) => Number(r[4])), 60);
  const c1 = secs.map((r) => Number(r[4]));
  const newSigma = sigmaOf(c1.filter((_, i) => (c1.length - 1 - i) % 5 === 0), 5);
  if (!oldSigma || !newSigma) return null;

  const up = Number(five[0][4]) >= Number(five[0][1]);
  const side = round.spot >= round.priceToBeat ? "up" : "down";
  const won = (side === "up") === up;
  const dist = Math.abs(Math.log(round.spot / round.priceToBeat));
  const t = Math.max(round.secondsLeft, 0);

  const prob = (sigma, mult) => {
    const spread = sigma * mult * Math.sqrt(t);
    return spread > 0 ? cdf(dist / spread) : 1;
  };
  return {
    won,
    old: Object.fromEntries(MULTS.map((m) => [m, prob(oldSigma, m)])),
    new: Object.fromEntries(MULTS.map((m) => [m, prob(newSigma, m)])),
    ratio: newSigma / oldSigma,
  };
}

const { rounds } = await (await fetch(`${BASE}/rounds?asset=${asset}&limit=${limitArg}`)).json();
const usable = rounds.filter(
  (r) => r.decidedAt && r.spot > 0 && r.priceToBeat > 0 && r.secondsLeft >= 0 && r.spot !== r.priceToBeat,
);
console.log(`${asset}: scoring ${usable.length} decided rounds of ${rounds.length}\n`);

const rows = [];
for (let i = 0; i < usable.length; i += 8) {
  const batch = await Promise.all(usable.slice(i, i + 8).map((r) => score(r).catch(() => null)));
  rows.push(...batch.filter(Boolean));
}
if (rows.length === 0) {
  console.log("nothing scored");
  process.exit(0);
}

const ratios = rows.map((r) => r.ratio).sort((a, b) => a - b);
console.log(
  `new σ / old σ: median ${ratios[Math.floor(ratios.length / 2)].toFixed(2)}, ` +
    `p10 ${ratios[Math.floor(ratios.length * 0.1)].toFixed(2)}, p90 ${ratios[Math.floor(ratios.length * 0.9)].toFixed(2)}\n`,
);

const BUCKETS = [0.7, 0.8, 0.9, 0.95, 0.99, 1.0001];
for (const model of ["old", "new"]) {
  for (const m of MULTS) {
    let brier = 0;
    let logLoss = 0;
    const buckets = BUCKETS.slice(0, -1).map((lo, i) => ({ lo, hi: BUCKETS[i + 1], n: 0, p: 0, w: 0 }));
    for (const r of rows) {
      const p = Math.min(Math.max(r[model][m], 1e-6), 1 - 1e-6);
      brier += (p - (r.won ? 1 : 0)) ** 2;
      logLoss -= r.won ? Math.log(p) : Math.log(1 - p);
      const b = buckets.find((b) => p >= b.lo && p < b.hi);
      if (b) {
        b.n++;
        b.p += p;
        b.w += r.won ? 1 : 0;
      }
    }
    const cells = buckets
      .filter((b) => b.n > 0)
      .map((b) => `${b.lo}+: ${(b.p / b.n * 100).toFixed(1)}% pred / ${(b.w / b.n * 100).toFixed(1)}% won (n=${b.n})`);
    console.log(
      `${model} ×${m}: brier ${(brier / rows.length).toFixed(4)}, log loss ${(logLoss / rows.length).toFixed(4)}`,
    );
    for (const c of cells) console.log(`    ${c}`);
  }
  console.log();
}
