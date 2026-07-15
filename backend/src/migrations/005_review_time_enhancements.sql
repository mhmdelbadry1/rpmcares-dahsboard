-- Migration 005: Review time source tracking + per-clinic review mode
-- Run once in Supabase SQL Editor.

-- Distinguish SmartMeter syncs, manual logs, and profile-view sessions
ALTER TABLE public.patient_review_times
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'smartmeter_sync';

-- Per-clinic review mode: 'automatic' (agent handles it) or 'manual' (staff logs manually)
ALTER TABLE public.clinics
  ADD COLUMN IF NOT EXISTS review_mode TEXT NOT NULL DEFAULT 'automatic';
