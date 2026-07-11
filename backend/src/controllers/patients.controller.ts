import type { Request, Response } from "express";
import { supabaseAdmin, supabaseAnon } from "../lib/supabase";

// Normalize any phone string to E.164.
// - Always preserves explicit country code (+ or 00 prefix).
// - Only adds +1 for bare 10-digit numbers (US/CA assumption).
// - International numbers (UAE +971, etc.) must include the country code when entered.
export function normalizePhone(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return undefined;
  if (trimmed.startsWith("+"))  return `+${digits}`;                        // +971... +1... +20...
  if (trimmed.startsWith("00")) return `+${digits.slice(2)}`;               // 00971... international dialing prefix
  if (digits.length === 10)     return `+1${digits}`;                       // bare US 10-digit
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;  // 1XXXXXXXXXX US
  return `+${digits}`;                                                       // pass through — assume country code included
}
import { findProfileById } from "../models/profile";
import { listPatients, findPatientById, createPatient, deletePatient, updatePatientProfileExtras } from "../models/patient";
import { enrollTenoviPatient, getTenoviFacilities, getRpmToken } from "../services/tenovi";
import {
  enrollSmartMeterPatient,
  getSmartMeterPatientDetail,
  getSmartMeterPatientReadingDetail,
  getSmartMeterReviewTime,
  deleteSmartMeterReviewTime,
  getSmartMeterManualReview,
  deactivateSmartMeterPatient,
  type SmartMeterPatientDetail,
} from "../services/smartmeter";
import { getTenoviPatientReadings } from "../services/patient-readings";

export async function list(req: Request, res: Response) {
  const profile = await findProfileById(req.auth!.sub);
  const { source, status, program, risk, search } = req.query as Record<string, string>;
  const page  = Math.max(0, parseInt(req.query.page  as string) || 0);
  const limit = Math.min(1000, Math.max(10, parseInt(req.query.limit as string) || 100));

  let clinicId: string | undefined;
  if (profile && profile.role !== "super_admin") {
    if (!profile.clinic_id) return res.json({ patients: [], total: 0 });
    clinicId = profile.clinic_id;
  } else {
    clinicId = req.query.clinicId as string | undefined;
  }

  const { data, count } = await listPatients({
    clinicId,
    source:  source  || undefined,
    status:  status  || undefined,
    program: program || undefined,
    risk:    risk    || undefined,
    search:  search  || undefined,
    limit,
    offset:  page * limit,
  });

  return res.json({ patients: data, total: count });
}

export async function getOne(req: Request, res: Response) {
  const { id } = req.params;
  const profile = await findProfileById(req.auth!.sub);
  const patient = await findPatientById(id);
  if (!patient) return res.status(404).json({ error: "Patient not found." });
  if (
    profile &&
    profile.role !== "super_admin" &&
    patient.clinic_id !== profile.clinic_id
  ) {
    return res.status(403).json({ error: "Access denied." });
  }

  // Enrich SmartMeter patients with live full-profile data (DOB, gender, address, …)
  let smDetail: SmartMeterPatientDetail | null = null;
  if (patient.source === "smartmeter") {
    const { data: clinicRow } = await supabaseAdmin
      .from("clinics")
      .select("smartmeter_api_key")
      .eq("id", patient.clinic_id)
      .maybeSingle();
    const apiKey = (clinicRow as any)?.smartmeter_api_key as string | null;
    if (apiKey) {
      smDetail = await getSmartMeterPatientDetail(apiKey, patient.external_patient_id);
      // Sync gender/DOB back to our DB so registry card shows correct values
      if (smDetail) {
        const updates: Record<string, string> = {};
        if (!patient.sex && smDetail.gender) {
          const g = smDetail.gender.toLowerCase();
          if (g.startsWith("f")) updates.sex = "F";
          else if (g.startsWith("m")) updates.sex = "M";
        }
        if (!patient.dob && smDetail.dob) updates.dob = smDetail.dob;
        if (Object.keys(updates).length > 0) {
          await supabaseAdmin.from("patients").update(updates).eq("id", patient.id);
        }
      }
    }
  }

  return res.json({ patient, smDetail });
}

