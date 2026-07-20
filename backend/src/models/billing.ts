import { supabaseAdmin } from "../lib/supabase";
import { fetchReviewMinutesMap, minutesFromMap } from "../lib/review-minutes";

// ── Types ──────────────────────────────────────────────────────────────────

export type BillingRule = {
  id: string;
  rule_name: string;
  rule_category: string;
  insurance_type: string;
  min_readings: number | null;
  max_readings: number | null;
  trigger_minutes: number | null;
  cpt_codes: string[];
  units: number;
  is_one_time: boolean;
  is_active: boolean;
  sort_order: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export type FeeSchedule = {
  id: string;
  payer: string;
  cpt_code: string;
  amount: number;
  effective_date: string;
  end_date: string | null;
  created_at: string;
  updated_at: string;
};

export type DosOffset = {
  id: string;
  program: string;
  cpt_code: string;
  offset_days: number | null;
  offset_type: "cycle_start" | "shipment_date";
  created_at: string;
  updated_at: string;
};

export type BillingCycle = {
  id: string;
  patient_id: string;
  cycle_start: string;
  consent_date: string | null;
  shipment_date: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type BillingRecord = {
  id: string;
  patient_id: string;
  clinic_id: string;
  cycle_start: string;
  cycle_end: string;
  cpt_code: string;
  units: number;
  dos: string | null;
  program: string;
  insurance_type: string;
  status: "pending" | "generated" | "reviewed" | "signed" | "submitted" | "paid" | "voided";
  projected_amount: number | null;
  actual_amount: number | null;
  reading_count: number | null;
  total_minutes: number | null;
  note_id: string | null;
  locked_at: string | null;
  submitted_at: string | null;
  override_by: string | null;
  override_reason: string | null;
  created_at: string;
  updated_at: string;
};

export type PatientCycleStats = {
  patient_id: string;
  cycle_start: string;
  cycle_end: string;
  reading_count: number;
  monitoring_days: number;
  source: string;
  synced_at: string;
};

export type CareNote = {
  id: string;
  patient_id: string;
  clinic_id: string;
  author_id: string | null;
  note_type: string;
  cpt_codes: string[];
  content: Record<string, unknown>;
  ai_generated: boolean;
  ai_generated_at: string | null;
  status: "draft" | "reviewed" | "signed" | "locked";
  signed_by: string | null;
  signed_at: string | null;
  dos: string | null;
  cycle_start: string | null;
  created_at: string;
  updated_at: string;
};

// ── Billing Rules ──────────────────────────────────────────────────────────

export async function listBillingRules(): Promise<BillingRule[]> {
  const { data, error } = await supabaseAdmin
    .from("billing_rules")
    .select("*")
    .order("rule_category")
    .order("sort_order");
  if (error) throw error;
  return data ?? [];
}

export async function createBillingRule(
  input: Omit<BillingRule, "id" | "created_at" | "updated_at">,
): Promise<BillingRule> {
  const { data, error } = await supabaseAdmin
    .from("billing_rules")
    .insert(input)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updateBillingRule(
  id: string,
  patch: Partial<Omit<BillingRule, "id" | "created_at">>,
): Promise<BillingRule> {
  const { data, error } = await supabaseAdmin
    .from("billing_rules")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deleteBillingRule(id: string): Promise<void> {
  const { error } = await supabaseAdmin.from("billing_rules").delete().eq("id", id);
  if (error) throw error;
}

// ── Fee Schedules ──────────────────────────────────────────────────────────

export async function listFeeSchedules(): Promise<FeeSchedule[]> {
  const { data, error } = await supabaseAdmin
    .from("fee_schedules")
    .select("*")
    .order("payer")
    .order("cpt_code")
    .order("effective_date", { ascending: false });
  if (error) throw error;
  return (data ?? []).map((r) => ({ ...r, amount: parseFloat(r.amount) }));
}

export async function upsertFeeSchedule(
  input: Omit<FeeSchedule, "id" | "created_at" | "updated_at">,
): Promise<FeeSchedule> {
  const { data, error } = await supabaseAdmin
    .from("fee_schedules")
    .upsert({ ...input, updated_at: new Date().toISOString() }, {
      onConflict: "payer,cpt_code,effective_date",
    })
    .select()
    .single();
  if (error) throw error;
  return { ...data, amount: parseFloat(data.amount) };
}

export async function deleteFeeSchedule(id: string): Promise<void> {
  const { error } = await supabaseAdmin.from("fee_schedules").delete().eq("id", id);
  if (error) throw error;
}

// ── DOS Offsets ────────────────────────────────────────────────────────────

export async function listDosOffsets(): Promise<DosOffset[]> {
  const { data, error } = await supabaseAdmin
    .from("dos_offsets")
    .select("*")
    .order("program")
    .order("cpt_code");
  if (error) throw error;
  return data ?? [];
}

export async function updateDosOffset(
  id: string,
  patch: Partial<Pick<DosOffset, "offset_days" | "offset_type">>,
): Promise<DosOffset> {
  const { data, error } = await supabaseAdmin
    .from("dos_offsets")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// ── Billing Cycles ─────────────────────────────────────────────────────────

export async function getLatestCycle(patientId: string): Promise<BillingCycle | null> {
  const { data } = await supabaseAdmin
    .from("billing_cycles")
    .select("*")
    .eq("patient_id", patientId)
    .order("cycle_start", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ?? null;
}

export async function upsertBillingCycle(
  patientId: string,
  cycleStart: string,
  fields: Partial<Pick<BillingCycle, "consent_date" | "shipment_date">>,
  staffId?: string,
): Promise<BillingCycle> {
  const { data, error } = await supabaseAdmin
    .from("billing_cycles")
    .upsert(
      {
        patient_id: patientId,
        cycle_start: cycleStart,
        created_by: staffId ?? null,
        updated_at: new Date().toISOString(),
        ...fields,
      },
      { onConflict: "patient_id,cycle_start" },
    )
    .select()
    .single();
  if (error) throw error;
  return data;
}

// ── Billing Queue ──────────────────────────────────────────────────────────

export type BillingQueueFilters = {
  clinicId?: string;
  program?: string;
  insuranceType?: string;
  cptCode?: string;
  status?: string;
  month?: string; // YYYY-MM
};

export type BillingQueueRow = BillingRecord & {
  patient_name: string;
  patient_dob: string | null;
  clinic_name: string | null;
};

export async function listBillingQueue(
  role: string,
  userClinicId: string | null,
  filters: BillingQueueFilters = {},
): Promise<{ records: BillingQueueRow[]; totalCount: number }> {

  function buildMonthRange() {
    if (!filters.month || !/^\d{4}-\d{2}$/.test(filters.month)) return null;
    const [y, m] = filters.month.split("-").map(Number);
    if (m < 1 || m > 12) return null;
    const start   = `${y}-${String(m).padStart(2, "0")}-01`;
    const lastDay = new Date(y, m, 0).getDate();
    const end     = `${y}-${String(m).padStart(2, "0")}-${lastDay}`;
    return { start, end };
  }

  function applyFilters(q: any) {
    if (role === "clinic_admin" && userClinicId) q = q.eq("clinic_id", userClinicId);
    else if (filters.clinicId) q = q.eq("clinic_id", filters.clinicId);
    if (filters.program)       q = q.eq("program", filters.program);
    if (filters.insuranceType) q = q.eq("insurance_type", filters.insuranceType);
    if (filters.cptCode)       q = q.eq("cpt_code", filters.cptCode);
    if (filters.status)        q = q.eq("status", filters.status);
    const range = buildMonthRange();
    if (range) q = q.lte("cycle_start", range.end).gte("cycle_end", range.start);
    return q;
  }

  // Exact total count
  const { count } = await applyFilters(
    supabaseAdmin
      .from("billing_records")
      .select("*", { count: "exact", head: true })
      .not("status", "eq", "voided"),
  );
  const totalCount = count ?? 0;

  // Load current fee schedules so projected_amount reflects the latest admin-set rates,
  // not the stale value stored at evaluation time.
  const { data: feeData } = await supabaseAdmin
    .from("fee_schedules")
    .select("payer, cpt_code, amount")
    .is("end_date", null);
  const liveFeeMap = new Map<string, number>();
  for (const f of feeData ?? []) {
    liveFeeMap.set(`${f.payer}:${f.cpt_code}`, parseFloat(f.amount));
  }
  function liveAmount(insuranceType: string, cptCode: string): number | null {
    return liveFeeMap.get(`${insuranceType}:${cptCode}`)
      ?? liveFeeMap.get(`Medicare:${cptCode}`)
      ?? null;
  }

  // Paginate to fetch all rows (Supabase caps each request at 1000)
  const PAGE = 1000;
  let allRows: any[] = [];
  for (let from = 0; from < totalCount; from += PAGE) {
    const { data, error } = await applyFilters(
      supabaseAdmin
        .from("billing_records")
        .select(`*, patients!inner(full_name, dob), clinics(name)`)
        .not("status", "eq", "voided")
        .order("dos", { ascending: false, nullsFirst: false })
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .range(from, from + PAGE - 1),
    );
    if (error) throw error;
    allRows = allRows.concat(data ?? []);
  }

  // Live-compute total_minutes from time_logs + patient_review_times (batched to avoid URL limits)
  if (allRows.length > 0) {
    const patientIds = [...new Set(allRows.map((r: any) => r.patient_id as string))];
    const allStarts  = allRows.map((r: any) => r.cycle_start as string).filter(Boolean);
    const allEnds    = allRows.map((r: any) => r.cycle_end   as string).filter(Boolean);
    const rangeMin   = allStarts.reduce((a, b) => (a < b ? a : b));
    const rangeMax   = allEnds.reduce((a, b) => (a > b ? a : b));

    const rtMap = await fetchReviewMinutesMap(patientIds, rangeMin, rangeMax);
    for (const row of allRows) {
      row.total_minutes = minutesFromMap(rtMap, row.patient_id, row.cycle_start, row.cycle_end ?? row.cycle_start);
    }
  }

  // Deduplicate by id — inner join can cause the same row to appear across pages
  // if its position shifts between requests due to ordering ties.
  const seen = new Set<string>();
  const uniqueRows = allRows.filter((row: any) => {
    if (seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  });

  return {
    totalCount,
    records: uniqueRows.map((row: any) => ({
      ...row,
      patient_name:     row.patients?.full_name ?? "",
      patient_dob:      row.patients?.dob       ?? null,
      clinic_name:      row.clinics?.name       ?? null,
      projected_amount: liveAmount(row.insurance_type, row.cpt_code)
        ?? (row.projected_amount ? parseFloat(row.projected_amount) : null),
      actual_amount:    row.actual_amount ? parseFloat(row.actual_amount) : null,
      patients: undefined,
      clinics:  undefined,
    })),
  };
}

export async function updateBillingRecord(
  id: string,
  patch: Partial<Pick<BillingRecord, "status" | "dos" | "actual_amount" | "note_id" | "locked_at" | "submitted_at" | "override_reason">>,
  overrideBy?: string,
): Promise<BillingRecord> {
  const update: Record<string, unknown> = { ...patch, updated_at: new Date().toISOString() };
  if (overrideBy) update.override_by = overrideBy;
  const { data, error } = await supabaseAdmin
    .from("billing_records")
    .update(update)
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  return { ...data, projected_amount: data.projected_amount ? parseFloat(data.projected_amount) : null };
}

// ── Revenue Breakdown ──────────────────────────────────────────────────────

export type RevenueBreakdown = {
  totalProjected: number;
  totalSubmitted: number;
  totalPaid: number;
  pending: number;
  byProgram:   Array<{ program: string;       amount: number; count: number }>;
  byClinic:    Array<{ clinic_id: string; clinic_name: string; amount: number; count: number }>;
  byCpt:       Array<{ cpt_code: string;      amount: number; count: number; units: number }>;
  byInsurance: Array<{ insurance_type: string; amount: number; count: number }>;
  byMonth:     Array<{ month: string;         amount: number; count: number }>;
};

export async function getRevenueBreakdown(
  role: string,
  userClinicId: string | null,
  year: number,
  clinicId?: string,
): Promise<RevenueBreakdown> {
  let q = supabaseAdmin
    .from("billing_records")
    .select("*, clinics(name)")
    .gte("cycle_start", `${year}-01-01`)
    .lte("cycle_start", `${year}-12-31`)
    .not("status", "eq", "voided");

  if (role === "clinic_admin" && userClinicId) q = q.eq("clinic_id", userClinicId);
  else if (clinicId) q = q.eq("clinic_id", clinicId);

  const PAGE = 1000;
  let rows: any[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await q.range(from, from + PAGE - 1);
    if (error) throw error;
    rows = rows.concat(data ?? []);
    if ((data ?? []).length < PAGE) break;
  }

  const totalProjected = rows.reduce((s, r) => s + (parseFloat(r.projected_amount) || 0), 0);
  const totalSubmitted = rows
    .filter((r) => ["submitted", "paid"].includes(r.status))
    .reduce((s, r) => s + (parseFloat(r.projected_amount) || 0), 0);
  const totalPaid = rows
    .filter((r) => r.status === "paid")
    .reduce((s, r) => s + (parseFloat(r.actual_amount || r.projected_amount) || 0), 0);
  const pending = rows.filter((r) => ["pending", "generated", "reviewed"].includes(r.status)).length;

  const programMap  = new Map<string, { amount: number; count: number }>();
  const clinicMap   = new Map<string, { clinic_name: string; amount: number; count: number }>();
  const cptMap      = new Map<string, { amount: number; count: number; units: number }>();
  const insMap      = new Map<string, { amount: number; count: number }>();
  const monthMap    = new Map<string, { amount: number; count: number }>();

  for (const r of rows) {
    const amt   = parseFloat(r.projected_amount) || 0;
    const month = (r.cycle_start as string)?.slice(0, 7) ?? "";

    const p = programMap.get(r.program) ?? { amount: 0, count: 0 };
    programMap.set(r.program, { amount: p.amount + amt, count: p.count + 1 });

    const c = clinicMap.get(r.clinic_id) ?? { clinic_name: r.clinics?.name ?? "", amount: 0, count: 0 };
    clinicMap.set(r.clinic_id, { clinic_name: r.clinics?.name ?? c.clinic_name, amount: c.amount + amt, count: c.count + 1 });

    const ct = cptMap.get(r.cpt_code) ?? { amount: 0, count: 0, units: 0 };
    cptMap.set(r.cpt_code, { amount: ct.amount + amt, count: ct.count + 1, units: ct.units + r.units });

    const ins = insMap.get(r.insurance_type) ?? { amount: 0, count: 0 };
    insMap.set(r.insurance_type, { amount: ins.amount + amt, count: ins.count + 1 });

    const mo = monthMap.get(month) ?? { amount: 0, count: 0 };
    monthMap.set(month, { amount: mo.amount + amt, count: mo.count + 1 });
  }

  return {
    totalProjected,
    totalSubmitted,
    totalPaid,
    pending,
    byProgram:   [...programMap.entries()].map(([program, v]) => ({ program, ...v })).sort((a, b) => b.amount - a.amount),
    byClinic:    [...clinicMap.entries()].map(([clinic_id, v]) => ({ clinic_id, ...v })).sort((a, b) => b.amount - a.amount),
    byCpt:       [...cptMap.entries()].map(([cpt_code, v]) => ({ cpt_code, ...v })).sort((a, b) => b.amount - a.amount),
    byInsurance: [...insMap.entries()].map(([insurance_type, v]) => ({ insurance_type, ...v })).sort((a, b) => b.amount - a.amount),
    byMonth:     [...monthMap.entries()].map(([month, v]) => ({ month, ...v })).sort((a, b) => a.month.localeCompare(b.month)),
  };
}

// ── Per-Patient Billing Summary ────────────────────────────────────────────

export async function getPatientBillingSummary(patientId: string) {
  const [cycleRes, recordsRes, statsRes] = await Promise.all([
    supabaseAdmin
      .from("billing_cycles")
      .select("*")
      .eq("patient_id", patientId)
      .order("cycle_start", { ascending: false }),
    supabaseAdmin
      .from("billing_records")
      .select("*")
      .eq("patient_id", patientId)
      .order("cycle_start", { ascending: false })
      .order("cpt_code"),
    supabaseAdmin
      .from("patient_cycle_stats")
      .select("*")
      .eq("patient_id", patientId)
      .order("cycle_start", { ascending: false }),
  ]);

  return {
    cycles:  cycleRes.data ?? [],
    records: (recordsRes.data ?? []).map((r) => ({
      ...r,
      projected_amount: r.projected_amount ? parseFloat(r.projected_amount) : null,
      actual_amount:    r.actual_amount    ? parseFloat(r.actual_amount)    : null,
    })),
    stats: statsRes.data ?? [],
  };
}

// ── Patient Cycle Stats upsert (from sync) ─────────────────────────────────

export async function upsertPatientCycleStats(rows: PatientCycleStats[]): Promise<void> {
  if (rows.length === 0) return;
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await supabaseAdmin
      .from("patient_cycle_stats")
      .upsert(rows.slice(i, i + CHUNK), { onConflict: "patient_id,cycle_start" });
    if (error) console.error("[billing:stats] Upsert failed:", error.message);
  }
}
