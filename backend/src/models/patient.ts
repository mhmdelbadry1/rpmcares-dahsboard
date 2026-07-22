import { supabaseAdmin } from "../lib/supabase";

export type PatientSource  = "tenovi" | "smartmeter" | "local";
export type PatientProgram = "RPM" | "RTM" | "CCM" | "PCM";

// Matches the public.patients table already in Supabase
export type PatientRecord = {
  id: string;
  clinic_id: string;
  clinic_name: string | null;
  source: PatientSource;              // device_vendor enum
  external_patient_id: string;
  mrn: string | null;
  full_name: string;
  dob: string | null;
  sex: string | null;                 // sex_type enum ('M' | 'F')
  phone: string | null;
  language: string;
  provider_id: string | null;
  assigned_staff_id: string | null;
  program: PatientProgram;            // program_type enum
  diagnoses: string[];
  icd10_codes: string[];
  insurance_payer: string | null;
  insurance_class: string | null;     // insurance_class enum
  enrollment_status: string;          // enrollment_status enum (default 'active')
  consent: boolean;
  risk: string;                       // risk_level enum ('low' | 'medium' | 'high' | 'critical')
  enrolled_at: string;
  disenrolled_at: string | null;
  created_at: string;
  updated_at: string;
  profile_extras: Record<string, string>;
};

export type PatientInput = {
  clinicId: string;
  source: PatientSource;
  externalPatientId: string;
  fullName: string;
  dob?: string;
  sex?: string;
  phone?: string;
  language?: string;
  program: PatientProgram;
  diagnoses?: string[];
  insurancePayer?: string;
};

const SELECT = "*, clinics(name)";

function mapRow(r: any): PatientRecord {
  return {
    id:                  r.id,
    clinic_id:           r.clinic_id,
    clinic_name:         r.clinics?.name ?? null,
    source:              r.source,
    external_patient_id: r.external_patient_id,
    mrn:                 r.mrn ?? null,
    full_name:           r.full_name,
    dob:                 r.dob ?? null,
    sex:                 r.sex ?? null,
    phone:               r.phone ?? null,
    language:            r.language ?? "EN",
    provider_id:         r.provider_id ?? null,
    assigned_staff_id:   r.assigned_staff_id ?? null,
    program:             r.program,
    diagnoses:           r.diagnoses ?? [],
    icd10_codes:         r.icd10_codes ?? [],
    insurance_payer:     r.insurance_payer ?? null,
    insurance_class:     r.insurance_class ?? null,
    enrollment_status:   r.enrollment_status,
    consent:             r.consent ?? true,
    risk:                r.risk ?? "low",
    enrolled_at:         r.enrolled_at,
    disenrolled_at:      r.disenrolled_at ?? null,
    created_at:          r.created_at,
    updated_at:          r.updated_at,
    profile_extras:      r.profile_extras ?? {},
  };
}

export async function updatePatientProfileExtras(
  id: string,
  extras: Record<string, string | null>,
): Promise<PatientRecord> {
  const { data: current } = await supabaseAdmin
    .from("patients")
    .select("profile_extras")
    .eq("id", id)
    .single();
  const merged: Record<string, string> = { ...(current?.profile_extras ?? {}) };
  for (const [k, v] of Object.entries(extras)) {
    if (v === null || v === "") delete merged[k];
    else merged[k] = v;
  }
  const { data, error } = await supabaseAdmin
    .from("patients")
    .update({ profile_extras: merged })
    .eq("id", id)
    .select(SELECT)
    .single();
  if (error) throw error;
  return mapRow(data);
}

export async function listPatients(filter: {
  clinicId?: string;
  source?:   string;
  status?:   string;
  program?:  string;
  risk?:     string;
  search?:   string;
  limit?:    number;
  offset?:   number;
}): Promise<{ data: PatientRecord[]; count: number }> {
  const limit  = filter.limit  ?? 100;
  const offset = filter.offset ?? 0;

  let query = supabaseAdmin
    .from("patients")
    .select(SELECT, { count: "exact" })
    // active < disenrolled < inactive < pending alphabetically → active first
    .order("enrollment_status", { ascending: true })
    .order("full_name",          { ascending: true })
    .range(offset, offset + limit - 1);

  if (filter.clinicId) query = query.eq("clinic_id",         filter.clinicId);
  if (filter.source)   query = query.eq("source",            filter.source);
  if (filter.status)   query = query.eq("enrollment_status", filter.status);
  if (filter.program)  query = query.eq("program",           filter.program);
  if (filter.risk)     query = query.eq("risk",              filter.risk);
  if (filter.search) {
    // Search name, external ID, or MRN
    const term = filter.search.replace(/'/g, "''"); // basic SQL-literal escape
    query = query.or(
      `full_name.ilike.%${term}%,external_patient_id.ilike.%${term}%,mrn.ilike.%${term}%`,
    );
  }

  const { data, error, count } = await query;
  if (error) throw error;
  return { data: (data ?? []).map(mapRow), count: count ?? 0 };
}

export async function findPatientById(id: string): Promise<PatientRecord | null> {
  const { data, error } = await supabaseAdmin
    .from("patients")
    .select(SELECT)
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data ? mapRow(data) : null;
}

// Matches a phone number against patients.phone tolerating differing formats
// (dashes, spaces, missing country code) by comparing the last 10 digits.
// Used to resolve inbound Twilio webhooks (calls/SMS), which only give us a
// raw phone number, back to a patient record.
export async function findPatientByPhone(phone: string): Promise<{ id: string; clinic_id: string | null } | null> {
  const digits = phone.replace(/\D/g, "");
  const last10 = digits.slice(-10);
  const e164   = `+${digits}`;

  const { data: exact } = await supabaseAdmin
    .from("patients").select("id, clinic_id").eq("phone", e164).limit(1);
  if (exact?.[0]) return exact[0];

  const { data: all } = await supabaseAdmin
    .from("patients").select("id, clinic_id, phone").not("phone", "is", null).limit(5000);
  const match = (all ?? []).find((p: any) => p.phone.replace(/\D/g, "").slice(-10) === last10);
  return match ? { id: match.id, clinic_id: match.clinic_id } : null;
}

export async function deletePatient(id: string): Promise<void> {
  const { error } = await supabaseAdmin.from("patients").delete().eq("id", id);
  if (error) throw error;
}

export async function createPatient(input: PatientInput): Promise<PatientRecord> {
  const { data, error } = await supabaseAdmin
    .from("patients")
    .insert({
      clinic_id:           input.clinicId,
      source:              input.source,
      external_patient_id: input.externalPatientId,
      full_name:           input.fullName,
      dob:                 input.dob ?? null,
      sex:                 input.sex ?? null,
      phone:               input.phone ?? null,
      language:            input.language ?? "EN",
      program:             input.program,
      diagnoses:           input.diagnoses ?? [],
      insurance_payer:     input.insurancePayer ?? null,
      enrollment_status:   "active",
      consent:             true,
      risk:                "low",
    })
    .select(SELECT)
    .single();
  if (error) throw error;
  return mapRow(data);
}
