-- Real audit trail backing the Settings > Audit tab, which was previously
-- just hardcoded mock rows in the frontend. Tracks security/administrative
-- actions (invites, role changes, suspensions, clinic changes, logins,
-- review-time deletions) so there's a real record of who did what and when.
CREATE TABLE IF NOT EXISTS public.audit_log (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id    uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  actor_name  text        NOT NULL,
  actor_email text        NOT NULL,
  clinic_id   uuid        REFERENCES public.clinics(id) ON DELETE SET NULL,
  action      text        NOT NULL,
  detail      text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_log_created_at_idx ON public.audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_clinic_id_idx   ON public.audit_log(clinic_id);

ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
