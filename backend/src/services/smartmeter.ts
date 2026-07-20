import { env } from "../env";

const BASE = env.SMARTMETER_BASE_URL ?? "https://api.smartmeterrpm.com";

// Limits concurrent outbound HTTP calls — SmartMeter rate-limits aggressive parallelism.
async function pLimit<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      try {
        results[i] = { status: "fulfilled", value: await tasks[i]() };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return results;
}

// ── JWT cache (tokens expire in 30 min; refresh after 25) ─────────────────
const tokenCache = new Map<string, { jwt: string; expiresAt: number }>();

async function getJwt(apiKey: string): Promise<string> {
  const cached = tokenCache.get(apiKey);
  if (cached && Date.now() < cached.expiresAt) return cached.jwt;
  const res = await fetch(`${BASE}/api/token`, { headers: { "X-API-KEY": apiKey } });
  if (!res.ok) throw new Error(`SmartMeter /api/token → ${res.status}`);
  const body = (await res.json()) as { data: { jwt: string } };
  const jwt = body.data.jwt;
  tokenCache.set(apiKey, { jwt, expiresAt: Date.now() + 25 * 60 * 1000 });
  return jwt;
}

const REQUEST_TIMEOUT_MS = 20_000;

function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

async function smGet<T>(apiKey: string, path: string): Promise<T> {
  const jwt = await getJwt(apiKey);
  const res = await fetchWithTimeout(`${BASE}${path}`, { headers: { Authorization: `Bearer ${jwt}` } });
  if (!res.ok) throw new Error(`SmartMeter ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

async function smPost<T>(apiKey: string, path: string, body: object): Promise<T> {
  const jwt = await getJwt(apiKey);
  const res = await fetchWithTimeout(`${BASE}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`SmartMeter POST ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

async function smDelete(apiKey: string, path: string, body?: object): Promise<void> {
  const jwt = await getJwt(apiKey);
  const res = await fetchWithTimeout(`${BASE}${path}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${jwt}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`SmartMeter DELETE ${path} → ${res.status}: ${text.slice(0, 200)}`);
  }
}

// ── response shapes ────────────────────────────────────────────────────────
export type AlertItem = {
  alert_id: number;
  patient_name: string;
  patient_id: number;
  alert_date: string;
  alert_type: string;
  alert_threshold: number;
  reading_value: number;
};

type AlertListResp = { data: { alerts: AlertItem[] } };

type BillingRecord = {
  id: number;
  patient_id: number;
  is_billed: boolean;
  cpt_codes: { cpt_code: string; quantity: number }[];
  meta: { review_time_seconds: number } | null;
};
type BillingResp = { data: BillingRecord[] };

type ReadingItem = {
  patient_id:    number;
  date_recorded: string;
  device_id?:    string | number | null;
  reading_type?: string | null;
};
type ReadingsResp = { data: ReadingItem[] };

type WorklistResp = { data: { page: unknown[]; page_info: { total_records: number } } | string };

// ── helpers ────────────────────────────────────────────────────────────────
function isoDate(d: Date) { return d.toISOString().slice(0, 10); }
function isoDateTime(d: Date) { return d.toISOString().slice(0, 19); }

function currentMonthRange() {
  const now = new Date();
  return {
    start: isoDateTime(new Date(now.getFullYear(), now.getMonth(), 1)),
    end: isoDateTime(now),
  };
}

function billingRange(days = 60) {
  const now = new Date();
  const start = new Date(now);
  start.setDate(start.getDate() - days);
  return { start: isoDate(start), end: isoDate(now) };
}

