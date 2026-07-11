-- Fix: sendSmsHandler was inserting outbound SMS without twilio_sid, so the
-- Twilio background sync couldn't dedup on the unique index and inserted a
-- second row (staff_id = null).  This migration:
--   1. Copies the Twilio SID from each sync row onto the matching staff row.
--   2. Deletes the now-redundant sync rows.
-- After this, the backend fix (twilio_sid persisted at send time) prevents
-- new duplicates from forming.

BEGIN;

WITH sync_rows AS (
  -- Outbound rows imported by the sync (no staff_id, has twilio_sid)
  -- that have a matching staff-sent row (has staff_id, no twilio_sid).
  SELECT
    c_sync.id          AS sync_id,
    c_sync.twilio_sid,
    c_sync.patient_id,
    c_sync.summary
  FROM communications_log c_sync
  WHERE c_sync.direction  = 'outbound'
    AND c_sync.staff_id   IS NULL
    AND c_sync.twilio_sid IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM communications_log c_staff
      WHERE c_staff.patient_id  = c_sync.patient_id
        AND c_staff.summary     = c_sync.summary
        AND c_staff.direction   = 'outbound'
        AND c_staff.staff_id    IS NOT NULL
        AND c_staff.twilio_sid  IS NULL
    )
),
deleted AS (
  DELETE FROM communications_log
  WHERE id IN (SELECT sync_id FROM sync_rows)
  RETURNING twilio_sid, patient_id, summary
)
UPDATE communications_log AS c_staff
SET twilio_sid = deleted.twilio_sid
FROM deleted
WHERE c_staff.patient_id  = deleted.patient_id
  AND c_staff.summary     = deleted.summary
  AND c_staff.direction   = 'outbound'
  AND c_staff.staff_id    IS NOT NULL
  AND c_staff.twilio_sid  IS NULL;

COMMIT;
