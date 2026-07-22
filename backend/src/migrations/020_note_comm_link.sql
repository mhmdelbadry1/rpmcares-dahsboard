-- Migration 020: Link AI call-summary notes back to their call
-- Run once in Supabase SQL Editor.

-- Lets the Review Time tab show a "View Note" link on entries that have a
-- corresponding AI-generated note in care_notes.
ALTER TABLE public.care_notes
  ADD COLUMN IF NOT EXISTS comm_log_id UUID REFERENCES public.communications_log(id);