function hasCpt(record: BillingRecord, ...codes: string[]) {
  return record.cpt_codes?.some((c) => codes.includes(c.cpt_code)) ?? false;
}

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[smartmeter] "${label}" failed, retrying in 5s… (${msg})`);
    await new Promise((r) => setTimeout(r, 5000));
    return fn();
  }
}

async function fetchPatientCount(apiKey: string, clinicName: string): Promise<number> {
  let page = 1, total = 0;
  while (true) {
    const res = await withRetry(
      () => smGet<{ data: unknown[] }>(apiKey, `/api/patients?page=${page}&size=100`),
      `${clinicName} patients p${page}`,
    );
    const count = res.data?.length ?? 0;
    total += count;
    if (count < 100) break;
    page++;
    if (page > 100) break;
  }
  return total;
}

// Count patients with 2+ distinct reading days this month from actual readings
async function fetchReadingsCompliance(apiKey: string): Promise<number> {
  const { start, end } = currentMonthRange();
  const resp = await smPost<ReadingsResp>(apiKey, "/api/readings", {
    date_start: start,
    date_end: end,
  });
  const readings = resp.data ?? [];
  const daysByPatient = new Map<number, Set<string>>();
  for (const r of readings) {
    const day = r.date_recorded?.slice(0, 10) ?? "";
    if (!day) continue;
    if (!daysByPatient.has(r.patient_id)) daysByPatient.set(r.patient_id, new Set());
    daysByPatient.get(r.patient_id)!.add(day);
  }
  return [...daysByPatient.values()].filter((days) => days.size >= 2).length;
}

// ── Individual patient detail (full profile) ──────────────────────────────

export type SmartMeterAddress = {
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  country?: string | null;
};

export type SmartMeterPatientDetail = {
  patient_id: number;
  first_name?: string | null;
  middle_name?: string | null;
  last_name?: string | null;
  suffix?: string | null;
  display_name?: string | null;
  gender?: string | null;
  race?: string | null;
  dob?: string | null;
  language?: string | null;
  time_zone?: string | null;
  email?: string | null;
  home_phone?: string | null;
  cell_phone?: string | null;
  message_delivery_preference?: string | null;
  preferred_phone?: string | null;
  preferred_time_of_day?: string | null;
  preferred_day_of_week?: string | null;
  shipping_address?: SmartMeterAddress | null;
  physical_address?: SmartMeterAddress | null;
};

export async function getSmartMeterPatientDetail(
  apiKey: string,
  patientId: string | number,
): Promise<SmartMeterPatientDetail | null> {
  try {
    const res = await withRetry(
      () => smGet<{ data: any }>(apiKey, `/api/patients/${patientId}`),
      `patient-detail-${patientId}`,
    );
    const d = res.data;
    if (!d) return null;
    // SmartMeter API uses date_of_birth, mobile_phone, etc. — map to our internal names
    return {
      patient_id:    d.patient_id ?? d.id,
      first_name:    d.first_name,
      middle_name:   d.middle_name,
      last_name:     d.last_name,
      suffix:        d.suffix,
      display_name:  d.display_name,
      gender:        d.gender,
      race:          d.race,
      dob:           d.dob ?? d.date_of_birth ?? null,
      language:      d.language,
      time_zone:     d.time_zone ?? d.time_zone_name ?? d.timezone ?? null,
      email:         d.email,
      home_phone:    d.home_phone ?? d.home_phone_number ?? null,
      cell_phone:    d.cell_phone ?? d.mobile_phone ?? null,
      message_delivery_preference: d.message_delivery_preference,
      preferred_phone:       d.preferred_phone,
      preferred_time_of_day: d.preferred_time_of_day,
      preferred_day_of_week: d.preferred_day_of_week,
      shipping_address:      d.shipping_address ?? null,
      physical_address:      d.physical_address ?? null,
    };
  } catch {
    return null;
  }
}

// ── Deactivate patient ────────────────────────────────────────────────────
// SmartMeter has no delete-patient endpoint; best we can do is set status=Inactive
// and disenrollment_date. Fetches current patient to include required fields.
export async function deactivateSmartMeterPatient(
  apiKey: string,
  patientId: string | number,
): Promise<void> {
  const jwt = await getJwt(apiKey);
  const now = new Date().toISOString().replace("T", "T").slice(0, 19);

  // Fetch current patient so we can include required fields (first_name, last_name, date_of_birth)
  let detail: SmartMeterPatientDetail | null = null;
  try {
    const r = await smGet<{ data: SmartMeterPatientDetail }>(apiKey, `/api/patients/${patientId}`);
    detail = r.data ?? null;
  } catch {
    // continue without detail — PUT may fail if required fields are missing
  }

  const body: Record<string, unknown> = {
    status: "Inactive",
    disenrollment_date: now,
  };
  if (detail?.first_name) body.first_name = detail.first_name;
  if (detail?.last_name)  body.last_name  = detail.last_name;
  if (detail?.dob)        body.date_of_birth = detail.dob;

  const res = await fetchWithTimeout(`${BASE}/api/patients/${patientId}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.warn(`[smartmeter] deactivate patient ${patientId} → ${res.status}: ${text.slice(0, 200)}`);
  } else {
    console.log(`[smartmeter] patient ${patientId} set to Inactive`);
  }
}

// ── Individual patient readings ────────────────────────────────────────────
// Field names match the SmartMeter /api/readings response exactly (see api-docs.yaml readings_info schema)

