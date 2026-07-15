const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:4000';

// Paths that must never trigger the 401-refresh retry (they ARE the auth endpoints)
const NO_REFRESH_PATHS = ['/api/auth/login', '/api/auth/refresh'];

// Module-level refresh callback, set by AuthProvider on mount.
// Called when any request gets a 401 — returns a fresh access token or null.
let _refreshCallback: (() => Promise<string | null>) | null = null;

// Deduplicates concurrent 401-triggered refreshes so we only call the
// backend once even when multiple requests expire at the same moment.
let _pendingRefresh: Promise<string | null> | null = null;

// Called when any request returns a 403 "suspended" response.
let _suspendedCallback: (() => void) | null = null;

export function configureRefresh(fn: (() => Promise<string | null>) | null) {
  _refreshCallback = fn;
}

export function configureSuspended(fn: (() => void) | null) {
  _suspendedCallback = fn;
}

export type Role = 'super_admin' | 'clinic_admin' | 'staff';

export type ApiUser = { id: string; email: string; role: Role; name: string; clinicId: string | null };

export type LoginResponse = { token: string; refreshToken: string; expiresAt: number; user: ApiUser };

export type Member = {
  id: string;
  email: string;
  role: Role;
  name: string;
  clinic_id: string | null;
  created_at: string;
  banned_until?: string | null;
};

export type Clinic = {
  id: string;
  name: string;
  specialty: string | null;
  location: string | null;
  created_at: string;
  hasSmartMeterKey: boolean;
};

export type SmartMeterAlert = {
  alert_id: number;
  patient_name: string;
  patient_id: number;
  alert_date: string;
  alert_type: string;
  alert_threshold: number;
  reading_value: number;
};

export type ClinicBreakdownItem = {
  name: string;
  totalPatients: number;
  complianceRate: number;
  unreadAlerts: number;
  openTasks: number;
};

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

export type DashboardSummary = {
  tenovi: TenoviSummary | null;
  smartmeter: {
    totalPatients: number;
    unreadAlerts: number;
    openTasks: number;
    complianceRate: number;
    compliance20min: number;
    billingReadiness: number;
    reviewTimeMinutes: number;
    topAlerts: SmartMeterAlert[];
    clinicBreakdown: ClinicBreakdownItem[];
  };
  cachedAt?: string | null;
};

export type AlertStatus = 'open' | 'assigned' | 'escalated' | 'resolved';

export type AlertEvent = {
  id: string;
  timestamp: string | null;
  patient_id: string;
  patient_name: string;
  patient_uuid: string | null;  // our internal UUID, enriched by the API
  clinic_name: string;
  alert_type: string;
  tier: string;
  value: string | null;
  unit: string | null;
  threshold: string | null;
  device_type: string | null;
  reading_id: string | null;
  reading_time: string | null;
  provider_email: string | null;
  sms_sent: string | null;
  email_sent: string | null;
  status: AlertStatus;
  assigned_to: string | null;
  assignee: { id: string; name: string; email: string } | null;
  resolved_at: string | null;
  created_at: string;
};

export type PatientSource  = 'tenovi' | 'smartmeter';
export type PatientProgram = 'RPM' | 'RTM' | 'CCM' | 'PCM';

export type SmartMeterAddress = {
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  country?: string | null;
};

