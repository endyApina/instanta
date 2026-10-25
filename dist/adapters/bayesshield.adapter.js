"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BayesShieldAdapter = void 0;
const index_1 = require("./index");
const perpetuals_1 = require("../domain/perpetuals");
const money_1 = require("../domain/money");
const node_crypto_1 = require("node:crypto");
const zod_1 = require("zod");
const demo_1 = require("../config/demo");
class BayesShieldAdapter {
    gateway;
    async assess(input) {
        const endpoint = process.env.BAYESSHIELD_GATEWAY_URL;
        const key = process.env.BAYESSHIELD_API_KEY;
        if ((0, demo_1.isDemoMode)() || !endpoint || !key)
            return {
                source: "UNAVAILABLE", simulated: true, lossProbability: null, winProbability: null,
                warning: "No AI risk estimate is available. You could lose the amount you invest. Confirm that you understand before trying this trade.",
                assessedAt: new Date().toISOString(),
            };
        this.gateway ??= new index_1.PartnerGateway("BayesShield normalization gateway", endpoint, key);
        const scoreContract = perpetuals_1.riskScoreSchema.extend({
            symbol: zod_1.z.literal(input.symbol), side: zod_1.z.literal(input.side), qty: zod_1.z.literal(input.qty), price: zod_1.z.literal(input.price),
            source: zod_1.z.literal("BAYESSHIELD_GATEWAY"), simulated: zod_1.z.literal(false),
            lossProbability: zod_1.z.number().finite().min(0).max(1), winProbability: zod_1.z.number().finite().min(0).max(1),
        }).superRefine((score, context) => {
            if (new money_1.MoneyDecimal(score.lossProbability).plus(score.winProbability).minus(1).abs().gt("0.000001")
                || Date.now() - Date.parse(score.assessedAt) > 30_000 || Date.parse(score.assessedAt) > Date.now() + 5000) {
                context.addIssue({ code: "custom", message: "Score must be fresh and normalized" });
            }
        });
        const result = await this.gateway.post(`risk:${(0, node_crypto_1.randomUUID)()}`, input, scoreContract);
        return perpetuals_1.riskScoreSchema.parse(result);
    }
}
exports.BayesShieldAdapter = BayesShieldAdapter;