export type SmartMeterReadingDetail = {
  reading_id?: number | string;
  patient_id?: number;
  date_recorded?: string;
  reading_type?: string;           // "blood_pressure" | "blood_glucose" | "pulse_ox" | "weight" | "thermometer"
  systolic_mmhg?: number | null;
  diastolic_mmhg?: number | null;
  pulse_bpm?: number | null;
  blood_glucose_mgdl?: number | null;
  blood_glucose_mmol?: number | null;
  weight_lbs?: number | null;
  weight_kg?: number | null;
  spo2?: number | null;
  temperature?: number | null;
  is_flagged?: boolean;
  device_id?: string | number | null;
};

export async function getSmartMeterPatientReadingDetail(
  apiKey: string,
  patientId: string | number,
  startDate: string,  // YYYY-MM-DD
  endDate: string,    // YYYY-MM-DD
): Promise<SmartMeterReadingDetail[]> {
  // SmartMeter enforces a 31-day window per call — chunk into 30-day pieces if needed
  try {
    const jwt = await getJwt(apiKey);
    const all: SmartMeterReadingDetail[] = [];

    let chunkEnd = new Date(endDate + "T23:59:59");
    const rangeStart = new Date(startDate + "T00:00:00");

    while (chunkEnd >= rangeStart) {
      const chunkStart = new Date(chunkEnd);
      chunkStart.setDate(chunkStart.getDate() - 30);
      if (chunkStart < rangeStart) chunkStart.setTime(rangeStart.getTime());

      const res = await fetchWithTimeout(`${BASE}/api/readings`, {
        method: "POST",
        headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          date_start: chunkStart.toISOString().slice(0, 19),
          date_end: chunkEnd.toISOString().slice(0, 19),
          patient_id: Number(patientId),
        }),
      });
      if (res.ok) {
        const body = (await res.json()) as { data: SmartMeterReadingDetail[] };
        all.push(...(body.data ?? []).filter((r) => String(r.patient_id) === String(patientId)));
      } else {
        console.warn(`[smartmeter] readings chunk for patient ${patientId} → ${res.status}`);
      }

      chunkEnd = new Date(chunkStart);
      chunkEnd.setDate(chunkEnd.getDate() - 1);
    }

    return all;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[smartmeter] readings for patient ${patientId} failed: ${msg}`);
    return [];
  }
}

// ── Patient list (for sync) ────────────────────────────────────────────────

export type SmartMeterPatientItem = {
  patient_id: number;
  first_name?: string;
  last_name?: string;
  dob?: string;
  sex?: string;
  phone?: string;        // some API versions return phone here
  mobile_phone?: string; // others return it here
  cell_phone?: string;   // or here
  insurance_type?: string;
  primary_diagnosis?: string;
  language?: string;
};

/** Fetches ALL patients from a SmartMeter clinic (handles pagination). */
export async function listSmartMeterPatients(
  apiKey: string,
): Promise<SmartMeterPatientItem[]> {
  const all: SmartMeterPatientItem[] = [];
  let page = 1;
  while (true) {
    const res = await withRetry(
      () => smGet<{ data: SmartMeterPatientItem[] }>(apiKey, `/api/patients?page=${page}&size=100`),
      `patients p${page}`,
    );
    const batch = res.data ?? [];
    all.push(...batch);
    if (batch.length < 100) break;
    page++;
    if (page > 100) break; // safety cap
  }
  return all;
}

// ── Orders ────────────────────────────────────────────────────────────────

export type SmartMeterOrderLine = {
  id?: number;
  order_number?: string;
  line_item?: number;
  sku?: string;
  line_name?: string | null;
  serial_number?: string | null;
  lot_number?: string | null;
  qty?: number;
  device_model?: string | null;
  imei?: string | null;
  tracking_number?: string | null;
  carrier?: string | null;
};

export type SmartMeterOrder = {
  id: number;
  order_number: string;
  customer_id?: string | null;
  customer_name?: string | null;
  address1?: string | null;
  city?: string | null;
  state?: string | null;
  status?: string | null;
  carrier?: string | null;
  date_created?: string | null;
  last_updated?: string | null;
  date_shipped?: string | null;
  is_refill?: boolean;
  is_replacement?: boolean;
  is_sample?: boolean;
  lines: SmartMeterOrderLine[];
};

/** Fetch orders within the last `days` days (max 30-day window per request). */
export async function getSmartMeterOrders(apiKey: string, days = 30): Promise<SmartMeterOrder[]> {
  const all: SmartMeterOrder[] = [];
  const now = new Date();
  // SmartMeter enforces a 30-day maximum window per call; chunk accordingly.
  for (let offset = 0; offset < days; offset += 30) {
    const endDate = new Date(now);
    endDate.setDate(endDate.getDate() - offset);
    const startDate = new Date(now);
    startDate.setDate(startDate.getDate() - Math.min(offset + 30, days));
    const path = `/api/orders?start_date=${isoDate(startDate)}&end_date=${isoDate(endDate)}`;
    try {
      const res = await withRetry(
        () => smGet<{ data: SmartMeterOrder[] }>(apiKey, path),
        `orders-chunk-${offset}`,
      );
      all.push(...(res.data ?? []));
    } catch (err) {
      console.warn(`[smartmeter] orders chunk ${offset} failed:`, err);
    }
  }
  return all;
}

// ── Patient enrollment ─────────────────────────────────────────────────────

const LANG_ISO: Record<string, string> = { EN: "eng", ES: "spa", AR: "ara" };
const SEX_MAP:  Record<string, string> = { M: "male", F: "female" };

// Normalize phone to E.164 (required by SmartMeter).
// Accepts "+15551234567", "5551234567", "+1 555 123 4567", "(555) 123-4567", etc.
function toE164(raw?: string): string | undefined {
  if (!raw) return undefined;
  const digits = raw.replace(/\D/g, "");       // strip all non-digits
  if (raw.trimStart().startsWith("+")) {
    // Already had a country-code prefix — keep it with the stripped digits
    return digits.length >= 7 ? `+${digits}` : undefined;
  }
  if (digits.length === 10) return `+1${digits}`;       // bare US number
  if (digits.length === 11 && digits[0] === "1") return `+${digits}`;  // 1-prefixed US
  return undefined;  // unrecognizable — omit rather than send invalid
}

export async function enrollSmartMeterPatient(
  apiKey: string,
  data: {
    firstName: string;
    lastName: string;
    dob: string;          // YYYY-MM-DD
    sex?: "M" | "F" | string;
    phone?: string;
    language?: string;    // "EN" | "ES" | "AR"
  },
): Promise<{ patientId: string }> {
  const jwt = await getJwt(apiKey);

  const body: Record<string, string> = {
    first_name:    data.firstName,
    last_name:     data.lastName,
    date_of_birth: data.dob,
    language:      LANG_ISO[data.language ?? "EN"] ?? "eng",
  };
  const gender = SEX_MAP[data.sex ?? ""];
  if (gender)              body.gender       = gender;
  const phone = toE164(data.phone);
  if (phone)               body.mobile_phone = phone;

  console.log("[smartmeter] POST /api/patients →", JSON.stringify(body));

  const res = await fetchWithTimeout(`${BASE}/api/patients`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`SmartMeter enroll patient → ${res.status}: ${text.slice(0, 300)}`);
  }
  const json = (await res.json()) as any;
  const patientId = json?.data?.patient_id ?? json?.data?.id ?? json?.id;
  if (patientId == null) throw new Error("SmartMeter patient creation returned no ID");
  return { patientId: String(patientId) };
}

// ── per-clinic fetch ───────────────────────────────────────────────────────
type ClinicRaw = {
  name: string;
  totalPatients: number;
  compliant16: number;  // patients with 2+ distinct reading days this month
  unreadAlerts: number;
  openTasks: number;
  billingCount: number;
  compliant20: number;  // billing records with CPT 99457/99490 (20+ min)
  unbilled: number;
  reviewTimeSeconds: number;
  topAlerts: AlertItem[];
};

async function fetchClinic(name: string, apiKey: string, days: number): Promise<ClinicRaw> {
  const { start, end } = billingRange(days);

  const [patientsRes, readingsRes, alertsRes, billingRes, worklistRes] = await Promise.allSettled([
    fetchPatientCount(apiKey, name),
    fetchReadingsCompliance(apiKey),
    smGet<AlertListResp>(apiKey, "/api/patients/alerts/group?alert_status=unread&page=1&size=1000"),
    smGet<BillingResp>(apiKey, `/api/patients/billing?start_date=${start}&end_date=${end}`),
    smGet<WorklistResp>(apiKey, "/api/worklist/get-worklist?Status=OPEN&page=1&size=1"),
  ]);

  // Log any per-endpoint failures so we can diagnose which API call is flaky
  const endpoints = ["patients", "readings", "alerts", "billing", "worklist"];
  [patientsRes, readingsRes, alertsRes, billingRes, worklistRes].forEach((r, i) => {
    if (r.status === "rejected") {
      const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
      console.warn(`[smartmeter] "${name}" ${endpoints[i]} failed: ${msg}`);
    }
  });

  const totalPatients  = patientsRes.status === "fulfilled"  ? patientsRes.value : 0;
  const compliant16    = readingsRes.status === "fulfilled"  ? readingsRes.value  : 0;
  const allAlerts      = alertsRes.status === "fulfilled"    ? (alertsRes.value.data?.alerts ?? [])  : [];
  const billingRecords = billingRes.status === "fulfilled"   ? (billingRes.value.data ?? [])         : [];

  const billingCount      = billingRecords.length;
  const compliant20       = billingRecords.filter((r) => hasCpt(r, "99457", "99490")).length;
  const unbilled          = billingRecords.filter((r) => !r.is_billed).length;
  const reviewTimeSeconds = billingRecords.reduce((s, r) => s + (r.meta?.review_time_seconds ?? 0), 0);

  let openTasks = 0;
  if (worklistRes.status === "fulfilled") {
    const d = worklistRes.value.data;
    if (d && typeof d === "object" && "page_info" in d) {
      openTasks = (d as { page_info: { total_records: number } }).page_info.total_records ?? 0;
    }
  }

  return {
    name, totalPatients, compliant16, unreadAlerts: allAlerts.length, openTasks,
    billingCount, compliant20, unbilled, reviewTimeSeconds,
    topAlerts: allAlerts.slice(0, 5),
  };
}

// ── public types ───────────────────────────────────────────────────────────
export type ClinicBreakdownItem = {
  name: string;
  totalPatients: number;
  complianceRate: number;
  unreadAlerts: number;
  openTasks: number;
};

export type SmartMeterSummary = {
  totalPatients: number;
  unreadAlerts: number;
  openTasks: number;
  complianceRate: number;    // % patients with 2+ distinct reading days this month
  compliance20min: number;   // % billing records with CPT 99457/99490 (20+ min)
  billingReadiness: number;  // % billing records not yet submitted
  reviewTimeMinutes: number;
  topAlerts: AlertItem[];
  clinicBreakdown: ClinicBreakdownItem[];
};

// ── main export ────────────────────────────────────────────────────────────
export async function getSmartMeterSummary(
  clinics: { name: string; apiKey: string }[],
  options: { days?: number } = {},
): Promise<SmartMeterSummary> {
  const days = options.days ?? 60;
  if (clinics.length === 0) {
    return {
      totalPatients: 0, unreadAlerts: 0, openTasks: 0,
      complianceRate: 0, compliance20min: 0, billingReadiness: 0,
      reviewTimeMinutes: 0, topAlerts: [], clinicBreakdown: [],
    };
  }

  // Process max 4 clinics concurrently — avoids overwhelming SmartMeter API
  const results = await pLimit(
    clinics.map((c) => () => withRetry(() => fetchClinic(c.name, c.apiKey, days), c.name)),
    4,
  );

  const ok = results
    .filter((r): r is PromiseFulfilledResult<ClinicRaw> => r.status === "fulfilled")
    .map((r) => r.value);

  const failedResults = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failedResults.length > 0) {
    console.warn(`[smartmeter] ${failedResults.length}/${clinics.length} clinics failed after retry:`);
    results.forEach((r, i) => {
      if (r.status === "rejected") {
        const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
        console.warn(`  · ${clinics[i].name}: ${msg}`);
      }
    });
  }

  const totalPatients   = ok.reduce((s, c) => s + c.totalPatients, 0);
  const totalCompliant16 = ok.reduce((s, c) => s + c.compliant16,  0);
  const unreadAlerts    = ok.reduce((s, c) => s + c.unreadAlerts,  0);
  const openTasks       = ok.reduce((s, c) => s + c.openTasks,     0);
  const totalBilling    = ok.reduce((s, c) => s + c.billingCount,  0);
  const totalCompliant20 = ok.reduce((s, c) => s + c.compliant20,  0);
  const totalUnbilled   = ok.reduce((s, c) => s + c.unbilled,      0);
  const totalReviewSecs = ok.reduce((s, c) => s + c.reviewTimeSeconds, 0);

  // Compliance = compliant patients / total enrolled patients
  const complianceRate   = totalPatients > 0 ? Math.round((totalCompliant16 / totalPatients) * 100) : 0;
  // 20-min = billing records with 20+ min CPT / total billing records
  const compliance20min  = totalBilling  > 0 ? Math.round((totalCompliant20 / totalBilling)  * 100) : 0;
  // Billing readiness = unbilled / total billing records
  const billingReadiness = totalBilling  > 0 ? Math.round((totalUnbilled    / totalBilling)  * 100) : 0;
  const reviewTimeMinutes = totalBilling > 0 ? Math.round(totalReviewSecs / totalBilling / 60) : 0;

  const allAlerts = ok.flatMap((c) => c.topAlerts);
  allAlerts.sort((a, b) => new Date(b.alert_date).getTime() - new Date(a.alert_date).getTime());

  const clinicBreakdown: ClinicBreakdownItem[] = ok
    .map((c) => ({
      name: c.name,
      totalPatients: c.totalPatients,
      // Per-clinic compliance: compliant16 / totalPatients
      complianceRate: c.totalPatients > 0 ? Math.round((c.compliant16 / c.totalPatients) * 100) : 0,
      unreadAlerts: c.unreadAlerts,
      openTasks: c.openTasks,
    }))
    .sort((a, b) => b.totalPatients - a.totalPatients);

  return {
    totalPatients, unreadAlerts, openTasks,
    complianceRate, compliance20min, billingReadiness, reviewTimeMinutes,
    topAlerts: allAlerts.slice(0, 5),
    clinicBreakdown,
  };
}

// ── Per-patient review time records ──────────────────────────────────────

export type SmartMeterReviewTime = {
  review_time_id: number;
  clock_start: string;          // ISO datetime
  review_duration_seconds: number;
  note_id: number | null;
  note: string | null;
  patient_interaction: boolean;
  added_by: { user_id: number; display_name: string } | null;
};

export async function getSmartMeterReviewTime(
  apiKey: string,
  patientId: string | number,
): Promise<SmartMeterReviewTime[]> {
  try {
    const res = await smGet<{ data: { review_times: SmartMeterReviewTime[] } }>(
      apiKey,
      `/api/patients/${patientId}/review-time`,
    );
    return res.data?.review_times ?? [];
  } catch (err) {
    console.warn(`[smartmeter] review-time for patient ${patientId} failed:`, err);
    return [];
  }
}

export async function deleteSmartMeterReviewTime(
  apiKey: string,
  patientId: string | number,
  reviewTimeId: number,
): Promise<void> {
  const jwt = await getJwt(apiKey);
  const res = await fetchWithTimeout(
    `${BASE}/api/patients/${patientId}/review-time/${reviewTimeId}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${jwt}` } },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.warn(`[smartmeter] delete review-time ${reviewTimeId} → ${res.status}: ${text.slice(0, 200)}`);
  }
}

export async function getSmartMeterManualReview(
  apiKey: string,
  patientId: string | number,
  clockStart: string,
  durationSeconds: number,
  note: string | null,
  patientInteraction: boolean,
): Promise<{ review_time_id: number } | null> {
  const jwt = await getJwt(apiKey);
  const res = await fetchWithTimeout(
    `${BASE}/api/patients/${patientId}/review-time`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        clock_start:             clockStart,
        review_duration_seconds: durationSeconds,
        note:                    note ?? undefined,
        patient_interaction:     patientInteraction,
      }),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.warn(`[smartmeter] manual review POST → ${res.status}: ${text.slice(0, 200)}`);
    return null;
  }
  const body = await res.json().catch(() => ({})) as any;
  return body?.data?.review_time_id != null ? { review_time_id: body.data.review_time_id } : null;
}

// ── SKU catalog ───────────────────────────────────────────────────────────

export type SmartMeterSku = {
  sku: string;
  description: string;
  category: Array<{ short_code: string; category_name: string; is_primary: boolean }>;
  sort: number;
  includes_device: boolean;
  max_order_quantity: number;
  item_type: string;
  device_model: string[];
};

export async function getSmartMeterSkus(apiKey: string): Promise<SmartMeterSku[]> {
  try {
    const res = await smGet<{ data: SmartMeterSku[] }>(apiKey, "/api/orders/available-skus");
    return res.data ?? [];
  } catch (err) {
    console.warn("[smartmeter] getSmartMeterSkus failed:", err);
    return [];
  }
}

// ── Order creation ────────────────────────────────────────────────────────

export type SmartMeterCreateOrderBody = {
  order: {
    order_number: string;
    customer_name: string;
    address1: string;
    address2?: string;
    city: string;
    state: string;
    zipcode: string;
    country?: string;
    shipping_method: string;
    po_number?: string;
    validate?: boolean;
  };
  lines: Array<{ sku: string; quantity: number }>;
  patient_id?: number;
};

export async function createSmartMeterOrder(
  apiKey: string,
  body: SmartMeterCreateOrderBody,
): Promise<{ id: number; order_number: string }> {
  const res = await smPost<{ data: { order: { id: number; order_number: string } } }>(
    apiKey,
    "/api/orders",
    body,
  );
  return res.data.order;
}

// ── Patient devices (from patient detail endpoint) ────────────────────────

export type SmartMeterDevice = {
  device_id:                string;
  device_model:             string | null;
  device_type:              string | null;
  date_added:               string | null;
  most_recent_reading_date: string | null;
};

/** Returns devices assigned to a patient in SmartMeter (via GET /api/patients/{id}). */
export async function getSmartMeterPatientDevices(
  apiKey: string,
  smPatientId: string | number,
): Promise<SmartMeterDevice[]> {
  try {
    const res = await smGet<{ data: { devices?: SmartMeterDevice[] } }>(
      apiKey,
      `/api/patients/${smPatientId}`,
    );
    return (res.data?.devices ?? []).filter((d) => d?.device_id);
  } catch (err) {
    console.warn(`[smartmeter] getSmartMeterPatientDevices for ${smPatientId} failed:`, err);
    return [];
  }
}

/** Assigns a device (by IMEI/device_id) to a SmartMeter patient. */
export async function assignSmartMeterDevice(
  apiKey: string,
  smPatientId: string | number,
  deviceId: string,
): Promise<void> {
  try {
    await smPost(apiKey, `/api/patients/${smPatientId}/device`, { device_id: deviceId });
  } catch (err) {
    console.warn(`[smartmeter] assignSmartMeterDevice ${deviceId} → patient ${smPatientId} failed:`, err);
  }
}

/** Removes a device from a SmartMeter patient. */
export async function unassignSmartMeterDevice(
  apiKey: string,
  smPatientId: string | number,
  deviceId: string,
): Promise<void> {
  try {
    await smDelete(apiKey, `/api/patients/${smPatientId}/device/${encodeURIComponent(deviceId)}`);
  } catch (err) {
    console.warn(`[smartmeter] unassignSmartMeterDevice ${deviceId} from patient ${smPatientId} failed:`, err);
  }
}

// ── Active device fleet (from readings, which carry device_id) ────────────

export type SmartMeterActiveDevice = {
  deviceId:    string;
  patientId:   number;
  readingType: string;
  lastReading: string;
};

/**
 * Derives the active SmartMeter device fleet by scanning the last 30 days of
 * readings. Each reading carries a device_id (IMEI / serial). We deduplicate
 * by deviceId and keep the most-recent reading per device.
 *
 * This is the only reliable way to surface SmartMeter devices — the orders API
 * only populates imei/serial_number after physical fulfilment, which never
 * happens for clinic-shipped bulk orders.
 */
export async function getSmartMeterActiveDevices(apiKey: string): Promise<SmartMeterActiveDevice[]> {
  const { start, end } = currentMonthRange();
  try {
    const resp = await smPost<ReadingsResp>(apiKey, "/api/readings", {
      date_start: start,
      date_end:   end,
    });

    const deviceMap = new Map<string, SmartMeterActiveDevice>();
    for (const r of resp.data ?? []) {
      if (!r.device_id) continue;
      const deviceId = String(r.device_id);
      const existing = deviceMap.get(deviceId);
      if (!existing || (r.date_recorded ?? "") > existing.lastReading) {
        deviceMap.set(deviceId, {
          deviceId,
          patientId:   r.patient_id ?? 0,
          readingType: r.reading_type ?? "unknown",
          lastReading: r.date_recorded ?? "",
        });
      }
    }
    return [...deviceMap.values()];
  } catch (err) {
    console.warn("[smartmeter] getSmartMeterActiveDevices failed:", err);
    return [];
  }
}

/**
 * Fetches readings for a specific SM patient over `days` days.
 * Returns one entry per unique device_id (the SM device identifier), keeping
 * the most-recent reading as lastReading. Used to auto-sync patient_devices.
 */
export async function getSmartMeterReadingsForPatient(
  apiKey:      string,
  smPatientId: number | string,
  days:        number = 365,
): Promise<SmartMeterActiveDevice[]> {
  const end   = new Date();
  const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const fmt   = (d: Date) => d.toISOString().split("T")[0];
  try {
    const resp = await smPost<ReadingsResp>(apiKey, "/api/readings", {
      date_start: fmt(start),
      date_end:   fmt(end),
      patient_id: Number(smPatientId),
    });
    const deviceMap = new Map<string, SmartMeterActiveDevice>();
    for (const r of resp.data ?? []) {
      if (!r.device_id) continue;
      const deviceId = String(r.device_id);
      const existing = deviceMap.get(deviceId);
      if (!existing || (r.date_recorded ?? "") > existing.lastReading) {
        deviceMap.set(deviceId, {
          deviceId,
          patientId:   r.patient_id ?? Number(smPatientId),
          readingType: r.reading_type ?? "unknown",
          lastReading: r.date_recorded ?? "",
        });
      }
    }
    return [...deviceMap.values()];
  } catch (err) {
    console.warn("[smartmeter] getSmartMeterReadingsForPatient failed:", err);
    return [];
  }
}

/**
 * Like getSmartMeterReadingsForPatient but includes readings even when device_id is null.
 * Returns one entry per unique reading_type, keeping the latest reading date.
 * Used as a final fallback so every patient with readings gets a device entry.
 */
export async function getSmartMeterReadingTypesForPatient(
  apiKey:      string,
  smPatientId: number | string,
  days:        number = 365,
): Promise<{ readingType: string; lastReading: string }[]> {
  const end   = new Date();
  const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const fmt   = (d: Date) => d.toISOString().split("T")[0];
  try {
    const resp = await smPost<ReadingsResp>(apiKey, "/api/readings", {
      date_start: fmt(start),
      date_end:   fmt(end),
      patient_id: Number(smPatientId),
    });
    const typeMap = new Map<string, string>(); // readingType → lastReading
    for (const r of resp.data ?? []) {
      const type = r.reading_type ?? "unknown";
      const date = r.date_recorded ?? "";
      if (!typeMap.has(type) || date > (typeMap.get(type) ?? "")) {
        typeMap.set(type, date);
      }
    }
    return [...typeMap.entries()].map(([readingType, lastReading]) => ({ readingType, lastReading }));
  } catch {
    return [];
  }
}

/** Returns the raw number of readings for a patient in a date range (no deduplication). */
export async function countSmartMeterReadingsForPatient(
  apiKey:      string,
  smPatientId: number | string,
  dateStart:   string,
  dateEnd:     string,
): Promise<number> {
  const numericId = Number(smPatientId);
  if (!Number.isFinite(numericId) || numericId <= 0) return -1; // non-numeric external ID — skip silently
  try {
    const resp = await smPost<ReadingsResp>(apiKey, "/api/readings", {
      date_start: dateStart,
      date_end:   dateEnd,
      patient_id: numericId,
    });
    return (resp.data ?? []).length;
  } catch (err: any) {
    // 500 from SmartMeter is expected when the patient doesn't exist in their system.
    // Return -1 so the caller falls back to cached reading stats.
    console.debug(`[smartmeter] readings count skipped for patient ${smPatientId}:`, err?.message ?? err);
    return -1;
  }
}

// ── Orders for a specific patient (for IMEI detection) ───────────────────

export type DetectedImei = {
  imei: string;
  serialNumber: string | null;
  deviceModel: string | null;
  deviceName: string | null;
  orderNumber: string;
  orderedAt: string | null;
};

/**
 * Fetches orders for a specific SmartMeter patient (by customer_id) over
 * `days` days and extracts IMEIs from shipped order lines.
 */
export async function getSmartMeterDevicesForPatient(
  apiKey: string,
  smPatientId: string | number,
  days = 180,
): Promise<DetectedImei[]> {
  const orders = await getSmartMeterOrders(apiKey, days);
  const seen   = new Set<string>();
  const result: DetectedImei[] = [];

  for (const order of orders) {
    if (String(order.customer_id) !== String(smPatientId)) continue;
    for (const line of order.lines ?? []) {
      const imei = line.imei ?? line.serial_number;
      if (!imei || seen.has(imei)) continue;
      seen.add(imei);
      result.push({
        imei,
        serialNumber: line.serial_number ?? null,
        deviceModel:  line.device_model   ?? null,
        deviceName:   line.line_name      ?? null,
        orderNumber:  order.order_number,
        orderedAt:    order.date_created  ?? null,
      });
    }
  }
  return result;
}

// ── Per-patient reading counts (used by billing engine sync) ──────────────
// Returns a map of SmartMeter patient_id → distinct reading day count this month.
export async function getSmartMeterReadingsByPatient(
  apiKey: string,
): Promise<Map<number, number>> {
  const { start, end } = currentMonthRange();
  try {
    const resp = await smPost<ReadingsResp>(apiKey, "/api/readings", {
      date_start: start,
      date_end:   end,
    });
    const daysByPatient = new Map<number, Set<string>>();
    for (const r of resp.data ?? []) {
      const day = r.date_recorded?.slice(0, 10) ?? "";
      if (!day) continue;
      if (!daysByPatient.has(r.patient_id)) daysByPatient.set(r.patient_id, new Set());
      daysByPatient.get(r.patient_id)!.add(day);
    }
    const result = new Map<number, number>();
    for (const [pid, days] of daysByPatient) result.set(pid, days.size);
    return result;
  } catch (err) {
    console.warn("[smartmeter] getSmartMeterReadingsByPatient failed:", err);
    return new Map();
  }
}
