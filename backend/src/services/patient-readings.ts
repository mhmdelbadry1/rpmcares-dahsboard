/**
 * Unified readings fetcher for SmartMeter and Tenovi patients.
 * Returns a normalised PatientReading[] regardless of source.
 */
import { env } from "../env";
import { getTenoviHwiMeasurements } from "./tenovi";

// ── Shared output type ─────────────────────────────────────────────────────

export type ReadingType =
  | "blood_pressure"
  | "glucose"
  | "weight"
  | "spo2"
  | "heart_rate"
  | "temperature"
  | "unknown";

export type PatientReading = {
  id: string;
  timestamp: string;       // ISO
  type: ReadingType;
  label: string;           // "Blood Pressure"
  displayValue: string;    // "128/84 mmHg"
  value: number | null;    // primary numeric (systolic for BP)
  unit: string;
  systolic?: number;
  diastolic?: number;
  pulse?: number;
  flagged: boolean;
  source: "smartmeter" | "tenovi";
  deviceId?: string | null;
};

// ── Helpers ────────────────────────────────────────────────────────────────

function isoDateTime(d: Date) { return d.toISOString().slice(0, 19); }

function dateRange(days: number) {
  const now = new Date();
  const start = new Date(now);
  start.setDate(start.getDate() - days);
  return { start: isoDateTime(start), end: isoDateTime(now) };
}

function normaliseType(raw: string | null | undefined): ReadingType {
  const r = (raw ?? "").toLowerCase().replace(/[\s_-]/g, "");
  if (r.includes("glucose") || r.includes("sugar")) return "glucose";  // must precede "blood" check
  if (r.includes("pressure") || r === "bp") return "blood_pressure";
  if (r.includes("weight")) return "weight";
  if (r.includes("pulseox") || r.includes("spo2") || r.includes("oxygen") || r.includes("oximetry")) return "spo2";
  if (r.includes("heart") || r.includes("pulse") || r.includes("hr")) return "heart_rate";
  if (r.includes("temp") || r === "thermometer") return "temperature";
  return "unknown";
}

const TYPE_LABELS: Record<ReadingType, string> = {
  blood_pressure: "Blood Pressure",
  glucose:        "Glucose",
  weight:         "Weight",
  spo2:           "SpO₂",
  heart_rate:     "Heart Rate",
  temperature:    "Temperature",
  unknown:        "Reading",
};


function unitForType(type: ReadingType): string {
  const m: Record<ReadingType, string> = {
    blood_pressure: "mmHg", glucose: "mg/dL", weight: "lbs",
    spo2: "%", heart_rate: "bpm", temperature: "°F", unknown: "",
  };
  return m[type];
}

// ── SmartMeter ─────────────────────────────────────────────────────────────

const SM_BASE = env.SMARTMETER_BASE_URL ?? "https://api.smartmeterrpm.com";

const smTokenCache = new Map<string, { jwt: string; expiresAt: number }>();
async function getSmJwt(apiKey: string): Promise<string> {
  const cached = smTokenCache.get(apiKey);
  if (cached && Date.now() < cached.expiresAt) return cached.jwt;
  const res = await fetch(`${SM_BASE}/api/token`, { headers: { "X-API-KEY": apiKey } });
  if (!res.ok) throw new Error(`SmartMeter /api/token → ${res.status}`);
  const body = (await res.json()) as { data: { jwt: string } };
  const jwt = body.data.jwt;
  smTokenCache.set(apiKey, { jwt, expiresAt: Date.now() + 25 * 60 * 1000 });
  return jwt;
}

// Field names match SmartMeter /api/readings response (see api-docs.yaml readings_info schema)
type RawSmReading = {
  reading_id?: number;
  patient_id: number;
  date_recorded: string;
  reading_type?: string;
  systolic_mmhg?: number | null;
  diastolic_mmhg?: number | null;
  pulse_bpm?: number | null;
  blood_glucose_mgdl?: number | null;
  weight_lbs?: number | null;
  spo2?: number | null;
  temperature?: number | null;
  is_flagged?: boolean;
  device_id?: string | number;
};

