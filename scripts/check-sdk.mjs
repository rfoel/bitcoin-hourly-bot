#!/usr/bin/env node
// Read-only smoke test of every Futuur call the 5-minute bot makes, so an SDK upgrade
// can be checked against the live API before it is deployed. Places nothing.
//
//   FUTUUR_PUBLIC_KEY=… FUTUUR_PRIVATE_KEY=… node scripts/check-sdk.mjs
//
// Keys never reach stdout.
import { Futuur } from "futuur";

const publicKey = process.env.FUTUUR_PUBLIC_KEY;
const privateKey = process.env.FUTUUR_PRIVATE_KEY;
if (!publicKey || !privateKey) {
  console.error("set FUTUUR_PUBLIC_KEY and FUTUUR_PRIVATE_KEY first");
  process.exit(1);
}
const sdk = new Futuur({ publicKey, privateKey, timeout: 15_000 });

let failures = 0;
async function attempt(label, run) {
  const started = Date.now();
  try {
    const result = await run();
    console.log(`PASS  ${label}  (${Date.now() - started}ms)`);
    return result;
  } catch (error) {
    failures++;
    console.log(`FAIL  ${label}  [${error?.status ?? "?"}] ${error?.code ?? error?.message}`);
    return null;
  }
}

const events = await attempt("listEvents bitcoin-5min", () =>
  sdk.listEvents({ categories: [3728], currency_mode: "play_money", ordering: "bet_end_date", limit: 20 }),
);
const open = events?.results.find((e) => e.status === "open" && e.markets?.length);
console.log(`      ${events?.results.length ?? 0} events, open: ${open?.id ?? "none"}`);

if (open) {
  await attempt(`getEvent ${open.id}`, () => sdk.getEvent(open.id));
  const market = open.markets[0];
  for (const position of ["long", "short"]) {
    const book = await attempt(`getOrderBook ${market.id} ${position}`, () =>
      sdk.getOrderBook(market.id, { currency_mode: "play_money", position }),
    );
    if (book) console.log(`      best ask ${book.ask?.[0]?.price ?? "—"} × ${book.ask?.[0]?.total_shares ?? 0}`);
  }
}

const balances = await attempt("balances OOM", () => sdk.balances({ currency: "OOM" }));
if (balances) console.log(`      ${balances.length} balance rows`);

// The bot passes an empty currency_mode here; it must still sign correctly.
const wagers = await attempt('listWagers currency_mode ""', () =>
  sdk.listWagers({ currency_mode: "", limit: 5 }),
);
if (wagers) console.log(`      ${Array.isArray(wagers) ? wagers.length : wagers.results?.length ?? "?"} wagers`);

process.exit(failures ? 1 : 0);
