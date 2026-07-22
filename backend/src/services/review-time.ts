import { supabaseAdmin } from "../lib/supabase";
import { findPatientById } from "../models/patient";
import type { PatientRecord } from "../models/patient";
import { getSmartMeterManualReview, deleteSmartMeterReviewTime } from "./smartmeter";
import { postTenoviReviewTime, postTenoviCallSummaryEvent } from "./tenovi";

async function getSmartMeterApiKey(clinicId: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from("clinics")
    .select("smartmeter_api_key")
    .eq("id", clinicId)
    .maybeSingle();
  return (data as any)?.smartmeter_api_key ?? null;
}

export type RecordReviewTimeParams = {
  patient: PatientRecord;
  durationSeconds: number;
  note: string | null;
  patientInteraction: boolean;
  loggedByName: string;
  staffId: string | null;
  source: "manual" | "call";
  callDirection?: "inbound" | "outbound";
  commLogId?: string | null;
};

/**
 * Single writer for public.patient_review_times — the table the patient's
 * "Review Time" tab reads and the billing engine sums minutes from (combined
 * with time_logs). Anything that logs clinical review time (manual entry,
 * outbound call, inbound call) must go through here, never insert directly —
 * inserting the same duration into both time_logs and patient_review_times
 * double-counts billing minutes.
 *
 * Best-effort pushes the same duration to the patient's real external system
 * (SmartMeter or Tenovi) so it's reflected in their official clinical record,
 * matching what a human logging review time in that portal would create.
 */
export async function recordReviewTime(params: RecordReviewTimeParams) {
  const { patient, durationSeconds, note, patientInteraction, loggedByName, staffId, source, callDirection, commLogId } = params;
  const clockStart = new Date().toISOString();

  let smReviewTimeId: number | null = null;
  let tenoviEventId: string | null = null;
  let tenoviReviewLogId: string | null = null;

  if (patient.source === "smartmeter") {
    const apiKey = await getSmartMeterApiKey(patient.clinic_id);
    if (apiKey) {
      try {
        const result = await getSmartMeterManualReview(
          apiKey, patient.external_patient_id, clockStart, durationSeconds,
          note, patientInteraction,
        );
        smReviewTimeId = result?.review_time_id ?? null;
      } catch (e) {
        console.warn("[review-time] SmartMeter push failed:", e);
      }
    }
  } else if (patient.source === "tenovi" && (patient.program === "RPM" || patient.program === "RTM")) {
    const { eventEndId, reviewLogId } = await postTenoviReviewTime(
      patient.external_patient_id, patient.program, durationSeconds,
      note ?? `Review — ${new Date(clockStart).toLocaleDateString()}`, loggedByName,
    );
    tenoviEventId = eventEndId;
    tenoviReviewLogId = reviewLogId;
  }

  const { data: entry, error } = await supabaseAdmin
    .from("patient_review_times")
    .insert({
      patient_id:            patient.id,
      sm_review_time_id:     smReviewTimeId,
      tenovi_event_id:       tenoviEventId,
      tenovi_review_log_id:  tenoviReviewLogId,
      clock_start:           clockStart,
      duration_seconds:      durationSeconds,
      note,
      patient_interaction:   patientInteraction,
      logged_by:             loggedByName,
      staff_id:              staffId,
      source,
      call_direction:        callDirection ?? null,
      comm_log_id:           commLogId ?? null,
      synced_at:             clockStart,
    })
    .select("*")
    .single();

  if (error) throw new Error(`patient_review_times insert failed: ${error.message}`);
  return entry;
}

/**
 * Calls log review time immediately at hang-up with a placeholder note
 * (the real content doesn't exist yet — Gemini takes a few seconds to
 * transcribe the recording). Once the AI summary is ready, this replaces
 * that placeholder everywhere it landed: locally, and on whichever external
 * system (SmartMeter/Tenovi) got the original push.
 *
 * SmartMeter has no update endpoint for a review-time entry, so this
 * deletes the placeholder one and recreates it with the real note —
 * same real-world effect as an edit. Tenovi's events are append-only, so
 * this posts the summary as a distinct supplementary event instead.
 */
export async function updateReviewTimeSummary(commLogId: string, summary: string): Promise<void> {
  const { data: entry } = await supabaseAdmin
    .from("patient_review_times")
    .select("*")
    .eq("comm_log_id", commLogId)
    .maybeSingle();
  if (!entry) return; // no review-time entry for this call (e.g. too short to log, or push failed entirely)

  const patient = await findPatientById(entry.patient_id);
  if (!patient) return;

  let newSmReviewTimeId: number | null = entry.sm_review_time_id ?? null;

  if (patient.source === "smartmeter" && entry.sm_review_time_id) {
    const apiKey = await getSmartMeterApiKey(patient.clinic_id);
    if (apiKey) {
      try {
        await deleteSmartMeterReviewTime(apiKey, patient.external_patient_id, entry.sm_review_time_id);
        const result = await getSmartMeterManualReview(
          apiKey, patient.external_patient_id, entry.clock_start, entry.duration_seconds,
          summary, entry.patient_interaction,
        );
        newSmReviewTimeId = result?.review_time_id ?? null;
      } catch (e) {
        console.warn("[review-time] SmartMeter note update failed:", e);
      }
    }
  } else if (patient.source === "tenovi" && (patient.program === "RPM" || patient.program === "RTM")) {
    await postTenoviCallSummaryEvent(patient.external_patient_id, patient.program, summary, entry.logged_by ?? "Staff");
  }

  await supabaseAdmin
    .from("patient_review_times")
    .update({ note: summary, sm_review_time_id: newSmReviewTimeId })
    .eq("id", entry.id);
}
