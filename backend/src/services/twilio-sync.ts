import twilio from "twilio";
import { env } from "../env";
import { supabaseAdmin } from "../lib/supabase";

// ── Patient lookup (cached per call to avoid hammering DB) ─────────────────

async function findPatient(
  phone: string,
  cache: Map<string, { id: string; clinic_id: string | null } | null>,
) {
  if (cache.has(phone)) return cache.get(phone) ?? null;

  const normalised = phone.replace(/\s/g, "");

  const { data: exact } = await supabaseAdmin
    .from("patients")
    .select("id, clinic_id")
    .eq("phone", normalised)
    .limit(1);

  if (exact?.[0]) { cache.set(phone, exact[0]); return exact[0]; }

  const suffix = normalised.replace(/^\+?1/, "").slice(-10);
  const { data: fuzzy } = await supabaseAdmin
    .from("patients")
    .select("id, clinic_id")
    .ilike("phone", `%${suffix}`)
    .limit(1);

  const result = fuzzy?.[0] ?? null;
  cache.set(phone, result);
  return result;
}

// ── Core sync ──────────────────────────────────────────────────────────────
// Fetches Twilio SMS history (optionally since a cutoff date) and upserts
// into communications_log. Safe to call repeatedly — twilio_sid is the
// dedup key so existing rows are never duplicated.

export async function syncTwilioMessages(since?: Date): Promise<{ inserted: number; skipped: number; errors: number }> {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_FROM_NUMBER) {
    return { inserted: 0, skipped: 0, errors: 0 };
  }

  const client = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
  const filter = since ? { dateSentAfter: since } : {};

  const [outbound, inbound] = await Promise.all([
    client.messages.list({ from: env.TWILIO_FROM_NUMBER, ...filter }),
    client.messages.list({ to:   env.TWILIO_FROM_NUMBER, ...filter }),
  ]);

  // Dedup by sid in case a message appears in both lists
  const byId = new Map<string, (typeof outbound)[0]>();
  for (const m of [...outbound, ...inbound]) byId.set(m.sid, m);
  const all = [...byId.values()];

  const patientCache = new Map<string, { id: string; clinic_id: string | null } | null>();
  let inserted = 0, skipped = 0, errors = 0;

  for (const msg of all) {
    const isInbound    = msg.direction === "inbound";
    const patientPhone = isInbound ? String(msg.from) : String(msg.to);
    const patient      = await findPatient(patientPhone, patientCache);

    if (!patient) { skipped++; continue; }

    const row = {
      patient_id:  patient.id,
      clinic_id:   patient.clinic_id,
      staff_id:    null,
      comm_type:   "sms",
      direction:   isInbound ? "inbound" : "outbound",
      summary:     (msg.body ?? "").slice(0, 200),
      transcript:  msg.body ?? "",
      occurred_at: msg.dateSent?.toISOString() ?? new Date().toISOString(),
      twilio_sid:  msg.sid,
    };

    // onConflict requires migration 006_twilio_sid.sql to have been run
    let { error } = await supabaseAdmin
      .from("communications_log")
      .upsert(row, { onConflict: "twilio_sid", ignoreDuplicates: true });

    // Fall back to plain insert if the unique index hasn't been created yet
    if (error?.message?.includes("no unique or exclusion constraint")) {
      ({ error } = await supabaseAdmin.from("communications_log").insert(row));
    }

    if (error) { errors++; }
    else inserted++;
  }

  return { inserted, skipped, errors };
}
