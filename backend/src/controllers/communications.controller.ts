import type { Request, Response } from "express";
import { supabaseAdmin } from "../lib/supabase";
import { findPatientById, findPatientByPhone } from "../models/patient";
import { findProfileById } from "../models/profile";
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

  // Non-super_admins are scoped to their own clinic — for a specific patient
  // this also blocks viewing another clinic's patient by guessing their ID.
  if (patientId && profile.role !== "super_admin" && profile.clinic_id) {
    const patient = await findPatientById(patientId);
    if (patient && patient.clinic_id !== profile.clinic_id) {
      res.status(403).json({ error: "Access denied." });
      return;
    }
  }

  let q = supabaseAdmin
    .from("communications_log")
    .select("*, profiles!communications_log_staff_id_fkey(name)")
    .order("occurred_at", { ascending: false })
    .limit(parseInt(limit));

  if (patientId) q = q.eq("patient_id", patientId);
  else if (profile.role !== "super_admin" && profile.clinic_id) q = q.eq("clinic_id", profile.clinic_id);

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

  // Upserts atomically keyed on twilio_sid — if the dial-status webhook
  // already finalized this call (race: a very short call can end and fire
  // its webhook before this request lands), this only fills in staff_id and
  // never clobbers the already-final duration_seconds/summary. p_is_final
  // false means "don't touch duration/summary if the row already exists".
  const { data, error } = await supabaseAdmin.rpc("upsert_inbound_call_leg", {
    p_twilio_sid:       twilio_sid,
    p_patient_id:       patient_id,
    p_clinic_id:        pat?.clinic_id ?? null,
    p_staff_id:         profile.id,
    p_duration_seconds: null,
    p_summary:          "Inbound call",
    p_occurred_at:      new Date().toISOString(),
    p_is_final:         false,
  }).single();

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
    // Same patient lookup regardless of whether /call-accepted already ran —
    // upsert_inbound_call_leg's ON CONFLICT keeps whichever patient/clinic
    // was set first, so this is a no-op if the accept-time row already has it.
    const patient = await findPatientByPhone(from);

    if (patient) {
      // Atomically create-or-finalize this call's row keyed on twilio_sid.
      // p_is_final=true means THIS write's duration_seconds/summary always
      // wins — it's the real, authoritative outcome from Twilio, so unlike
      // the old code, a race where this fires before /call-accepted's insert
      // lands no longer mislabels an answered call as "Missed call".
      const { data, error } = await supabaseAdmin.rpc("upsert_inbound_call_leg", {
        p_twilio_sid:       callSid || null,
        p_patient_id:       patient.id,
        p_clinic_id:        patient.clinic_id ?? null,
        p_staff_id:         null,
        p_duration_seconds: answered ? dialDuration : null,
        p_summary:          summary,
        p_occurred_at:      new Date().toISOString(),
        p_is_final:         true,
      }).single();
      const row = data as { id: string; staff_id: string | null } | null;

      if (error || !row) {
        console.warn("[dial-status] upsert failed:", error?.message);
      } else {
        console.log("[dial-status] finalized call %s (answered by staff %s)", callSid, row.staff_id);
        if (answered && dialDuration > 0 && row.staff_id) {
          const [staffName, fullPatient] = await Promise.all([
            findProfileById(row.staff_id).then((p) => p?.name ?? "Staff"),
            findPatientById(patient.id),
          ]);
          if (fullPatient) {
            recordReviewTime({
              patient:            fullPatient,
              durationSeconds:    dialDuration,
              note:               `Inbound call — ${new Date().toLocaleDateString()}`,
              patientInteraction: true,
              loggedByName:       staffName,
              staffId:            row.staff_id,
              source:             "call",
              callDirection:      "inbound",
              commLogId:          row.id,
            }).catch((e) => console.warn("[dial-status] review-time record failed:", e));
          }
        }
      }
    } else {
      console.log("[dial-status] no patient found for", from);
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
  const profile = req.profile!;

  const { data, error } = await supabaseAdmin
    .rpc("get_comm_summaries", {
      p_staff_id:  profile.id,
      p_clinic_id: profile.role === "super_admin" ? null : profile.clinic_id,
    });

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

  const patient = await findPatientByPhone(from);
  const e164    = from.startsWith("+") ? from : `+${from.replace(/\D/g, "")}`;

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
    console.warn("[inbound-sms] No patient found for", e164);
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
      const patient = await findPatientByPhone(from);

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

  // Outbound: staff browser identity is embedded by Twilio as "client:<staffId>"
  // (see generateVoiceToken, which uses profile.id as the identity).
  const staffId  = from.startsWith("client:") ? from.slice("client:".length) : null;
  const patient  = await findPatientByPhone(to);
  const base     = env.PUBLIC_URL ?? env.APP_BASE_URL;
  const params   = new URLSearchParams();
  if (patient) params.set("patientId", patient.id);
  if (staffId) params.set("staffId", staffId);
  const actionUrl = `${base}/api/communications/outbound-dial-status${params.toString() ? `?${params}` : ""}`;

  const twiml = buildDialTwiml(to, actionUrl);
  res.type("text/xml").send(twiml);
}

