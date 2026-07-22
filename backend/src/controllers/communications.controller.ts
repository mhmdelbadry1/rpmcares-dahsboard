import type { Request, Response } from "express";
import { supabaseAdmin } from "../lib/supabase";
import { findPatientById } from "../models/patient";
import { recordReviewTime, updateReviewTimeSummary } from "../services/review-time";
import { transcribeAndSummarizeCall, geminiConfigured } from "../services/gemini";
import {
  generateVoiceToken, generateInboundToken,
  sendSms, buildDialTwiml, buildInboundRouteTwiml, twilioConfigured,
} from "../services/twilio";
import { env } from "../env";

// ── List communication logs ────────────────────────────────────────────────

export async function listCommunications(req: Request, res: Response): Promise<void> {
  const profile = req.profile!;
  const { patientId, limit = "100" } = req.query as Record<string, string>;

  let q = supabaseAdmin
    .from("communications_log")
    .select("*, profiles!communications_log_staff_id_fkey(name)")
    .order("occurred_at", { ascending: false })
    .limit(parseInt(limit));

  if (patientId) q = q.eq("patient_id", patientId);
  else if (profile.role === "clinic_admin" && profile.clinic_id) q = q.eq("clinic_id", profile.clinic_id);

  const { data, error } = await q;
  if (error) { res.status(500).json({ error: error.message }); return; }

  const logs = (data ?? []).map((row: any) => ({
    ...row,
    staff_name: row.profiles?.name ?? null,
    profiles: undefined,
  }));

  res.json({ logs });
}

// ── Create manual communication log ───────────────────────────────────────

export async function createCommunication(req: Request, res: Response): Promise<void> {
  const profile = req.profile!;
  const {
    patient_id, clinic_id, comm_type, direction,
    duration_seconds, summary, transcript, occurred_at, twilio_sid,
  } = req.body;

  if (!patient_id) {
    res.status(400).json({ error: "patient_id is required." });
    return;
  }

  const patient = await findPatientById(patient_id);
  const resolvedClinicId: string | null = clinic_id ?? profile.clinic_id ?? patient?.clinic_id ?? null;
  const occurredAt = occurred_at ?? new Date().toISOString();

  const { data, error } = await supabaseAdmin
    .from("communications_log")
    .insert({
      patient_id,
      clinic_id:        resolvedClinicId,
      staff_id:         profile.id,
      comm_type:        comm_type        ?? "call",
      direction:        direction        ?? "outbound",
      duration_seconds: duration_seconds ?? null,
      summary:          summary          ?? null,
      transcript:       transcript       ?? null,
      twilio_sid:       twilio_sid       ?? null,
      occurred_at:      occurredAt,
    })
    .select()
    .single();

  if (error) { res.status(500).json({ error: error.message }); return; }

  if ((comm_type ?? "call") === "call" && duration_seconds && duration_seconds > 0 && patient) {
    recordReviewTime({
      patient,
      durationSeconds:    duration_seconds,
      note:               `Outbound call — ${new Date(occurredAt).toLocaleDateString()}`,
      patientInteraction: true,
      loggedByName:       profile.name ?? "Staff",
      staffId:            profile.id,
      source:             "call",
      callDirection:      "outbound",
      commLogId:          data.id,
    }).catch((e) => console.warn("[create-communication] review-time record failed:", e));
  }

  res.status(201).json({ log: data });
}

// ── Inbound call answered ───────────────────────────────────────────────────
// POST /api/communications/call-accepted
// Called by the browser the instant it accepts an incoming call — this is
// how we know WHICH staff member answered (all browsers share the same
// "rpmcares_inbound" Twilio identity, so the server-side dial-status webhook
// has no way to tell them apart on its own). twilio_sid is the call's
// ParentCallSid, injected into the TwiML as a <Parameter> — NOT the browser
// Client leg's own CallSid, which is a different value.

export async function callAccepted(req: Request, res: Response): Promise<void> {
  const profile = req.profile!;
  const { patient_id, twilio_sid } = req.body as { patient_id?: string; twilio_sid?: string };
  if (!patient_id || !twilio_sid) {
    res.status(400).json({ error: "patient_id and twilio_sid are required." });
    return;
  }

  const { data: pat } = await supabaseAdmin
    .from("patients").select("clinic_id").eq("id", patient_id).maybeSingle();

  const { data, error } = await supabaseAdmin
    .from("communications_log")
    .insert({
      patient_id,
      clinic_id:        pat?.clinic_id ?? null,
      staff_id:         profile.id,
      comm_type:        "call",
      direction:        "inbound",
      duration_seconds: null, // filled in by dial-status once the call ends
      summary:          "Inbound call",
      twilio_sid,
      occurred_at:      new Date().toISOString(),
    })
    .select()
    .single();

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.status(201).json({ log: data });
}

