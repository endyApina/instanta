import { PartnerGateway } from "./index";
import { riskScoreSchema, type GlobalRiskScore } from "../domain/perpetuals";
import { MoneyDecimal as D } from "../domain/money";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { isDemoMode } from "../config/demo";

export class BayesShieldAdapter {
  private gateway: PartnerGateway | undefined;
  async assess(input: { symbol: string; side: string; qty: string; price: string }): Promise<GlobalRiskScore> {
    const endpoint = process.env.BAYESSHIELD_GATEWAY_URL;
    const key = process.env.BAYESSHIELD_API_KEY;
    if (isDemoMode() || !endpoint || !key) return {
      source: "UNAVAILABLE", simulated: true, lossProbability: null, winProbability: null,
      warning: "No AI risk estimate is available. You could lose the amount you invest. Confirm that you understand before trying this trade.",
      assessedAt: new Date().toISOString(),
    };
    this.gateway ??= new PartnerGateway("BayesShield normalization gateway", endpoint, key);
    const scoreContract = riskScoreSchema.extend({
      symbol: z.literal(input.symbol), side: z.literal(input.side), qty: z.literal(input.qty), price: z.literal(input.price),
      source: z.literal("BAYESSHIELD_GATEWAY"), simulated: z.literal(false),
      lossProbability: z.number().finite().min(0).max(1), winProbability: z.number().finite().min(0).max(1),
    }).superRefine((score, context) => {
      if (new D(score.lossProbability).plus(score.winProbability).minus(1).abs().gt("0.000001")
        || Date.now() - Date.parse(score.assessedAt) > 30_000 || Date.parse(score.assessedAt) > Date.now() + 5000) {
        context.addIssue({ code: "custom", message: "Score must be fresh and normalized" });
      }
    });
    const result = await this.gateway.post(`risk:${randomUUID()}`, input, scoreContract);
    return riskScoreSchema.parse(result);
  }
}
