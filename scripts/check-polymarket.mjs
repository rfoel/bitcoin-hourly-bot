#!/usr/bin/env node
// Reads Polymarket's hourly Bitcoin market for the next few hour boundaries and prints
// the quote the agent's briefing would carry, including the line check against the
// Binance hourly open that the two venues have to share to be the same question.
//
//   node scripts/check-polymarket.mjs            # the current hour and the next two
//   node scripts/check-polymarket.mjs 63764      # also check a known price to beat
//
// Read-only, no keys needed: Polymarket's gamma and CLOB reads are public.
import { polymarketQuote, slugForHourEnding, binanceHourOpen } from "../src/polymarket.ts";

const priceToBeat = process.argv[2] === undefined ? undefined : Number(process.argv[2]);
const hour = Math.ceil(Date.now() / 3_600_000) * 3_600_000;

for (let i = 0; i < 3; i++) {
  const close = hour + i * 3_600_000;
  const label = `${new Date(close).toISOString()} (${slugForHourEnding(close)})`;

  // The real price to beat only belongs to the hour actually open, so later hours are
  // checked against the Binance open alone.
  const line = i === 0 ? priceToBeat : undefined;
  const quote = await polymarketQuote(close, line);

  if (quote === null) {
    console.log(`${label}\n  no quote\n`);
    continue;
  }

  const sides = quote.sides
    .map((s) => `${s.direction} ${fmt(s.bid)}/${fmt(s.ask)}`)
    .join("  ");

  console.log(label);
  console.log(`  ${sides}  →  up ${fmt(quote.up)}`);
  console.log(
    `  $${Math.round(quote.volume).toLocaleString("en-US")} traded (${quote.volumeVersusTypical.toFixed(2)}x a` +
      ` typical hour), $${Math.round(quote.liquidity).toLocaleString("en-US")} quoted`,
  );
  if (quote.strike) {
    console.log(
      `  line: binance ${quote.strike.binanceOpen} vs futuur ${quote.strike.futuurPriceToBeat}` +
        ` — ${quote.strike.difference} apart, ${quote.strike.aligned ? "ALIGNED" : "MISMATCHED"}`,
    );
  } else if (i === 0) {
    const open = await binanceHourOpen(close).catch(() => null);
    console.log(`  binance hourly open ${open ?? "unavailable"} (pass a price to beat to compare)`);
  }
  console.log();
}

function fmt(value) {
  return value === null || value === undefined ? "—" : value.toFixed(2);
}