// ── Twilio: browser Access Token ───────────────────────────────────────────
// GET /api/communications/token
// Returns a short-lived Twilio Access Token so the browser Voice SDK can
// place outbound calls. The identity is the staff member's user ID.

export async function getVoiceToken(req: Request, res: Response): Promise<void> {
  if (!twilioConfigured()) {
    res.status(503).json({ error: "Twilio is not configured on this server." });
    return;
  }
  try {
    const token = generateVoiceToken(req.profile!.id);
    res.json({ token });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
}

// ── Twilio: inbound browser token ─────────────────────────────────────────
// GET /api/communications/inbound-token
// Returns a Twilio Access Token for the shared "rpmcares_inbound" identity.
// All staff browsers register with this token; when a patient calls, every
// open tab rings simultaneously and the first to accept gets the call.

export async function getInboundToken(req: Request, res: Response): Promise<void> {
  if (!twilioConfigured()) {
    res.status(503).json({ error: "Twilio is not configured." });
    return;
  }
  try {
    const token = generateInboundToken();
    res.json({ token });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
}

// ── Twilio: dial-status callback ───────────────────────────────────────────
// POST /api/communications/dial-status   (PUBLIC — Twilio calls this)
// Fires after a <Dial> leg ends. Handles all inbound call logging so the
// twimlVoiceWebhook doesn't have to guess whether the call was answered.

export async function dialStatusCallback(req: Request, res: Response): Promise<void> {
  const from: string       = req.body?.From             ?? "";
  const callSid: string    = req.body?.CallSid          ?? "";
  const dialStatus: string = req.body?.DialCallStatus   ?? "";
  const dialDuration       = parseInt(req.body?.DialCallDuration ?? "0", 10) || 0;

  console.log("[dial-status] from=%s sid=%s status=%s duration=%d", from, callSid, dialStatus, dialDuration);

  // Twilio sends DialCallStatus="completed" when a <Client> answers and the
  // call ends normally. "answered" is never sent for <Client> dials.
  const answered = dialStatus === "completed" || dialStatus === "answered";
  const summary   = answered
    ? `Inbound call${dialDuration ? ` · ${Math.floor(dialDuration / 60)}:${String(dialDuration % 60).padStart(2, "0")}` : ""}`
    : "Missed call";

  if (from) {
    // If the answering browser already created a row for this call (via
    // /call-accepted at accept-time, which is how we know WHO answered),
    // update it with the final duration instead of inserting a duplicate.
    const { data: existingRows, error: updateError } = await supabaseAdmin
      .from("communications_log")
      .update({
        duration_seconds: answered ? dialDuration : null,
        summary,
      })
      .eq("twilio_sid", callSid)
      .select("id, patient_id, clinic_id, staff_id, profiles!communications_log_staff_id_fkey(name)")
      .maybeSingle();
    if (updateError) console.warn("[dial-status] update failed:", updateError.message);

    if (existingRows) {
      console.log("[dial-status] updated existing row for call %s (answered by staff %s)", callSid, existingRows.staff_id);
      if (answered && dialDuration > 0 && existingRows.staff_id) {
        const patient = await findPatientById(existingRows.patient_id);
        const staffName = (existingRows as any).profiles?.name ?? "Staff";
        if (patient) {
          recordReviewTime({
            patient,
            durationSeconds:    dialDuration,
            note:               `Inbound call — ${new Date().toLocaleDateString()}`,
            patientInteraction: true,
            loggedByName:       staffName,
            staffId:            existingRows.staff_id,
            source:             "call",
            callDirection:      "inbound",
            commLogId:          existingRows.id,
          }).catch((e) => console.warn("[dial-status] review-time record failed:", e));
        }
      }
    } else {
      // No accept-time row exists — call was never answered (rang out / no browser accepted).
      const digits = from.replace(/\D/g, "");
      const last10 = digits.slice(-10);
      const e164   = `+${digits}`;

      const { data: exact } = await supabaseAdmin
        .from("patients").select("id, clinic_id").eq("phone", e164).limit(1);
      let patient: { id: any; clinic_id: any } | null = (exact ?? [])[0] ?? null;

      if (!patient) {
        const { data: all } = await supabaseAdmin
          .from("patients").select("id, clinic_id, phone").not("phone", "is", null).limit(5000);
        patient = (all ?? []).find((p: any) => p.phone.replace(/\D/g, "").slice(-10) === last10) ?? null;
      }

      if (patient) {
        const { error } = await supabaseAdmin.from("communications_log").insert({
          patient_id:       patient.id,
          clinic_id:        patient.clinic_id ?? null,
          staff_id:         null,
          comm_type:        "call",
          direction:        "inbound",
          duration_seconds: null,
          summary:          "Missed call",
          twilio_sid:       callSid || null,
          occurred_at:      new Date().toISOString(),
        });
        if (error) console.warn("[dial-status] missed-call insert failed:", error.message);
        else console.log("[dial-status] logged missed call for patient %s", patient.id);
      } else {
        console.log("[dial-status] no patient found for", from);
      }
    }
  }

  // Return TwiML; for no-answer play a fallback message on the still-open PSTN leg.
  const { VoiceResponse } = (await import("twilio")).default.twiml;
  const response = new VoiceResponse();
  if (dialStatus !== "completed" && dialStatus !== "answered") {
    response.say(
      { voice: "Polly.Joanna" },
      "No one is available to take your call right now. " +
      "Please contact your clinic directly or try again later. Goodbye.",
    );
    response.hangup();
  }
  res.type("text/xml").send(response.toString());
}

// ── Twilio: send SMS ───────────────────────────────────────────────────────
// POST /api/communications/sms
// Body: { patient_id, to, body, clinic_id? }

export async function sendSmsHandler(req: Request, res: Response): Promise<void> {
  if (!twilioConfigured()) {
    res.status(503).json({ error: "Twilio is not configured on this server." });
    return;
  }

  const profile = req.profile!;
  const { patient_id, to, body: msgBody, clinic_id } = req.body as Record<string, string>;

  if (!patient_id || !to || !msgBody) {
    res.status(400).json({ error: "patient_id, to, and body are required." });
    return;
  }

  // Resolve clinic_id — super_admin has no clinic_id on their profile,
  // so fall back to the patient's own clinic_id to avoid a NOT NULL violation.
  let resolvedClinicId: string | null = clinic_id ?? profile.clinic_id ?? null;
  if (!resolvedClinicId) {
    const { data: pat } = await supabaseAdmin
      .from("patients")
      .select("clinic_id")
      .eq("id", patient_id)
      .single();
    resolvedClinicId = pat?.clinic_id ?? null;
  }

  let sid: string;
  try {
    sid = await sendSms(to, msgBody);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: `Twilio SMS failed: ${msg}` });
    return;
  }

  const occurredAt = new Date().toISOString();

  const { data, error } = await supabaseAdmin
    .from("communications_log")
    .insert({
      patient_id,
      clinic_id:        resolvedClinicId,
      staff_id:         profile.id,
      comm_type:        "sms",
      direction:        "outbound",
      duration_seconds: null,
      summary:          msgBody.slice(0, 200),
      transcript:       msgBody,
      occurred_at:      occurredAt,
      twilio_sid:       sid,
    })
    .select()
    .single();

  if (error) {
    console.error("[sms] Log insert failed:", error.message);
    // SMS was already sent — return 207 so the frontend knows to show "sent but unlogged"
    res.status(207).json({ ok: true, sid, log: null, logError: error.message });
    return;
  }

  res.status(201).json({ ok: true, sid, log: data });
}

