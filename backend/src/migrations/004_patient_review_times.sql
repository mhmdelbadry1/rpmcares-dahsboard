-- Migration 004: Patient review time cache
-- Run once in Supabase SQL Editor.
-- Caches SmartMeter review-time records per patient (TTL refreshed by the backend).

CREATE TABLE IF NOT EXISTS public.patient_review_times (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id          UUID        NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  sm_review_time_id   INTEGER,
  clock_start         TIMESTAMPTZ NOT NULL,
  duration_seconds    INTEGER     NOT NULL DEFAULT 0,
  note                TEXT,
  patient_interaction BOOLEAN     NOT NULL DEFAULT FALSE,
  logged_by           TEXT,
  synced_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Only the service-role key (used by the backend) can read/write.
ALTER TABLE public.patient_review_times ENABLE ROW LEVEL SECURITY;
