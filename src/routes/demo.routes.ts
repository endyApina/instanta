import { Router } from "express";
import { z } from "zod";
import { isDemoMode } from "../config/demo";
import { deviceHash, enforceRateLimit } from "../services/session.service";
import { openDemoSession, rebalanceDemo, requireDemoMode } from "../services/demoMode.service";
import { requireAuth } from "../middleware/auth";
import { idempotentMutation } from "../middleware/idempotency.middleware";
import { localDemoEnabled } from "../services/local-demo-proxy";

export const demoRoutes = Router();
demoRoutes.get("/config", (_request, response) => response.json({ success: true, data: { enabled: isDemoMode(), localDemoAvailable: localDemoEnabled() } }));
demoRoutes.post("/session", async (request, response, next) => {
  try {
    requireDemoMode();
    await enforceRateLimit(`demo-ip:${request.ip}`, 10, 900, "Too many demo sign-ins. Please wait 15 minutes.");
    const { identity } = z.object({ identity: z.string().regex(/^[a-f0-9]{64}$/) }).parse(request.body);
    response.json({ success: true, data: await openDemoSession(identity, deviceHash(request)) });
  } catch (error) { next(error); }
});
demoRoutes.post("/rebalance", requireAuth, idempotentMutation(async (request, tx) => ({
  status: 200, body: { success: true, data: await rebalanceDemo(tx, request.userId!) },
})));