// ── Mark patient conversation as read ─────────────────────────────────────
// POST /api/communications/mark-read   body: { patient_id }

export async function markRead(req: Request, res: Response): Promise<void> {
  const { patient_id } = req.body as { patient_id?: string };
  if (!patient_id) { res.status(400).json({ error: "patient_id required" }); return; }

  const { error } = await supabaseAdmin
    .from("comm_last_viewed")
    .upsert(
      { patient_id, staff_id: req.profile!.id, viewed_at: new Date().toISOString() },
      { onConflict: "patient_id,staff_id" },
    );

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ ok: true });
}

// ── Unread counts + last-message summaries ─────────────────────────────────
// GET /api/communications/unread

export async function getUnreadCounts(req: Request, res: Response): Promise<void> {
  const staffId = req.profile!.id;

  const { data, error } = await supabaseAdmin
    .rpc("get_comm_summaries", { p_staff_id: staffId });

  if (error) { res.status(500).json({ error: error.message }); return; }

  const result: Record<string, { unread: number; lastAt: string; lastSummary: string | null; lastCommType: string; hasCall: boolean; hasSms: boolean }> = {};
  for (const row of (data ?? []) as any[]) {
    result[row.patient_id] = {
      unread:       Number(row.unread_count),
      lastAt:       row.last_at,
      lastSummary:  row.last_summary,
      lastCommType: row.last_comm_type,
      hasCall:      Boolean(row.has_call),
      hasSms:       Boolean(row.has_sms),
    };
  }

  res.json({ counts: result });
}

