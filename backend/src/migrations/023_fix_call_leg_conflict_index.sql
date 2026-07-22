-- Fixes a bug in 021: that migration created a PARTIAL unique index
-- (WHERE twilio_sid IS NOT NULL), but upsert_inbound_call_leg's
-- "ON CONFLICT (twilio_sid)" clause didn't repeat that predicate — Postgres
-- requires an exact match to use a partial index as the conflict-inference
-- target, so every call to the function failed with "there is no unique or
-- exclusion constraint matching the ON CONFLICT specification" (42P10),
-- meaning NO inbound call got logged at all since 021 was applied.
--
-- The partial predicate was unnecessary in the first place: Postgres
-- already treats every NULL as distinct from every other NULL under a
-- plain (non-partial) unique index, so existing SMS/manual rows with a
-- null twilio_sid are unaffected either way — only real duplicate
-- non-null values are blocked, which is all we ever needed.
drop index if exists communications_log_twilio_sid_uniq;
create unique index if not exists communications_log_twilio_sid_uniq
  on communications_log (twilio_sid);
