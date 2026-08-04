#!/usr/bin/env node
// Prints the opening briefing the agent would be handed right now, for the hourly event
// that is actually open. This is the fastest way to see the Polymarket comparison and
// its line check against real Futuur data without spending a run.
//
//   FUTUUR_PUBLIC_KEY=… FUTUUR_PRIVATE_KEY=… pnpm dlx tsx scripts/check-brief.mjs
//
// It needs tsx rather than node: agent.ts imports its siblings as `.js`, which Node's
// own type stripping will not resolve back to the `.ts` files on disk.
//
// Read-only: it resolves the event and reads books, but places nothing.
import { brief } from "../src/agent.ts";
import { resolveEvent } from "../src/bet.ts";

const currency = process.env.FUTUUR_CURRENCY ?? "OOM";
const event = await resolveEvent(currency);

console.log(`Event #${event.id}: ${event.title}`);
console.log(`Closes ${event.bet_end_date}\n`);
console.log(await brief(event, currency));
