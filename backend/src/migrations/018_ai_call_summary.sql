-- Migration 018: Inline AI call summary on communications_log
-- Run once in Supabase SQL Editor.

-- Separate the short AI-generated clinical summary from the full transcript
-- so the chat thread can show it inline on the call bubble itself, without
-- a second fetch to care_notes.
ALTER TABLE public.communications_log
  ADD COLUMN IF NOT EXISTS ai_summary TEXT;
