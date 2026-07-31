#!/usr/bin/env node
// Isolates why Futuur answers `authentication_failed`.
//
//   FUTUUR_PUBLIC_KEY=… FUTUUR_PRIVATE_KEY=… node scripts/check-auth.mjs
//
// Nothing is printed except call outcomes — keys never reach stdout.
import { Futuur } from "futuur";

const publicKey = process.env.FUTUUR_PUBLIC_KEY;
const privateKey = process.env.FUTUUR_PRIVATE_KEY;

if (!publicKey || !privateKey) {
  console.error("set FUTUUR_PUBLIC_KEY and FUTUUR_PRIVATE_KEY first");
  process.exit(1);
}

async function attempt(label, run) {
  try {
    const result = await run();
    console.log(`PASS  ${label}`);
    return result;
  } catch (error) {
    const status = error?.response?.status ?? "?";
    const code = error?.response?.data?.errors?.[0]?.code ?? error?.message;
    console.log(`FAIL  ${label}  [${status}] ${code}`);
    return null;
  }
}

// Straight pair, and the reverse — a swapped pair is the usual cause.
const straight = new Futuur({ publicKey, privateKey });
const swapped = new Futuur({ publicKey: privateKey, privateKey: publicKey });

console.log("--- credentials ---");
// `me()` sends no params, so only Key + Timestamp are signed. If this fails the
// pair itself is rejected; if it passes, the problem is param signing.
const me = await attempt("me() with keys as given", () => straight.me());
if (!me) await attempt("me() with keys swapped", () => swapped.me());

if (me) {
  console.log(`      wallet currencies: ${Object.keys(me.wallet ?? {}).join(", ") || "none"}`);
}

console.log("--- param signing ---");
await attempt("listEvents({ limit: 1 })", () => straight.listEvents({ limit: 1 }));
await attempt("listEvents({ tag }) — query 1 of the resolver", () =>
  straight.listEvents({
    tag: "bitcoin-hourly",
    currency_mode: "play_money",
    ordering: "bet_end_date",
    limit: 50,
  }),
);
// A space is the encoding that differs between %20 and + implementations.
await attempt("listEvents({ search: 'bitcoin hourly' }) — space in a param", () =>
  straight.listEvents({
    search: "bitcoin hourly",
    currency_mode: "play_money",
    ordering: "bet_end_date",
    limit: 50,
  }),
);

console.log("--- what the resolver would find ---");
const found = await attempt("listEvents({ search: 'bitcoin' })", () =>
  straight.listEvents({ search: "bitcoin", currency_mode: "play_money", limit: 50 }),
);
for (const event of found?.results ?? []) {
  console.log(
    `      #${event.id} ${event.status} closes=${event.bet_end_date} ${event.slug}` +
      `\n        tags=[${event.tags?.map((t) => t.slug).join(", ")}]` +
      ` categories=[${event.category?.map((c) => `${c.id}:${c.slug}`).join(", ")}]`,
  );
}