export async function getSmartMeterPatientReadings(
  apiKey: string,
  patientId: string | number,
  days = 30,
): Promise<PatientReading[]> {
  const jwt = await getSmJwt(apiKey);
  const { start, end } = dateRange(days);

  const res = await fetch(`${SM_BASE}/api/readings`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify({ date_start: start, date_end: end, patient_id: Number(patientId) }),
  });
  if (!res.ok) throw new Error(`SmartMeter /api/readings → ${res.status}`);
  const body = (await res.json()) as { data: RawSmReading[] };
  const rows = body.data ?? [];

  return rows
    .filter((r) => String(r.patient_id) === String(patientId))
    .map((r, i): PatientReading => {
      const type = normaliseType(r.reading_type);
      const unit = unitForType(type);
      let value: number | null = null;
      let systolic: number | undefined;
      let diastolic: number | undefined;
      let pulse: number | undefined;
      let displayValue = "—";

      if (type === "blood_pressure") {
        systolic = r.systolic_mmhg ?? undefined;
        diastolic = r.diastolic_mmhg ?? undefined;
        pulse = r.pulse_bpm ?? undefined;
        value = systolic ?? null;
        displayValue = systolic != null && diastolic != null ? `${systolic}/${diastolic} ${unit}` : "—";
      } else if (type === "glucose") {
        value = r.blood_glucose_mgdl ?? null;
        displayValue = value != null ? `${value} ${unit}` : "—";
      } else if (type === "weight") {
        value = r.weight_lbs ?? null;
        displayValue = value != null ? `${value} ${unit}` : "—";
      } else if (type === "spo2") {
        value = r.spo2 ?? null;
        displayValue = value != null ? `${value}${unit}` : "—";
      } else if (type === "heart_rate") {
        value = r.pulse_bpm ?? null;
        displayValue = value != null ? `${value} ${unit}` : "—";
      } else if (type === "temperature") {
        value = r.temperature ?? null;
        displayValue = value != null ? `${value} ${unit}` : "—";
      }

      return {
        id: String(r.reading_id ?? `sm-${i}-${r.date_recorded}`),
        timestamp: r.date_recorded,
        type,
        label: TYPE_LABELS[type],
        displayValue,
        value,
        unit,
        systolic,
        diastolic,
        pulse,
        flagged: r.is_flagged ?? false,
        source: "smartmeter",
        deviceId: r.device_id != null ? String(r.device_id) : null,
      };
    })
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
}

// ── Tenovi ─────────────────────────────────────────────────────────────────

// Metrics from Tenovi HWI that are device telemetry, not clinical readings
const SKIP_TENOVI_METRICS = new Set(["battery_percentage", "signal_strength", "irregular_heartbeat"]);

export async function getTenoviPatientReadings(
  externalPatientId: string,
  startDate: string,  // YYYY-MM-DD
  endDate: string,    // YYYY-MM-DD
): Promise<PatientReading[]> {
  // HWI /hwi/patients/{external_id}/measurements/ aggregates all devices for the patient
  const all = await getTenoviHwiMeasurements(externalPatientId, startDate, endDate);

  return all
    .filter((r) => !!r.timestamp && !SKIP_TENOVI_METRICS.has(r.metric))
    .map((r, i): PatientReading => {
      const type = normaliseType(r.metric);
      const unit = unitForType(type);
      const primaryVal  = r.value_1 ? parseFloat(r.value_1)  : null;
      const secondaryVal = r.value_2 ? parseFloat(r.value_2) : null;

      let value: number | null = primaryVal != null && !isNaN(primaryVal) ? primaryVal : null;
      let systolic: number | undefined;
      let diastolic: number | undefined;
      let displayValue = "—";

      if (type === "blood_pressure") {
        systolic  = primaryVal  != null && !isNaN(primaryVal)  ? primaryVal  : undefined;
        diastolic = secondaryVal != null && !isNaN(secondaryVal) && secondaryVal !== 0
          ? secondaryVal : undefined;
        value = systolic ?? null;
        if (systolic != null && diastolic != null) displayValue = `${systolic}/${diastolic} ${unit}`;
        else if (systolic != null) displayValue = `${systolic} ${unit}`;
      } else if (value != null) {
        displayValue = `${value} ${unit}`;
      }

      return {
        id: `tnv-${r.hwi_device_id ?? "x"}-${i}-${r.timestamp}`,
        timestamp: r.timestamp,
        type,
        label: TYPE_LABELS[type],
        displayValue,
        value,
        unit,
        systolic,
        diastolic,
        flagged: false,
        source: "tenovi",
        deviceId: r.hwi_device_id ?? null,
      };
    })
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
}
