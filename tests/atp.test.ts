import assert from "node:assert/strict";
import test from "node:test";
import { calculateFloorProtection, evaluateDrift } from "../src/domain/atp";

test("discounts the maturity floor across the requested horizon", () => {
  const result = calculateFloorProtection(1000, 10, 0.04, 2);
  assert.equal(result.floorValue, 900);
  assert.ok(Math.abs(result.requiredTbills - 833.3333333333333) < 1e-9);
});

test("5 percentage points is not a trigger; a larger drift is", () => {
  const portfolio = {
    totalValue: 1000,
    holdings: [{ assetClass: "T-Bills", marketValue: 500 }, { assetClass: "ETF", marketValue: 500 }],
  };
  assert.equal(evaluateDrift(portfolio, { "T-Bills": 0.55, ETF: 0.45 }).shouldRebalance, false);
  const signal = evaluateDrift(portfolio, { "T-Bills": 0.7, ETF: 0.3 });
  assert.equal(signal.shouldRebalance, true);
  assert.deepEqual(signal.suggestedTrades.map(({ side, amount }) => ({ side, amount })), [
    { side: "BUY", amount: 200 }, { side: "SELL", amount: 200 },
  ]);
});

test("all suggested trades offset when one asset triggers the rebalance", () => {
  const signal = evaluateDrift({
    totalValue: 1000,
    holdings: [{ assetClass: "A", marketValue: 400 }, { assetClass: "B", marketValue: 300 }, { assetClass: "C", marketValue: 300 }],
  }, { A: 0.5, B: 0.25, C: 0.25 });
  const buyTotal = signal.suggestedTrades.filter((trade) => trade.side === "BUY").reduce((sum, trade) => sum + trade.amount, 0);
  const sellTotal = signal.suggestedTrades.filter((trade) => trade.side === "SELL").reduce((sum, trade) => sum + trade.amount, 0);
  assert.equal(signal.suggestedTrades.length, 3);
  assert.ok(Math.abs(buyTotal - sellTotal) < 1e-9);
});

test("rejects invalid risk inputs and inconsistent holdings", () => {
  assert.throws(() => calculateFloorProtection(1000, 101, 0.04), /Maximum loss/);
  assert.throws(() => calculateFloorProtection(1000, 10, 0.04, 0), /Time horizon/);
  assert.throws(() => evaluateDrift({
    totalValue: 1000, holdings: [{ assetClass: "T-Bills", marketValue: 500 }],
  }, { "T-Bills": 1 }), /Holding values must sum/);
});
