-- Add twilio_sid for dedup when importing message history from Twilio API
ALTER TABLE communications_log
  ADD COLUMN IF NOT EXISTS twilio_sid TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS comm_log_twilio_sid_idx
  ON communications_log (twilio_sid)
  WHERE twilio_sid IS NOT NULL;
