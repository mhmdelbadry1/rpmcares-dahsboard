-- ── local patient source ─────────────────────────────────────────────────────
-- Adds 'local' as a valid source/device_vendor value for patients enrolled
-- directly in RPMCares without a SmartMeter or Tenovi device.

-- Extend the device_vendor enum if it exists (safe no-op if already present)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'device_vendor'
  ) THEN
    ALTER TYPE device_vendor ADD VALUE IF NOT EXISTS 'local';
  END IF;
END$$;

-- Drop and recreate the CHECK constraint on patients.source to include 'local'
DO $$
BEGIN
  -- Remove old constraint (name may vary; try common names)
  ALTER TABLE public.patients DROP CONSTRAINT IF EXISTS patients_source_check;
  ALTER TABLE public.patients DROP CONSTRAINT IF EXISTS chk_patients_source;
  ALTER TABLE public.patients DROP CONSTRAINT IF EXISTS patients_source_fkey;
EXCEPTION WHEN others THEN NULL;
END$$;

ALTER TABLE public.patients
  DROP CONSTRAINT IF EXISTS patients_source_check;

ALTER TABLE public.patients
  ADD CONSTRAINT patients_source_check
  CHECK (source IN ('tenovi', 'smartmeter', 'local'));
