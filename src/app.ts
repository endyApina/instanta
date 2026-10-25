import express, { type Request, type Response } from "express";
import path from "node:path";
import { atpRoutes } from "./routes/atp.routes";
import { authRoutes } from "./routes/auth.routes";
import { savingsRoutes } from "./routes/savings.routes";
import { webhookRoutes } from "./routes/webhook.routes";
import { errorHandler } from "./middleware/error-handler";
import { dashboardRoutes } from "./routes/dashboard.routes";
import { marketRoutes } from "./routes/market.routes";
import { perpetualsRoutes } from "./routes/perpetuals.routes";
import { demoRoutes } from "./routes/demo.routes";
import { wealthRoutes } from "./routes/wealth.routes";
import { proxyLocalDemo } from "./services/local-demo-proxy";
import { isDemoMode } from "./config/demo";

declare global {
  namespace Express {
    interface Request {
      rawBody?: Buffer;
    }
  }
}

export const app = express();

app.disable("x-powered-by");
app.use((_request, response, next) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "same-origin");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  next();
});
app.use((request, _response, next) => {
  if (isDemoMode() && request.url.startsWith("/demo-api/v1/")) request.url = request.url.replace(/^\/demo-api/, "/api");
  next();
});
app.use("/demo-api/v1", proxyLocalDemo);
app.use(express.json({
  limit: "1mb",
  verify: (request, _response, buffer) => {
    (request as Request).rawBody = Buffer.from(buffer);
  },
}));

app.get("/health", (_request: Request, response: Response) => {
  response.json({ success: true, data: { status: "ok" } });
});
app.get("/ready", async (_request, response, next) => {
  try {
    const { prisma } = await import("./config/prisma");
    await prisma.$queryRaw`SELECT 1`;
    response.json({ success: true, data: { status: "ready" } });
  } catch (error) { next(error); }
});
app.use("/api/v1/auth", authRoutes);
app.use("/api/v1/demo", demoRoutes);
app.use("/api/v1/savings", savingsRoutes);
app.use("/api/v1/atp", atpRoutes);
app.use("/api/v1/webhooks", webhookRoutes);
app.use("/api/v1/dashboard", dashboardRoutes);
app.use("/api/v1/markets", marketRoutes);
app.use("/api/v1/perpetuals", perpetualsRoutes);
app.use("/api/v1/wealth", wealthRoutes, perpetualsRoutes);

app.use(express.static(path.join(__dirname, "web")));
app.get("/app", (_request, response) => {
  response.setHeader("X-Robots-Tag", "noindex");
  response.sendFile(path.join(__dirname, "web", "index.html"));
});

app.use((_request, response) => {
  response.status(404).json({
    success: false,
    error: { code: "NOT_FOUND", message: "Route was not found" },
  });
});
app.use(errorHandler);
