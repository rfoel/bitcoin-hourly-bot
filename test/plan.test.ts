import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { allocate, planOrder, planSell } from "../src/plan.ts";

const ladder = [
  { price: 0.52, total_shares: 1155 },
  { price: 0.51, total_shares: 577 },
  { price: 0.53, total_shares: 2000 },
];

describe("planOrder", () => {
  it("walks the ladder cheapest first and stops at prob − minEdge", () => {
    const plan = planOrder(ladder, 0.58, 1_000_000, { minEdge: 0.05, kelly: 1 });
    assert.equal(plan.maxPrice, 0.53);
    assert.equal(plan.levels, 3);
    assert.equal(plan.limit, 0.53);
    assert.equal(plan.shares, 577 + 1155 + 2000);
  });

  it("buys nothing when even the best ask is too dear", () => {
    const plan = planOrder(ladder, 0.55, 10_000, { minEdge: 0.05, kelly: 1 });
    assert.equal(plan.shares, 0);
    assert.equal(plan.cost, 0);
    assert.equal(plan.avgPrice, 0);
  });

  it("never stakes more than Kelly on the average price", () => {
    const bankroll = 1_000;
    const prob = 0.8;
    const plan = planOrder(ladder, prob, bankroll, { minEdge: 0.05, kelly: 1 });
    const kelly = (prob - plan.avgPrice) / (1 - plan.avgPrice);
    assert.ok(plan.cost <= bankroll * kelly + 1e-9, `${plan.cost} > ${bankroll * kelly}`);
    assert.ok(plan.cost > 0);
  });

  it("half Kelly stakes about half of full Kelly", () => {
    const full = planOrder(ladder, 0.95, 1_000, { minEdge: 0.05, kelly: 1 });
    const half = planOrder(ladder, 0.95, 1_000, { minEdge: 0.05, kelly: 0.5 });
    assert.ok(Math.abs(half.cost - full.cost / 2) < 1, `${half.cost} vs ${full.cost}`);
  });

  it("does not mutate the ladder it was given", () => {
    const asks = ladder.map((l) => ({ ...l }));
    planOrder(asks, 0.9, 1_000, { minEdge: 0.05, kelly: 1 });
    assert.deepEqual(asks, ladder);
  });

  it("tops up a held position only to the Kelly cap of the whole position", () => {
    const cfg = { minEdge: 0.05, kelly: 0.5 };
    const once = planOrder(ladder, 0.9, 1_000, cfg);
    const firstHalf = planOrder(ladder, 0.9, 1_000 / 2, cfg);
    const topUp = planOrder(ladder, 0.9, 1_000, cfg, { shares: firstHalf.shares, cost: firstHalf.cost });
    assert.ok(topUp.shares > 0);
    const cost = firstHalf.cost + topUp.cost;
    const avg = cost / (firstHalf.shares + topUp.shares);
    const cap = 1_000 * ((0.9 - avg) / (1 - avg)) * cfg.kelly;
    assert.ok(cost <= cap + 1e-9, `${cost} > ${cap}`);
    assert.ok(Math.abs(cost - once.cost) / once.cost < 0.01, `${cost} vs ${once.cost}`);

    // A position already past the cap buys nothing more.
    const over = planOrder(ladder, 0.9, 1_000, cfg, { shares: 1_000, cost: 600 });
    assert.equal(over.shares, 0);
  });
});

describe("planSell", () => {
  const bids = [
    { price: 0.4, total_shares: 100 },
    { price: 0.6, total_shares: 50 },
    { price: 0.5, total_shares: 80 },
  ];

  it("sells highest bids first, only at least minEdge above what the shares are worth", () => {
    const sell = planSell(bids, 0.42, 1_000, { minEdge: 0.05 });
    assert.equal(sell.minPrice, 0.47);
    assert.equal(sell.shares, 130);
    assert.equal(sell.limit, 0.5);
    assert.equal(sell.proceeds, 50 * 0.6 + 80 * 0.5);
  });

  it("never sells more than is held", () => {
    assert.equal(planSell(bids, 0.1, 70, { minEdge: 0.05 }).shares, 70);
  });

  it("holds a side still worth more than the bids pay", () => {
    assert.equal(planSell(bids, 0.9, 1_000, { minEdge: 0.05 }).shares, 0);
  });
});

describe("allocate", () => {
  it("gives each asset its whole bankroll when the wallet covers them all", () => {
    assert.deepEqual(allocate(50_000, [10_000, 12_000, 8_000]), [10_000, 12_000, 8_000]);
  });

  it("splits a short wallet in proportion, never over the wallet", () => {
    const slices = allocate(15_000, [10_000, 10_000, 10_000]);
    assert.deepEqual(slices, [5_000, 5_000, 5_000]);
    const uneven = allocate(1_000, [3_000, 1_000, 0]);
    assert.deepEqual(uneven, [750, 250, 0]);
    assert.ok(uneven.reduce((a, b) => a + b, 0) <= 1_000);
  });

  it("rounds down to the cent, so the slices never sum past the wallet", () => {
    const slices = allocate(100, [1, 1, 1]);
    assert.ok(slices.reduce((a, b) => a + b, 0) <= 100);
  });

  it("gives nothing when there is no wallet or no bankroll", () => {
    assert.deepEqual(allocate(0, [10, 20]), [0, 0]);
    assert.deepEqual(allocate(100, [0, -5]), [0, 0]);
  });
});