export type SmartMeterDetail = {
  patient_id?: number;
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

// Matches the existing public.patients table in Supabase
export type Patient = {
  id: string;
  clinic_id: string;
  clinic_name: string | null;
  source: PatientSource;            // device_vendor enum
  external_patient_id: string;
  mrn: string | null;
  full_name: string;
  dob: string | null;
  sex: string | null;               // sex_type enum
  phone: string | null;
  language: string;
  provider_id: string | null;
  assigned_staff_id: string | null;
  program: PatientProgram;
  diagnoses: string[];
  icd10_codes: string[];
  insurance_payer: string | null;
  insurance_class: string | null;
  enrollment_status: string;        // enrollment_status enum (default 'active')
  consent: boolean;
  risk: string;                     // risk_level enum
  enrolled_at: string;
  disenrolled_at: string | null;
  created_at: string;
  updated_at: string;
};

export type ReadingType =
  | 'blood_pressure' | 'glucose' | 'weight'
  | 'spo2' | 'heart_rate' | 'temperature' | 'unknown';

export type PatientReading = {
  id: string;
  timestamp: string;
  type: ReadingType;
  label: string;
  displayValue: string;
  value: number | null;
  unit: string;
  systolic?: number;
  diastolic?: number;
  pulse?: number;
  flagged: boolean;
  source: 'smartmeter' | 'tenovi';
  deviceId?: string | null;
};

export type EnrollPatientInput = {
  clinicId: string;
  system: PatientSource;
  firstName: string;
  lastName: string;
  dob?: string;
  sex?: 'M' | 'F';
  phone?: string;
  language?: string;
  insurance?: string;
  program: PatientProgram;
  diagnosis?: string;
  orderingPhysician?: string;
  healthCondition?: string;
};

// ── Billing types ──────────────────────────────────────────────────────────

export type BillingRecord = {
  id: string;
  patient_id: string;
  patient_name: string;
  patient_dob: string | null;
  clinic_id: string;
  clinic_name: string | null;
  cycle_start: string;
  cycle_end: string;
  cpt_code: string;
  units: number;
  dos: string | null;
  program: string;
  insurance_type: string;
  status: 'pending' | 'generated' | 'reviewed' | 'signed' | 'submitted' | 'paid' | 'voided';
  projected_amount: number | null;
  actual_amount: number | null;
  reading_count: number | null;
  total_minutes: number | null;
  note_id: string | null;
  locked_at: string | null;
  submitted_at: string | null;
  override_reason: string | null;
  created_at: string;
  updated_at: string;
};

export type BillingRuleItem = {
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

export type FeeScheduleItem = {
  id: string;
  payer: string;
  cpt_code: string;
  amount: number;
  effective_date: string;
  end_date: string | null;
  created_at: string;
  updated_at: string;
};

export type DosOffsetItem = {
  id: string;
  program: string;
  cpt_code: string;
  offset_days: number | null;
  offset_type: 'cycle_start' | 'shipment_date';
  created_at: string;
  updated_at: string;
};

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

export type PatientBillingSummary = {
  cycles:  Array<{ id: string; cycle_start: string; consent_date: string | null; shipment_date: string | null }>;
  records: BillingRecord[];
  stats:   Array<{ cycle_start: string; cycle_end: string; reading_count: number; monitoring_days: number }>;
};

export type TimeLog = {
  id: string;
  patient_id: string;
  staff_id: string | null;
  staff_name: string | null;
  program: string;
  activity_type: string;
  duration_seconds: number;
  duration_minutes: number;
  notes: string | null;
  logged_at: string;
  created_at: string;
};

export type CareNote = {
  id: string;
  patient_id: string;
  author_id: string | null;
  author_name: string | null;
  note_type: string;
  cpt_codes: string[];
  content: Record<string, unknown>;
  ai_generated: boolean;
  status: 'draft' | 'reviewed' | 'signed' | 'locked';
  signed_at: string | null;
  dos: string | null;
  cycle_start: string | null;
  created_at: string;
  updated_at: string;
};

export type ReviewTimeEntry = {
  id: string;                   // DB UUID (used for deletion)
  patient_id: string;
  sm_review_time_id: number | null;
  clock_start: string;
  duration_seconds: number;
  note: string | null;
  patient_interaction: boolean;
  logged_by: string | null;
  source: string;               // 'smartmeter_sync' | 'manual' | 'profile_view' | 'n8n_agent'
  synced_at: string;
  created_at: string;
};

export type WorkflowClinic = {
  id: string;
  name: string;
  has_smartmeter: boolean;
  review_mode: 'automatic' | 'manual';
};

export type WorkflowStats = Record<string, number>; // source → session count this month

export type CommLog = {
  id: string;
  patient_id: string;
  staff_id: string | null;
  staff_name: string | null;
  comm_type: string;
  direction: string;
  duration_seconds: number | null;
  summary: string | null;
  occurred_at: string;
  created_at: string;
};

// ── Device types ───────────────────────────────────────────────────────────

export type UnifiedDevice = {
  id: string;
  serial: string;
  type: string;
  vendor: 'SmartMeter' | 'Tenovi';
  module: 'RPM' | 'RTM';
  status: string;
  patientName: string | null;
  patientExternalId: string | null;
  facilityName: string | null;
  lastMeasurement: string | null;
  connected: boolean | null;
  shippedDate: string | null;
};

export type UnifiedOrder = {
  id: string;
  orderNumber: string;
  source: 'SmartMeter' | 'Tenovi';
  status: string;
  statusRaw: string;
  patientName: string | null;
  clinicName: string | null;
  devices: string[];
  carrier: string | null;
  tracking: string | null;
  trackingLink: string | null;
  createdAt: string | null;
  shippedOn: string | null;
  deliveredOn: string | null;
  fulfilled: boolean;
};

export type CatalogItem = {
  id: string;
  vendor: 'SmartMeter' | 'Tenovi';
  name: string;
  sku: string;
  description: string;
  imageUrl: string | null;
  upFrontCost: string | null;
  shippingCost: string | null;
  monthlyCost: string | null;
  inStock: boolean;
  maxQty: number;
  deviceModels: string[];
  category: string;
};

export type SmClinic = { id: string; name: string };

export type DetectedImei = {
  imei: string;
  serialNumber: string | null;
  deviceModel: string | null;
  deviceName: string | null;
  orderNumber: string;
  orderedAt: string | null;
};

export type PatientDevice = {
  id: string;
  patient_id: string;
  imei: string;
  device_name: string | null;
  device_model: string | null;
  vendor: string;
  notes: string | null;
  assigned_at: string;
  unassigned_at: string | null;
  assigned_by_user_id: string | null;
  created_at: string;
};

// ── Report Types ──────────────────────────────────────────────────────────

export type ReportCategory = {
  program: string;
  label: string;
  cptCodes: string[];
  thresholdMinutes: number;
  totalMinutes: number;
  reviewMinutes: number;
  thresholdMet: boolean;
  notesCount: number;
  readingCount: number;
  billingRecords: BillingRecord[];
  notes: Array<{
    id: string; dos: string | null; status: string;
    cpt_codes: string[]; content: string;
    author_name: string | null; signed_at: string | null;
  }>;
};

export type BillingCycleReport = {
  id: string;
  cycle_start: string;
  consent_date: string | null;
  shipment_date: string | null;
  created_at: string;
  records: BillingRecord[];
  totalProjected: number;
  totalActual: number;
  status: string;
};

export type CarePlan = {
  id: string; content: string | Record<string, unknown>; status: string;
  author_name: string | null; signed_at: string | null; created_at: string;
};

export type PatientReport = {
  patient: {
    id: string; full_name: string; dob: string | null; mrn: string | null;
    program: string | null; diagnoses: string[]; icd10_codes: string[];
    insurance_payer: string | null; enrollment_status: string | null;
  };
  clinic: { name: string | null; specialty: string | null; location: string | null };
  period: { start: string; end: string; label: string };
  provider: string | null;
  generatedAt: string;
  readingCount: number | null;
  monitoringDays: number | null;
  categories: ReportCategory[];
  carePlan: CarePlan | null;
  billingRecords: BillingRecord[];
  billingCycles: BillingCycleReport[];
};

export type ClinicPatientSummary = {
  patient_id: string; full_name: string; dob: string | null; mrn: string | null;
  program: string | null; diagnoses: string[]; icd10_codes: string[];
  insurance_payer: string | null;
  totalMinutes: number; totalReadings: number; cptCodes: string[];
  totalProjected: number;
  byProgram: Array<{
    program: string; cptCodes: string[]; minutes: number; readings: number;
    thresholdMet: boolean; billingStatus: string | null; projectedAmount: number;
  }>;
};

export type ClinicReport = {
  clinic: { id: string; name: string; specialty: string | null; location: string | null };
  period: { start: string; end: string; label: string };
  generatedAt: string;
  patients: ClinicPatientSummary[];
  totals: {
    patients: number; totalMinutes: number; totalReadings: number;
    totalProjected: number; thresholdMet: number;
    byCpt: Record<string, { count: number; amount: number }>;
  };
};

export type MonthlyReportRecord = {
  id: string; patient_id: string; patient_name: string | null; patient_dob: string | null;
  patient_mrn: string | null; patient_program: string | null;
  diagnoses: string[]; icd10_codes: string[]; insurance_payer: string | null;
  clinic_id: string; clinic_name: string | null;
  cpt_code: string; units: number | null; dos: string | null;
  program: string | null; status: string; reading_count: number; total_minutes: number;
  projected_amount: number | null; actual_amount: number | null; cycle_start: string;
};

export type MonthlyBillingReport = {
  period: { start: string; end: string; label: string };
  generatedAt: string;
  clinics: Array<{
    clinic_id: string; clinic_name: string;
    records: MonthlyReportRecord[];
    subtotalProjected: number; subtotalActual: number; readingCount: number;
  }>;
  totals: {
    records: number; totalProjected: number; totalActual: number;
    totalReadings: number;
    byCpt: Array<{ cpt_code: string; count: number; projected: number }>;
  };
};

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, options: RequestInit = {}, token?: string, _retried = false): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...options.headers,
      },
    });
  } catch {
    throw new ApiError(`Could not reach the server at ${API_URL}.`, 0);
  }

  const body = await res.json().catch(() => null);

  // On 401, attempt a single token refresh and retry — but never for auth
  // endpoints themselves (login/refresh) to avoid infinite loops.
  if (
    res.status === 401 &&
    !_retried &&
    _refreshCallback &&
    !NO_REFRESH_PATHS.some((p) => path.startsWith(p))
  ) {
    if (!_pendingRefresh) {
      _pendingRefresh = _refreshCallback().finally(() => { _pendingRefresh = null; });
    }
    const newToken = await _pendingRefresh;
    if (newToken) return request<T>(path, options, newToken, true);
  }

  if (!res.ok) {
    // Notify the auth layer so it can show the suspension screen
    if (res.status === 403 && typeof body?.error === 'string' && body.error.toLowerCase().includes('suspend')) {
      _suspendedCallback?.();
    }
    throw new ApiError(body?.error ?? `Request failed (${res.status})`, res.status);
  }
  return body as T;
}

