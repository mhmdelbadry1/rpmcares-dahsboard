-- Migration 019: Link review-time entries back to their call
-- Run once in Supabase SQL Editor.

-- Lets the AI-summary pipeline find and update the review-time entry a
-- call created once the real summary is ready (calls log review time
-- immediately with a placeholder note — the real note lands seconds later).
ALTER TABLE public.patient_review_times
  ADD COLUMN IF NOT EXISTS comm_log_id UUID REFERENCES public.communications_log(id);
