import crypto from "crypto";
import { env } from "../env";

const TENOVI_BASE = "https://api2.tenovi.com";

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

// ── TOTP (RFC 6238, SHA-1, 30s window) ────────────────────────────────────

function base32Decode(s: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of s.replace(/=+$/, "").toUpperCase()) {
    const v = alphabet.indexOf(c);
    if (v !== -1) bits += v.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8)
    bytes.push(parseInt(bits.substring(i, i + 8), 2));
  return Buffer.from(bytes);
}

function computeTOTP(secret: string, windowOffset = 0): string {
  const key = base32Decode(secret);
  const counter = Math.floor(Date.now() / 1000 / 30) + windowOffset;
  const buf = Buffer.alloc(8);
  buf.writeBigInt64BE(BigInt(counter));
  const h = crypto.createHmac("sha1", key).update(buf).digest();
  const offset = h[h.length - 1] & 0xf;
  const code =
    (((h[offset] & 0x7f) << 24) |
      (h[offset + 1] << 16) |
      (h[offset + 2] << 8) |
      h[offset + 3]) %
    1_000_000;
  return code.toString().padStart(6, "0");
}

// ── RPM token cache ────────────────────────────────────────────────────────
// CRITICAL: each new login invalidates ALL prior tokens.
// Use a pending-promise to deduplicate concurrent login attempts.

let _rpmToken: string | null = null;
let _rpmTokenExpiry = 0;
let _pendingLogin: Promise<string> | null = null;
const TOKEN_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

