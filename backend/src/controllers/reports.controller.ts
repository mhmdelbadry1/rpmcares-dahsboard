import type { Request, Response } from "express";
import { supabaseAdmin } from "../lib/supabase";
import { countSmartMeterReadingsForPatient } from "../services/smartmeter";
import { fetchReviewMinutesMap, minutesFromMap } from "../lib/review-minutes";
import { normalizeInsurance } from "../services/billing-engine";

// ── Constants ──────────────────────────────────────────────────────────────

const PROGRAM_CATEGORIES = [
  { program: "RPM", label: "RPM — 99457 / 99458", cptCodes: ["99457", "99458"], thresholdMinutes: 20 },
  { program: "RTM", label: "RTM — 98980 / 98981", cptCodes: ["98980", "98981"], thresholdMinutes: 20 },
  { program: "CCM", label: "CCM — 99490 / 99439", cptCodes: ["99490", "99439"], thresholdMinutes: 20 },
  { program: "PCM", label: "PCM — 99426 / 99427", cptCodes: ["99426", "99427"], thresholdMinutes: 30 },
] as const;

// ── Helpers ────────────────────────────────────────────────────────────────

function periodRange(monthStr?: string): { start: string; end: string; label: string } {
  const now   = new Date();
  const year  = monthStr ? parseInt(monthStr.slice(0, 4))     : now.getFullYear();
  const month = monthStr ? parseInt(monthStr.slice(5, 7)) - 1 : now.getMonth();
  const startDate = new Date(year, month, 1);
  const endDate   = new Date(year, month + 1, 0);
  return {
    start: startDate.toISOString().slice(0, 10),
    end:   endDate.toISOString().slice(0, 10),
    label: startDate.toLocaleString("en-US", { month: "long", year: "numeric" }),
  };
}

function buildCategories(
  notes:             any[],
  reviewTimes:       any[],
  records:           any[],
  patientProgram:    string,
  totalReadingCount: number | null = null,
) {
  // Review time from patient_review_times — the only time source; timer removed per spec.
  // A patient is enrolled in exactly one program, so all of their review time
  // belongs to that program only — it must never appear under the other three.
  const totalReviewSeconds = reviewTimes.reduce((s: number, r: any) => s + (r.duration_seconds ?? 0), 0);
  const totalReviewMinutes = Math.round(totalReviewSeconds / 60);

  return PROGRAM_CATEGORIES.map((cat) => {
    const reviewMinutes = cat.program === patientProgram ? totalReviewMinutes : 0;
    const totalMinutes  = reviewMinutes;

    const catNotes   = notes.filter((n) =>
      (n.cpt_codes ?? []).some((c: string) => (cat.cptCodes as readonly string[]).includes(c)),
    );
    const catRecords = records.filter((r) =>
      (cat.cptCodes as readonly string[]).includes(r.cpt_code),
    );

    // For RPM: use direct API reading count; for others fall back to billing_records
    const billingReadingCount = catRecords.reduce((s: number, r: any) => s + (r.reading_count ?? 0), 0);
    const readingCount = cat.program === "RPM" && totalReadingCount !== null && totalReadingCount >= 0
      ? totalReadingCount
      : billingReadingCount;

    return {
      program:          cat.program,
      label:            cat.label,
      cptCodes:         [...cat.cptCodes],
      thresholdMinutes: cat.thresholdMinutes,
      totalMinutes,
      reviewMinutes,
      thresholdMet:     totalMinutes >= cat.thresholdMinutes,
      notesCount:       catNotes.length,
      readingCount,
      billingRecords:   catRecords,
      notes:            catNotes.map((n) => ({
        id:          n.id,
        dos:         n.dos,
        status:      n.status,
        cpt_codes:   n.cpt_codes ?? [],
        content:     n.content,
        author_name: n.profiles?.name ?? null,
        signed_at:   n.signed_at,
      })),
    };
  });
}

// ── 1. Patient Clinical Report ─────────────────────────────────────────────

