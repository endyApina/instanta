import { createHash } from "node:crypto";
import { z } from "zod";
import { isProduction } from "../config/runtime";
import { AppError } from "../errors/app-error";
import { MoneyDecimal, moneyAmount } from "../domain/money";
import { CircuitBreaker } from "./circuit-breaker";

export interface IdentityRequest {
  reference: string; userId: string; bvn?: string; nin?: string;
}
export interface IdentityResult {
  status: "PENDING" | "VERIFIED" | "REJECTED";
  reference: string;
  simulated: boolean;
}
export interface VirtualAccount {
  accountNumber: string; accountName: string; bankName: string; simulated: boolean;
}
export interface FundOrder {
  id: string; asset: string; amount: string;
}
export interface FundExecution {
  id: string; amount: string; nav: string; units: string; simulated: boolean;
}
export abstract class KycAdapter {
  abstract verify(input: IdentityRequest): Promise<IdentityResult>;
}
export abstract class BaasAdapter {
  abstract createAccount(userId: string): Promise<VirtualAccount>;
}
export abstract class FundManagerAdapter {
  abstract placeBatch(batchId: string, orders: FundOrder[]): Promise<FundExecution[]>;
}
export abstract class NotificationAdapter {
  abstract sendOtp(id: string, destination: string, code: string): Promise<void>;
  abstract sendAlert(id: string, destination: string, text: string): Promise<void>;
}

export class PartnerGateway {
  private readonly breaker: CircuitBreaker;
  constructor(private readonly name: string, private readonly url: string, private readonly key: string) {
    this.breaker = new CircuitBreaker(name);
    const parsed = new URL(url);
    if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) {
      throw new Error(`${name} gateway must be an HTTP(S) URL without embedded credentials or a fragment`);
    }
    if (isProduction() && parsed.protocol !== "https:") throw new Error(`${name} gateway must use HTTPS in production`);
  }
  async post<T>(key: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
    if (process.env.IS_DEMO_MODE === "true") throw new AppError(403, "DEMO_NETWORK_DISABLED", "External provider calls are disabled in demo mode.");
    return this.breaker.execute(async () => {
      let response: Response;
      try {
        response = await fetch(this.url, {
          method: "POST",
          headers: {
            "content-type": "application/json", authorization: ["Bearer", this.key].join(" "),
            "idempotency-key": key,
          },
          body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
        });
      } catch {
        throw new AppError(503, "PARTNER_TIMEOUT", `${this.name} could not be reached`);
      }
      if (!response.ok) throw new AppError(502, "PARTNER_REJECTED", `${this.name} returned HTTP ${response.status}`);
      let responseBody: unknown;
      try {
        responseBody = await response.json();
      } catch {
        throw new AppError(502, "PARTNER_INVALID_RESPONSE", `${this.name} returned invalid JSON`);
      }
      const result = schema.safeParse(responseBody);
      if (!result.success) throw new AppError(502, "PARTNER_INVALID_RESPONSE", `${this.name} response did not match the certified gateway contract`);
      return result.data;
    });
  }
}

// Named live adapters target an explicitly configured normalization gateway, not undocumented vendor APIs.
export class YouVerifyGateway extends KycAdapter {
  constructor(private readonly gateway: PartnerGateway) { super(); }
  verify(input: IdentityRequest) {
    return this.gateway.post(input.reference, input, z.object({
      status: z.enum(["PENDING", "VERIFIED", "REJECTED"]), reference: z.literal(input.reference),
      simulated: z.literal(false),
    }));
  }
}
export class AnchorGateway extends BaasAdapter {
  constructor(private readonly gateway: PartnerGateway) { super(); }
  createAccount(userId: string) {
    return this.gateway.post(`account:${userId}`, { userId, currency: "NGN" }, z.object({
      accountNumber: z.string().regex(/^\d{10}$/),
      accountName: z.string(), bankName: z.string(), simulated: z.literal(false),
    }));
  }
}
export class SecFundManagerGateway extends FundManagerAdapter {
  constructor(private readonly gateway: PartnerGateway) { super(); }
  async placeBatch(batchId: string, orders: FundOrder[]) {
    if (!orders.length || orders.length > 100 || new Set(orders.map((order) => order.id)).size !== orders.length) {
      throw new AppError(400, "INVALID_BATCH", "Supply 1-100 uniquely identified orders");
    }
    const expected = new Map(orders.map((order) => [order.id, moneyAmount(order.amount)]));
    // Validate the full execution inside the breaker so malformed success responses count as failures.
    const executionPattern = /^\d{1,28}(\.\d{1,8})?$/;
    const amountPattern = /^\d{1,18}(\.\d{1,2})?$/;
    const positiveDecimal = z.string()
      .refine((value) => executionPattern.test(value) && new MoneyDecimal(value).gt(0), "Execution value must be a positive finite decimal");
    const schema = z.array(z.object({
      id: z.string(), amount: z.string().regex(amountPattern),
      nav: positiveDecimal, units: positiveDecimal, simulated: z.literal(false),
    })).length(orders.length).superRefine((executions, context) => {
      if (new Set(executions.map((item) => item.id)).size !== orders.length
        || executions.some((item) => !amountPattern.test(item.amount) || !expected.get(item.id)?.eq(item.amount))) {
        context.addIssue({ code: "custom", message: "Executions do not match the submitted orders" });
      }
    });
    return this.gateway.post(batchId, { batchId, orders }, schema);
  }
}
export class TermiiGateway extends NotificationAdapter {
  constructor(private readonly gateway: PartnerGateway) { super(); }
  async sendOtp(id: string, destination: string, code: string) {
    await this.gateway.post(id, { destination, message: `Your Instanta verification code is ${code}. Expires in 5 minutes.` }, z.object({ accepted: z.literal(true) }));
  }
  async sendAlert(id: string, destination: string, text: string) {
    await this.gateway.post(id, { destination, message: text }, z.object({ accepted: z.literal(true) }));
  }
}