// ── System-scoped clinic list (for the enrollment modal dropdown) ──────────

export async function getSystemClinics(req: Request, res: Response) {
  const system = req.query.system as string | undefined;

  if (system === "smartmeter") {
    const { data, error } = await supabaseAdmin
      .from("clinics")
      .select("id, name, specialty, location")
      .not("smartmeter_api_key", "is", null)
      .order("name");
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ clinics: data ?? [] });
  }

  if (system === "tenovi") {
    // Fetch Tenovi facilities + our DB clinics in parallel, then intersect by name
    const [facilitiesResult, clinicsResult] = await Promise.allSettled([
      getTenoviFacilities(),
      supabaseAdmin.from("clinics").select("id, name, specialty, location").order("name"),
    ]);

    const dbClinics =
      clinicsResult.status === "fulfilled" ? (clinicsResult.value.data ?? []) : [];

    if (facilitiesResult.status === "rejected") {
      // Tenovi unreachable — return all clinics so the form still works
      return res.json({ clinics: dbClinics, warning: "Could not reach Tenovi to filter clinics." });
    }

    const facilityNames = new Set(
      (facilitiesResult.value as Array<{ name: string }>).map((f) =>
        f.name.toLowerCase().trim(),
      ),
    );
    const matched = (dbClinics as Array<{ id: string; name: string; specialty: string | null; location: string | null }>)
      .filter((c) => facilityNames.has(c.name.toLowerCase().trim()));

    return res.json({ clinics: matched });
  }

  return res.status(400).json({ error: "Query param 'system' must be 'tenovi' or 'smartmeter'." });
}

// ── Enroll patient ─────────────────────────────────────────────────────────

