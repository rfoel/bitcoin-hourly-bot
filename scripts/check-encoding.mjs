#!/usr/bin/env node
// A space in a signed param makes Futuur answer 401. This pins down which
// encoding the server signs with, so the fix can go into the `futuur` SDK.
//
//   FUTUUR_PUBLIC_KEY=… FUTUUR_PRIVATE_KEY=… node scripts/check-encoding.mjs
//
// The SDK builds its signature with encodeURIComponent, which renders a space as
// %20. Python's urlencode — the obvious server-side implementation — renders it
// as +. If that is the mismatch, signing with + passes while %20 fails.
import { createHmac } from "node:crypto";

const publicKey = process.env.FUTUUR_PUBLIC_KEY;
const privateKey = process.env.FUTUUR_PRIVATE_KEY;

if (!publicKey || !privateKey) {
  console.error("set FUTUUR_PUBLIC_KEY and FUTUUR_PRIVATE_KEY first");
  process.exit(1);
}

const percent = (value) => encodeURIComponent(value);
const plus = (value) => encodeURIComponent(value).replaceAll("%20", "+");

function sign(params, encode) {
  const paramString = Object.keys(params)
    .sort()
    .map((key) => `${encode(key)}=${encode(String(params[key]))}`)
    .join("&");
  return createHmac("sha512", privateKey).update(paramString).digest("hex");
}

async function attempt(label, { signWith, sendWith }) {
  const timestamp = Math.floor(Date.now() / 1000);
  const params = { Key: publicKey, Timestamp: timestamp, search: "bitcoin hourly", limit: 1 };

  const query = Object.keys(params)
    .filter((key) => key !== "Key" && key !== "Timestamp")
    .map((key) => `${sendWith(key)}=${sendWith(String(params[key]))}`)
    .join("&");

  const response = await fetch(`https://api.futuur.com/v2.0/events/?${query}`, {
    headers: {
      Key: publicKey,
      Timestamp: String(timestamp),
      HMAC: sign(params, signWith),
      "Content-Type": "application/json",
    },
  });

  const body = await response.text();
  const code = response.ok ? "" : ` ${body.slice(0, 160)}`;
  console.log(`${response.ok ? "PASS" : "FAIL"}  ${label}  [${response.status}]${code}`);
}

// Current SDK behaviour — the one that fails.
await attempt("sign %20, send %20", { signWith: percent, sendWith: percent });
// Server signs with + and the query also uses +.
await attempt("sign +,   send +  ", { signWith: plus, sendWith: plus });
// Server signs with + but the wire stays properly percent-encoded. If this passes,
// only the signature builder needs changing — the query serializer is fine.
await attempt("sign +,   send %20", { signWith: plus, sendWith: percent });