// ── Twilio: inbound SMS webhook ────────────────────────────────────────────
// POST /api/communications/inbound-sms   (PUBLIC — Twilio calls this)
// Twilio sends this when a patient replies to your number.
// Saves the message as an inbound SMS in communications_log.

export async function inboundSmsWebhook(req: Request, res: Response): Promise<void> {
  const from: string       = req.body?.From       ?? req.body?.from       ?? "";
  const body: string       = req.body?.Body       ?? req.body?.body       ?? "";
  const messageSid: string = req.body?.MessageSid ?? req.body?.messageSid ?? "";

  console.log("[inbound-sms] from=%s sid=%s body=%s", from, messageSid, body.slice(0, 50));

  if (!from) {
    res.type("text/xml").status(200).send("<?xml version=\"1.0\"?><Response/>");
    return;
  }

  // Normalise to E.164
  const digits   = from.replace(/\D/g, "");
  const e164     = from.startsWith("+") ? from.replace(/\D/g, "").replace(/^/, "+") : `+${digits}`;
  // Last 10 digits — used for fuzzy matching against any stored format (dashes, spaces, etc.)
  const last10   = digits.slice(-10);

  // 1. Exact E.164 match
  const { data: exact } = await supabaseAdmin
    .from("patients")
    .select("id, clinic_id")
    .eq("phone", e164)
    .limit(1);

  let patient = exact?.[0] ?? null;

  if (!patient) {
    // 2. Load all patients with a phone and compare digits-only (handles any stored format)
    const { data: all } = await supabaseAdmin
      .from("patients")
      .select("id, clinic_id, phone")
      .not("phone", "is", null)
      .limit(5000);
    const match = (all ?? []).find(p => p.phone.replace(/\D/g, "").slice(-10) === last10);
    patient = match ?? null;
  }

  if (patient) {
    const { error } = await supabaseAdmin.from("communications_log").insert({
      patient_id:  patient.id,
      clinic_id:   patient.clinic_id ?? null,
      staff_id:    null,
      comm_type:   "sms",
      direction:   "inbound",
      summary:     body.slice(0, 200),
      transcript:  body,
      twilio_sid:  messageSid || null,
      occurred_at: new Date().toISOString(),
    });
    if (error) console.warn("[inbound-sms] log insert failed:", error.message);
    else console.log("[inbound-sms] saved for patient %s", patient.id);
  } else {
    console.warn("[inbound-sms] No patient found for", e164, "/ last10", last10);
    // Auto-reply so the unknown sender knows they reached the wrong line
    const xml = `<?xml version="1.0"?><Response><Message>This number is used by RPMCares clinical staff to contact patients. If you are a patient, please reply from the phone number on file with your clinic.</Message></Response>`;
    res.type("text/xml").status(200).send(xml);
    return;
  }

  // Twilio expects a 200 TwiML response; empty = no auto-reply
  res.type("text/xml").status(200).send("<?xml version=\"1.0\"?><Response/>");
}

// ── Twilio: recording status callback ─────────────────────────────────────
// POST /api/communications/recording-status   (PUBLIC — Twilio calls this)
// Fires when a call recording is ready. Stores the recording URL, then
// (best-effort, non-blocking) transcribes + summarizes it via Gemini and
// saves the summary as an AI-generated care note.

