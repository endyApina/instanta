"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CircuitBreaker = void 0;
const app_error_1 = require("../errors/app-error");
class CircuitBreaker {
    partner;
    cooldownMs;
    failures = 0;
    openedAt = null;
    probing = false;
    generation = 0;
    constructor(partner, cooldownMs = 30_000) {
        this.partner = partner;
        this.cooldownMs = cooldownMs;
    }
    async execute(action) {
        let isProbe = false;
        if (this.openedAt !== null) {
            if (Date.now() - this.openedAt < this.cooldownMs || this.probing) {
                throw new app_error_1.AppError(503, "PARTNER_CIRCUIT_OPEN", `${this.partner} is temporarily unavailable`);
            }
            this.probing = true;
            isProbe = true;
        }
        const generation = this.generation;
        try {
            const result = await action();
            // An older in-flight success must not close a circuit opened by newer failures.
            if (generation === this.generation) {
                this.failures = 0;
                this.openedAt = null;
                this.probing = false;
                if (isProbe)
                    this.generation++;
            }
            return result;
        }
        catch (error) {
            if (generation === this.generation) {
                this.failures++;
                if (isProbe || this.failures >= 3) {
                    this.openedAt = Date.now();
                    this.probing = false;
                    this.generation++;
                    console.error(`[ALERT] Partner circuit opened: ${this.partner}. Durable jobs will retry; investigate upstream health.`);
                }
            }
            throw error;
        }
    }
}
exports.CircuitBreaker = CircuitBreaker;
