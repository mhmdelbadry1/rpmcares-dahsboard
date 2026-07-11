CREATE TABLE IF NOT EXISTS public.communications_log (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id       text        NOT NULL,
  clinic_id        uuid        REFERENCES public.clinics(id) ON DELETE SET NULL,
  staff_id         uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  comm_type        text        NOT NULL DEFAULT 'call',   -- 'call' | 'sms' | 'email'
  direction        text        NOT NULL DEFAULT 'outbound', -- 'inbound' | 'outbound'
  duration_seconds integer,
  summary          text,
  transcript       text,
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS communications_log_patient_idx  ON public.communications_log(patient_id);
CREATE INDEX IF NOT EXISTS communications_log_clinic_idx   ON public.communications_log(clinic_id);
CREATE INDEX IF NOT EXISTS communications_log_occurred_idx ON public.communications_log(occurred_at DESC);

ALTER TABLE public.communications_log ENABLE ROW LEVEL SECURITY;
