#!/usr/bin/env node
// Shows the direction the spot strategy would bet right now, and dumps the
// event's outcome shape so the long/short mapping can be checked by eye.
//
//   FUTUUR_PUBLIC_KEY=… FUTUUR_PRIVATE_KEY=… node scripts/check-spot.mjs
//
// Read-only: no order is placed.
import { Futuur } from "futuur";

const publicKey = process.env.FUTUUR_PUBLIC_KEY;
const privateKey = process.env.FUTUUR_PRIVATE_KEY;
const CATEGORY = 3702; // bitcoin-hourly

if (!publicKey || !privateKey) {
  console.error("set FUTUUR_PUBLIC_KEY and FUTUUR_PRIVATE_KEY first");
  process.exit(1);
}

const sdk = new Futuur({ publicKey, privateKey });

const { results } = await sdk.listEvents({
  categories: [CATEGORY],
  currency_mode: "play_money",
  ordering: "bet_end_date",
  limit: 50,
});

const event = results
  .filter((e) => e.status === "open" && e.bet_end_date)
  .filter((e) => Date.parse(e.bet_end_date) > Date.now())
  .sort((a, b) => Date.parse(a.bet_end_date) - Date.parse(b.bet_end_date))
  .at(0);

if (!event) {
  console.error(`no open event in category ${CATEGORY}`);
  process.exit(1);
}

console.log(`event  #${event.id} closes ${event.bet_end_date}`);
console.log(`title  ${event.title}`);
console.log(`slug   ${event.slug}`);
console.log(`markets_correlation: ${event.markets_correlation ?? "none"}`);
console.log("--- outcome shape ---");
for (const market of event.markets) {
  console.log(
    `  #${market.id} price=${JSON.stringify(market.price)}\n` +
      `    title="${market.title}"\n` +
      `    long_label=${JSON.stringify(market.long_label)}` +
      ` short_label=${JSON.stringify(market.short_label)}` +
      ` position_labels=${JSON.stringify(market.position_labels)}`,
  );
}

console.log("--- price to beat ---");
const fromTitle = /price to beat\s*\$?\s*([\d,]+(?:\.\d+)?)/i.exec(event.title);
const fromSlug = /price-to-beat-(\d+)/.exec(event.slug);
const priceToBeat = fromTitle
  ? Number(fromTitle[1].replaceAll(",", ""))
  : fromSlug
    ? Number(fromSlug[1]) / 100
    : null;
console.log(`  from title: ${fromTitle ? fromTitle[1] : "no match"}`);
console.log(`  from slug:  ${fromSlug ? Number(fromSlug[1]) / 100 : "no match"}`);

console.log("--- spot quotes ---");
const sources = [
  ["coinbase", "https://api.coinbase.com/v2/prices/BTC-USD/spot", (b) => b.data.amount],
  ["binance", "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT", (b) => b.price],
  ["kraken", "https://api.kraken.com/0/public/Ticker?pair=XBTUSD", (b) => b.result.XXBTZUSD.c[0]],
];

let chosen = null;
for (const [name, url, read] of sources) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const price = Number(read(await response.json()));
    const side = priceToBeat === null ? "?" : price >= priceToBeat ? "up" : "down";
    console.log(`  ${name.padEnd(9)} ${price}  → ${side}`);
    chosen ??= { name, price };
  } catch (error) {
    console.log(`  ${name.padEnd(9)} failed: ${error.message}`);
  }
}

console.log("--- decision ---");
if (chosen && priceToBeat !== null) {
  const direction = chosen.price >= priceToBeat ? "up" : "down";
  const gap = (chosen.price - priceToBeat).toFixed(2);
  console.log(`  ${chosen.name} ${chosen.price} vs ${priceToBeat} (${gap}) → bet ${direction}`);
  console.log(`  sources disagree by tens of dollars, so a gap under ~100 is noise`);
} else {
  console.log("  no decision possible");
}