async function doLogin(): Promise<string> {
  if (!env.TENOVI_USERNAME || !env.TENOVI_PASSWORD || !env.TENOVI_TOTP_SECRET) {
    throw new Error(
      "Tenovi RPM credentials not set (TENOVI_USERNAME, TENOVI_PASSWORD, TENOVI_TOTP_SECRET)"
    );
  }
  // Try current TOTP window, then ±1 to tolerate clock drift
  for (const windowOffset of [0, 1, -1]) {
    const otp = computeTOTP(env.TENOVI_TOTP_SECRET, windowOffset);
    const res = await fetch(`${TENOVI_BASE}/auth/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://app.tenovi.com" },
      body: JSON.stringify({
        username: env.TENOVI_USERNAME,
        password: env.TENOVI_PASSWORD,
        otp,
        otp_method: "A",
        session_cookie: crypto.randomUUID(),
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Tenovi auth → ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = (await res.json()) as Record<string, unknown>;
    if (typeof data.token === "string" && data.token) {
      _rpmToken = data.token;
      _rpmTokenExpiry = Date.now() + TOKEN_TTL_MS;
      return _rpmToken;
    }
    // No token in response — likely wrong OTP window. Log on last attempt.
    if (windowOffset === -1) {
      console.warn("[tenovi] Auth returned no token across all TOTP windows. Response:", JSON.stringify(data).slice(0, 300));
    }
  }
  throw new Error(
    "Tenovi auth: all three TOTP windows succeeded (HTTP 200) but returned no token — verify TENOVI_TOTP_SECRET is the correct base-32 TOTP seed"
  );
}

export async function getRpmToken(): Promise<string> {
  if (_rpmToken && Date.now() < _rpmTokenExpiry) return _rpmToken;
  if (_pendingLogin) return _pendingLogin;
  _pendingLogin = doLogin().finally(() => {
    _pendingLogin = null;
  });
  return _pendingLogin;
}

// ── RPM API fetch (full URL — handles paginated `next` links) ─────────────

async function rpmFetch<T>(url: string, retry = true): Promise<T> {
  const token = await getRpmToken();
  const res = await fetch(url, {
    headers: { Authorization: `Token ${token}`, Accept: "application/json" },
  });
  if (res.status === 401 && retry) {
    // Token expired on Tenovi's side before our local TTL — force re-login once
    _rpmToken = null;
    _rpmTokenExpiry = 0;
    return rpmFetch<T>(url, false);
  }
  if (!res.ok) throw new Error(`Tenovi RPM ${url} → ${res.status}`);
  return res.json() as Promise<T>;
}

// ── HWI API (Api-Key — gateway counts only) ───────────────────────────────

function hwiBase(): string {
  if (!env.TENOVI_API_KEY || !env.TENOVI_CLIENT_DOMAIN) {
    throw new Error("Tenovi HWI not configured (TENOVI_API_KEY, TENOVI_CLIENT_DOMAIN)");
  }
  return `${TENOVI_BASE}/clients/${env.TENOVI_CLIENT_DOMAIN}`;
}

async function hwiGet<T>(path: string): Promise<T> {
  const base = hwiBase();
  const res = await fetch(`${base}${path}`, {
    headers: { Authorization: `Api-Key ${env.TENOVI_API_KEY}` },
  });
  if (!res.ok) throw new Error(`Tenovi HWI ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

async function hwiGetFull<T>(url: string): Promise<T> {
  if (!env.TENOVI_API_KEY) throw new Error("TENOVI_API_KEY not set");
  const res = await fetch(url, {
    headers: { Authorization: `Api-Key ${env.TENOVI_API_KEY}` },
  });
  if (!res.ok) throw new Error(`Tenovi HWI ${url} → ${res.status}`);
  return res.json() as Promise<T>;
}

async function hwiPost<T>(path: string, body: object): Promise<T> {
  const base = hwiBase();
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Api-Key ${env.TENOVI_API_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Tenovi HWI POST ${path} → ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json() as Promise<T>;
}

// ── Response types ─────────────────────────────────────────────────────────

type Facility = { id: string; name: string };

type PatientEnrollment = {
  patient: { id: string; devices: { module?: string }[]; has_alert: boolean };
  status: string;
  review_time: number;             // seconds of clinical review this month
  number_of_measurements: number;
  date_of_service_99454: string | null;
};

type PatientsPage = { count: number; next: string | null; results: PatientEnrollment[] };
type PagedCount   = { count: number };

// ── Per-facility patient aggregation ──────────────────────────────────────

type FacilityAgg = {
  name: string;
  activePatients: number;
  rpmPatients: number;
  rtmPatients: number;
  totalDevices: number;
  with99454: number;
  with20min: number;
  patientsWithReadings: number;
  activeAlerts: number;
};

async function fetchFacility(facility: Facility): Promise<FacilityAgg> {
  let url: string | null =
    `${TENOVI_BASE}/clients/rpmcares/rpm/facilities/${facility.id}/patients/?status=AC&page_size=500`;
  const patients: PatientEnrollment[] = [];
  while (url) {
    const page: PatientsPage = await rpmFetch<PatientsPage>(url);
    patients.push(...page.results);
    url = page.next ?? null;
  }

  let rpmPatients = 0, rtmPatients = 0, totalDevices = 0;
  let with99454 = 0, with20min = 0, patientsWithReadings = 0, activeAlerts = 0;

  for (const p of patients) {
    const module = p.patient.devices[0]?.module ?? "RPM";
    if (module === "RTM") rtmPatients++; else rpmPatients++;
    totalDevices += p.patient.devices.length;
    if (p.date_of_service_99454) with99454++;
    if (p.review_time >= 1200) with20min++;
    if (p.number_of_measurements > 0) patientsWithReadings++;
    if (p.patient.has_alert) activeAlerts++;
  }

  return {
    name: facility.name,
    activePatients: patients.length,
    rpmPatients,
    rtmPatients,
    totalDevices,
    with99454,
    with20min,
    patientsWithReadings,
    activeAlerts,
  };
}

// ── Public types ───────────────────────────────────────────────────────────

export type TenoviFacilityItem = {
  name: string;
  activePatients: number;
  rpmPatients: number;
  rtmPatients: number;
  readingsCompliance: number;
  reviewCompliance: number;
};

export type TenoviSummary = {
  totalPatients: number;
  totalRpmPatients: number;
  totalRtmPatients: number;
  totalDevices: number;
  activeGateways: number;
  activeAlerts: number;
  readingsCompliance: number;
  reviewCompliance: number;
  patientsWithReadings: number;
  facilityBreakdown: TenoviFacilityItem[];
};

// ── Patient sync helpers ───────────────────────────────────────────────────

export type TenoviPatientListItem = {
  patient: {
    id: string;
    name: string;
    phone_number: string;
    devices: Array<{ module?: string }>;
    enrolled_in_ccm: boolean;
  };
  status: string;
  ordering_physician: string;
  health_condition: string;
};

type PatientListPage = { count: number; next: string | null; results: TenoviPatientListItem[] };

/** Fetch ALL patients for a single facility regardless of status (handles pagination) */
async function listFacilityPatients(facilityId: string): Promise<TenoviPatientListItem[]> {
  const all: TenoviPatientListItem[] = [];
  let url: string | null =
    `${TENOVI_BASE}/clients/rpmcares/rpm/facilities/${facilityId}/patients/?page_size=500`;
  while (url) {
    const page: PatientListPage = await rpmFetch<PatientListPage>(url);
    all.push(...(page.results ?? []));
    url = page.next ?? null;
  }
  return all;
}

type FacilityPatientsGroup = {
  facilityName: string;
  facilityId:   string;
  patients:     TenoviPatientListItem[];
};

/** Returns ALL Tenovi patients (all statuses) grouped by facility name. */
export async function listAllTenoviPatients(): Promise<FacilityPatientsGroup[]> {
  const facilities = await rpmFetch<Array<{ id: string; name: string }>>(
    `${TENOVI_BASE}/clients/rpmcares/facilities/`,
  );

  const results = await pLimit<FacilityPatientsGroup>(
    facilities.map((f) => async () => ({
      facilityName: f.name,
      facilityId:   f.id,
      patients:     await listFacilityPatients(f.id),
    })),
    5,
  );

  return results
    .filter((r): r is PromiseFulfilledResult<FacilityPatientsGroup> => r.status === "fulfilled")
    .map((r) => r.value);
}

// ── Per-patient reading counts for billing ────────────────────────────────

export type TenoviPatientReadings = {
  facilityName: string;
  patients: Array<{ externalId: string; readingCount: number; reviewSeconds: number }>;
};

/** Returns per-patient reading counts and review time for all active Tenovi patients, grouped by facility. */
export async function getTenoviReadingsByFacility(): Promise<TenoviPatientReadings[]> {
  const facilities = await rpmFetch<Facility[]>(`${TENOVI_BASE}/clients/rpmcares/facilities/`);

  const results = await pLimit<TenoviPatientReadings>(
    facilities.map((f) => async () => {
      let url: string | null =
        `${TENOVI_BASE}/clients/rpmcares/rpm/facilities/${f.id}/patients/?status=AC&page_size=500`;
      const patients: Array<{ externalId: string; readingCount: number; reviewSeconds: number }> = [];
      while (url) {
        const page: PatientsPage = await rpmFetch<PatientsPage>(url);
        for (const p of page.results) {
          patients.push({
            externalId:    String(p.patient.id),
            readingCount:  p.number_of_measurements,
            reviewSeconds: p.review_time,
          });
        }
        url = page.next ?? null;
      }
      return { facilityName: f.name, patients };
    }),
    5,
  );

  return results
    .filter((r): r is PromiseFulfilledResult<TenoviPatientReadings> => r.status === "fulfilled")
    .map((r) => r.value);
}

// ── Patient enrollment ─────────────────────────────────────────────────────

export async function getTenoviFacilities(): Promise<Array<{ id: string; name: string }>> {
  return rpmFetch<Array<{ id: string; name: string }>>(
    `${TENOVI_BASE}/clients/rpmcares/facilities/`,
  );
}

// Tenovi RPM API is read-only — no patient creation endpoint exists.
// Patient enrollment uses the HWI API (POST /hwi-patients/) which creates
// the patient record in Tenovi's system. The external_id is our identifier;
// readings appear once the patient is assigned a physical device.
export async function enrollTenoviPatient(
  _facilityId: string,
  data: {
    name: string;
    phone?: string;
    externalId: string;
    orderingPhysician?: string;
    healthCondition?: string;
  },
): Promise<{ patientId: string }> {
  const body: Record<string, unknown> = {
    external_id: data.externalId,
    name:        data.name,
  };
  if (data.phone)             body.phone_number = data.phone;
  if (data.orderingPhysician) body.physician    = data.orderingPhysician;

  await hwiPost<unknown>("/hwi/hwi-patients/", body);

  // The HWI patient is identified by external_id (which we control).
  // Store it so we can later match against RPM patient records.
  return { patientId: data.externalId };
}

// ── Client devices (RPM API — all enrolled devices) ───────────────────────

export type TenoviClientDevice = {
  id: string;
  device: {
    hardware_uuid: string;
    name: string;
    sensor_code: string;
  };
  gateway_id: string | null;
  module: string;
  patient: {
    id: string;
    name: string;
    facility_name: string;
    external_id: string;
    phone_number?: string | null;
  } | null;
  connected: boolean;
  connected_on: string | null;
  last_measurement: string | null;
  status: string;
};

type ClientDevicesPage = {
  count: number;
  next: string | null;
  results: TenoviClientDevice[];
};

export async function getTenoviClientDevices(): Promise<TenoviClientDevice[]> {
  const all: TenoviClientDevice[] = [];
  let url: string | null = `${TENOVI_BASE}/clients/rpmcares/data/client-devices/?page_size=500`;
  while (url) {
    const page: ClientDevicesPage = await rpmFetch<ClientDevicesPage>(url);
    all.push(...(page.results ?? []));
    url = page.next ?? null;
  }
  return all;
}

// ── Bulk orders (HWI API) ─────────────────────────────────────────────────

type HwiBulkOrderContent = {
  name: string;
  quantity: number;
  kit_id?: string | null;
};

export type TenoviBulkOrder = {
  id: string;
  order_number: string;
  created: string;
  updated: string;
  shipping_name?: string | null;
  shipping_address?: string | null;
  shipping_city?: string | null;
  shipping_state?: string | null;
  shipping_zip_code?: string | null;
  shipping_status: string;
  shipping_tracking_link?: string | null;
  fulfilled: boolean;
  requested_by?: string | null;
  shipped_on?: string | null;
  delivered_on?: string | null;
  contents: HwiBulkOrderContent[];
};

type BulkOrdersPage = {
  count: number;
  next: string | null;
  results: TenoviBulkOrder[];
};

export async function getTenoviBulkOrders(): Promise<TenoviBulkOrder[]> {
  const base = hwiBase();
  const all: TenoviBulkOrder[] = [];
  let url: string | null = `${base}/hwi/hwi-bulk-orders/?page_size=100`;
  while (url) {
    const page: BulkOrdersPage = await hwiGetFull<BulkOrdersPage>(url);
    all.push(...(page.results ?? []));
    url = page.next ?? null;
  }
  return all;
}

// ── HWI patient measurements ───────────────────────────────────────────────

export type TenoviHwiMeasurement = {
  metric: string;
  device_name?: string | null;
  hwi_device_id?: string | null;
  hardware_uuid?: string | null;
  sensor_code?: string | null;
  value_1: string;   // primary value as decimal string (systolic for BP)
  value_2: string;   // secondary value as decimal string (diastolic for BP, "0" otherwise)
  created: string;
  timestamp: string; // ISO datetime when reading was taken
};

type HwiMeasurementsPage = {
  count: number;
  next: string | null;
  results: TenoviHwiMeasurement[];
};

export async function getTenoviHwiMeasurements(
  patientExternalId: string,
  startDate: string,  // YYYY-MM-DD
  endDate: string,    // YYYY-MM-DD
): Promise<TenoviHwiMeasurement[]> {
  const base = hwiBase();
  const start = new Date(startDate + "T00:00:00").toISOString().slice(0, 19);
  const end   = new Date(endDate   + "T23:59:59").toISOString().slice(0, 19);

  const all: TenoviHwiMeasurement[] = [];
  let url: string | null =
    `${base}/hwi/patients/${encodeURIComponent(patientExternalId)}/measurements/` +
    `?timestamp__gte=${encodeURIComponent(start)}&timestamp__lt=${encodeURIComponent(end)}&page_size=100`;

  while (url) {
    const page = await hwiGetFull<HwiMeasurementsPage>(url);
    all.push(...(page.results ?? []));
    url = page.next ?? null;
  }
  return all;
}

// ── Device type catalog (HWI) ─────────────────────────────────────────────

export type TenoviDeviceType = {
  id: string;
  name: string;
  client_sku: string | null;
  stock_type: string | null;
  metrics: Array<{ name: string; primary_display_name: string }>;
  sensor_code: string;
  image: string | null;
  up_front_cost: string;
  shipping_cost: string;
  monthly_cost: string;
  sensor_id_required: boolean;
  in_stock: boolean;
  virtual: boolean;
  deprecated: boolean;
};

export async function getTenoviDeviceTypes(): Promise<TenoviDeviceType[]> {
  const result = await hwiGet<TenoviDeviceType[]>("/hwi/hwi-device-types/");
  return Array.isArray(result) ? result.filter((d) => !d.deprecated && !d.virtual) : [];
}

// ── Per-device fulfillment order ───────────────────────────────────────────

export type TenoviFulfillmentBody = {
  device: {
    name: string;
    hardware_uuid: null;
    fulfillment_request: {
      shipping_name: string;
      shipping_address: string;
      shipping_city: string;
      shipping_state: string;
      shipping_zip_code: string;
      notify_emails?: string;
    };
  };
  patient?: {
    external_id?: string;
    name?: string;
    phone_number?: string;
    sms_opt_in?: boolean;
  };
};

export async function createTenoviFulfillmentOrder(body: TenoviFulfillmentBody): Promise<unknown> {
  return hwiPost<unknown>("/hwi/hwi-devices/", body);
}

// ── Main export ────────────────────────────────────────────────────────────

export async function getTenoviSummary(allowedClinicNames?: string[]): Promise<TenoviSummary> {
  const [facilitiesResult, gatewaysResult] = await Promise.allSettled([
    rpmFetch<Facility[]>(`${TENOVI_BASE}/clients/rpmcares/facilities/`),
    hwiGet<PagedCount>("/hwi/hwi-gateways/?page_size=1&last_measurement__isnull=false"),
  ]);

  let facilities =
    facilitiesResult.status === "fulfilled" ? facilitiesResult.value : [];
  const activeGateways =
    gatewaysResult.status === "fulfilled" ? gatewaysResult.value.count : 0;

  if (facilitiesResult.status === "rejected")
    console.warn("[tenovi] Facilities fetch failed:", facilitiesResult.reason);

  // Scope to the caller's clinic(s) — super_admin passes undefined (all facilities)
  if (allowedClinicNames?.length) {
    const allowed = new Set(allowedClinicNames.map((n) => n.toLowerCase().trim()));
    facilities = facilities.filter((f) => allowed.has(f.name.toLowerCase().trim()));
  }

  if (facilities.length === 0) {
    return {
      totalPatients: 0, totalRpmPatients: 0, totalRtmPatients: 0,
      totalDevices: 0, activeGateways, activeAlerts: 0,
      readingsCompliance: 0, reviewCompliance: 0,
      patientsWithReadings: 0, facilityBreakdown: [],
    };
  }

  // Process 5 facilities at a time — avoids concurrent token invalidation issues
  const facilityResults = await pLimit(
    facilities.map((f) => () => fetchFacility(f)),
    5,
  );

  const failed = facilityResults.filter((r) => r.status === "rejected").length;
  if (failed > 0)
    console.warn(`[tenovi] ${failed}/${facilities.length} facilities failed`);

  const aggs = facilityResults
    .filter((r): r is PromiseFulfilledResult<FacilityAgg> => r.status === "fulfilled")
    .map((r) => r.value)
    .filter((f) => f.activePatients > 0);

  const totalPatients        = aggs.reduce((s, f) => s + f.activePatients, 0);
  const totalRpmPatients     = aggs.reduce((s, f) => s + f.rpmPatients, 0);
  const totalRtmPatients     = aggs.reduce((s, f) => s + f.rtmPatients, 0);
  const totalDevices         = aggs.reduce((s, f) => s + f.totalDevices, 0);
  const totalWith99454       = aggs.reduce((s, f) => s + f.with99454, 0);
  const totalWith20min       = aggs.reduce((s, f) => s + f.with20min, 0);
  const totalWithReadings    = aggs.reduce((s, f) => s + f.patientsWithReadings, 0);
  const totalActiveAlerts    = aggs.reduce((s, f) => s + f.activeAlerts, 0);

  const pct = (n: number) =>
    totalPatients > 0 ? Math.round((n / totalPatients) * 100) : 0;

  const facilityBreakdown: TenoviFacilityItem[] = aggs
    .map((f) => ({
      name: f.name,
      activePatients: f.activePatients,
      rpmPatients: f.rpmPatients,
      rtmPatients: f.rtmPatients,
      readingsCompliance:
        f.activePatients > 0
          ? Math.round((f.with99454 / f.activePatients) * 100)
          : 0,
      reviewCompliance:
        f.activePatients > 0
          ? Math.round((f.with20min / f.activePatients) * 100)
          : 0,
    }))
    .sort((a, b) => b.activePatients - a.activePatients);

  return {
    totalPatients,
    totalRpmPatients,
    totalRtmPatients,
    totalDevices,
    activeGateways,
    activeAlerts: totalActiveAlerts,
    readingsCompliance: pct(totalWith99454),
    reviewCompliance:   pct(totalWith20min),
    patientsWithReadings: totalWithReadings,
    facilityBreakdown,
  };
}
