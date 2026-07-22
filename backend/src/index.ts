import "express-async-errors"; // must be first — patches Express to forward async throws to the error handler
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { startCron } from "./lib/cron";
import fs from "fs";
import path from "path";
import rateLimit from "express-rate-limit";
import { env } from "./env";
import { renderAcceptInvitePage } from "./pages/accept-invite";
import { adminRouter } from "./routes/admin.routes";
import { alertsRouter } from "./routes/alerts.routes";
import { authRouter } from "./routes/auth.routes";
import { billingRouter } from "./routes/billing.routes";
import { clinicsRouter } from "./routes/clinics.routes";
import { communicationsRouter } from "./routes/communications.routes";
import { dashboardRouter } from "./routes/dashboard.routes";
import { notesRouter } from "./routes/notes.routes";
import { patientsRouter } from "./routes/patients.routes";
import { timeLogsRouter } from "./routes/time-logs.routes";
import { devicesRouter } from "./routes/devices.routes";
import { workflowsRouter } from "./routes/workflows.routes";
import { reportsRouter } from "./routes/reports.routes";

const app = express();

// Behind Traefik in production — trust exactly one hop so req.ip (and
// express-rate-limit's keying) uses the real client IP from X-Forwarded-For
// instead of Traefik's own container IP. Without this, every request looked
// like it came from the same IP, so the 120 req/min API limiter below was
// effectively a single shared budget across every user of the app combined.
app.set("trust proxy", 1);

app.use(cors({ origin: env.CORS_ORIGIN }));
app.use(express.json());
app.use(express.urlencoded({ extended: false })); // Twilio webhooks POST as x-www-form-urlencoded

// Strict limit on auth endpoints to prevent brute-force attacks
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many attempts. Please try again in 15 minutes." },
  skipSuccessfulRequests: true,
});

// General limit on all API traffic
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many requests. Please slow down." },
});

app.use("/api/auth/login", authLimiter);
app.use("/api/auth/refresh", authLimiter);
app.use("/api", apiLimiter);

app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/accept-invite", (_req, res) => res.type("html").send(renderAcceptInvitePage()));

app.use("/api/auth",           authRouter);
app.use("/api/admin",          adminRouter);
app.use("/api/billing",        billingRouter);
app.use("/api/clinics",        clinicsRouter);
app.use("/api/alerts",         alertsRouter);
app.use("/api/communications", communicationsRouter);
app.use("/api/dashboard",      dashboardRouter);
app.use("/api/notes",          notesRouter);
app.use("/api/patients",       patientsRouter);
app.use("/api/time-logs",      timeLogsRouter);
app.use("/api/devices",        devicesRouter);
app.use("/api/workflows",      workflowsRouter);
app.use("/api/reports",        reportsRouter);

// Unknown /api/* routes → JSON 404
app.use("/api", (_req, res) => res.status(404).json({ error: "Not found." }));

// Serve the built Expo web app (output of `npm run build:frontend`).
// Any non-API path falls back to index.html so client-side routing works.
const staticDir = process.env.STATIC_DIR ?? path.resolve(process.cwd(), "../frontend/dist");
if (fs.existsSync(staticDir)) {
  app.use(express.static(staticDir));
  app.get("*", (_req, res) => res.sendFile(path.join(staticDir, "index.html")));
} else {
  app.get("/", (_req, res) =>
    res.type("html").send(
      `<h2 style="font-family:sans-serif;padding:2rem">RPMCares API is running.<br>
       <small>No frontend build found. Run <code>npm run build:full</code> to serve the UI here.</small></h2>`
    )
  );
}

// Global error handler — catches any unhandled throw from async route handlers
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error("Unhandled error:", err);
  if (res.headersSent) return;
  res.status(500).json({ error: "Internal server error." });
});

app.listen(env.PORT, () => {
  console.log(`RPMCares backend listening on port ${env.PORT}`);
  startCron();
});