export class MockKyc extends KycAdapter {
  async verify(input: IdentityRequest): Promise<IdentityResult> {
    const verified = input.bvn === "00000000000" || input.nin === "00000000000";
    return { reference: input.reference, status: verified ? "VERIFIED" : "REJECTED", simulated: true };
  }
}
export class MockBaas extends BaasAdapter {
  async createAccount(userId: string): Promise<VirtualAccount> {
    // Synthetic identifiers are never described as bank-issued NUBANs or routed to real banks.
    return {
      accountNumber: `MOCK-${createHash("sha256").update(userId).digest("hex").slice(0, 16)}`,
      accountName: "Instanta simulated wallet", bankName: "MOCK - not a bank account", simulated: true,
    };
  }
}
export class MockFundManager extends FundManagerAdapter {
  async placeBatch(_batchId: string, orders: FundOrder[]): Promise<FundExecution[]> {
    return orders.map((order) => ({
      id: order.id, amount: moneyAmount(order.amount).toFixed(2), nav: "100.000000",
      units: moneyAmount(order.amount).div(100).toFixed(8), simulated: true,
    }));
  }
}
export class MockNotifications extends NotificationAdapter {
  async sendOtp(id: string, _destination: string, code: string) {
    if ((process.env.NODE_ENV ?? "development") === "development" || (process.env.IS_DEMO_MODE === "true" && process.env.NODE_ENV === "staging")) {
      console.warn(`\u001b[33m[DEV ONLY OTP] challenge=${id} code=${code} (never enable console OTP in production)\u001b[0m`);
    } else if (process.env.NODE_ENV !== "test") {
      throw new AppError(503, "SMS_NOT_CONFIGURED", "Staging OTP delivery requires a configured notification gateway");
    }
  }
  async sendAlert(id: string, _destination: string, _text: string) {
    console.warn(`[MOCK] Transaction alert simulated: ${id}; no message delivered`);
  }
}

function choose<T>(name: string, prefix: string, live: (gateway: PartnerGateway) => T, mock: () => T): T {
  const url = process.env[`${prefix}_GATEWAY_URL`];
  const key = process.env[`${prefix}_API_KEY`];
  if (url && key) return live(new PartnerGateway(name, url, key));
  if (isProduction()) throw new Error(`${name}: live gateway URL and API key are required in production`);
  if (!["development", "staging", "test"].includes(process.env.NODE_ENV ?? "development")) {
    throw new Error("Mock partners are restricted to development, staging and test");
  }
  console.warn(`\u001b[33m[WARN] LIVE API KEY MISSING: Falling back to secure mock mode for ${name}\u001b[0m`);
  return mock();
}

let configured: ReturnType<typeof createPartners> | undefined;
function createPartners() {
  return {
    kyc: choose("YouVerify / Smile ID", "KYC", (gateway) => new YouVerifyGateway(gateway), () => new MockKyc()),
    baas: choose("Anchor / Maplerad / SafeHaven", "BAAS", (gateway) => new AnchorGateway(gateway), () => new MockBaas()),
    fund: choose("SEC-licensed Fund Manager", "FUND", (gateway) => new SecFundManagerGateway(gateway), () => new MockFundManager()),
    notifications: choose("Termii / Africa's Talking", "SMS", (gateway) => new TermiiGateway(gateway), () => new MockNotifications()),
  };
}
export function partners() {
  if (process.env.IS_DEMO_MODE === "true") return {
    kyc: new MockKyc(), baas: new MockBaas(), fund: new MockFundManager(), notifications: new MockNotifications(),
  };
  return configured ??= createPartners();
}
