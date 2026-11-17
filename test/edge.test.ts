import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { fairValue, volatilityFromCloses } from "../src/edge.ts";

describe("fairValue", () => {
  const vol = { sigma: 1e-4, samples: 100 };

  it("is a coin flip on the line", () => {
    const v = fairValue(100, 100, 15, vol);
    assert.equal(v.fair.up, 0.5);
    assert.equal(v.fair.down, 0.5);
  });

  it("favours the side spot is on, more so with less time left", () => {
    const early = fairValue(100.05, 100, 60, vol);
    const late = fairValue(100.05, 100, 5, vol);
    assert.ok(early.fair.up > 0.5);
    assert.ok(late.fair.up > early.fair.up);
    assert.ok(fairValue(99.95, 100, 15, vol).fair.down > 0.5);
  });

  it("is certain at the close or with no volatility", () => {
    assert.equal(fairValue(101, 100, 0, vol).fair.up, 1);
    assert.equal(fairValue(99, 100, 10, { sigma: 0, samples: 0 }).fair.down, 1);
  });

  it("sums to one", () => {
    const v = fairValue(100.02, 100, 12, vol);
    assert.ok(Math.abs(v.fair.up + v.fair.down - 1) < 1e-9);
  });
});

describe("volatilityFromCloses", () => {
  it("is zero for a price that never moves", () => {
    assert.equal(volatilityFromCloses(Array(20).fill(100), 5).sigma, 0);
  });

  it("scales per-interval variance down to per-second", () => {
    // Alternating ±1% moves: the stdev of returns does not depend on the spacing,
    // so the per-second figure must shrink by √spacing.
    const closes = Array.from({ length: 41 }, (_, i) => (i % 2 === 0 ? 100 : 101));
    const per1 = volatilityFromCloses(closes, 1).sigma;
    const per5 = volatilityFromCloses(closes, 5).sigma;
    assert.ok(Math.abs(per1 / per5 - Math.sqrt(5)) < 1e-9);
    assert.equal(volatilityFromCloses(closes, 5).samples, 40);
  });

  it("refuses too few candles", () => {
    assert.throws(() => volatilityFromCloses([1, 2, 3], 1), /usable candles/);
  });
});