export async function enroll(req: Request, res: Response) {
  const profile = await findProfileById(req.auth!.sub);
  if (!profile) return res.status(401).json({ error: "Not authenticated." });
  if (profile.role !== "super_admin" && profile.role !== "clinic_admin") {
    return res.status(403).json({ error: "Not authorized." });
  }

  const {
    clinicId,
    system: rpmSource,
    firstName,
    lastName,
    dob,
    sex,
    phone,
    language,
    insurance,
    program,
    diagnosis,
    orderingPhysician,
    healthCondition,
  } = req.body as Record<string, string | undefined>;

  if (!clinicId || !rpmSource || !firstName || !lastName || !program) {
    return res.status(400).json({
      error: "Missing required fields: clinicId, system, firstName, lastName, program.",
    });
  }
  if (rpmSource !== "tenovi" && rpmSource !== "smartmeter") {
    return res.status(400).json({ error: "system must be 'tenovi' or 'smartmeter'." });
  }
  if (!["RPM", "RTM", "CCM", "PCM"].includes(program)) {
    return res.status(400).json({ error: "program must be RPM, RTM, CCM, or PCM." });
  }
  if (profile.role === "clinic_admin" && clinicId !== profile.clinic_id) {
    return res.status(403).json({ error: "clinic_admin can only enroll in their own clinic." });
  }

  const { data: clinic } = await supabaseAdmin
    .from("clinics")
    .select("id, name, smartmeter_api_key")
    .eq("id", clinicId)
    .maybeSingle();
  if (!clinic) return res.status(400).json({ error: "Clinic not found." });

  const fullName   = `${firstName.trim()} ${lastName.trim()}`;
  const diagnoses: string[] = [];
  const diagnosisText = healthCondition || diagnosis;
  if (diagnosisText) diagnoses.push(diagnosisText.trim());

  // External system must succeed before we write to the DB
  let externalPatientId: string;

  if (rpmSource === "tenovi") {
    let facilities: { id: string; name: string }[];
    try {
      facilities = await getTenoviFacilities();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return res.status(502).json({ error: `Tenovi unreachable: ${msg}` });
    }

    const facility = facilities.find(
      (f) => f.name.toLowerCase().trim() === clinic.name.toLowerCase().trim(),
    );
    if (!facility) {
      return res.status(422).json({
        error:
          `No Tenovi facility matches clinic "${clinic.name}". ` +
          `Available: ${facilities.map((f) => f.name).join(", ")}`,
      });
    }

    try {
      const result = await enrollTenoviPatient(facility.id, {
        name:              fullName,
        phone:             phone || undefined,
        externalId:        `rpmcares-${Date.now()}`,
        orderingPhysician: orderingPhysician || undefined,
        healthCondition:   healthCondition || diagnosis || undefined,
      });
      externalPatientId = result.patientId;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return res.status(422).json({ error: `Tenovi enrollment failed: ${msg}` });
    }
  } else {
    const apiKey = clinic.smartmeter_api_key as string | null;
    if (!apiKey) {
      return res.status(422).json({
        error: `Clinic "${clinic.name}" has no SmartMeter API key. Add it in Clinic Settings.`,
      });
    }
    if (!dob) {
      return res.status(400).json({ error: "Date of birth is required for SmartMeter enrollment." });
    }
    try {
      const result = await enrollSmartMeterPatient(apiKey, {
        firstName: firstName.trim(),
        lastName:  lastName.trim(),
        dob:       dob,              // already validated non-empty above
        sex:       (sex as "M" | "F") || undefined,
        phone:     phone || undefined,
        language:  language || undefined,
      });
      externalPatientId = result.patientId;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return res.status(422).json({ error: `SmartMeter enrollment failed: ${msg}` });
    }
  }

  const patient = await createPatient({
    clinicId:         clinic.id,
    source:           rpmSource as "tenovi" | "smartmeter",
    externalPatientId,
    fullName,
    dob:              dob || undefined,
    sex:              sex || undefined,
    phone:            normalizePhone(phone),
    language:         language || undefined,
    program:          program as "RPM" | "RTM" | "CCM" | "PCM",
    diagnoses,
    insurancePayer:   insurance || undefined,
  });

  return res.status(201).json({ patient });
}

// ── Patch patient profile extras ───────────────────────────────────────────

export async function patchProfile(req: Request, res: Response) {
  const { id } = req.params;
  const profile = await findProfileById(req.auth!.sub);
  const patient = await findPatientById(id);
  if (!patient) return res.status(404).json({ error: "Patient not found." });
  if (profile && profile.role !== "super_admin" && patient.clinic_id !== profile.clinic_id) {
    return res.status(403).json({ error: "Access denied." });
  }
  const extras = req.body as Record<string, string | null>;
  const updated = await updatePatientProfileExtras(id, extras);
  return res.json({ patient: updated });
}

// ── Delete patient ─────────────────────────────────────────────────────────

