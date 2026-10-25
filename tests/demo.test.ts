import assert from "node:assert/strict";
import test from "node:test";
import { addDemoGoal, createDemoData } from "../web/src/demo";

test("new demo accounts start at zero without goals or transactions", () => {
  const data = createDemoData();
  assert.equal(data.wallet?.balance, "0.00");
  assert.deepEqual(data.goals, []);
  assert.deepEqual(data.activity, []);
  assert.equal(data.user.maxTolerableLoss, "0");
  assert.equal(data.user.targetReturn, "0");
  assert.equal(data.user.timeHorizonMonths, 0);
});

test("demo funding moves exact minor units and creates offsetting liability lines", () => {
  const original = createDemoData();
  assert.ok(original.wallet);
  // Explicit test funding, never the application default.
  original.wallet.balance = "20.00";
  const result = addDemoGoal(original, {
    name: "Test goal", targetAmount: "10000", initialAmount: "10.01", autoSweep: true,
    lockUntil: "2027-01-01T00:00:00Z",
  });
  assert.equal(result.wallet?.balance, "9.99");
  assert.equal(original.wallet?.balance, "20.00");
  assert.equal(result.goals[0]?.balance, "10.01");
  assert.equal(result.goals[0]?.status, "LOCKED");
  assert.equal(result.activity[0]?.side, "DEBIT");
  assert.equal(result.activity[1]?.side, "CREDIT");
  assert.equal(result.activity[0]?.journalEntryId, result.activity[1]?.journalEntryId);
  assert.equal(result.activity[0]?.amount, result.activity[1]?.amount);
});

test("unfunded demo goals do not fabricate ledger activity", () => {
  const original = createDemoData();
  const result = addDemoGoal(original, { name: "Future", targetAmount: "100", initialAmount: "0", autoSweep: false });
  assert.equal(result.wallet?.balance, original.wallet?.balance);
  assert.equal(result.activity.length, original.activity.length);
  assert.equal(result.goals[0]?.balance, "0.00");
});

test("demo goals reject overspending, malformed amounts, and inconsistent dates", () => {
  const input = { name: "Test", targetAmount: "500000", initialAmount: "425000.01", autoSweep: false };
  assert.throws(() => addDemoGoal(createDemoData(), input), /Insufficient wallet/);
  assert.throws(() => addDemoGoal(createDemoData(), { ...input, initialAmount: "1.001" }), /decimal places/);
  assert.throws(() => addDemoGoal(createDemoData(), { ...input, initialAmount: "0", targetAmount: "0" }), /target must be positive/);
  assert.throws(() => addDemoGoal(createDemoData(), {
    ...input, initialAmount: "0", lockUntil: "2027-02-01", endDate: "2027-01-01",
  }), /end date/);
});
