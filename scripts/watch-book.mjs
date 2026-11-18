#!/usr/bin/env node
// Watches the open 5-minute window of every asset until it closes: the top of both
// books, trade count, and the Binance price against the line, every 2 seconds.
// Read-only; places nothing.
//
//   FUTUUR_PUBLIC_KEY=… FUTUUR_PRIVATE_KEY=… node scripts/watch-book.mjs
//
// What it answers: whether the cheap ladder is there when the bot decides, and if it
// disappears or reprices, whether trades happened (someone bought it) or not (the
// maker pulled or moved its quotes).
import { Futuur } from "futuur";

const sdk = new Futuur({
  publicKey: process.env.FUTUUR_PUBLIC_KEY,
  privateKey: process.env.FUTUUR_PRIVATE_KEY,
});
const ASSETS = [
  ["btc", 3728, "BTCUSDT"],
  ["eth", 3729, "ETHUSDT"],
  ["sol", 3731, "SOLUSDT"],
];

const watched = [];
for (const [name, category, symbol] of ASSETS) {
  const { results } = await sdk.listEvents({
    categories: [category],
    currency_mode: "play_money",
    ordering: "bet_end_date",
    limit: 5,
  });
  const event = results
    .filter((e) => e.status === "open" && Date.parse(e.bet_end_date) > Date.now())
    .sort((a, b) => Date.parse(a.bet_end_date) - Date.parse(b.bet_end_date))[0];
  if (!event) continue;
  const line = Number(event.event_extra_data?.open_price);
  watched.push({ name, symbol, line, market: event.markets[0].id, close: Date.parse(event.bet_end_date) });
}
if (watched.length === 0) {
  console.log("no open window");
  process.exit(0);
}
const close = Math.min(...watched.map((w) => w.close));
console.log(`window closing ${new Date(close).toISOString()}; lines ${watched.map((w) => `${w.name} ${w.line}`).join(", ")}`);

const top = (book) =>
  book.err
    ? `err${book.err}`
    : book.ask?.[0]
      ? `${book.ask[0].price}×${Math.round(book.ask[0].total_shares)}(${book.ask.length})`
      : "EMPTY";

while (Date.now() < close + 3_000) {
  const left = ((close - Date.now()) / 1000).toFixed(1).padStart(6);
  const rows = await Promise.all(
    watched.map(async (w) => {
      const [up, down, spot] = await Promise.all([
        sdk.getOrderBook(w.market, { currency_mode: "play_money", position: "long" }).catch((e) => ({ err: e.status })),
        sdk.getOrderBook(w.market, { currency_mode: "play_money", position: "short" }).catch((e) => ({ err: e.status })),
        fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${w.symbol}`)
          .then((r) => r.json())
          .then((j) => Number(j.price))
          .catch(() => NaN),
      ]);
      const gap = ((spot / w.line - 1) * 1e4).toFixed(1);
      return `${w.name} ${gap.padStart(5)}bp up ${top(up).padEnd(14)} dn ${top(down).padEnd(14)} tr ${up.trades_24h ?? "?"}`;
    }),
  );
  console.log(`${left}s | ${rows.join(" | ")}`);
  await new Promise((r) => setTimeout(r, 2_000));
}
