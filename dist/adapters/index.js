"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MockNotifications = exports.MockFundManager = exports.MockBaas = exports.MockKyc = exports.TermiiGateway = exports.SecFundManagerGateway = exports.AnchorGateway = exports.YouVerifyGateway = exports.PartnerGateway = exports.NotificationAdapter = exports.FundManagerAdapter = exports.BaasAdapter = exports.KycAdapter = void 0;
exports.partners = partners;
const node_crypto_1 = require("node:crypto");
const zod_1 = require("zod");
const runtime_1 = require("../config/runtime");
const app_error_1 = require("../errors/app-error");
const money_1 = require("../domain/money");
const circuit_breaker_1 = require("./circuit-breaker");
class KycAdapter {
}
exports.KycAdapter = KycAdapter;
class BaasAdapter {
}
exports.BaasAdapter = BaasAdapter;
class FundManagerAdapter {
}
exports.FundManagerAdapter = FundManagerAdapter;
class NotificationAdapter {
}
exports.NotificationAdapter = NotificationAdapter;
class PartnerGateway {
    name;
    url;
    key;
    breaker;
    constructor(name, url, key) {
        this.name = name;
        this.url = url;
        this.key = key;
        this.breaker = new circuit_breaker_1.CircuitBreaker(name);
        const parsed = new URL(url);
        if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) {
            throw new Error(`${name} gateway must be an HTTP(S) URL without embedded credentials or a fragment`);
        }
        if ((0, runtime_1.isProduction)() && parsed.protocol !== "https:")
            throw new Error(`${name} gateway must use HTTPS in production`);
    }
    async post(key, body, schema) {
        if (process.env.IS_DEMO_MODE === "true")
            throw new app_error_1.AppError(403, "DEMO_NETWORK_DISABLED", "External provider calls are disabled in demo mode.");
        return this.breaker.execute(async () => {
            let response;
            try {
                response = await fetch(this.url, {
                    method: "POST",
                    headers: {
                        "content-type": "application/json", authorization: ["Bearer", this.key].join(" "),
                        "idempotency-key": key,
                    },
                    body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
                });
            }
            catch {
                throw new app_error_1.AppError(503, "PARTNER_TIMEOUT", `${this.name} could not be reached`);
            }
            if (!response.ok)
                throw new app_error_1.AppError(502, "PARTNER_REJECTED", `${this.name} returned HTTP ${response.status}`);
            let responseBody;
            try {
                responseBody = await response.json();
            }
            catch {
                throw new app_error_1.AppError(502, "PARTNER_INVALID_RESPONSE", `${this.name} returned invalid JSON`);
            }
            const result = schema.safeParse(responseBody);
            if (!result.success)
                throw new app_error_1.AppError(502, "PARTNER_INVALID_RESPONSE", `${this.name} response did not match the certified gateway contract`);
            return result.data;
        });
    }
}
exports.PartnerGateway = PartnerGateway;
// Named live adapters target an explicitly configured normalization gateway, not undocumented vendor APIs.
class YouVerifyGateway extends KycAdapter {
    gateway;
    constructor(gateway) {
        super();
        this.gateway = gateway;
    }
    verify(input) {
        return this.gateway.post(input.reference, input, zod_1.z.object({
            status: zod_1.z.enum(["PENDING", "VERIFIED", "REJECTED"]), reference: zod_1.z.literal(input.reference),
            simulated: zod_1.z.literal(false),
        }));
    }
}
exports.YouVerifyGateway = YouVerifyGateway;
class AnchorGateway extends BaasAdapter {
    gateway;
    constructor(gateway) {
        super();
        this.gateway = gateway;
    }
    createAccount(userId) {
        return this.gateway.post(`account:${userId}`, { userId, currency: "NGN" }, zod_1.z.object({
            accountNumber: zod_1.z.string().regex(/^\d{10}$/),
            accountName: zod_1.z.string(), bankName: zod_1.z.string(), simulated: zod_1.z.literal(false),
        }));
    }
}
exports.AnchorGateway = AnchorGateway;
class SecFundManagerGateway extends FundManagerAdapter {
    gateway;
    constructor(gateway) {
        super();
        this.gateway = gateway;
    }
    async placeBatch(batchId, orders) {
        if (!orders.length || orders.length > 100 || new Set(orders.map((order) => order.id)).size !== orders.length) {
            throw new app_error_1.AppError(400, "INVALID_BATCH", "Supply 1-100 uniquely identified orders");
        }
        const expected = new Map(orders.map((order) => [order.id, (0, money_1.moneyAmount)(order.amount)]));
        // Validate the full execution inside the breaker so malformed success responses count as failures.
        const executionPattern = /^\d{1,28}(\.\d{1,8})?$/;
        const amountPattern = /^\d{1,18}(\.\d{1,2})?$/;
        const positiveDecimal = zod_1.z.string()
            .refine((value) => executionPattern.test(value) && new money_1.MoneyDecimal(value).gt(0), "Execution value must be a positive finite decimal");
        const schema = zod_1.z.array(zod_1.z.object({
            id: zod_1.z.string(), amount: zod_1.z.string().regex(amountPattern),
            nav: positiveDecimal, units: positiveDecimal, simulated: zod_1.z.literal(false),
        })).length(orders.length).superRefine((executions, context) => {
            if (new Set(executions.map((item) => item.id)).size !== orders.length
                || executions.some((item) => !amountPattern.test(item.amount) || !expected.get(item.id)?.eq(item.amount))) {
                context.addIssue({ code: "custom", message: "Executions do not match the submitted orders" });
            }
        });
        return this.gateway.post(batchId, { batchId, orders }, schema);
    }
}
exports.SecFundManagerGateway = SecFundManagerGateway;
class TermiiGateway extends NotificationAdapter {
    gateway;
    constructor(gateway) {
        super();
        this.gateway = gateway;
    }
    async sendOtp(id, destination, code) {
        await this.gateway.post(id, { destination, message: `Your Instanta verification code is ${code}. Expires in 5 minutes.` }, zod_1.z.object({ accepted: zod_1.z.literal(true) }));
    }
    async sendAlert(id, destination, text) {
        await this.gateway.post(id, { destination, message: text }, zod_1.z.object({ accepted: zod_1.z.literal(true) }));
    }
}
exports.TermiiGateway = TermiiGateway;
class MockKyc extends KycAdapter {
    async verify(input) {
        const verified = input.bvn === "00000000000" || input.nin === "00000000000";
        return { reference: input.reference, status: verified ? "VERIFIED" : "REJECTED", simulated: true };
    }
}
exports.MockKyc = MockKyc;
class MockBaas extends BaasAdapter {
    async createAccount(userId) {
        // Synthetic identifiers are never described as bank-issued NUBANs or routed to real banks.
        return {
            accountNumber: `MOCK-${(0, node_crypto_1.createHash)("sha256").update(userId).digest("hex").slice(0, 16)}`,
            accountName: "Instanta simulated wallet", bankName: "MOCK - not a bank account", simulated: true,
        };
    }
}
exports.MockBaas = MockBaas;
class MockFundManager extends FundManagerAdapter {
    async placeBatch(_batchId, orders) {
        return orders.map((order) => ({
            id: order.id, amount: (0, money_1.moneyAmount)(order.amount).toFixed(2), nav: "100.000000",
            units: (0, money_1.moneyAmount)(order.amount).div(100).toFixed(8), simulated: true,
        }));
    }
}
exports.MockFundManager = MockFundManager;
class MockNotifications extends NotificationAdapter {
    async sendOtp(id, _destination, code) {
        if ((process.env.NODE_ENV ?? "development") === "development" || (process.env.IS_DEMO_MODE === "true" && process.env.NODE_ENV === "staging")) {
            console.warn(`\u001b[33m[DEV ONLY OTP] challenge=${id} code=${code} (never enable console OTP in production)\u001b[0m`);
        }
        else if (process.env.NODE_ENV !== "test") {
            throw new app_error_1.AppError(503, "SMS_NOT_CONFIGURED", "Staging OTP delivery requires a configured notification gateway");
        }
    }
    async sendAlert(id, _destination, _text) {
        console.warn(`[MOCK] Transaction alert simulated: ${id}; no message delivered`);
    }
}
exports.MockNotifications = MockNotifications;
function choose(name, prefix, live, mock) {
    const url = process.env[`${prefix}_GATEWAY_URL`];
    const key = process.env[`${prefix}_API_KEY`];
    if (url && key)
        return live(new PartnerGateway(name, url, key));
    if ((0, runtime_1.isProduction)())
        throw new Error(`${name}: live gateway URL and API key are required in production`);
    if (!["development", "staging", "test"].includes(process.env.NODE_ENV ?? "development")) {
        throw new Error("Mock partners are restricted to development, staging and test");
    }
    console.warn(`\u001b[33m[WARN] LIVE API KEY MISSING: Falling back to secure mock mode for ${name}\u001b[0m`);
    return mock();
}
let configured;
function createPartners() {
    return {
        kyc: choose("YouVerify / Smile ID", "KYC", (gateway) => new YouVerifyGateway(gateway), () => new MockKyc()),
        baas: choose("Anchor / Maplerad / SafeHaven", "BAAS", (gateway) => new AnchorGateway(gateway), () => new MockBaas()),
        fund: choose("SEC-licensed Fund Manager", "FUND", (gateway) => new SecFundManagerGateway(gateway), () => new MockFundManager()),
        notifications: choose("Termii / Africa's Talking", "SMS", (gateway) => new TermiiGateway(gateway), () => new MockNotifications()),
    };
}
function partners() {
    if (process.env.IS_DEMO_MODE === "true")
        return {
            kyc: new MockKyc(), baas: new MockBaas(), fund: new MockFundManager(), notifications: new MockNotifications(),
        };
    return configured ??= createPartners();
}
