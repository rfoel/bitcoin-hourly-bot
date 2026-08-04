#!/usr/bin/env node
// Runs the note compactor against the live notebook without writing anything, so the
// rewrite can be read before it is trusted. Prints the proposed set, or the reason the
// validation refused it.
//
//   pnpm sst shell --stage production -- pnpm dlx tsx scripts/check-compaction.mjs
//   COMPACT_THRESHOLD=5 pnpm sst shell --stage production -- pnpm dlx tsx scripts/check-compaction.mjs
//
// The threshold override is there because the compactor no-ops on a short notebook, and
// a dry run is worth having before the notebook is long enough to trigger one.
process.env.COMPACT_DRY_RUN = "true";

const { handler } = await import("../src/compact.ts");
const result = await handler();

console.log("\n---");
console.log(JSON.stringify(result, null, 2));
