-- ── exported_billing_reports ────────────────────────────────────────────────
-- Records each billing cycle that has been auto-exported (cycle end passed).
-- Used to populate the "Exported Billing" tab in the patient profile.

CREATE TABLE IF NOT EXISTS public.exported_billing_reports (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id   uuid        NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  clinic_id    uuid        NOT NULL REFERENCES public.clinics(id)  ON DELETE CASCADE,
  cycle_start  date        NOT NULL,
  cycle_end    date        NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS exported_billing_reports_patient_cycle_idx
  ON public.exported_billing_reports (patient_id, cycle_start DESC);

-- RLS: clinic staff / admins can read their clinic's exports; service role inserts
ALTER TABLE public.exported_billing_reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "clinic_staff_read_exported_billing_reports"
  ON public.exported_billing_reports FOR SELECT
  USING (
    clinic_id IN (
      SELECT clinic_id FROM public.profiles WHERE id = auth.uid()
    )
  );