// ── Twilio: outbound dial-status callback ──────────────────────────────────
// POST /api/communications/outbound-dial-status   (PUBLIC — Twilio calls this)
// Fires after the outbound <Dial> leg ends (see buildDialTwiml). This — not
// the browser Voice SDK's own `accept` event — is the authoritative source
// for whether the patient actually answered: `accept` fires as soon as
// Twilio bridges media to the calling browser, which happens before the
// dialed phone rings, so a ring-out-to-no-answer still looked "connected"
// client-side. Mirrors dialStatusCallback's inbound handling.

export async function outboundDialStatusCallback(req: Request, res: Response): Promise<void> {
  const callSid: string    = req.body?.CallSid        ?? "";
  const dialStatus: string = req.body?.DialCallStatus  ?? "";
  const dialDuration       = parseInt(req.body?.DialCallDuration ?? "0", 10) || 0;
  const { patientId, staffId } = req.query as { patientId?: string; staffId?: string };

  const answered = dialStatus === "completed" || dialStatus === "answered";
  console.log("[outbound-dial-status] sid=%s status=%s duration=%d patient=%s", callSid, dialStatus, dialDuration, patientId);

  if (patientId) {
    const patient = await findPatientById(patientId);
    // DialCallStatus distinguishes *why* it wasn't answered — "canceled" means
    // the staff member hung up before the patient's phone was reached at all
    // (different from "no-answer", which means it rang out unanswered).
    const outcome = answered && dialDuration > 0
      ? `${Math.floor(dialDuration / 60)}:${String(dialDuration % 60).padStart(2, "0")}`
      : dialStatus === "canceled" ? "Canceled"
      : dialStatus === "busy"     ? "Busy"
      : dialStatus === "failed"   ? "Call failed"
      : "No answer";
    const summary = `Outbound call · ${outcome}`;

    let staffName = "Staff";
    if (staffId) {
      const { data: prof } = await supabaseAdmin.from("profiles").select("name").eq("id", staffId).maybeSingle();
      staffName = prof?.name ?? staffName;
    }

    const { data: row, error } = await supabaseAdmin
      .from("communications_log")
      .insert({
        patient_id:       patientId,
        clinic_id:        patient?.clinic_id ?? null,
        staff_id:         staffId ?? null,
        comm_type:        "call",
        direction:        "outbound",
        duration_seconds: answered && dialDuration > 0 ? dialDuration : null,
        summary,
        twilio_sid:       callSid || null,
        occurred_at:      new Date().toISOString(),
      })
      .select()
      .single();

    if (error) {
      console.warn("[outbound-dial-status] insert failed:", error.message);
    } else if (answered && dialDuration > 0 && staffId && patient) {
      recordReviewTime({
        patient,
        durationSeconds:    dialDuration,
        note:               `Outbound call — ${new Date().toLocaleDateString()}`,
        patientInteraction: true,
        loggedByName:       staffName,
        staffId,
        source:             "call",
        callDirection:      "outbound",
        commLogId:          row.id,
      }).catch((e) => console.warn("[outbound-dial-status] review-time record failed:", e));
    }
  }

  res.type("text/xml").send("<Response/>");
}

// ── Twilio: voice fallback ─────────────────────────────────────────────────
// POST /api/communications/voice-fallback   (PUBLIC — Twilio calls this)
// Configured as the Voice Fallback URL on both the TwiML App (outbound) and
// the phone number (inbound) — Twilio calls this instead of playing its own
// generic "an application error has occurred" message whenever the primary
// voice webhook fails to respond (5xx, timeout, deploy restart, etc).

export async function voiceFallbackWebhook(_req: Request, res: Response): Promise<void> {
  const { VoiceResponse } = (await import("twilio")).default.twiml;
  const response = new VoiceResponse();
  response.say(
    { voice: "Polly.Joanna" },
    "This number is not available right now. Please call back later, or send a text message.",
  );
  response.hangup();
  res.type("text/xml").send(response.toString());
}