export async function remove(req: Request, res: Response) {
  const { id } = req.params;

  const profile = await findProfileById(req.auth!.sub);
  if (!profile) return res.status(401).json({ error: "Not authenticated." });
  if (profile.role !== "super_admin" && profile.role !== "clinic_admin") {
    return res.status(403).json({ error: "Not authorized." });
  }

  const patient = await findPatientById(id);
  if (!patient) return res.status(404).json({ error: "Patient not found." });
  if (profile.role === "clinic_admin" && patient.clinic_id !== profile.clinic_id) {
    return res.status(403).json({ error: "Access denied." });
  }

  // Best-effort: discharge from Tenovi
  if (patient.source === "tenovi") {
    try {
      const { data: clinicRow } = await supabaseAdmin
        .from("clinics").select("name").eq("id", patient.clinic_id).maybeSingle();
      const clinicName = (clinicRow as any)?.name as string | undefined;
      if (clinicName) {
        const facilities = await getTenoviFacilities();
        const facility = facilities.find(
          (f) => f.name.toLowerCase().trim() === clinicName.toLowerCase().trim(),
        );
        if (facility) {
          const token = await getRpmToken();
          await fetch(
            `https://api2.tenovi.com/clients/rpmcares/rpm/facilities/${facility.id}/patients/${patient.external_patient_id}/`,
            {
              method: "PATCH",
              headers: { Authorization: `Token ${token}`, "Content-Type": "application/json" },
              body: JSON.stringify({ status: "DC" }),
            },
          ).catch((e) => console.warn("[delete patient] Tenovi discharge failed:", e));
        }
      }
    } catch (err) {
      console.warn("[delete patient] Tenovi discharge error:", err);
    }
  }
  // Best-effort: deactivate in SmartMeter (no delete endpoint; set status=Inactive)
  if (patient.source === "smartmeter") {
    const { data: clinicRow } = await supabaseAdmin
      .from("clinics").select("smartmeter_api_key").eq("id", patient.clinic_id).maybeSingle();
    const apiKey = (clinicRow as any)?.smartmeter_api_key as string | null;
    if (apiKey) {
      await deactivateSmartMeterPatient(apiKey, patient.external_patient_id).catch((e) =>
        console.warn("[delete patient] SmartMeter deactivate failed:", e),
      );
    }
  }

  await deletePatient(id);
  return res.json({ ok: true });
}

// ── Patient readings ────────────────────────────────────────────────────────

