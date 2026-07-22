-- Migration 017: Call-based review time + recording metadata
-- Run once in Supabase SQL Editor.

-- Attribute review-time entries to the staff member who did the work, and
-- record whether a "call" entry was inbound or outbound.
ALTER TABLE public.patient_review_times
  ADD COLUMN IF NOT EXISTS staff_id         UUID REFERENCES public.profiles(id),
  ADD COLUMN IF NOT EXISTS call_direction   TEXT CHECK (call_direction IN ('inbound', 'outbound')),
  ADD COLUMN IF NOT EXISTS tenovi_event_id      TEXT,
  ADD COLUMN IF NOT EXISTS tenovi_review_log_id TEXT;

-- Separate the actual recording URL from the transcript text — previously
-- recording-status stored "<url>.mp3" directly in `transcript` as a placeholder.
ALTER TABLE public.communications_log
  ADD COLUMN IF NOT EXISTS recording_url TEXT;
