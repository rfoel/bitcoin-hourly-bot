#!/usr/bin/env node
// Finds the order body shape that Futuur accepts for a market order.
//
//   FUTUUR_PUBLIC_KEY=… FUTUUR_PRIVATE_KEY=… node scripts/check-order.mjs
//
// Stakes 1 OOM (play money) per attempt and stops at the first success, so at
// most one real bet is placed. Variants C and D exist to tell the `futuur` SDK
// author exactly how the server signs a null body param.
import { createHmac } from "node:crypto";
import { Futuur } from "futuur";

const publicKey = process.env.FUTUUR_PUBLIC_KEY;
const privateKey = process.env.FUTUUR_PRIVATE_KEY;
const CATEGORY = 3702; // bitcoin-hourly
const SHARES = 2; // ~1-2 OOM at any realistic price

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

const market = [...event.markets]
  .filter((m) => typeof m.price?.OOM === "number")
  .sort((a, b) => b.price.OOM - a.price.OOM)
  .at(0);

console.log(`event #${event.id} closes ${event.bet_end_date}`);
console.log(`market #${market.id} @ ${market.price.OOM} — ${market.title}`);
console.log("---");

const book = await sdk
  .getOrderBook(market.id, { currency_mode: "play_money", position: "long" })
  .catch(() => null);
const bestAsk = book?.ask?.[0]?.price;
console.log(`best ask ${bestAsk ?? "none"} (bid levels ${book?.bid?.length ?? 0})`);

const base = {
  market: market.id,
  side: "bid",
  position: "long",
  currency: "OOM",
  shares: SHARES,
};

/** Same algorithm as the SDK, but the caller decides how null renders. */
function sign(params, renderNull) {
  const flat = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (value === null) {
      if (renderNull === undefined) continue; // SDK behaviour: drop it
      flat[key] = renderNull;
      continue;
    }
    flat[key] = String(value);
  }
  const paramString = Object.keys(flat)
    .sort()
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(flat[key])}`)
    .join("&");
  return createHmac("sha512", privateKey).update(paramString).digest("hex");
}

async function post(body, renderNull) {
  const timestamp = Math.floor(Date.now() / 1000);
  const response = await fetch("https://api.futuur.com/v2.0/orders/", {
    method: "POST",
    headers: {
      Key: publicKey,
      Timestamp: String(timestamp),
      HMAC: sign({ Key: publicKey, Timestamp: timestamp, ...body }, renderNull),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { ok: response.ok, status: response.status, text: await response.text() };
}

const variants = [
  {
    // What placeBet() now sends when the book has an ask to cross.
    label: `A  shares + limit price ${bestAsk}`,
    run: () => (bestAsk ? sdk.createOrder({ ...base, price: bestAsk }) : null),
  },
  {
    // The fallback when the book is empty: market order, no `price` key.
    label: "B  shares, price key omitted   ",
    run: () => sdk.createOrder(base),
  },
  {
    // Confirms the SDK fix: the server signs a null param as the string "None".
    label: "C  shares + price: null, signed None",
    run: () => post({ ...base, price: null }, "None"),
  },
];

for (const variant of variants) {
  try {
    const result = await variant.run();
    if (result === null) {
      console.log(`SKIP  ${variant.label}  no ask level to cross`);
      continue;
    }
    if (result?.ok === false) {
      console.log(`FAIL  ${variant.label}  [${result.status}] ${result.text.slice(0, 140)}`);
      continue;
    }
    const id = result?.id ?? JSON.parse(result.text).id;
    console.log(`PASS  ${variant.label}  order #${id} — stopping, bet placed`);
    break;
  } catch (error) {
    const status = error?.response?.status ?? "?";
    const code = error?.response?.data?.errors?.[0]?.code ?? error?.message;
    console.log(`FAIL  ${variant.label}  [${status}] ${code}`);
  }
  // The API rejects identical POSTs inside one second.
  await new Promise((resolve) => setTimeout(resolve, 1200));
}
