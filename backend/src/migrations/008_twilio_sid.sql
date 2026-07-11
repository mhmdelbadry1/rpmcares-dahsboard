-- Add twilio_sid to communications_log for recording/transcription callbacks
ALTER TABLE public.communications_log
  ADD COLUMN IF NOT EXISTS twilio_sid TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS comm_log_twilio_sid_idx
  ON public.communications_log (twilio_sid)
  WHERE twilio_sid IS NOT NULL;
