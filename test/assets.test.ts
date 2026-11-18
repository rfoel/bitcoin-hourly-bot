import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { assetOf, enabledAssets, TIMEFRAMES } from "../src/assets.ts";

const at = (iso: string) => new Date(iso);
const closing = (iso: string) =>
  TIMEFRAMES.filter((t) => t.closesAt(at(iso))).map((t) => t.key);

describe("assets", () => {
  afterEach(() => {
    delete process.env.FIVEMIN_ASSETS;
    delete process.env.FIVEMIN_TIMEFRAMES;
  });

  it("keeps the 5-minute markets on the keys they had before", () => {
    assert.deepEqual(
      ["btc", "eth", "sol"].map((key) => {
        const a = assetOf(key)!;
        return [a.timeframe.key, a.roundPk, a.ledgerSk];
      }),
      [
        ["5m", "ROUND5", "STATE"],
        ["5m", "ROUND5#ETH", "STATE#ETH"],
        ["5m", "ROUND5#SOL", "STATE#SOL"],
      ],
    );
  });

  it("gives every market its own rounds and ledger", () => {
    const all = enabledAssets();
    assert.equal(all.length, 12);
    assert.equal(new Set(all.map((a) => a.roundPk)).size, 12);
    assert.equal(new Set(all.map((a) => a.ledgerSk)).size, 12);
    assert.equal(new Set(all.map((a) => a.category)).size, 12);
    assert.equal(all[0]!.key, "btc");
    assert.deepEqual(
      [assetOf("eth-1h")!.category, assetOf("sol-1d")!.ledgerSk, assetOf("btc-15m")!.roundPk],
      [3730, "STATE#1D#SOL", "ROUND#15M#BTC"],
    );
  });

  it("plays each timeframe only on the windows it can close in", () => {
    assert.deepEqual(closing("2026-11-18T12:05:00Z"), ["5m"]);
    assert.deepEqual(closing("2026-11-18T12:15:00Z"), ["5m", "15m"]);
    assert.deepEqual(closing("2026-11-18T13:00:00Z"), ["5m", "15m", "1h", "1d"]);
  });

  it("filters by coin and by timeframe", () => {
    process.env.FIVEMIN_ASSETS = "btc";
    process.env.FIVEMIN_TIMEFRAMES = "15m,1d";
    assert.deepEqual(enabledAssets().map((a) => a.key), ["btc-15m", "btc-1d"]);

    process.env.FIVEMIN_TIMEFRAMES = "2h";
    assert.throws(() => enabledAssets(), /FIVEMIN_TIMEFRAMES/);
  });
});
