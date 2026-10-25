import { z } from "zod";

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

const envelopeSchema = z.discriminatedUnion("success", [
  z.object({ success: z.literal(true), data: z.unknown() }),
  z.object({
    success: z.literal(false),
    error: z.object({ code: z.string(), message: z.string() }),
  }),
]);

export function apiBase(): string {
  return new URLSearchParams(window.location.search).get("mode") === "demo" ? "/demo-api/v1" : "/api/v1";
}

export async function api<T>(
  path: string,
  schema: z.ZodType<T>,
  token: string | null,
  body?: unknown,
  idempotencyKey: string = crypto.randomUUID(),
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${apiBase()}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "X-Device-ID": browserDeviceId(),
        ...(body === undefined ? {} : { "Idempotency-Key": idempotencyKey }),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new Error("The API could not be reached. Check that the backend is running.");
  }
  const parsed = envelopeSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new Error("The server returned an invalid response. Check your API configuration.");
  if (!parsed.data.success) {
    throw new ApiError(response.status, parsed.data.error.message);
  }
  if (!response.ok) throw new ApiError(response.status, "The request failed. Please try again.");
  return schema.parse(parsed.data.data);
}

export const authSchema = z.object({ accessToken: z.string() });
export const challengeSchema = z.object({ challengeId: z.string(), mfaRequired: z.literal(true), expiresIn: z.number() });
export const registeredSchema = z.object({ registered: z.literal(true), userId: z.string(), message: z.string() });
export const goalCreatedSchema = z.object({ goal: z.object({ id: z.string(), status: z.string() }) });

export const dashboardSchema = z.object({
  partnerMode: z.enum(["MOCK", "LIVE"]),
  user: z.object({
    id: z.string(), email: z.string(), firstName: z.string(), lastName: z.string(),
    kycLevel: z.string(), kycStatus: z.string(),
    bvnLastFour: z.string().nullable(), ninLastFour: z.string().nullable(),
    maxTolerableLoss: z.string().nullable(), targetReturn: z.string().nullable(),
    timeHorizonMonths: z.number().nullable(),
  }),
  wallet: z.object({
    status: z.string(), currency: z.string(), balance: z.string(),
    virtualAccountNumber: z.string().nullable(),
    virtualAccountName: z.string().nullable(), virtualAccountBank: z.string().nullable(),
  }).nullable(),
  goals: z.array(z.object({
    id: z.string(), name: z.string(), targetAmount: z.string(), lockedAmount: z.string(),
    yieldAccrued: z.string(), balance: z.string(), status: z.string(), autoSweep: z.boolean(),
    lockUntil: z.string().nullable(), endDate: z.string().nullable(),
  })),
  activity: z.array(z.object({
    id: z.string(), journalEntryId: z.string(), description: z.string(), accountName: z.string(),
    side: z.enum(["DEBIT", "CREDIT"]), amount: z.string(), createdAt: z.string(),
  })),
});

export const evaluationSchema = z.object({
  evaluationId: z.string(), requiredTbills: z.number(), floorValue: z.number(),
  signal: z.object({
    shouldRebalance: z.boolean(), thresholdPercentagePoints: z.number(),
    targetVsActual: z.record(z.string(), z.object({ target: z.number(), actual: z.number(), drift: z.number() })),
    suggestedTrades: z.array(z.object({
      assetClass: z.string(), side: z.enum(["BUY", "SELL"]), amount: z.number(), driftPercentagePoints: z.number(),
    })),
  }),
});
export type Evaluation = z.infer<typeof evaluationSchema>;

export function browserDeviceId(): string {
  const key = "instanta-device";
  let id = sessionStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(key, id);
  }
  return id;
}