export async function getPatientReport(req: Request, res: Response): Promise<void> {
  const { patientId } = req.params as { patientId: string };
  // ?cycleStart=YYYY-MM-DD targets a specific billing cycle; otherwise falls back to calendar month
  const cycleStartParam = req.query.cycleStart as string | undefined;
  const period          = periodRange(req.query.month as string | undefined);

  // When an exact cycle start is given, resolve its end date from billing_cycles
  let rangeStart = period.start;
  let rangeEnd   = period.end;
  let exactCycleStart: string | null = null;
  if (cycleStartParam && /^\d{4}-\d{2}-\d{2}$/.test(cycleStartParam)) {
    exactCycleStart = cycleStartParam;
    const { data: cycleRow } = await supabaseAdmin
      .from("billing_cycles")
      .select("cycle_start, cycle_end")
      .eq("patient_id", patientId)
      .eq("cycle_start", cycleStartParam)
      .maybeSingle();
    if (cycleRow) {
      rangeStart = cycleRow.cycle_start;
      rangeEnd   = cycleRow.cycle_end;
    } else {
      rangeStart = cycleStartParam;
    }
  }

  const [patientRes, notesRes, reviewTimesRes, billingRes, allBillingRes, billingCyclesRes, cycleStatsRes, carePlanRes] =
    await Promise.all([
      supabaseAdmin
        .from("patients")
        .select("*, clinics(name, specialty, location)")
        .eq("id", patientId)
        .single(),
      supabaseAdmin
        .from("care_notes")
        .select("*, profiles!care_notes_author_id_fkey(name)")
        .eq("patient_id", patientId)
        .neq("note_type", "care_plan")
        .gte("dos", rangeStart)
        .lte("dos", rangeEnd)
        .order("dos", { ascending: false }),
      supabaseAdmin
        .from("patient_review_times")
        .select("*")
        .eq("patient_id", patientId)
        .gte("clock_start", rangeStart)
        .lte("clock_start", `${rangeEnd}T23:59:59`),
      // Records for the selected cycle — used in report body & categories
      supabaseAdmin
        .from("billing_records")
        .select("*")
        .eq("patient_id", patientId)
        .eq("cycle_start", exactCycleStart ?? period.start),
      // All records across every cycle — used to populate billing cycle history
      supabaseAdmin
        .from("billing_records")
        .select("*")
        .eq("patient_id", patientId)
        .order("cycle_start", { ascending: false }),
      // Last 6 billing cycles for the cycle history section
      supabaseAdmin
        .from("billing_cycles")
        .select("*")
        .eq("patient_id", patientId)
        .order("cycle_start", { ascending: false })
        .limit(6),
      // Fallback reading count — use range overlap so patients whose cycle
      // doesn't start on the 1st still match their synced stat row
      supabaseAdmin
        .from("patient_cycle_stats")
        .select("reading_count, monitoring_days")
        .eq("patient_id", patientId)
        .lte("cycle_start", rangeEnd)
        .gte("cycle_end", rangeStart)
        .order("synced_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabaseAdmin
        .from("care_notes")
        .select("*, profiles!care_notes_author_id_fkey(name)")
        .eq("patient_id", patientId)
        .eq("note_type", "care_plan")
        .order("created_at", { ascending: false })
        .limit(1),
    ]);

  if (!patientRes.data) {
    res.status(404).json({ error: "Patient not found." });
    return;
  }

  const patient      = patientRes.data as any;
  const clinic       = Array.isArray(patient.clinics) ? patient.clinics[0] : patient.clinics;
  const notes        = (notesRes.data ?? []) as any[];
  const reviews      = (reviewTimesRes.data ?? []) as any[];
  const records      = (billingRes.data    ?? []) as any[];
  const allRecords   = (allBillingRes.data ?? []) as any[];
  const billingCycles = (billingCyclesRes.data ?? []) as any[];
  const cycleStats   = cycleStatsRes.data as any ?? null;
  const carePlanRow  = ((carePlanRes.data ?? []) as any[])[0] ?? null;

  // Fetch accurate reading count directly from SmartMeter API (no dedup — raw count)
  let totalReadingCount: number | null = cycleStats?.reading_count ?? null;
  if (patient.source === "smartmeter" && patient.external_patient_id) {
    const { data: clinicRow } = await supabaseAdmin
      .from("clinics")
      .select("smartmeter_api_key")
      .eq("id", patient.clinic_id)
      .single();
    const apiKey = (clinicRow as any)?.smartmeter_api_key as string | undefined;
    if (apiKey) {
      const liveCount = await countSmartMeterReadingsForPatient(
        apiKey,
        patient.external_patient_id,
        period.start,
        period.end,
      );
      if (liveCount >= 0) totalReadingCount = liveCount;
    }
  }

  const monitoringDays = cycleStats?.monitoring_days ?? null;
  const signedNote = notes.find((n) => n.signed_at);
  const provider   = signedNote?.profiles?.name ?? null;

  const categories = buildCategories(notes, reviews, records, patient.program, totalReadingCount);
  const carePlan   = carePlanRow
    ? {
        id:          carePlanRow.id,
        content:     carePlanRow.content,
        status:      carePlanRow.status,
        author_name: carePlanRow.profiles?.name ?? null,
        signed_at:   carePlanRow.signed_at,
        created_at:  carePlanRow.created_at,
      }
    : null;

  res.json({
    patient: {
      id:               patient.id,
      full_name:        patient.full_name,
      dob:              patient.dob,
      mrn:              patient.mrn,
      program:          patient.program,
      diagnoses:        patient.diagnoses    ?? [],
      icd10_codes:      patient.icd10_codes  ?? [],
      insurance_payer:  patient.insurance_payer  ?? null,
      insurance_type:   normalizeInsurance(patient.insurance_class ?? null, patient.insurance_payer ?? null),
      enrollment_status: patient.enrollment_status,
    },
    clinic: {
      name:     clinic?.name     ?? null,
      specialty: clinic?.specialty ?? null,
      location: clinic?.location  ?? null,
    },
    period,
    provider,
    generatedAt:   new Date().toISOString(),
    readingCount:  totalReadingCount,
    monitoringDays,
    categories,
    carePlan,
    billingRecords: records,
    billingCycles:  billingCycles.map((c) => {
      const cycleRecords = allRecords.filter((r: any) => r.cycle_start === c.cycle_start);
      return {
        id:            c.id,
        cycle_start:   c.cycle_start,
        consent_date:  c.consent_date  ?? null,
        shipment_date: c.shipment_date ?? null,
        created_at:    c.created_at,
        records:       cycleRecords,
        totalProjected: cycleRecords.reduce((s: number, r: any) => s + parseFloat(r.projected_amount ?? "0"), 0),
        status: cycleRecords.length > 0
          ? cycleRecords.every((r: any) => r.status === "paid")      ? "paid"
          : cycleRecords.every((r: any) => r.status === "submitted") ? "submitted"
          : cycleRecords.some((r: any)  => r.status === "signed")    ? "signed"
          : cycleRecords.some((r: any)  => r.status === "generated") ? "generated"
          : "pending"
          : "no_records",
      };
    }),
  });
}

// ── 2. Clinic Insurance Summary ────────────────────────────────────────────

export async function getClinicReport(req: Request, res: Response): Promise<void> {
  const profile   = req.profile!;
  const clinicId  = req.params.clinicId ?? profile.clinic_id;
  const period    = periodRange(req.query.month as string | undefined);

  if (!clinicId) {
    res.status(400).json({ error: "clinicId is required." });
    return;
  }

  // Step 1: clinic info + patients (paginated — clinics can exceed 1000 active patients)
  const clinicRes = await supabaseAdmin.from("clinics").select("id, name, specialty, location").eq("id", clinicId).single();
  async function fetchClinicPatients(): Promise<any[]> {
    const PAGE = 1000;
    let all: any[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabaseAdmin.from("patients")
        .select("id, full_name, dob, program, diagnoses, icd10_codes, insurance_payer, enrollment_status, mrn")
        .eq("clinic_id", clinicId)
        .eq("enrollment_status", "active")
        .range(from, from + PAGE - 1);
      if (error) throw error;
      all = all.concat(data ?? []);
      if ((data ?? []).length < PAGE) break;
    }
    return all;
  }

  const clinic     = clinicRes.data as any;
  const patients   = await fetchClinicPatients();
  const patientIds = patients.map((p: any) => p.id);

  // Step 2: billing records (paginated) + review times
  async function fetchClinicBillingRecords(): Promise<any[]> {
    const PAGE = 1000;
    let all: any[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabaseAdmin.from("billing_records").select("*")
        .eq("clinic_id", clinicId)
        .lte("cycle_start", period.end)
        .gte("cycle_end",   period.start)
        .range(from, from + PAGE - 1);
      if (error) throw error;
      all = all.concat(data ?? []);
      if ((data ?? []).length < PAGE) break;
    }
    return all;
  }

  const records = await fetchClinicBillingRecords();

  // Live-compute minutes across the full span of all billing cycle dates.
  let clinicRtMap = new Map<string, Array<{ date: string; secs: number }>>();
  if (records.length > 0) {
    const allStarts = records.map((r: any) => r.cycle_start as string).filter(Boolean);
    const allEnds   = records.map((r: any) => r.cycle_end   as string).filter(Boolean);
    const rangeMin  = allStarts.length > 0 ? allStarts.reduce((a, b) => (a < b ? a : b)) : period.start;
    const rangeMax  = allEnds.length   > 0 ? allEnds.reduce((a, b) => (a > b ? a : b))   : period.end;
    clinicRtMap = await fetchReviewMinutesMap(patientIds, rangeMin, rangeMax);
  }

  // Per-patient summary
  const patientSummaries = patients.map((p) => {
    const ptRecords  = records.filter((r: any) => r.patient_id === p.id);
    const cycleStart = ptRecords[0]?.cycle_start ?? period.start;
    const cycleEnd   = ptRecords[0]?.cycle_end   ?? period.end;
    const totalMinutes   = minutesFromMap(clinicRtMap, p.id, cycleStart, cycleEnd);
    const totalReadings  = ptRecords.length > 0
      ? Math.max(...ptRecords.map((r: any) => r.reading_count ?? 0))
      : 0;
    const cptCodes       = [...new Set(ptRecords.map((r: any) => r.cpt_code))];
    const totalProjected = ptRecords.reduce((s: number, r: any) => s + parseFloat(r.projected_amount ?? "0"), 0);
    const insuranceType  = ptRecords[0]?.insurance_type ?? null;

    // A patient is enrolled in exactly one program — their tracked minutes
    // belong to that program only and must never be attributed to the other
    // three (previously `minutes: totalMinutes` was assigned unconditionally
    // to every category, so every patient with any tracked time appeared to
    // have met the threshold for all four programs at once).
    const byProgram = PROGRAM_CATEGORIES.map((cat) => {
      const progRecords = ptRecords.filter((r: any) => (cat.cptCodes as readonly string[]).includes(r.cpt_code));
      const readings    = progRecords.reduce((s: number, r: any) => s + (r.reading_count ?? 0), 0);
      const minutes     = cat.program === p.program ? totalMinutes : 0;
      const thresholdMet = minutes >= cat.thresholdMinutes;
      return {
        program: cat.program, cptCodes: progRecords.map((r: any) => r.cpt_code),
        minutes, readings, thresholdMet,
        billingStatus: progRecords[0]?.status ?? null,
        projectedAmount: progRecords.reduce((s: number, r: any) => s + parseFloat(r.projected_amount ?? "0"), 0),
      };
    }).filter((b) => b.minutes > 0 || b.readings > 0 || b.cptCodes.length > 0);

    return {
      patient_id:       p.id,
      full_name:        p.full_name,
      dob:              p.dob,
      mrn:              p.mrn,
      program:          p.program,
      diagnoses:        p.diagnoses    ?? [],
      icd10_codes:      p.icd10_codes  ?? [],
      insurance_payer:  p.insurance_payer ?? null,
      insurance_type:   insuranceType,
      cycle_start:      cycleStart ?? null,
      cycle_end:        cycleEnd   ?? null,
      totalMinutes,
      totalReadings,
      cptCodes,
      totalProjected,
      byProgram,
    };
  });

  // Clinic totals
  const totals = {
    patients:        patientSummaries.length,
    totalMinutes:    patientSummaries.reduce((s, p) => s + p.totalMinutes, 0),
    totalReadings:   patientSummaries.reduce((s, p) => s + p.totalReadings, 0),
    totalProjected:  patientSummaries.reduce((s, p) => s + p.totalProjected, 0),
    thresholdMet:    patientSummaries.filter((p) =>
      p.byProgram.some((b) => b.thresholdMet),
    ).length,
    byCpt: records.reduce((map: Record<string, { count: number; amount: number }>, r: any) => {
      if (!map[r.cpt_code]) map[r.cpt_code] = { count: 0, amount: 0 };
      map[r.cpt_code].count++;
      map[r.cpt_code].amount += parseFloat(r.projected_amount ?? "0");
      return map;
    }, {}),
  };

  res.json({
    clinic:    { id: clinic?.id, name: clinic?.name, specialty: clinic?.specialty, location: clinic?.location },
    period,
    generatedAt: new Date().toISOString(),
    patients:  patientSummaries,
    totals,
  });
}

// ── 3. Monthly Billing Report ──────────────────────────────────────────────

export async function getMonthlyReport(req: Request, res: Response): Promise<void> {
  const profile  = req.profile!;
  const period   = periodRange(req.query.month as string | undefined);
  const clinicId = req.query.clinicId as string | undefined;

  function buildRecordsQuery(from: number, to: number) {
    let q = supabaseAdmin
      .from("billing_records")
      .select("*, patients(full_name, dob, program, diagnoses, icd10_codes, insurance_payer, mrn, clinic_id, clinics(name))")
      .lte("cycle_start", period.end)
      .gte("cycle_end",   period.start)
      .order("clinic_id")
      .order("patient_id")
      .order("cpt_code")
      .range(from, to);
    if (profile.role !== "super_admin" && profile.clinic_id) q = q.eq("clinic_id", profile.clinic_id);
    else if (clinicId) q = q.eq("clinic_id", clinicId);
    return q;
  }

  // Paginate to bypass Supabase's 1000-row server cap
  const PAGE = 1000;
  let rawRecords: any[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await buildRecordsQuery(from, from + PAGE - 1);
    if (error) { res.status(502).json({ error: error.message }); return; }
    rawRecords = rawRecords.concat(data ?? []);
    if ((data ?? []).length < PAGE) break;
  }

  // Live-compute minutes using the same approach as the billing queue:
  // span the full date range of all billing cycles so no time logs fall outside the fetch window.
  let reportRtMap = new Map<string, Array<{ date: string; secs: number }>>();
  if (rawRecords.length > 0) {
    const reportPatientIds = [...new Set(rawRecords.map((r: any) => r.patient_id as string))];
    const allStarts = rawRecords.map((r: any) => r.cycle_start as string).filter(Boolean);
    const allEnds   = rawRecords.map((r: any) => r.cycle_end   as string).filter(Boolean);
    const rangeMin  = allStarts.length > 0 ? allStarts.reduce((a, b) => (a < b ? a : b)) : period.start;
    const rangeMax  = allEnds.length   > 0 ? allEnds.reduce((a, b) => (a > b ? a : b))   : period.end;
    reportRtMap = await fetchReviewMinutesMap(reportPatientIds, rangeMin, rangeMax);
  }

  const records = rawRecords.map((r: any) => {
    const pat    = Array.isArray(r.patients) ? r.patients[0] : r.patients;
    const clinic = pat ? (Array.isArray(pat.clinics) ? pat.clinics[0] : pat.clinics) : null;
    const liveMinutes = minutesFromMap(reportRtMap, r.patient_id, r.cycle_start, r.cycle_end ?? r.cycle_start);
    return {
      id:               r.id,
      patient_id:       r.patient_id,
      patient_name:     pat?.full_name         ?? null,
      patient_dob:      pat?.dob               ?? null,
      patient_mrn:      pat?.mrn               ?? null,
      patient_program:  pat?.program           ?? null,
      diagnoses:        pat?.diagnoses         ?? [],
      icd10_codes:      pat?.icd10_codes       ?? [],
      insurance_payer:  pat?.insurance_payer   ?? null,
      insurance_type:   r.insurance_type       ?? null,
      clinic_id:        r.clinic_id,
      clinic_name:      clinic?.name           ?? null,
      cpt_code:         r.cpt_code,
      units:            r.units,
      dos:              r.dos,
      program:          r.program,
      status:           r.status,
      reading_count:    r.reading_count        ?? 0,
      total_minutes:    liveMinutes,
      projected_amount: r.projected_amount     ? parseFloat(r.projected_amount) : null,
      actual_amount:    r.actual_amount        ? parseFloat(r.actual_amount)    : null,
      cycle_start:      r.cycle_start,
      cycle_end:        r.cycle_end            ?? null,
    };
  });

  // Group by clinic
  const clinicMap = new Map<string, { clinic_id: string; clinic_name: string; records: typeof records }>();
  for (const r of records) {
    const key = r.clinic_id ?? "unknown";
    if (!clinicMap.has(key)) {
      clinicMap.set(key, { clinic_id: key, clinic_name: r.clinic_name ?? "Unknown", records: [] });
    }
    clinicMap.get(key)!.records.push(r);
  }

  const byCpt: Record<string, { count: number; projected: number }> = {};
  for (const r of records) {
    if (!byCpt[r.cpt_code]) byCpt[r.cpt_code] = { count: 0, projected: 0 };
    byCpt[r.cpt_code].count++;
    byCpt[r.cpt_code].projected += r.projected_amount ?? 0;
  }

  res.json({
    period,
    generatedAt: new Date().toISOString(),
    clinics: [...clinicMap.values()].map((c) => ({
      clinic_id:       c.clinic_id,
      clinic_name:     c.clinic_name,
      records:         c.records,
      subtotalProjected: c.records.reduce((s, r) => s + (r.projected_amount ?? 0), 0),
      subtotalActual:    c.records.reduce((s, r) => s + (r.actual_amount    ?? 0), 0),
      readingCount:      c.records.reduce((s, r) => s + r.reading_count,           0),
    })),
    totals: {
      records:          records.length,
      totalProjected:   records.reduce((s, r) => s + (r.projected_amount ?? 0), 0),
      totalActual:      records.reduce((s, r) => s + (r.actual_amount    ?? 0), 0),
      totalReadings:    records.reduce((s, r) => s + r.reading_count,           0),
      byCpt:            Object.entries(byCpt).map(([cpt_code, v]) => ({ cpt_code, ...v }))
                          .sort((a, b) => b.projected - a.projected),
    },
  });
}

// ── 4. Exported Billing Reports (per-patient index) ────────────────────────

export async function getExportedBillingReports(req: Request, res: Response): Promise<void> {
  const { patientId } = req.params as { patientId: string };

  const { data, error } = await supabaseAdmin
    .from("exported_billing_reports")
    .select("id, patient_id, clinic_id, cycle_start, cycle_end, generated_at, created_at")
    .eq("patient_id", patientId)
    .order("cycle_start", { ascending: false });

  if (error) { res.status(502).json({ error: error.message }); return; }
  res.json({ reports: data ?? [] });
}
