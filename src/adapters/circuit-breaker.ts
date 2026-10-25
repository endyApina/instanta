import { AppError } from "../errors/app-error";

export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;
  private probing = false;
  private generation = 0;

  constructor(private readonly partner: string, private readonly cooldownMs = 30_000) {}

  async execute<T>(action: () => Promise<T>): Promise<T> {
    let isProbe = false;
    if (this.openedAt !== null) {
      if (Date.now() - this.openedAt < this.cooldownMs || this.probing) {
        throw new AppError(503, "PARTNER_CIRCUIT_OPEN", `${this.partner} is temporarily unavailable`);
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
        if (isProbe) this.generation++;
      }
      return result;
    } catch (error) {
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