export async function recordingStatusCallback(req: Request, res: Response): Promise<void> {
  const callSid: string      = req.body?.CallSid       ?? "";
  const recordingUrl: string = req.body?.RecordingUrl  ?? "";

  if (callSid && recordingUrl) {
    const { data: row, error } = await supabaseAdmin
      .from("communications_log")
      .update({ recording_url: recordingUrl })
      .eq("twilio_sid", callSid)
      .select("id, patient_id, clinic_id, staff_id, direction")
      .maybeSingle();
    if (error) console.warn("[recording-status] update failed:", error.message);

    // Twilio only waits ~15s for this response before retrying the webhook —
    // acknowledge immediately and do the slow AI work after responding.
    res.sendStatus(204);

    if (row && geminiConfigured()) {
      transcribeAndSummarizeCall(recordingUrl)
        .then(async (result) => {
          if (!result) return;
          await supabaseAdmin
            .from("communications_log")
            .update({ transcript: result.transcript, ai_summary: result.summary })
            .eq("id", row.id);
          await supabaseAdmin.from("care_notes").insert({
            patient_id:      row.patient_id,
            clinic_id:       row.clinic_id,
            author_id:       row.staff_id,
            note_type:       "call_summary",
            content:         { summary: result.summary, call_direction: row.direction },
            ai_generated:    true,
            ai_generated_at: new Date().toISOString(),
            status:          "draft",
            comm_log_id:     row.id,
          });
          await updateReviewTimeSummary(row.id, result.summary);
          console.log("[recording-status] transcript + AI summary saved for call %s", callSid);
        })
        .catch((e) => console.warn("[recording-status] transcription failed:", e));
    }
    return;
  }

  res.sendStatus(204);
}

// ── Twilio: TwiML voice webhook ────────────────────────────────────────────
// POST /api/communications/twiml   (PUBLIC — Twilio calls this directly)
// Twilio sends `To` in the request body when the browser SDK places a call.
// This returns TwiML telling Twilio to dial that number.

export async function twimlVoiceWebhook(req: Request, res: Response): Promise<void> {
  const to     = (req.body?.To     ?? req.body?.to     ?? "") as string;
  const from   = (req.body?.From   ?? req.body?.from   ?? "") as string;
  const callSid = (req.body?.CallSid ?? "") as string;

  const { VoiceResponse } = (await import("twilio")).default.twiml;

  // Inbound PSTN: To = our Twilio number. Outbound browser SDK: To = patient's number.
  // The SDK also sends Direction=inbound for outbound calls, so Direction is useless here.
  if (!to || to === env.TWILIO_FROM_NUMBER) {
    if (from) {
      const digits = from.replace(/\D/g, "");
      const last10 = digits.slice(-10);
      const e164   = `+${digits}`;

      const { data: exact } = await supabaseAdmin
        .from("patients").select("id, clinic_id, full_name").eq("phone", e164).limit(1);
      let patient: { id: string; clinic_id: string | null; full_name: string } | null = (exact ?? [])[0] ?? null;

      if (!patient) {
        const { data: all } = await supabaseAdmin
          .from("patients").select("id, clinic_id, phone, full_name").not("phone", "is", null).limit(5000);
        patient = (all ?? []).find((p: any) => p.phone.replace(/\D/g, "").slice(-10) === last10) ?? null;
      }

      if (patient) {
        // Known patient — ring all registered browser tabs simultaneously.
        // Logging (answered vs missed) is handled by the dial-status callback.
        const base = env.PUBLIC_URL ?? env.APP_BASE_URL;
        const actionUrl = `${base}/api/communications/dial-status`;
        const recordingUrl = `${base}/api/communications/recording-status`;
        console.log("[twiml] routing inbound call from patient %s to rpmcares_inbound", patient.id);
        res.type("text/xml").send(buildInboundRouteTwiml(actionUrl, callSid, recordingUrl));
        return;
      }

      console.log("[twiml] inbound call from unknown number", from);
    }

    // Unknown caller — play a polite message
    const r = new VoiceResponse();
    r.say(
      { voice: "Polly.Joanna" },
      "Thank you for calling RPM Cares. This line is used by our clinical team to reach patients. " +
      "Please contact your clinic directly or call back the number your care team uses to reach you. Goodbye.",
    );
    r.hangup();
    res.type("text/xml").send(r.toString());
    return;
  }

  const twiml = buildDialTwiml(to);
  res.type("text/xml").send(twiml);
}
