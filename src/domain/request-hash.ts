import { createHash } from "node:crypto";
import { AppError } from "../errors/app-error";

export function requestHash(value: unknown): string {
  function canonical(item: unknown, depth = 0): string {
    if (depth > 20) throw new AppError(400, "INVALID_REQUEST", "Request nesting exceeds the supported depth");
    if (Array.isArray(item)) return `[${item.map((val) => canonical(val, depth + 1)).join(",")}]`;
    if (item !== null && typeof item === "object") {
      return `{${Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, val]) => `${JSON.stringify(key)}:${canonical(val, depth + 1)}`).join(",")}}`;
    }
    return JSON.stringify(item) ?? "null";
  }
  return createHash("sha256").update(canonical(value)).digest("hex");
}
