-- ═══════════════════════════════════════════════════════════════════════════
-- 0004_billing.sql
-- Full billing system: billing cycles, time logs, reading stats,
-- configurable rules / fee schedules / DOS offsets, billing records,
-- care notes, note audit log, communications log.
-- Run in Supabase SQL Editor (service_role bypasses RLS for all operations).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. BILLING CYCLES ────────────────────────────────────────────────────────
-- One active cycle per patient.
-- New patients: cycle_start = enrolled_at (set automatically by billing engine).
-- Existing patients: set manually by care staff via the billing panel.
CREATE TABLE IF NOT EXISTS public.billing_cycles (
  id            uuid  PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id    uuid  NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  cycle_start   date  NOT NULL,
  consent_date  date,
  shipment_date date,  -- used for one-time installation CPTs (99453, 98975)
  created_by    uuid  REFERENCES public.profiles(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE(patient_id, cycle_start)
);

-- ── 2. TIME LOGS ─────────────────────────────────────────────────────────────
-- Clinical time per patient per staff member.
-- Each entry triggers a re-evaluation of billing eligibility.
CREATE TABLE IF NOT EXISTS public.time_logs (
  id               uuid  PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id       uuid  NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  clinic_id        uuid  NOT NULL REFERENCES public.clinics(id),
  staff_id         uuid  REFERENCES public.profiles(id),
  program          text  NOT NULL CHECK (program IN ('RPM','RTM','CCM','PCM')),
  activity_type    text  NOT NULL DEFAULT 'review',
  -- call | review | coordination | documentation | monitoring | education
  duration_seconds int   NOT NULL CHECK (duration_seconds > 0),
  notes            text,
  logged_at        timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- ── 3. PATIENT CYCLE STATS ────────────────────────────────────────────────────
-- Reading counts per patient per cycle window.
-- Populated by the background sync from SmartMeter / Tenovi APIs.
CREATE TABLE IF NOT EXISTS public.patient_cycle_stats (
  id              uuid  PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id      uuid  NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  cycle_start     date  NOT NULL,
  cycle_end       date  NOT NULL,
  reading_count   int   NOT NULL DEFAULT 0,   -- distinct reading days in window
  monitoring_days int   NOT NULL DEFAULT 0,
  source          text  NOT NULL DEFAULT 'smartmeter',
  synced_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE(patient_id, cycle_start)
);

-- ── 4. BILLING RULES (fully configurable) ────────────────────────────────────
-- No code changes required when CPT rules change — edit rows in this table.
-- rule_category maps to patient programs:
--   RPM patients  → evaluate: RPM + Device + Installation + 99091 rules
--   RTM patients  → evaluate: RTM + Installation + 99091 rules
--   CCM patients  → evaluate: CCM + 99091 rules
--   PCM patients  → evaluate: PCM + 99091 rules
CREATE TABLE IF NOT EXISTS public.billing_rules (
  id              uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_name       text    NOT NULL,
  rule_category   text    NOT NULL,
  -- RPM | Device | CCM | RTM | PCM | 99091 | Installation
  insurance_type  text    NOT NULL,
  -- Medicare | Medicare Advantage | Commercial | Medicaid | Any
  min_readings    int,               -- NULL = no minimum
  max_readings    int,               -- NULL = no upper bound
  trigger_minutes int,               -- minimum accumulated minutes to trigger
  cpt_codes       text[]  NOT NULL,
  units           int     NOT NULL DEFAULT 1,
  is_one_time     bool    NOT NULL DEFAULT false,
  is_active       bool    NOT NULL DEFAULT true,
  sort_order      int     NOT NULL DEFAULT 0,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ── 5. FEE SCHEDULES ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.fee_schedules (
  id             uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  payer          text          NOT NULL,
  cpt_code       text          NOT NULL,
  amount         numeric(10,2) NOT NULL,
  effective_date date          NOT NULL DEFAULT CURRENT_DATE,
  end_date       date,
  created_at     timestamptz   NOT NULL DEFAULT now(),
  updated_at     timestamptz   NOT NULL DEFAULT now(),
  UNIQUE(payer, cpt_code, effective_date)
);

-- ── 6. DOS OFFSETS ────────────────────────────────────────────────────────────
-- Date-of-service = cycle_start + offset_days  OR  shipment_date.
-- Fully configurable from admin panel.
CREATE TABLE IF NOT EXISTS public.dos_offsets (
  id           uuid  PRIMARY KEY DEFAULT gen_random_uuid(),
  program      text  NOT NULL,
  cpt_code     text  NOT NULL,
  offset_days  int,               -- NULL when offset_type = 'shipment_date'
  offset_type  text  NOT NULL DEFAULT 'cycle_start',
  -- cycle_start | shipment_date
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE(program, cpt_code)
);

-- ── 7. CARE NOTES ─────────────────────────────────────────────────────────────
-- AI-generated and manually entered clinical documentation.
-- content is a JSONB object with keys:
--   demographics, clinical_summary, monitoring, communication,
--   time_docs, assessment, care_plan, cpt_section
CREATE TABLE IF NOT EXISTS public.care_notes (
  id              uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id      uuid    NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  clinic_id       uuid    NOT NULL REFERENCES public.clinics(id),
  author_id       uuid    REFERENCES public.profiles(id),
  note_type       text    NOT NULL DEFAULT 'manual',
  -- rpm | rtm | ccm | pcm | 99091 | manual | soap
  cpt_codes       text[]  NOT NULL DEFAULT '{}',
  content         jsonb   NOT NULL DEFAULT '{}',
  ai_generated    bool    NOT NULL DEFAULT false,
  ai_generated_at timestamptz,
  status          text    NOT NULL DEFAULT 'draft',
  -- draft | reviewed | signed | locked
  signed_by       uuid    REFERENCES public.profiles(id),
  signed_at       timestamptz,
  dos             date,
  cycle_start     date,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ── 8. NOTE AUDIT LOG ─────────────────────────────────────────────────────────
-- Every create / edit / sign / lock is recorded for compliance.
CREATE TABLE IF NOT EXISTS public.note_audit_log (
  id               uuid  PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id          uuid  NOT NULL REFERENCES public.care_notes(id) ON DELETE CASCADE,
  changed_by       uuid  REFERENCES public.profiles(id),
  change_type      text  NOT NULL,
  -- created | edited | signed | locked | ai_generated
  previous_content jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- ── 9. BILLING RECORDS ────────────────────────────────────────────────────────
-- One row per patient × CPT code × billing cycle.
-- UNIQUE constraint prevents duplicate billing within a 30-day period.
CREATE TABLE IF NOT EXISTS public.billing_records (
  id               uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id       uuid          NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  clinic_id        uuid          NOT NULL REFERENCES public.clinics(id),
  cycle_start      date          NOT NULL,
  cycle_end        date          NOT NULL,
  cpt_code         text          NOT NULL,
  units            int           NOT NULL DEFAULT 1,
  dos              date,
  program          text          NOT NULL,
  insurance_type   text          NOT NULL,
  status           text          NOT NULL DEFAULT 'pending',
  -- pending | generated | reviewed | signed | submitted | paid | voided
  projected_amount numeric(10,2),
  actual_amount    numeric(10,2),
  reading_count    int,
  total_minutes    int,
  note_id          uuid          REFERENCES public.care_notes(id) ON DELETE SET NULL,
  locked_at        timestamptz,
  submitted_at     timestamptz,
  override_by      uuid          REFERENCES public.profiles(id),
  override_reason  text,
  created_at       timestamptz   NOT NULL DEFAULT now(),
  updated_at       timestamptz   NOT NULL DEFAULT now(),
  UNIQUE(patient_id, cycle_start, cpt_code)
);

-- ── 10. COMMUNICATIONS LOG ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.communications_log (
  id               uuid  PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id       uuid  NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  clinic_id        uuid  NOT NULL REFERENCES public.clinics(id),
  staff_id         uuid  REFERENCES public.profiles(id),
  comm_type        text  NOT NULL DEFAULT 'call',
  -- call | sms | portal_message | ai_call | email
  direction        text  NOT NULL DEFAULT 'outbound',
  duration_seconds int,
  summary          text,
  transcript       text,
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- ── INDEXES ───────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_billing_cycles_patient      ON public.billing_cycles(patient_id);
CREATE INDEX IF NOT EXISTS idx_time_logs_patient_date      ON public.time_logs(patient_id, logged_at);
CREATE INDEX IF NOT EXISTS idx_time_logs_clinic_date       ON public.time_logs(clinic_id, logged_at);
CREATE INDEX IF NOT EXISTS idx_pcs_patient_cycle           ON public.patient_cycle_stats(patient_id, cycle_start);
CREATE INDEX IF NOT EXISTS idx_billing_records_patient     ON public.billing_records(patient_id, cycle_start);
CREATE INDEX IF NOT EXISTS idx_billing_records_clinic      ON public.billing_records(clinic_id, status, dos);
CREATE INDEX IF NOT EXISTS idx_billing_records_queue       ON public.billing_records(status, dos)
  WHERE status NOT IN ('paid','voided');
CREATE INDEX IF NOT EXISTS idx_care_notes_patient          ON public.care_notes(patient_id, dos DESC);
CREATE INDEX IF NOT EXISTS idx_note_audit_note             ON public.note_audit_log(note_id, created_at);
CREATE INDEX IF NOT EXISTS idx_comms_patient_date          ON public.communications_log(patient_id, occurred_at DESC);

-- ── ROW LEVEL SECURITY ────────────────────────────────────────────────────────
-- All access goes through Express backend with service_role (bypasses RLS).
ALTER TABLE public.billing_cycles       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.time_logs            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.patient_cycle_stats  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_rules        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fee_schedules        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dos_offsets          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_records      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.care_notes           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.note_audit_log       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.communications_log   ENABLE ROW LEVEL SECURITY;


-- ═══════════════════════════════════════════════════════════════════════════
-- SEED: BILLING RULES (from spec — fully configurable afterwards)
-- ═══════════════════════════════════════════════════════════════════════════
INSERT INTO public.billing_rules
  (rule_name, rule_category, insurance_type, min_readings, max_readings,
   trigger_minutes, cpt_codes, units, is_one_time, is_active, sort_order)
VALUES
  -- ── RPM Monitoring ─────────────────────────────────────────────────────
  ('RPM Medicare 2-15 readings',              'RPM','Medicare',          2, 15, 10, ARRAY['99470'],         1, false,true, 10),
  ('RPM Medicare 16+ readings',               'RPM','Medicare',         16,NULL, 10, ARRAY['99457','99458'], 2, false,true, 20),
  ('RPM Medicare Advantage 2-15 readings',    'RPM','Medicare Advantage',2, 15, 10, ARRAY['99470'],         1, false,true, 10),
  ('RPM Medicare Advantage 16+ readings',     'RPM','Medicare Advantage',16,NULL,10, ARRAY['99457','99458'], 2, false,true, 20),
  ('RPM Commercial 1+ readings',              'RPM','Commercial',        1,NULL, 10, ARRAY['99457','99458'], 2, false,true, 10),
  -- ── Device Maintenance ─────────────────────────────────────────────────
  ('Device Medicare 2-15 readings',           'Device','Medicare',       2, 15,NULL, ARRAY['99445'],        1, false,true, 10),
  ('Device Medicare 16+ readings',            'Device','Medicare',      16,NULL,NULL, ARRAY['99454'],       1, false,true, 20),
  ('Device Medicare Advantage 2-15 readings', 'Device','Medicare Advantage',2,15,NULL, ARRAY['99445'],     1, false,true, 10),
  ('Device Medicare Advantage 16+ readings',  'Device','Medicare Advantage',16,NULL,NULL, ARRAY['99454'],  1, false,true, 20),
  ('Device Commercial 1+ readings',           'Device','Commercial',     1,NULL,NULL, ARRAY['99454'],      1, false,true, 10),
  -- ── CCM / RCP ──────────────────────────────────────────────────────────
  ('CCM Medicare 16+ readings',               'CCM','Medicare',         16,NULL, 10, ARRAY['99490'],        1, false,true, 10),
  ('CCM Medicare 2-15 readings',              'CCM','Medicare',          2, 15, 10, ARRAY['99490','99439'], 2, false,true, 20),
  ('CCM Medicare 0-1 readings',               'CCM','Medicare',          0,  1, 10, ARRAY['99490','99439','99439'], 3, false,true, 30),
  ('CCM Commercial 1+ readings',              'CCM','Commercial',        1,NULL, 10, ARRAY['99490'],        1, false,true, 10),
  -- ── 99091 Interpretation ───────────────────────────────────────────────
  ('99091 Medicare 16+ readings',             '99091','Medicare',       16,NULL, 15, ARRAY['99091'],        1, false,true, 10),
  ('99091 Commercial 1+ readings',            '99091','Commercial',      1,NULL, 15, ARRAY['99091'],        1, false,true, 10),
  ('99091 Medicaid 1+ readings',              '99091','Medicaid',        1,NULL, 15, ARRAY['99091'],        1, false,true, 10),
  -- ── One-Time Installation ──────────────────────────────────────────────
  ('99453 Installation Medicare',             'Installation','Medicare',  0,NULL,NULL, ARRAY['99453'],      1,  true,true, 10),
  ('99453 Installation Commercial',           'Installation','Commercial',0,NULL,NULL, ARRAY['99453'],      1,  true,true, 10),
  -- ── RTM ────────────────────────────────────────────────────────────────
  ('RTM Installation Any',                    'RTM','Any',               0,NULL,NULL, ARRAY['98975'],       1,  true,true, 10),
  ('RTM Device Supply Any',                   'RTM','Any',               1,NULL,NULL, ARRAY['98977'],       1, false,true, 20),
  ('RTM Monitoring 16+ min',                  'RTM','Any',               1,NULL,  16, ARRAY['98980'],       1, false,true, 30),
  -- ── PCM ────────────────────────────────────────────────────────────────
  ('PCM 1st 30min Medicare',                  'PCM','Medicare',          1,NULL,  15, ARRAY['99426'],       1, false,true, 10),
  ('PCM 2nd 30min Medicare',                  'PCM','Medicare',          1,NULL,  45, ARRAY['99427'],       1, false,true, 20)
ON CONFLICT DO NOTHING;


-- ═══════════════════════════════════════════════════════════════════════════
-- SEED: FEE SCHEDULES (2024 Medicare national rates)
-- ═══════════════════════════════════════════════════════════════════════════
INSERT INTO public.fee_schedules (payer, cpt_code, amount, effective_date)
VALUES
  -- Medicare
  ('Medicare','99453', 19.04,'2024-01-01'),
  ('Medicare','99454', 66.98,'2024-01-01'),
  ('Medicare','99445', 38.00,'2024-01-01'),
  ('Medicare','99457', 50.18,'2024-01-01'),
  ('Medicare','99458', 41.98,'2024-01-01'),
  ('Medicare','99470', 31.00,'2024-01-01'),
  ('Medicare','99490', 62.82,'2024-01-01'),
  ('Medicare','99439', 47.56,'2024-01-01'),
  ('Medicare','99091', 58.67,'2024-01-01'),
  ('Medicare','98975', 19.54,'2024-01-01'),
  ('Medicare','98977', 65.59,'2024-01-01'),
  ('Medicare','98980', 50.18,'2024-01-01'),
  ('Medicare','98981', 40.84,'2024-01-01'),
  ('Medicare','99426', 72.00,'2024-01-01'),
  ('Medicare','99427', 50.00,'2024-01-01'),
  -- Medicare Advantage (mirrors Medicare by default)
  ('Medicare Advantage','99453', 19.04,'2024-01-01'),
  ('Medicare Advantage','99454', 66.98,'2024-01-01'),
  ('Medicare Advantage','99445', 38.00,'2024-01-01'),
  ('Medicare Advantage','99457', 50.18,'2024-01-01'),
  ('Medicare Advantage','99458', 41.98,'2024-01-01'),
  ('Medicare Advantage','99470', 31.00,'2024-01-01'),
  ('Medicare Advantage','99490', 62.82,'2024-01-01'),
  ('Medicare Advantage','99439', 47.56,'2024-01-01'),
  ('Medicare Advantage','99091', 58.67,'2024-01-01'),
  ('Medicare Advantage','98975', 19.54,'2024-01-01'),
  ('Medicare Advantage','98977', 65.59,'2024-01-01'),
  ('Medicare Advantage','98980', 50.18,'2024-01-01'),
  ('Medicare Advantage','99426', 72.00,'2024-01-01'),
  ('Medicare Advantage','99427', 50.00,'2024-01-01'),
  -- Commercial (~1.5× Medicare)
  ('Commercial','99453', 28.56,'2024-01-01'),
  ('Commercial','99454',100.47,'2024-01-01'),
  ('Commercial','99445', 57.00,'2024-01-01'),
  ('Commercial','99457', 75.27,'2024-01-01'),
  ('Commercial','99458', 62.97,'2024-01-01'),
  ('Commercial','99470', 46.50,'2024-01-01'),
  ('Commercial','99490', 94.23,'2024-01-01'),
  ('Commercial','99439', 71.34,'2024-01-01'),
  ('Commercial','99091', 88.00,'2024-01-01'),
  ('Commercial','98975', 29.31,'2024-01-01'),
  ('Commercial','98977', 98.39,'2024-01-01'),
  ('Commercial','98980', 75.27,'2024-01-01'),
  ('Commercial','99426',108.00,'2024-01-01'),
  ('Commercial','99427', 75.00,'2024-01-01'),
  -- Medicaid (limited coverage)
  ('Medicaid','99091', 46.94,'2024-01-01'),
  ('Medicaid','98975', 15.63,'2024-01-01'),
  ('Medicaid','98977', 52.47,'2024-01-01'),
  ('Medicaid','98980', 40.14,'2024-01-01'),
  ('Medicaid','98981', 32.67,'2024-01-01')
ON CONFLICT (payer, cpt_code, effective_date) DO NOTHING;


-- ═══════════════════════════════════════════════════════════════════════════
-- SEED: DOS OFFSETS (from spec — configurable afterwards)
-- ═══════════════════════════════════════════════════════════════════════════
INSERT INTO public.dos_offsets (program, cpt_code, offset_days, offset_type)
VALUES
  -- RPM
  ('RPM','99453', NULL,'shipment_date'),
  ('RPM','99457',  26, 'cycle_start'),
  ('RPM','99458',  26, 'cycle_start'),
  ('RPM','99470',  26, 'cycle_start'),
  ('RPM','99454',  28, 'cycle_start'),
  ('RPM','99445',  28, 'cycle_start'),
  ('RPM','99490',  27, 'cycle_start'),
  ('RPM','99439',  27, 'cycle_start'),
  ('RPM','99091',  29, 'cycle_start'),
  -- RTM
  ('RTM','98975', NULL,'shipment_date'),
  ('RTM','98977',  26, 'cycle_start'),
  ('RTM','98980',  29, 'cycle_start'),
  ('RTM','98981',  29, 'cycle_start'),
  -- CCM
  ('CCM','99490',  27, 'cycle_start'),
  ('CCM','99439',  27, 'cycle_start'),
  ('CCM','99091',  29, 'cycle_start'),
  -- PCM
  ('PCM','99426',  27, 'cycle_start'),
  ('PCM','99427',  27, 'cycle_start'),
  ('PCM','99091',  29, 'cycle_start'),
  -- Installation (one-time codes always use shipment date)
  ('Installation','99453', NULL,'shipment_date'),
  ('Installation','98975', NULL,'shipment_date')
ON CONFLICT (program, cpt_code) DO NOTHING;
