import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { CircuitBreaker } from "../adapters/circuit-breaker";
import { requestHash } from "../domain/request-hash";
import { partners, PartnerGateway, SecFundManagerGateway, YouVerifyGateway } from "../adapters";
import { z } from "zod";
import { encryptPii, decryptPii } from "../services/pii.service";
import { moneyAmount } from "../domain/money";

test("circuit opens after three failures and probes after cooldown", async () => {
  const breaker = new CircuitBreaker("test", 5);
  let calls = 0;
  const fail = () => breaker.execute(async () => { calls++; throw new Error("upstream"); });
  for (let i = 0; i < 3; i++) await assert.rejects(fail());
  await assert.rejects(fail(), /temporarily unavailable/);
  assert.equal(calls, 3);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(await breaker.execute(async () => "recovered"), "recovered");
});

test("late in-flight successes cannot close an opened circuit", async () => {
  const breaker = new CircuitBreaker("concurrent-test", 60_000);
  let finish: (value: string) => void = () => { throw new Error("Deferred call not initialized"); };
  const pending = breaker.execute(() => new Promise<string>((resolve) => { finish = resolve; }));
  for (let i = 0; i < 3; i++) await assert.rejects(breaker.execute(async () => { throw new Error("failed"); }));
  finish("late success");
  assert.equal(await pending, "late success");
  await assert.rejects(breaker.execute(async () => "must not run"), /temporarily unavailable/);
});

test("only one half-open probe runs and failed probes reopen the circuit", async () => {
  const breaker = new CircuitBreaker("probe-test", 5);
  for (let i = 0; i < 3; i++) await assert.rejects(breaker.execute(async () => { throw new Error("failed"); }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  let finish: (value: string) => void = () => { throw new Error("Probe not initialized"); };
  const probe = breaker.execute(() => new Promise<string>((resolve) => { finish = resolve; }));
  await assert.rejects(breaker.execute(async () => "second probe"), /temporarily unavailable/);
  finish("recovered");
  assert.equal(await probe, "recovered");
  assert.equal(await breaker.execute(async () => "healthy"), "healthy");
  for (let i = 0; i < 3; i++) await assert.rejects(breaker.execute(async () => { throw new Error("failed"); }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  await assert.rejects(breaker.execute(async () => { throw new Error("failed probe"); }), /failed probe/);
  await assert.rejects(breaker.execute(async () => "must not run"), /temporarily unavailable/);
});

test("malformed gateway JSON counts toward the circuit and never exposes response content", async (context) => {
  let calls = 0;
  context.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response("private upstream error", { status: 200 });
  });
  const gateway = new PartnerGateway("test-partner", "https://gateway.invalid", "test-key");
  for (let i = 0; i < 3; i++) {
    await assert.rejects(gateway.post("key", {}, z.object({ accepted: z.literal(true) })), /returned invalid JSON/);
  }
  await assert.rejects(gateway.post("key", {}, z.object({ accepted: z.literal(true) })), /temporarily unavailable/);
  assert.equal(calls, 3);
});

test("invalid fund executions trip the breaker rather than reporting success", async (context) => {
  let calls = 0;
  context.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json([{ id: "order", amount: "10.00", nav: "Infinity", units: "0.1", simulated: false }]);
  });
  const adapter = new SecFundManagerGateway(new PartnerGateway("fund-test", "https://gateway.invalid", "test-key"));
  for (let i = 0; i < 3; i++) await assert.rejects(
    adapter.placeBatch("batch", [{ id: "order", amount: "10.00", asset: "T-Bills" }]), /certified gateway contract/);
  await assert.rejects(adapter.placeBatch("batch", [{ id: "order", amount: "10.00", asset: "T-Bills" }]), /temporarily unavailable/);
  assert.equal(calls, 3);
});

test("KYC result must identify the submitted verification request", async (context) => {
  context.mock.method(globalThis, "fetch", async () => Response.json({
    reference: "wrong-request", status: "VERIFIED", simulated: false,
  }));
  const adapter = new YouVerifyGateway(new PartnerGateway("kyc-test", "https://gateway.invalid", "test-key"));
  await assert.rejects(adapter.verify({ reference: "expected-request", userId: "user" }), /certified gateway contract/);
});