export const api = {
  login: (email: string, password: string) =>
    request<LoginResponse>('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  refresh: (refreshToken: string) =>
    request<LoginResponse>('/api/auth/refresh', { method: 'POST', body: JSON.stringify({ refreshToken }) }),
  me: (token: string) => request<{ user: ApiUser }>('/api/auth/me', { method: 'GET' }, token),

  listMembers: (token: string, params?: { clinicName?: string }) => {
    const qs = params?.clinicName ? `?clinicName=${encodeURIComponent(params.clinicName)}` : '';
    return request<{ members: Member[] }>(`/api/admin/members${qs}`, { method: 'GET' }, token);
  },
  inviteMember: (
    token: string,
    payload: { email: string; name: string; role: 'clinic_admin' | 'staff'; clinicId: string },
  ) =>
    request<{ ok: true; emailSent: boolean; emailError?: string; inviteLink: string | null; email: string }>(
      '/api/admin/members/invite',
      { method: 'POST', body: JSON.stringify(payload) },
      token,
    ),
  removeMember: (token: string, id: string) =>
    request<{ ok: true }>(`/api/admin/members/${id}`, { method: 'DELETE' }, token),
  updateMember: (
    token: string,
    id: string,
    patch: { name?: string; role?: 'clinic_admin' | 'staff'; clinic_id?: string },
  ) =>
    request<{ member: Member }>(`/api/admin/members/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }, token),
  resetMemberPassword: (token: string, id: string) =>
    request<{ ok: true; resetLink: string; email: string }>(
      `/api/admin/members/${id}/reset-password`, { method: 'POST' }, token,
    ),
  suspendMember: (token: string, id: string) =>
    request<{ ok: true }>(`/api/admin/members/${id}/suspend`, { method: 'POST' }, token),
  unsuspendMember: (token: string, id: string) =>
    request<{ ok: true }>(`/api/admin/members/${id}/unsuspend`, { method: 'POST' }, token),

  listClinics: (token: string) => request<{ clinics: Clinic[] }>('/api/clinics', { method: 'GET' }, token),
  createClinic: (token: string, name: string) =>
    request<{ clinic: Clinic }>('/api/clinics', { method: 'POST', body: JSON.stringify({ name }) }, token),
  patchClinic: (token: string, id: string, payload: { smartmeter_api_key?: string; specialty?: string; location?: string }) =>
    request<{ clinic: Clinic }>(`/api/clinics/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }, token),
  deleteClinic: (token: string, id: string) =>
    request<void>(`/api/clinics/${id}`, { method: 'DELETE' }, token),

  patchMe: (token: string, payload: { name?: string; email?: string; password?: string }) =>
    request<{ user: ApiUser }>('/api/auth/me', { method: 'PATCH', body: JSON.stringify(payload) }, token),

  listAlerts: (token: string, params?: { clinic?: string; status?: string }) => {
    const qs = params && Object.keys(params).length
      ? '?' + new URLSearchParams(params as Record<string, string>).toString()
      : '';
    return request<{ alerts: AlertEvent[] }>(`/api/alerts${qs}`, { method: 'GET' }, token);
  },
  updateAlert: (token: string, id: string, patch: { status?: AlertStatus; assignedTo?: string | null }) =>
    request<{ alert: AlertEvent }>(`/api/alerts/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }, token),

  getDashboardSummary: (token: string, days = 30) =>
    request<DashboardSummary>(`/api/dashboard/summary?days=${days}`, { method: 'GET' }, token),

  listPatients: (
    token: string,
    params?: {
      clinicId?: string;
      source?:   PatientSource | '';
      status?:   string;
      program?:  PatientProgram | '';
      risk?:     string;
      search?:   string;
      page?:     number;
      limit?:    number;
    },
  ) => {
    const entries = Object.entries(params ?? {}).filter(([, v]) => v != null && v !== '');
    const qs = entries.length ? '?' + new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString() : '';
    return request<{ patients: Patient[]; total: number }>(`/api/patients${qs}`, { method: 'GET' }, token);
  },
  getPatient: (token: string, id: string) =>
    request<{ patient: Patient; smDetail?: SmartMeterDetail | null }>(`/api/patients/${id}`, { method: 'GET' }, token),
  enrollPatient: (token: string, data: EnrollPatientInput) =>
    request<{ patient: Patient; warning?: string }>(
      '/api/patients/enroll',
      { method: 'POST', body: JSON.stringify(data) },
      token,
    ),
  getSystemClinics: (token: string, system: PatientSource) =>
    request<{ clinics: Pick<Clinic, 'id' | 'name'>[]; warning?: string }>(
      `/api/patients/system-clinics?system=${system}`,
      { method: 'GET' },
      token,
    ),

  getClinicBreakdown: (token: string) =>
    request<{ breakdown: ClinicBreakdownItem[] }>('/api/clinics/breakdown', { method: 'GET' }, token),

  getPatientReadings: (token: string, patientId: string, startDate: string, endDate: string) =>
    request<{ readings: PatientReading[]; warning?: string }>(
      `/api/patients/${patientId}/readings?start_date=${startDate}&end_date=${endDate}`, { method: 'GET' }, token,
    ),

  getPatientAlerts: (token: string, patientId: string, startDate?: string, endDate?: string) => {
    const qs = startDate && endDate ? `?start_date=${startDate}&end_date=${endDate}` : '';
    return request<{ alerts: AlertEvent[] }>(`/api/patients/${patientId}/alerts${qs}`, { method: 'GET' }, token);
  },
  deletePatient: (token: string, patientId: string) =>
    request<{ ok: true }>(
      `/api/patients/${patientId}`,
      { method: 'DELETE' },
      token,
    ),

  getPatientReviewTime: (token: string, patientId: string) =>
    request<{ reviewTimes: ReviewTimeEntry[] }>(
      `/api/patients/${patientId}/review-time`, { method: 'GET' }, token,
    ),
  deletePatientReviewTime: (token: string, patientId: string, entryId: string) =>
    request<{ ok: true }>(
      `/api/patients/${patientId}/review-time/${entryId}`, { method: 'DELETE' }, token,
    ),

  logManualReview: (
    token: string, patientId: string,
    body: { duration_seconds: number; note?: string; patient_interaction?: boolean },
  ) =>
    request<{ ok: true; entry: ReviewTimeEntry }>(
      `/api/patients/${patientId}/review-time/manual`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      token,
    ),

  logProfileView: (token: string, patientId: string, body: { duration_seconds: number }) =>
    request<{ ok: true }>(
      `/api/patients/${patientId}/review-time/profile-view`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      token,
    ),

  // ── Workflows ──────────────────────────────────────────────────────────────
  getWorkflows: (token: string) =>
    request<{ clinics: WorkflowClinic[]; statsBySource: WorkflowStats }>(
      '/api/workflows', { method: 'GET' }, token,
    ),

  setReviewMode: (token: string, clinicId: string, review_mode: 'automatic' | 'manual') =>
    request<{ ok: true }>(
      `/api/workflows/${clinicId}/review-mode`,
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ review_mode }) },
      token,
    ),

  // ── Billing ────────────────────────────────────────────────────────────────
  getBillingQueue: (
    token: string,
    filters?: {
      clinicId?: string; program?: string; insuranceType?: string;
      cptCode?: string; status?: string; month?: string;
    },
  ) => {
    const qs = filters
      ? '?' + new URLSearchParams(
          Object.entries(filters).filter(([, v]) => v != null && v !== '') as [string, string][]
        ).toString()
      : '';
    return request<{ records: BillingRecord[]; count: number }>(`/api/billing/queue${qs}`, { method: 'GET' }, token);
  },
  updateBillingRecord: (
    token: string,
    id: string,
    patch: { status?: string; dos?: string; actual_amount?: number; override_reason?: string },
  ) => request<{ record: BillingRecord }>(`/api/billing/records/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }, token),

  getBillingRevenue: (token: string, year?: number, clinicId?: string) => {
    const p = new URLSearchParams();
    if (year)     p.set('year', String(year));
    if (clinicId) p.set('clinicId', clinicId);
    const qs = p.toString() ? '?' + p.toString() : '';
    return request<RevenueBreakdown>(`/api/billing/revenue${qs}`, { method: 'GET' }, token);
  },

  getBillingRules: (token: string) =>
    request<{ rules: BillingRuleItem[] }>('/api/billing/rules', { method: 'GET' }, token),
  createBillingRule: (token: string, rule: Omit<BillingRuleItem, 'id' | 'created_at' | 'updated_at'>) =>
    request<{ rule: BillingRuleItem }>('/api/billing/rules', { method: 'POST', body: JSON.stringify(rule) }, token),
  updateBillingRule: (token: string, id: string, patch: Partial<BillingRuleItem>) =>
    request<{ rule: BillingRuleItem }>(`/api/billing/rules/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }, token),
  deleteBillingRule: (token: string, id: string) =>
    request<{ ok: true }>(`/api/billing/rules/${id}`, { method: 'DELETE' }, token),

  getFeeSchedules: (token: string) =>
    request<{ schedules: FeeScheduleItem[] }>('/api/billing/fee-schedules', { method: 'GET' }, token),
  upsertFeeSchedule: (token: string, schedule: Omit<FeeScheduleItem, 'id' | 'created_at' | 'updated_at'>) =>
    request<{ schedule: FeeScheduleItem }>('/api/billing/fee-schedules', { method: 'PUT', body: JSON.stringify(schedule) }, token),
  deleteFeeSchedule: (token: string, id: string) =>
    request<{ ok: true }>(`/api/billing/fee-schedules/${id}`, { method: 'DELETE' }, token),

  getDosOffsets: (token: string) =>
    request<{ offsets: DosOffsetItem[] }>('/api/billing/dos-offsets', { method: 'GET' }, token),
  updateDosOffset: (token: string, id: string, patch: { offset_days?: number | null; offset_type?: string }) =>
    request<{ offset: DosOffsetItem }>(`/api/billing/dos-offsets/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }, token),

  getPatientBilling: (token: string, patientId: string) =>
    request<PatientBillingSummary>(`/api/billing/patients/${patientId}`, { method: 'GET' }, token),
  setPatientCycle: (
    token: string,
    patientId: string,
    body: { cycle_start: string; consent_date?: string; shipment_date?: string },
  ) => request<{ cycle: object }>(`/api/billing/patients/${patientId}/cycle`, { method: 'POST', body: JSON.stringify(body) }, token),
  triggerBillingEvaluation: (token: string, patientId?: string) =>
    request<{ ok: true; scope: string }>('/api/billing/evaluate', { method: 'POST', body: JSON.stringify({ patientId }) }, token),

  // ── Time Logs ──────────────────────────────────────────────────────────────
  listTimeLogs: (token: string, params?: { patientId?: string; clinicId?: string; from?: string; to?: string }) => {
    const qs = params
      ? '?' + new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]).toString()
      : '';
    return request<{ logs: TimeLog[] }>(`/api/time-logs${qs}`, { method: 'GET' }, token);
  },
  createTimeLog: (token: string, log: {
    patient_id: string; clinic_id?: string; program: string;
    activity_type?: string; duration_seconds: number; notes?: string; logged_at?: string;
  }) => request<{ log: TimeLog }>('/api/time-logs', { method: 'POST', body: JSON.stringify(log) }, token),
  updateTimeLog: (token: string, id: string, patch: { duration_seconds?: number; notes?: string; activity_type?: string }) =>
    request<{ log: TimeLog }>(`/api/time-logs/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }, token),
  deleteTimeLog: (token: string, id: string) =>
    request<{ ok: true }>(`/api/time-logs/${id}`, { method: 'DELETE' }, token),

  // ── Notes ──────────────────────────────────────────────────────────────────
  listNotes: (token: string, params?: { patientId?: string; status?: string }) => {
    const qs = params
      ? '?' + new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]).toString()
      : '';
    return request<{ notes: CareNote[] }>(`/api/notes${qs}`, { method: 'GET' }, token);
  },
  createNote: (token: string, note: {
    patient_id: string; clinic_id?: string | null; note_type?: string; cpt_codes?: string[];
    content: string | Record<string, unknown>; dos?: string; cycle_start?: string;
  }) => request<{ note: CareNote }>('/api/notes', { method: 'POST', body: JSON.stringify(note) }, token),
  updateNote: (token: string, id: string, patch: { content?: string | Record<string, unknown>; status?: string; cpt_codes?: string[]; dos?: string }) =>
    request<{ note: CareNote }>(`/api/notes/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }, token),
  signNote: (token: string, id: string) =>
    request<{ note: CareNote }>(`/api/notes/${id}/sign`, { method: 'POST' }, token),

  // ── Communications ─────────────────────────────────────────────────────────
  listCommunications: (token: string, params?: { patientId?: string }) => {
    const qs = params?.patientId ? `?patientId=${params.patientId}` : '';
    return request<{ logs: CommLog[] }>(`/api/communications${qs}`, { method: 'GET' }, token);
  },
  createCommunication: (token: string, log: {
    patient_id: string; comm_type?: string; direction?: string;
    duration_seconds?: number; summary?: string; occurred_at?: string; program?: string;
  }) => request<{ log: CommLog }>('/api/communications', { method: 'POST', body: JSON.stringify(log) }, token),

  // ── Devices ────────────────────────────────────────────────────────────────
  listDevices: (token: string) =>
    request<{ devices: UnifiedDevice[]; count: number; cached: boolean }>('/api/devices', { method: 'GET' }, token),
  listDeviceOrders: (token: string) =>
    request<{ orders: UnifiedOrder[]; count: number; cached: boolean }>('/api/devices/orders', { method: 'GET' }, token),
  getDeviceCatalog: (token: string) =>
    request<{ items: CatalogItem[]; smClinics: SmClinic[] }>('/api/devices/catalog', { method: 'GET' }, token),
  syncDeviceCatalog: (token: string) =>
    request<{ synced: number; tenovi: string; smartmeter: string }>('/api/devices/catalog/sync', { method: 'POST' }, token),
  placeSmartMeterDeviceOrder: (token: string, payload: {
    clinicId: string;
    order: { order_number: string; customer_name: string; address1: string; address2?: string; city: string; state: string; zipcode: string; country?: string; shipping_method: string; po_number?: string };
    lines: Array<{ sku: string; quantity: number }>;
  }) =>
    request<{ success: boolean; order: { id: number; order_number: string } }>(
      '/api/devices/orders/smartmeter',
      { method: 'POST', body: JSON.stringify(payload) },
      token,
    ),
  placeTenoviDeviceOrder: (token: string, payload: {
    device: { name: string; hardware_uuid: null; fulfillment_request: { shipping_name: string; shipping_address: string; shipping_city: string; shipping_state: string; shipping_zip_code: string; notify_emails?: string } };
    patient?: { external_id?: string; name?: string; phone_number?: string };
  }) =>
    request<{ success: boolean }>(
      '/api/devices/orders/tenovi',
      { method: 'POST', body: JSON.stringify(payload) },
      token,
    ),

  // ── Patient device assignment (IMEI-based, stored in Supabase) ───────────
  getPatientDevices: (token: string, patientId: string) =>
    request<{ devices: PatientDevice[] }>(`/api/devices/patient/${patientId}/devices`, { method: 'GET' }, token),
  detectPatientImeis: (token: string, patientId: string) =>
    request<{ detected: DetectedImei[] }>(`/api/devices/patient/${patientId}/detect-imeis`, { method: 'GET' }, token),
  assignPatientDevice: (token: string, patientId: string, payload: { imei: string; deviceName?: string; deviceModel?: string; vendor?: string; notes?: string }) =>
    request<{ success: boolean; device: PatientDevice }>(`/api/devices/patient/${patientId}/assign`, { method: 'POST', body: JSON.stringify(payload) }, token),
  unassignPatientDevice: (token: string, patientId: string, imei: string) =>
    request<{ success: boolean }>(`/api/devices/patient/${patientId}/unassign`, { method: 'DELETE', body: JSON.stringify({ imei }) }, token),

  // ── Reports ──────────────────────────────────────────────────────────────
  getPatientReport: (token: string, patientId: string, month?: string) =>
    request<PatientReport>(`/api/reports/patient/${patientId}${month ? `?month=${month}` : ''}`, { method: 'GET' }, token),
  getClinicReport: (token: string, clinicId: string, month?: string) =>
    request<ClinicReport>(`/api/reports/clinic/${clinicId}${month ? `?month=${month}` : ''}`, { method: 'GET' }, token),
  getMonthlyReport: (token: string, month?: string, clinicId?: string) => {
    const params = new URLSearchParams();
    if (month)    params.set('month',    month);
    if (clinicId) params.set('clinicId', clinicId);
    const qs = params.toString();
    return request<MonthlyBillingReport>(`/api/reports/monthly${qs ? `?${qs}` : ''}`, { method: 'GET' }, token);
  },
};
