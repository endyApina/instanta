"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_crypto_1 = require("node:crypto");
const node_events_1 = require("node:events");
const node_test_1 = __importDefault(require("node:test"));
const circuit_breaker_1 = require("../adapters/circuit-breaker");
const request_hash_1 = require("../domain/request-hash");
const adapters_1 = require("../adapters");
const zod_1 = require("zod");
const pii_service_1 = require("../services/pii.service");
const money_1 = require("../domain/money");
(0, node_test_1.default)("circuit opens after three failures and probes after cooldown", async () => {
    const breaker = new circuit_breaker_1.CircuitBreaker("test", 5);
    let calls = 0;
    const fail = () => breaker.execute(async () => { calls++; throw new Error("upstream"); });
    for (let i = 0; i < 3; i++)
        await strict_1.default.rejects(fail());
    await strict_1.default.rejects(fail(), /temporarily unavailable/);
    strict_1.default.equal(calls, 3);
    await new Promise((resolve) => setTimeout(resolve, 10));
    strict_1.default.equal(await breaker.execute(async () => "recovered"), "recovered");
});
(0, node_test_1.default)("late in-flight successes cannot close an opened circuit", async () => {
    const breaker = new circuit_breaker_1.CircuitBreaker("concurrent-test", 60_000);
    let finish = () => { throw new Error("Deferred call not initialized"); };
    const pending = breaker.execute(() => new Promise((resolve) => { finish = resolve; }));
    for (let i = 0; i < 3; i++)
        await strict_1.default.rejects(breaker.execute(async () => { throw new Error("failed"); }));
    finish("late success");
    strict_1.default.equal(await pending, "late success");
    await strict_1.default.rejects(breaker.execute(async () => "must not run"), /temporarily unavailable/);
});
(0, node_test_1.default)("only one half-open probe runs and failed probes reopen the circuit", async () => {
    const breaker = new circuit_breaker_1.CircuitBreaker("probe-test", 5);
    for (let i = 0; i < 3; i++)
        await strict_1.default.rejects(breaker.execute(async () => { throw new Error("failed"); }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    let finish = () => { throw new Error("Probe not initialized"); };
    const probe = breaker.execute(() => new Promise((resolve) => { finish = resolve; }));
    await strict_1.default.rejects(breaker.execute(async () => "second probe"), /temporarily unavailable/);
    finish("recovered");
    strict_1.default.equal(await probe, "recovered");
    strict_1.default.equal(await breaker.execute(async () => "healthy"), "healthy");
    for (let i = 0; i < 3; i++)
        await strict_1.default.rejects(breaker.execute(async () => { throw new Error("failed"); }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    await strict_1.default.rejects(breaker.execute(async () => { throw new Error("failed probe"); }), /failed probe/);
    await strict_1.default.rejects(breaker.execute(async () => "must not run"), /temporarily unavailable/);
});
(0, node_test_1.default)("malformed gateway JSON counts toward the circuit and never exposes response content", async (context) => {
    let calls = 0;
    context.mock.method(globalThis, "fetch", async () => {
        calls++;
        return new Response("private upstream error", { status: 200 });
    });
    const gateway = new adapters_1.PartnerGateway("test-partner", "https://gateway.invalid", "test-key");
    for (let i = 0; i < 3; i++) {
        await strict_1.default.rejects(gateway.post("key", {}, zod_1.z.object({ accepted: zod_1.z.literal(true) })), /returned invalid JSON/);
    }
    await strict_1.default.rejects(gateway.post("key", {}, zod_1.z.object({ accepted: zod_1.z.literal(true) })), /temporarily unavailable/);
    strict_1.default.equal(calls, 3);
});
(0, node_test_1.default)("invalid fund executions trip the breaker rather than reporting success", async (context) => {
    let calls = 0;
    context.mock.method(globalThis, "fetch", async () => {
        calls++;
        return Response.json([{ id: "order", amount: "10.00", nav: "Infinity", units: "0.1", simulated: false }]);
    });
    const adapter = new adapters_1.SecFundManagerGateway(new adapters_1.PartnerGateway("fund-test", "https://gateway.invalid", "test-key"));
    for (let i = 0; i < 3; i++)
        await strict_1.default.rejects(adapter.placeBatch("batch", [{ id: "order", amount: "10.00", asset: "T-Bills" }]), /certified gateway contract/);
    await strict_1.default.rejects(adapter.placeBatch("batch", [{ id: "order", amount: "10.00", asset: "T-Bills" }]), /temporarily unavailable/);
    strict_1.default.equal(calls, 3);
});
(0, node_test_1.default)("KYC result must identify the submitted verification request", async (context) => {
    context.mock.method(globalThis, "fetch", async () => Response.json({
        reference: "wrong-request", status: "VERIFIED", simulated: false,
    }));
    const adapter = new adapters_1.YouVerifyGateway(new adapters_1.PartnerGateway("kyc-test", "https://gateway.invalid", "test-key"));
    await strict_1.default.rejects(adapter.verify({ reference: "expected-request", userId: "user" }), /certified gateway contract/);
});
(0, node_test_1.default)("idempotency request hash ignores object key order but not payload changes", () => {
    strict_1.default.equal((0, request_hash_1.requestHash)({ b: "2", a: "1" }), (0, request_hash_1.requestHash)({ a: "1", b: "2" }));
    strict_1.default.notEqual((0, request_hash_1.requestHash)({ amount: "100.00" }), (0, request_hash_1.requestHash)({ amount: "101.00" }));
});
(0, node_test_1.default)("production cannot construct mock partners when live credentials are missing", () => {
    const previousEnv = process.env.NODE_ENV;
    const previousUrl = process.env.KYC_GATEWAY_URL;
    const previousKey = process.env.KYC_API_KEY;
    try {
        process.env.NODE_ENV = "production";
        delete process.env.KYC_GATEWAY_URL;
        delete process.env.KYC_API_KEY;
        strict_1.default.throws(() => (0, adapters_1.partners)(), /required in production/);
    }
    finally {
        if (previousEnv === undefined)
            delete process.env.NODE_ENV;
        else
            process.env.NODE_ENV = previousEnv;
        if (previousUrl === undefined)
            delete process.env.KYC_GATEWAY_URL;
        else
            process.env.KYC_GATEWAY_URL = previousUrl;
        if (previousKey === undefined)
            delete process.env.KYC_API_KEY;
        else
            process.env.KYC_API_KEY = previousKey;
    }
});
(0, node_test_1.default)("PII encryption is randomized, round-trips and rejects tampering", () => {
    const previousKey = process.env.PII_ENCRYPTION_KEY;
    try {
        process.env.PII_ENCRYPTION_KEY = "b".repeat(64);
        const first = (0, pii_service_1.encryptPii)("test@example.com");
        strict_1.default.notEqual(first, (0, pii_service_1.encryptPii)("test@example.com"));
        strict_1.default.equal((0, pii_service_1.decryptPii)(first), "test@example.com");
        const parts = first.split(".");
        parts[2] = Buffer.from("tampered").toString("base64");
        strict_1.default.throws(() => (0, pii_service_1.decryptPii)(parts.join(".")));
    }
    finally {
        if (previousKey === undefined)
            delete process.env.PII_ENCRYPTION_KEY;
        else
            process.env.PII_ENCRYPTION_KEY = previousKey;
    }
});
(0, node_test_1.default)("currency parsing rejects fractional kobo and preserves large balances", () => {
    strict_1.default.equal((0, money_1.moneyAmount)("999999999999999999.99").plus("0.01").toFixed(2), "1000000000000000000.00");
    strict_1.default.throws(() => (0, money_1.moneyAmount)("0.001"), /Amounts must be/);
    strict_1.default.throws(() => (0, money_1.moneyAmount)("NaN"), /Amounts must be/);
    strict_1.default.throws(() => (0, money_1.moneyAmount)("0"), /positive/);
});
(0, node_test_1.default)("PostgreSQL financial, replay, reconciliation and MFA integration cases", {
    skip: process.env.RUN_DB_TESTS !== "true",
}, async (suite) => {
    const url = new URL(process.env.DATABASE_URL ?? "");
    strict_1.default.ok(url.pathname.endsWith("_hardening_test"), "Use only a disposable *_hardening_test database");
    process.env.NODE_ENV = "test";
    process.env.JWT_SECRET = "integration-test-jwt-secret-32-bytes-only";
    process.env.PII_ENCRYPTION_KEY = "a".repeat(64);
    process.env.BAAS_WEBHOOK_SECRET = "integration-test-webhook-secret-32-bytes";
    process.env.KYC_WEBHOOK_SECRET = "integration-test-kyc-webhook-secret-32-bytes";
    for (const prefix of ["KYC", "BAAS", "SMS", "FUND"]) {
        delete process.env[`${prefix}_API_KEY`];
        delete process.env[`${prefix}_GATEWAY_URL`];
    }
    const { prisma } = await Promise.resolve().then(() => __importStar(require("../config/prisma")));
    const { serializable } = await Promise.resolve().then(() => __importStar(require("../services/transaction.service")));
    const { createJournalEntry, createDepositJournal, createWithdrawalJournal, accrueGoalInterest } = await Promise.resolve().then(() => __importStar(require("../services/ledger.service")));
    const { processNextJob } = await Promise.resolve().then(() => __importStar(require("../services/jobs.service")));
    const { decryptPii } = await Promise.resolve().then(() => __importStar(require("../services/pii.service")));
    const { app } = await Promise.resolve().then(() => __importStar(require("../app")));
    const server = app.listen(0, "127.0.0.1");
    await (0, node_events_1.once)(server, "listening");
    const address = server.address();
    strict_1.default.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const device = (0, node_crypto_1.randomUUID)();
    let token = "";
    let userId = "";
    let accountId = "";
    async function call(path, body, headers = {}) {
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
                email: `hardening-${(0, node_crypto_1.randomUUID)()}@example.com`, password: "test-password-1234",
                firstName: "Integration", lastName: "Test", phoneNumber: "+2348012345678", bvn: "00000000000",
            };
            const key = (0, node_crypto_1.randomUUID)();
            const first = await call("/auth/register", body, { "idempotency-key": key });
            strict_1.default.equal(first.status, 201, JSON.stringify(first.body));
            const second = await call("/auth/register", body, { "idempotency-key": key });
            strict_1.default.deepEqual(second.body, first.body);
            userId = first.body.data.userId;
            const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
            strict_1.default.equal(user.phoneNumber, null);
            strict_1.default.ok(user.phoneEncrypted && !user.phoneEncrypted.includes(body.phoneNumber));
            strict_1.default.ok(!user.email.includes("@"));
            strict_1.default.equal(decryptPii(user.email), body.email);
            strict_1.default.equal(decryptPii(user.firstName), "Integration");
            const login = await call("/auth/login", { email: body.email, password: body.password });
            strict_1.default.equal(login.status, 200, JSON.stringify(login.body));
            strict_1.default.equal(login.body.data.mfaRequired, true);
            strict_1.default.equal(login.body.data.accessToken, undefined);
            const challengeId = login.body.data.challengeId;
            const job = await prisma.outboxJob.findUniqueOrThrow({ where: { uniqueKey: `otp:${challengeId}` } });
            const payload = job.payload;
            strict_1.default.ok(payload && typeof payload === "object" && !Array.isArray(payload) && typeof payload.encryptedCode === "string");
            const code = decryptPii(payload.encryptedCode);
            const wrong = await call("/auth/verify-otp", { challengeId, code: code === "111111" ? "222222" : "111111" });
            strict_1.default.equal(wrong.status, 401);
            strict_1.default.equal((await prisma.authChallenge.findUniqueOrThrow({ where: { id: challengeId } })).attempts, 1);
            const verified = await call("/auth/verify-otp", { challengeId, code });
            strict_1.default.equal(verified.status, 200, JSON.stringify(verified.body));
            token = verified.body.data.accessToken;
            strict_1.default.equal((await call("/auth/verify-otp", { challengeId, code })).status, 401);
            strict_1.default.equal((await call("/dashboard")).status, 200);
            strict_1.default.equal((await call("/dashboard", undefined, { "x-device-id": (0, node_crypto_1.randomUUID)() })).status, 401);
            for (let i = 0; i < 10 && await processNextJob(); i++) { /* drain the finite fixture onboarding jobs */ }
            strict_1.default.equal((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).kycStatus, "VERIFIED");
            const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId }, include: { ledgerAccount: true } });
            strict_1.default.match(wallet.virtualAccountNumber ?? "", /^MOCK-/);
            strict_1.default.ok(wallet.ledgerAccount);
            accountId = wallet.ledgerAccount.id;
            await serializable((tx) => createDepositJournal(tx, accountId, "100.00", (0, node_crypto_1.randomUUID)(), (0, node_crypto_1.randomUUID)()));
        });
        await suite.test("simultaneous withdrawals cannot double-spend", async () => {
            const results = await Promise.allSettled([1, 2].map(() => serializable((tx) => createWithdrawalJournal(tx, accountId, "80.00", (0, node_crypto_1.randomUUID)(), (0, node_crypto_1.randomUUID)()))));
            strict_1.default.equal(results.filter((result) => result.status === "fulfilled").length, 1);
            const rejected = results.find((result) => result.status === "rejected");
            strict_1.default.ok(rejected?.status === "rejected" && rejected.reason.code === "INSUFFICIENT_LEDGER_BALANCE");
            strict_1.default.equal((await prisma.ledgerAccount.findUniqueOrThrow({ where: { id: accountId } })).balance.toFixed(2), "20.00");
        });
        await suite.test("market endpoints validate queries and report unconfigured feeds without creating transactions", async () => {
            const keys = ["NGX_API_TOKEN", "FMDQ_MARKET_GATEWAY_URL", "FMDQ_MARKET_API_KEY"];
            const previous = keys.map((key) => [key, process.env[key]]);
            for (const key of keys)
                delete process.env[key];
            const count = await prisma.journalEntry.count();
            try {
                strict_1.default.equal((await call("/markets/instruments?provider=UNKNOWN")).status, 400);
                strict_1.default.equal((await call("/markets/history?provider=NGX&symbol=TEST&range=BAD")).status, 400);
                for (const provider of ["NGX", "FMDQ"]) {
                    const result = await call(`/markets/instruments?provider=${provider}`);
                    strict_1.default.equal(result.status, 503);
                    strict_1.default.equal(result.body.error.code, "MARKET_DATA_NOT_CONFIGURED");
                }
                strict_1.default.equal(await prisma.journalEntry.count(), count);
            }
            finally {
                for (const [key, value] of previous) {
                    if (value === undefined)
                        delete process.env[key];
                    else
                        process.env[key] = value;
                }
            }
        });
        await suite.test("unbalanced journal rejects atomically and SQL constraints reject bypasses", async () => {
            const settlement = await prisma.ledgerAccount.findUniqueOrThrow({ where: { code: "BAAS_SETTLEMENT_ASSET" } });
            const count = await prisma.journalEntry.count();
            await strict_1.default.rejects(createJournalEntry([
                { ledgerAccountId: settlement.id, side: "DEBIT", amount: "10.01" },
                { ledgerAccountId: accountId, side: "CREDIT", amount: "10.00" },
            ], { description: "Unbalanced test" }), /Total debits/);
            strict_1.default.equal(await prisma.journalEntry.count(), count);
            await strict_1.default.rejects(prisma.journalEntry.create({ data: { description: "Orphan test" } }));
            await strict_1.default.rejects(prisma.ledgerAccount.update({ where: { id: accountId }, data: { balance: "100000" } }));
            strict_1.default.equal((await prisma.ledgerAccount.findUniqueOrThrow({ where: { id: accountId } })).balance.toFixed(2), "20.00");
        });
        await suite.test("signed webhooks dedupe and reconcile exactly once including during kill switch", async () => {
            const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId } });
            const body = {
                eventId: (0, node_crypto_1.randomUUID)(), eventType: "DEPOSIT", amount: "5.01", currency: "NGN",
                reference: (0, node_crypto_1.randomUUID)(), virtualAccountNumber: wallet.virtualAccountNumber, occurredAt: new Date().toISOString(),
            };
            const signature = (0, node_crypto_1.createHmac)("sha256", process.env.BAAS_WEBHOOK_SECRET).update(JSON.stringify(body)).digest("hex");
            const headers = { "x-baas-signature": signature };
            strict_1.default.equal((await call("/webhooks/baas", body, { "x-baas-signature": "0".repeat(64) })).status, 401);
            const first = await call("/webhooks/baas", body, headers);
            strict_1.default.equal(first.status, 202, JSON.stringify(first.body));
            strict_1.default.equal((await call("/webhooks/baas", body, headers)).body.data.duplicate, true);
            const changed = { ...body, amount: "6.00" };
            const changedSignature = (0, node_crypto_1.createHmac)("sha256", process.env.BAAS_WEBHOOK_SECRET).update(JSON.stringify(changed)).digest("hex");
            strict_1.default.equal((await call("/webhooks/baas", changed, { "x-baas-signature": changedSignature })).status, 409);
            await prisma.systemControl.update({ where: { id: "global" }, data: { readOnly: true } });
            await processNextJob();
            strict_1.default.equal((await prisma.ledgerAccount.findUniqueOrThrow({ where: { id: accountId } })).balance.toFixed(2), "20.00");
            strict_1.default.equal((await call("/dashboard")).status, 200);
            await prisma.systemControl.update({ where: { id: "global" }, data: { readOnly: false } });
            await prisma.outboxJob.updateMany({ where: { completedAt: null }, data: { availableAt: new Date(0) } });
            for (let i = 0; i < 10 && await processNextJob(); i++) { /* finite webhook/alert jobs */ }
            strict_1.default.equal((await prisma.ledgerAccount.findUniqueOrThrow({ where: { id: accountId } })).balance.toFixed(2), "25.01");
            strict_1.default.equal(await prisma.journalEntry.count({ where: { idempotencyKey: `baas:${body.eventId}` } }), 1);
        });
        await suite.test("mutating requests require a key, replay responses, and reject key/body conflicts", async () => {
            const body = { name: "Atomic goal", targetAmount: "20", initialAmount: "5.01" };
            strict_1.default.equal((await call("/savings/goals", body)).status, 400);
            const headers = { "idempotency-key": (0, node_crypto_1.randomUUID)() };
            const first = await call("/savings/goals", body, headers);
            strict_1.default.equal(first.status, 201, JSON.stringify(first.body));
            strict_1.default.deepEqual((await call("/savings/goals", body, headers)).body, first.body);
            strict_1.default.equal((await call("/savings/goals", { ...body, initialAmount: "6" }, headers)).status, 409);
            strict_1.default.equal((await prisma.ledgerAccount.findUniqueOrThrow({ where: { id: accountId } })).balance.toFixed(2), "20.00");
        });
        await suite.test("locked goal debits obey the database UTC clock", async () => {
            const result = await call("/savings/goals", {
                name: "Locked goal", targetAmount: "10", initialAmount: "1",
                lockUntil: new Date(Date.now() + 86400000).toISOString(),
            }, { "idempotency-key": (0, node_crypto_1.randomUUID)() });
            strict_1.default.equal(result.status, 201);
            const goalAccount = await prisma.ledgerAccount.findUniqueOrThrow({ where: { savingsGoalId: result.body.data.goal.id } });
            await strict_1.default.rejects(createJournalEntry([
                { ledgerAccountId: goalAccount.id, side: "DEBIT", amount: "1.00" },
                { ledgerAccountId: accountId, side: "CREDIT", amount: "1.00" },
            ], { description: "Premature release" }), /before the database lock expiry/);
        });
        await suite.test("concurrent interest retries post one journal and increment yield only once", async () => {
            const result = await call("/savings/goals", { name: "Accrual test", targetAmount: "100", initialAmount: "0" }, { "idempotency-key": (0, node_crypto_1.randomUUID)() });
            strict_1.default.equal(result.status, 201);
            const goalId = result.body.data.goal.id;
            const key = `interest:${(0, node_crypto_1.randomUUID)()}`;
            const results = await Promise.all([
                accrueGoalInterest(prisma, goalId, "1.01", key),
                accrueGoalInterest(prisma, goalId, "1.01", key),
            ]);
            strict_1.default.equal(results[0]?.id, results[1]?.id);
            strict_1.default.equal((await prisma.savingsGoal.findUniqueOrThrow({ where: { id: goalId } })).yieldAccrued.toFixed(2), "1.01");
            const goalAccount = await prisma.ledgerAccount.findUniqueOrThrow({ where: { savingsGoalId: goalId } });
            strict_1.default.equal(goalAccount.balance.toFixed(2), "1.01");
            await strict_1.default.rejects(accrueGoalInterest(prisma, goalId, "1.02", key), /reused for different entries/);
        });
        await suite.test("missing kill switch state fails closed instead of enabling money movement", async () => {
            await prisma.systemControl.delete({ where: { id: "global" } });
            try {
                await strict_1.default.rejects(serializable((tx) => createDepositJournal(tx, accountId, "1.00", (0, node_crypto_1.randomUUID)(), (0, node_crypto_1.randomUUID)())), /system control is restored/);
                strict_1.default.equal((await call("/dashboard")).status, 200);
            }
            finally {
                await prisma.systemControl.create({ data: { id: "global", readOnly: false } });
            }
        });
        await suite.test("inactive wallets reject direct ledger deposits and withdrawals", async () => {
            await prisma.wallet.update({ where: { userId }, data: { status: "SUSPENDED" } });
            const before = (await prisma.ledgerAccount.findUniqueOrThrow({ where: { id: accountId } })).balance.toFixed(2);
            try {
                await strict_1.default.rejects(serializable((tx) => createDepositJournal(tx, accountId, "1.00", (0, node_crypto_1.randomUUID)(), (0, node_crypto_1.randomUUID)())), /active wallets/);
                await strict_1.default.rejects(serializable((tx) => createWithdrawalJournal(tx, accountId, "1.00", (0, node_crypto_1.randomUUID)(), (0, node_crypto_1.randomUUID)())), /active wallets/);
                strict_1.default.equal((await prisma.ledgerAccount.findUniqueOrThrow({ where: { id: accountId } })).balance.toFixed(2), before);
            }
            finally {
                await prisma.wallet.update({ where: { userId }, data: { status: "ACTIVE" } });
            }
        });
        await suite.test("database kill switch rejects money movement, permits reads and logout revokes sessions", async () => {
            await prisma.systemControl.update({ where: { id: "global" }, data: { readOnly: true } });
            strict_1.default.equal((await call("/dashboard")).status, 200);
            const blocked = await call("/savings/goals", { name: "Blocked", targetAmount: "10", initialAmount: "1" }, { "idempotency-key": (0, node_crypto_1.randomUUID)() });
            strict_1.default.equal(blocked.status, 503);
            strict_1.default.equal(blocked.body.error.code, "SYSTEM_READ_ONLY");
            await prisma.systemControl.update({ where: { id: "global" }, data: { readOnly: false } });
            strict_1.default.equal((await call("/auth/logout", {})).status, 200);
            strict_1.default.equal((await call("/dashboard")).status, 401);
        });
        await suite.test("OTP expires by database clock and locks after five incorrect attempts", async () => {
            const { completeChallenge, secureHash } = await Promise.resolve().then(() => __importStar(require("../services/session.service")));
            const fingerprint = "test-fingerprint";
            const expiredId = (0, node_crypto_1.randomUUID)();
            await prisma.authChallenge.create({ data: {
                    id: expiredId, userId, deviceHash: fingerprint, codeHash: secureHash(`${expiredId}:123456`),
                    expiresAt: new Date(0),
                } });
            await strict_1.default.rejects(completeChallenge(expiredId, "123456", fingerprint), { code: "INVALID_OTP" });
            const lockedId = (0, node_crypto_1.randomUUID)();
            await prisma.authChallenge.create({ data: {
                    id: lockedId, userId, deviceHash: fingerprint, codeHash: secureHash(`${lockedId}:123456`),
                    expiresAt: new Date(Date.now() + 300000),
                } });
            for (let attempt = 0; attempt < 5; attempt++)
                await strict_1.default.rejects(completeChallenge(lockedId, "999999", fingerprint));
            await strict_1.default.rejects(completeChallenge(lockedId, "123456", fingerprint));
            strict_1.default.equal((await prisma.authChallenge.findUniqueOrThrow({ where: { id: lockedId } })).attempts, 5);
        });
    }
    finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        await prisma.$disconnect();
    }
});