test("idempotency request hash ignores object key order but not payload changes", () => {
  assert.equal(requestHash({ b: "2", a: "1" }), requestHash({ a: "1", b: "2" }));
  assert.notEqual(requestHash({ amount: "100.00" }), requestHash({ amount: "101.00" }));
});

test("production cannot construct mock partners when live credentials are missing", () => {
  const previousEnv = process.env.NODE_ENV;
  const previousUrl = process.env.KYC_GATEWAY_URL;
  const previousKey = process.env.KYC_API_KEY;
  try {
    process.env.NODE_ENV = "production";
    delete process.env.KYC_GATEWAY_URL;
    delete process.env.KYC_API_KEY;
    assert.throws(() => partners(), /required in production/);
  } finally {
    if (previousEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousEnv;
    if (previousUrl === undefined) delete process.env.KYC_GATEWAY_URL; else process.env.KYC_GATEWAY_URL = previousUrl;
    if (previousKey === undefined) delete process.env.KYC_API_KEY; else process.env.KYC_API_KEY = previousKey;
  }
});

test("PII encryption is randomized, round-trips and rejects tampering", () => {
  const previousKey = process.env.PII_ENCRYPTION_KEY;
  try {
    process.env.PII_ENCRYPTION_KEY = "b".repeat(64);
    const first = encryptPii("test@example.com");
    assert.notEqual(first, encryptPii("test@example.com"));
    assert.equal(decryptPii(first), "test@example.com");
    const parts = first.split(".");
    parts[2] = Buffer.from("tampered").toString("base64");
    assert.throws(() => decryptPii(parts.join(".")));
  } finally {
    if (previousKey === undefined) delete process.env.PII_ENCRYPTION_KEY; else process.env.PII_ENCRYPTION_KEY = previousKey;
  }
});

test("currency parsing rejects fractional kobo and preserves large balances", () => {
  assert.equal(moneyAmount("999999999999999999.99").plus("0.01").toFixed(2), "1000000000000000000.00");
  assert.throws(() => moneyAmount("0.001"), /Amounts must be/);
  assert.throws(() => moneyAmount("NaN"), /Amounts must be/);
  assert.throws(() => moneyAmount("0"), /positive/);
});

test("PostgreSQL financial, replay, reconciliation and MFA integration cases", {
  skip: process.env.RUN_DB_TESTS !== "true",
}, async (suite) => {
  const url = new URL(process.env.DATABASE_URL ?? "");
  assert.ok(url.pathname.endsWith("_hardening_test"), "Use only a disposable *_hardening_test database");
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = "integration-test-jwt-secret-32-bytes-only";
  process.env.PII_ENCRYPTION_KEY = "a".repeat(64);
  process.env.BAAS_WEBHOOK_SECRET = "integration-test-webhook-secret-32-bytes";
  process.env.KYC_WEBHOOK_SECRET = "integration-test-kyc-webhook-secret-32-bytes";
  for (const prefix of ["KYC", "BAAS", "SMS", "FUND"]) {
    delete process.env[`${prefix}_API_KEY`];
    delete process.env[`${prefix}_GATEWAY_URL`];
  }
  const { prisma } = await import("../config/prisma");
  const { serializable } = await import("../services/transaction.service");
  const { createJournalEntry, createDepositJournal, createWithdrawalJournal, accrueGoalInterest } = await import("../services/ledger.service");
  const { processNextJob } = await import("../services/jobs.service");
  const { decryptPii } = await import("../services/pii.service");
  const { app } = await import("../app");
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const device = randomUUID();
  let token = "";
  let userId = "";
  let accountId = "";
  async function call(path: string, body?: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(`${base}/api/v1${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", "x-device-id": device,
        ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  }
  try {
    await suite.test("registration responds, is replay-safe and queues partner work atomically", async () => {
      const body = {
        email: `hardening-${randomUUID()}@example.com`, password: "test-password-1234",
        firstName: "Integration", lastName: "Test", phoneNumber: "+2348012345678", bvn: "00000000000",
      };
      const key = randomUUID();
      const first = await call("/auth/register", body, { "idempotency-key": key });
      assert.equal(first.status, 201, JSON.stringify(first.body));
      const second = await call("/auth/register", body, { "idempotency-key": key });
      assert.deepEqual(second.body, first.body);
      userId = first.body.data.userId;
      const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
      assert.equal(user.phoneNumber, null);
      assert.ok(user.phoneEncrypted && !user.phoneEncrypted.includes(body.phoneNumber));
      assert.ok(!user.email.includes("@"));
      assert.equal(decryptPii(user.email), body.email);
      assert.equal(decryptPii(user.firstName), "Integration");
      const login = await call("/auth/login", { email: body.email, password: body.password });
      assert.equal(login.status, 200, JSON.stringify(login.body));
      assert.equal(login.body.data.mfaRequired, true);
      assert.equal(login.body.data.accessToken, undefined);
      const challengeId = login.body.data.challengeId;
      const job = await prisma.outboxJob.findUniqueOrThrow({ where: { uniqueKey: `otp:${challengeId}` } });
      const payload = job.payload;
      assert.ok(payload && typeof payload === "object" && !Array.isArray(payload) && typeof payload.encryptedCode === "string");
      const code = decryptPii(payload.encryptedCode);
      const wrong = await call("/auth/verify-otp", { challengeId, code: code === "111111" ? "222222" : "111111" });
      assert.equal(wrong.status, 401);
      assert.equal((await prisma.authChallenge.findUniqueOrThrow({ where: { id: challengeId } })).attempts, 1);
      const verified = await call("/auth/verify-otp", { challengeId, code });
      assert.equal(verified.status, 200, JSON.stringify(verified.body));
      token = verified.body.data.accessToken;
      assert.equal((await call("/auth/verify-otp", { challengeId, code })).status, 401);
      assert.equal((await call("/dashboard")).status, 200);
      assert.equal((await call("/dashboard", undefined, { "x-device-id": randomUUID() })).status, 401);
      for (let i = 0; i < 10 && await processNextJob(); i++) { /* drain the finite fixture onboarding jobs */ }
      assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).kycStatus, "VERIFIED");
      const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId }, include: { ledgerAccount: true } });
      assert.match(wallet.virtualAccountNumber ?? "", /^MOCK-/);
      assert.ok(wallet.ledgerAccount);
      accountId = wallet.ledgerAccount.id;
      await serializable((tx) => createDepositJournal(tx, accountId, "100.00", randomUUID(), randomUUID()));
    });
    await suite.test("simultaneous withdrawals cannot double-spend", async () => {
      const results = await Promise.allSettled([1, 2].map(() => serializable((tx) =>
        createWithdrawalJournal(tx, accountId, "80.00", randomUUID(), randomUUID()))));
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      const rejected = results.find((result) => result.status === "rejected");
      assert.ok(rejected?.status === "rejected" && rejected.reason.code === "INSUFFICIENT_LEDGER_BALANCE");
      assert.equal((await prisma.ledgerAccount.findUniqueOrThrow({ where: { id: accountId } })).balance.toFixed(2), "20.00");
    });
    await suite.test("market endpoints validate queries and report unconfigured feeds without creating transactions", async () => {
      const keys = ["NGX_API_TOKEN", "FMDQ_MARKET_GATEWAY_URL", "FMDQ_MARKET_API_KEY"];
      const previous = keys.map((key) => [key, process.env[key]] as const);
      for (const key of keys) delete process.env[key];
      const count = await prisma.journalEntry.count();
      try {
        assert.equal((await call("/markets/instruments?provider=UNKNOWN")).status, 400);
        assert.equal((await call("/markets/history?provider=NGX&symbol=TEST&range=BAD")).status, 400);
        for (const provider of ["NGX", "FMDQ"]) {
          const result = await call(`/markets/instruments?provider=${provider}`);
          assert.equal(result.status, 503);
          assert.equal(result.body.error.code, "MARKET_DATA_NOT_CONFIGURED");
        }
        assert.equal(await prisma.journalEntry.count(), count);
      } finally {
        for (const [key, value] of previous) {
          if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
      }
    });
    await suite.test("unbalanced journal rejects atomically and SQL constraints reject bypasses", async () => {
      const settlement = await prisma.ledgerAccount.findUniqueOrThrow({ where: { code: "BAAS_SETTLEMENT_ASSET" } });
      const count = await prisma.journalEntry.count();
      await assert.rejects(createJournalEntry([
        { ledgerAccountId: settlement.id, side: "DEBIT", amount: "10.01" },
        { ledgerAccountId: accountId, side: "CREDIT", amount: "10.00" },
      ], { description: "Unbalanced test" }), /Total debits/);
      assert.equal(await prisma.journalEntry.count(), count);
      await assert.rejects(prisma.journalEntry.create({ data: { description: "Orphan test" } }));
      await assert.rejects(prisma.ledgerAccount.update({ where: { id: accountId }, data: { balance: "100000" } }));
      assert.equal((await prisma.ledgerAccount.findUniqueOrThrow({ where: { id: accountId } })).balance.toFixed(2), "20.00");
    });
    await suite.test("signed webhooks dedupe and reconcile exactly once including during kill switch", async () => {
      const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId } });
      const body = {
        eventId: randomUUID(), eventType: "DEPOSIT", amount: "5.01", currency: "NGN",
        reference: randomUUID(), virtualAccountNumber: wallet.virtualAccountNumber, occurredAt: new Date().toISOString(),
      };
      const signature = createHmac("sha256", process.env.BAAS_WEBHOOK_SECRET!).update(JSON.stringify(body)).digest("hex");
      const headers = { "x-baas-signature": signature };
      assert.equal((await call("/webhooks/baas", body, { "x-baas-signature": "0".repeat(64) })).status, 401);
      const first = await call("/webhooks/baas", body, headers);
      assert.equal(first.status, 202, JSON.stringify(first.body));
      assert.equal((await call("/webhooks/baas", body, headers)).body.data.duplicate, true);
      const changed = { ...body, amount: "6.00" };
      const changedSignature = createHmac("sha256", process.env.BAAS_WEBHOOK_SECRET!).update(JSON.stringify(changed)).digest("hex");
      assert.equal((await call("/webhooks/baas", changed, { "x-baas-signature": changedSignature })).status, 409);
      await prisma.systemControl.update({ where: { id: "global" }, data: { readOnly: true } });
      await processNextJob();
      assert.equal((await prisma.ledgerAccount.findUniqueOrThrow({ where: { id: accountId } })).balance.toFixed(2), "20.00");
      assert.equal((await call("/dashboard")).status, 200);
      await prisma.systemControl.update({ where: { id: "global" }, data: { readOnly: false } });
      await prisma.outboxJob.updateMany({ where: { completedAt: null }, data: { availableAt: new Date(0) } });
      for (let i = 0; i < 10 && await processNextJob(); i++) { /* finite webhook/alert jobs */ }
      assert.equal((await prisma.ledgerAccount.findUniqueOrThrow({ where: { id: accountId } })).balance.toFixed(2), "25.01");
      assert.equal(await prisma.journalEntry.count({ where: { idempotencyKey: `baas:${body.eventId}` } }), 1);
    });
    await suite.test("mutating requests require a key, replay responses, and reject key/body conflicts", async () => {
      const body = { name: "Atomic goal", targetAmount: "20", initialAmount: "5.01" };
      assert.equal((await call("/savings/goals", body)).status, 400);
      const headers = { "idempotency-key": randomUUID() };
      const first = await call("/savings/goals", body, headers);
      assert.equal(first.status, 201, JSON.stringify(first.body));
      assert.deepEqual((await call("/savings/goals", body, headers)).body, first.body);
      assert.equal((await call("/savings/goals", { ...body, initialAmount: "6" }, headers)).status, 409);
      assert.equal((await prisma.ledgerAccount.findUniqueOrThrow({ where: { id: accountId } })).balance.toFixed(2), "20.00");
    });
    await suite.test("locked goal debits obey the database UTC clock", async () => {
      const result = await call("/savings/goals", {
        name: "Locked goal", targetAmount: "10", initialAmount: "1",
        lockUntil: new Date(Date.now() + 86400000).toISOString(),
      }, { "idempotency-key": randomUUID() });
      assert.equal(result.status, 201);
      const goalAccount = await prisma.ledgerAccount.findUniqueOrThrow({ where: { savingsGoalId: result.body.data.goal.id } });
      await assert.rejects(createJournalEntry([
        { ledgerAccountId: goalAccount.id, side: "DEBIT", amount: "1.00" },
        { ledgerAccountId: accountId, side: "CREDIT", amount: "1.00" },
      ], { description: "Premature release" }), /before the database lock expiry/);
    });
    await suite.test("concurrent interest retries post one journal and increment yield only once", async () => {
      const result = await call("/savings/goals", { name: "Accrual test", targetAmount: "100", initialAmount: "0" },
        { "idempotency-key": randomUUID() });
      assert.equal(result.status, 201);
      const goalId = result.body.data.goal.id;
      const key = `interest:${randomUUID()}`;
      const results = await Promise.all([
        accrueGoalInterest(prisma, goalId, "1.01", key),
        accrueGoalInterest(prisma, goalId, "1.01", key),
      ]);
      assert.equal(results[0]?.id, results[1]?.id);
      assert.equal((await prisma.savingsGoal.findUniqueOrThrow({ where: { id: goalId } })).yieldAccrued.toFixed(2), "1.01");
      const goalAccount = await prisma.ledgerAccount.findUniqueOrThrow({ where: { savingsGoalId: goalId } });
      assert.equal(goalAccount.balance.toFixed(2), "1.01");
      await assert.rejects(accrueGoalInterest(prisma, goalId, "1.02", key), /reused for different entries/);
    });
    await suite.test("missing kill switch state fails closed instead of enabling money movement", async () => {
      await prisma.systemControl.delete({ where: { id: "global" } });
      try {
        await assert.rejects(serializable((tx) => createDepositJournal(tx, accountId, "1.00", randomUUID(), randomUUID())),
          /system control is restored/);
        assert.equal((await call("/dashboard")).status, 200);
      } finally {
        await prisma.systemControl.create({ data: { id: "global", readOnly: false } });
      }
    });
    await suite.test("inactive wallets reject direct ledger deposits and withdrawals", async () => {
      await prisma.wallet.update({ where: { userId }, data: { status: "SUSPENDED" } });
      const before = (await prisma.ledgerAccount.findUniqueOrThrow({ where: { id: accountId } })).balance.toFixed(2);
      try {
        await assert.rejects(serializable((tx) => createDepositJournal(tx, accountId, "1.00", randomUUID(), randomUUID())), /active wallets/);
        await assert.rejects(serializable((tx) => createWithdrawalJournal(tx, accountId, "1.00", randomUUID(), randomUUID())), /active wallets/);
        assert.equal((await prisma.ledgerAccount.findUniqueOrThrow({ where: { id: accountId } })).balance.toFixed(2), before);
      } finally {
        await prisma.wallet.update({ where: { userId }, data: { status: "ACTIVE" } });
      }
    });
    await suite.test("database kill switch rejects money movement, permits reads and logout revokes sessions", async () => {
      await prisma.systemControl.update({ where: { id: "global" }, data: { readOnly: true } });
      assert.equal((await call("/dashboard")).status, 200);
      const blocked = await call("/savings/goals", { name: "Blocked", targetAmount: "10", initialAmount: "1" }, { "idempotency-key": randomUUID() });
      assert.equal(blocked.status, 503);
      assert.equal(blocked.body.error.code, "SYSTEM_READ_ONLY");
      await prisma.systemControl.update({ where: { id: "global" }, data: { readOnly: false } });
      assert.equal((await call("/auth/logout", {})).status, 200);
      assert.equal((await call("/dashboard")).status, 401);
    });
    await suite.test("OTP expires by database clock and locks after five incorrect attempts", async () => {
      const { completeChallenge, secureHash } = await import("../services/session.service");
      const fingerprint = "test-fingerprint";
      const expiredId = randomUUID();
      await prisma.authChallenge.create({ data: {
        id: expiredId, userId, deviceHash: fingerprint, codeHash: secureHash(`${expiredId}:123456`),
        expiresAt: new Date(0),
      } });
      await assert.rejects(completeChallenge(expiredId, "123456", fingerprint), { code: "INVALID_OTP" });
      const lockedId = randomUUID();
      await prisma.authChallenge.create({ data: {
        id: lockedId, userId, deviceHash: fingerprint, codeHash: secureHash(`${lockedId}:123456`),
        expiresAt: new Date(Date.now() + 300000),
      } });
      for (let attempt = 0; attempt < 5; attempt++) await assert.rejects(completeChallenge(lockedId, "999999", fingerprint));
      await assert.rejects(completeChallenge(lockedId, "123456", fingerprint));
      assert.equal((await prisma.authChallenge.findUniqueOrThrow({ where: { id: lockedId } })).attempts, 5);
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await prisma.$disconnect();
  }
});
