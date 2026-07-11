import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  SUPABASE_URL: z.string().url("SUPABASE_URL must be your Supabase project URL, e.g. https://xxxx.supabase.co"),
  SUPABASE_SERVICE_ROLE_KEY: z
    .string()
    .min(20, "SUPABASE_SERVICE_ROLE_KEY is required (Project Settings -> API -> service_role secret)"),
  SUPABASE_ANON_KEY: z
    .string()
    .min(20, "SUPABASE_ANON_KEY is required (Project Settings -> API -> anon/public key)"),
  // Public URL where this backend is reachable — used to build the invite-email
  // link (.../accept-invite). Must be added to Supabase Auth's allowed redirect
  // URLs (Authentication -> URL Configuration).
  APP_BASE_URL: z.string().url().default("http://localhost:4000"),
  PORT: z.coerce.number().default(4000),
  CORS_ORIGIN: z.string().default("*"),
  INGEST_SECRET: z.string().min(8).default("change-me-in-prod"),
  // Tenovi Hardware Integration API (HWI — device/gateway counts)
  TENOVI_API_KEY: z.string().optional(),
  TENOVI_CLIENT_DOMAIN: z.string().optional(),
  // Tenovi RPM Clinical API (patient data — TOTP login)
  TENOVI_USERNAME: z.string().optional(),
  TENOVI_PASSWORD: z.string().optional(),
  TENOVI_TOTP_SECRET: z.string().optional(),
  // SmartMeter RPM API
  SMARTMETER_API_KEY: z.string().optional(),
  SMARTMETER_BASE_URL: z.string().url().default("https://api.smartmeterrpm.com"),
  // Resend email (for invite emails sent directly by the backend)
  RESEND_API_KEY: z.string().optional(),
  INVITE_FROM_EMAIL: z.string().email().optional(),
  INVITE_FROM_NAME: z.string().default("RPMCares"),
  // Twilio (SMS + browser voice calling)
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_API_KEY: z.string().optional(),   // API Key SID (for Access Token)
  TWILIO_API_SECRET: z.string().optional(), // API Key Secret (for Access Token)
  TWILIO_TWIML_APP_SID: z.string().optional(),
  TWILIO_FROM_NUMBER: z.string().optional(),
  // Publicly reachable URL for Twilio callbacks (ngrok in dev, real domain in prod).
  // Falls back to APP_BASE_URL if not set.
  PUBLIC_URL: z.string().url().optional(),
});

export const env = envSchema.parse(process.env);