export async function getReadings(req: Request, res: Response) {
  const { id } = req.params;

  let startDate: string;
  let endDate: string;
  if (req.query.start_date && req.query.end_date) {
    startDate = req.query.start_date as string;
    endDate   = req.query.end_date   as string;
  } else {
    const days = Math.min(365, Math.max(1, parseInt(req.query.days as string) || 30));
    const now = new Date();
    endDate   = now.toISOString().slice(0, 10);
    const s = new Date(now); s.setDate(s.getDate() - days);
    startDate = s.toISOString().slice(0, 10);
  }
  const profile = await findProfileById(req.auth!.sub);

  const patient = await findPatientById(id);
  if (!patient) return res.status(404).json({ error: "Patient not found." });
  if (profile && profile.role !== "super_admin" && patient.clinic_id !== profile.clinic_id) {
    return res.status(403).json({ error: "Access denied." });
  }

  try {
    if (patient.source === "smartmeter") {
      const { data: clinic } = await supabaseAdmin
        .from("clinics")
        .select("smartmeter_api_key")
        .eq("id", patient.clinic_id)
        .maybeSingle();
      const apiKey = (clinic as any)?.smartmeter_api_key as string | null;
      if (!apiKey) return res.json({ readings: [] });

      // Use the detail endpoint which returns full reading values (not just compliance dates)
      const rawReadings = await getSmartMeterPatientReadingDetail(apiKey, patient.external_patient_id, startDate, endDate);

      // Normalise to PatientReading shape (field names from SmartMeter api-docs.yaml readings_info schema)
      const readings = rawReadings.map((r) => {
        const ts = r.date_recorded ?? new Date().toISOString();
        const rType = (r.reading_type ?? "").toLowerCase();
        let type: string = "unknown";
        let label = rType;
        let displayValue = "-";
        let value: number | null = null;
        let unit = "";

        if (rType === "blood_pressure" || (r.systolic_mmhg != null && r.diastolic_mmhg != null)) {
          type = "blood_pressure"; label = "Blood Pressure"; unit = "mmHg";
          const sys = r.systolic_mmhg ?? null;
          const dia = r.diastolic_mmhg ?? null;
          displayValue = sys != null && dia != null ? `${sys}/${dia} ${unit}` : "-";
          value = sys;
          return {
            id: String(r.reading_id ?? `sm-${ts}`),
            timestamp: ts, type, label, displayValue, value, unit,
            systolic: sys ?? undefined, diastolic: dia ?? undefined,
            pulse: r.pulse_bpm ?? undefined,
            flagged: r.is_flagged ?? false, source: "smartmeter" as const,
            deviceId: r.device_id != null ? String(r.device_id) : null,
          };
        }
        if (rType === "blood_glucose" || rType.includes("glucose")) {
          type = "glucose"; label = "Blood Glucose"; unit = "mg/dL";
          value = r.blood_glucose_mgdl ?? null;
        } else if (rType === "weight") {
          type = "weight"; label = "Weight"; unit = "lbs";
          value = r.weight_lbs ?? null;
        } else if (rType === "pulse_ox" || rType.includes("spo2") || rType.includes("oxygen")) {
          type = "spo2"; label = "SpO2"; unit = "%";
          value = r.spo2 ?? null;
        } else if (rType === "thermometer" || rType.includes("temp")) {
          type = "temperature"; label = "Temperature"; unit = "°F";
          value = r.temperature ?? null;
        } else if (rType.includes("heart") || rType.includes("pulse") || rType.includes("bpm")) {
          type = "heart_rate"; label = "Heart Rate"; unit = "bpm";
          value = r.pulse_bpm ?? null;
        }
        displayValue = value != null ? `${value}${unit ? " " + unit : ""}` : "-";

        return {
          id: String(r.reading_id ?? `sm-${ts}`),
          timestamp: ts, type, label, displayValue, value, unit,
          flagged: r.is_flagged ?? false, source: "smartmeter" as const,
          deviceId: r.device_id != null ? String(r.device_id) : null,
        };
      });

      return res.json({ readings });
    }

    if (patient.source === "tenovi") {
      const readings = await getTenoviPatientReadings(patient.external_patient_id, startDate, endDate);
      return res.json({ readings });
    }

    return res.json({ readings: [] });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[readings] patient ${id} failed: ${msg}`);
    return res.json({ readings: [], warning: msg });
  }
}

// ── Patient alerts (from our DB) ────────────────────────────────────────────

export async function getPatientAlerts(req: Request, res: Response) {
  const { id } = req.params;
  const startDate = req.query.start_date as string | undefined;
  const endDate   = req.query.end_date   as string | undefined;

  const profile = await findProfileById(req.auth!.sub);
  const patient = await findPatientById(id);
  if (!patient) return res.status(404).json({ error: "Patient not found." });
  if (profile && profile.role !== "super_admin" && patient.clinic_id !== profile.clinic_id) {
    return res.status(403).json({ error: "Access denied." });
  }

  // Two separate queries avoids cross-type issues when patient_id stores a numeric
  // SmartMeter ID as text rather than a UUID. We match by patient_name (ilike) and
  // by external_patient_id, then deduplicate the combined result.
  const FIELDS = `
    id, timestamp, patient_name, clinic_name, alert_type, tier, value, unit, threshold,
    device_type, reading_id, reading_time, provider_email, sms_sent, email_sent,
    status, assigned_to, resolved_at, created_at,
    assignee:assigned_to(id, name, email)
  `;
  const escapedName = patient.full_name.replace(/'/g, "''");

  function applyDateFilter(q: any) {
    if (startDate) q = q.gte("created_at", startDate + "T00:00:00");
    if (endDate)   q = q.lte("created_at", endDate   + "T23:59:59");
    return q;
  }

  const [r1, r2] = await Promise.all([
    applyDateFilter(
      supabaseAdmin.from("alert_events").select(FIELDS)
        .ilike("patient_name", `%${escapedName}%`)
    ).order("created_at", { ascending: false }).limit(200),

    applyDateFilter(
      supabaseAdmin.from("alert_events").select(FIELDS)
        .eq("patient_id", patient.external_patient_id)
    ).order("created_at", { ascending: false }).limit(200),
  ]);

  // Deduplicate by id, sort newest first
  const seen = new Set<string>();
  const merged: any[] = [];
  for (const row of [...(r1.data ?? []), ...(r2.data ?? [])]) {
    if (!seen.has(row.id)) { seen.add(row.id); merged.push(row); }
  }
  merged.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  return res.json({ alerts: merged });
}

// ── Patient review time (SmartMeter only, DB-cached) ──────────────────────

const REVIEW_TIME_TTL_MS = 30 * 60 * 1000; // 30 minutes

async function getApiKey(clinicId: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from("clinics")
    .select("smartmeter_api_key")
    .eq("id", clinicId)
    .maybeSingle();
  return (data as any)?.smartmeter_api_key ?? null;
}

async function syncReviewTimesToDb(
  patient: Awaited<ReturnType<typeof findPatientById>>,
  apiKey: string,
) {
  if (!patient) return;
  const smData = await getSmartMeterReviewTime(apiKey, patient.external_patient_id);
  const now = new Date().toISOString();

  // Only replace SmartMeter-synced rows — keep manual and profile_view entries
  await supabaseAdmin
    .from("patient_review_times")
    .delete()
    .eq("patient_id", patient.id)
    .eq("source", "smartmeter_sync");

  if (smData.length > 0) {
    const rows = smData.map((e) => ({
      patient_id:          patient.id,
      sm_review_time_id:   e.review_time_id,
      clock_start:         e.clock_start,
      duration_seconds:    e.review_duration_seconds ?? 0,
      note:                e.note ?? null,
      patient_interaction: e.patient_interaction ?? false,
      logged_by:           e.added_by?.display_name ?? null,
      synced_at:           now,
      source:              "smartmeter_sync",
    }));
    await supabaseAdmin.from("patient_review_times").insert(rows);
  }
}

export async function getReviewTime(req: Request, res: Response) {
  const { id } = req.params;

  const profile = await findProfileById(req.auth!.sub);
  const patient = await findPatientById(id);
  if (!patient) return res.status(404).json({ error: "Patient not found." });
  if (profile && profile.role !== "super_admin" && patient.clinic_id !== profile.clinic_id) {
    return res.status(403).json({ error: "Access denied." });
  }

  // ── Serve from DB cache (all sources) ─────────────────────────────────────
  const { data: cached } = await supabaseAdmin
    .from("patient_review_times")
    .select("*")
    .eq("patient_id", id)
    .order("clock_start", { ascending: false })
    .limit(200);

  // For SmartMeter patients: refresh the SmartMeter-synced subset when stale
  if (patient.source === "smartmeter") {
    const cutoff = new Date(Date.now() - REVIEW_TIME_TTL_MS).toISOString();
    const smRows = (cached ?? []).filter((r: any) => r.source === "smartmeter_sync");
    const hasFresh = smRows.some((r: any) => r.synced_at >= cutoff);

    if (!hasFresh) {
      const apiKey = await getApiKey(patient.clinic_id);
      if (apiKey) {
        if (smRows.length > 0) {
          // Stale — return current data and refresh in background
          syncReviewTimesToDb(patient, apiKey).catch((e) =>
            console.warn("[review-time] background sync failed:", e),
          );
          return res.json({ reviewTimes: cached ?? [] });
        }
        // No SmartMeter rows yet — sync synchronously on first load
        await syncReviewTimesToDb(patient, apiKey);
        const { data: fresh } = await supabaseAdmin
          .from("patient_review_times")
          .select("*")
          .eq("patient_id", id)
          .order("clock_start", { ascending: false })
          .limit(200);
        return res.json({ reviewTimes: fresh ?? [] });
      }
    }
  }

  return res.json({ reviewTimes: cached ?? [] });
}

export async function deleteReviewTime(req: Request, res: Response) {
  const { id, entryId } = req.params;

  const profile = await findProfileById(req.auth!.sub);
  const patient = await findPatientById(id);
  if (!patient) return res.status(404).json({ error: "Patient not found." });
  if (profile && profile.role !== "super_admin" && patient.clinic_id !== profile.clinic_id) {
    return res.status(403).json({ error: "Access denied." });
  }

  const { data: entry } = await supabaseAdmin
    .from("patient_review_times")
    .select("sm_review_time_id")
    .eq("id", entryId)
    .eq("patient_id", id)
    .maybeSingle();

  if (!entry) return res.status(404).json({ error: "Review time entry not found." });

  // Best-effort: delete from SmartMeter
  if (entry.sm_review_time_id) {
    const apiKey = await getApiKey(patient.clinic_id);
    if (apiKey) {
      await deleteSmartMeterReviewTime(apiKey, patient.external_patient_id, entry.sm_review_time_id).catch(
        (e) => console.warn("[review-time] SmartMeter delete failed:", e),
      );
    }
  }

  await supabaseAdmin.from("patient_review_times").delete().eq("id", entryId);
  return res.json({ ok: true });
}

// ── Log manual review time ─────────────────────────────────────────────────

export async function logManualReview(req: Request, res: Response) {
  const { id } = req.params;
  const { duration_seconds, note, patient_interaction } = req.body as {
    duration_seconds: number;
    note?: string;
    patient_interaction?: boolean;
  };

  if (!duration_seconds || duration_seconds < 1) {
    return res.status(400).json({ error: "duration_seconds must be ≥ 1." });
  }

  const profile = await findProfileById(req.auth!.sub);
  const patient = await findPatientById(id);
  if (!patient) return res.status(404).json({ error: "Patient not found." });
  if (profile && profile.role !== "super_admin" && patient.clinic_id !== profile.clinic_id) {
    return res.status(403).json({ error: "Access denied." });
  }

  const clockStart = new Date().toISOString();
  const loggedBy = (profile as any)?.name ?? "Staff";

  // For SmartMeter patients: also post to SmartMeter API best-effort
  let smReviewTimeId: number | null = null;
  if (patient.source === "smartmeter") {
    const apiKey = await getApiKey(patient.clinic_id);
    if (apiKey) {
      try {
        const result = await getSmartMeterManualReview(
          apiKey, patient.external_patient_id, clockStart, duration_seconds,
          note ?? null, patient_interaction ?? false,
        );
        smReviewTimeId = result?.review_time_id ?? null;
      } catch (e) {
        console.warn("[manual-review] SmartMeter post failed:", e);
      }
    }
  }

  const { data: entry } = await supabaseAdmin
    .from("patient_review_times")
    .insert({
      patient_id:          id,
      sm_review_time_id:   smReviewTimeId,
      clock_start:         clockStart,
      duration_seconds,
      note:                note ?? null,
      patient_interaction: patient_interaction ?? false,
      logged_by:           loggedBy,
      synced_at:           clockStart,
      source:              "manual",
    })
    .select("*")
    .single();

  return res.json({ ok: true, entry });
}

// ── Log profile-view session ───────────────────────────────────────────────

export async function logProfileView(req: Request, res: Response) {
  const { id } = req.params;
  const { duration_seconds } = req.body as { duration_seconds: number };

  if (!duration_seconds || duration_seconds < 30) {
    return res.status(400).json({ error: "duration_seconds must be ≥ 30." });
  }

  const profile = await findProfileById(req.auth!.sub);
  const patient = await findPatientById(id);
  if (!patient) return res.status(404).json({ error: "Patient not found." });
  if (profile && profile.role !== "super_admin" && patient.clinic_id !== profile.clinic_id) {
    return res.status(403).json({ error: "Access denied." });
  }

  const clockStart = new Date(Date.now() - duration_seconds * 1000).toISOString();
  const loggedBy = (profile as any)?.name ?? "Staff";

  const { data: entry } = await supabaseAdmin
    .from("patient_review_times")
    .insert({
      patient_id:          id,
      sm_review_time_id:   null,
      clock_start:         clockStart,
      duration_seconds,
      note:                null,
      patient_interaction: false,
      logged_by:           loggedBy,
      synced_at:           new Date().toISOString(),
      source:              "profile_view",
    })
    .select("*")
    .single();

  return res.json({ ok: true, entry });
}
