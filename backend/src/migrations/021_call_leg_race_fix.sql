-- Ensure only one communications_log row per Twilio call leg, so the two
-- writers that race on inbound calls (/call-accepted, fired by the browser
-- the instant it answers; and the dial-status webhook, fired by Twilio once
-- the call ends) can never both insert separate rows for the same call.
create unique index if not exists communications_log_twilio_sid_uniq
  on communications_log (twilio_sid) where twilio_sid is not null;

-- Atomically creates-or-merges the communications_log row for one inbound
-- call leg. Whichever writer arrives first creates the row; the other only
-- fills in the fields it uniquely knows (staff_id from accept-time; the
-- real duration/summary from dial-status), so a late-arriving accept-time
-- write can never stomp a dial-status write that already finalized the call
-- as answered/missed, and vice versa.
create or replace function upsert_inbound_call_leg(
  p_twilio_sid text,
  p_patient_id uuid,
  p_clinic_id uuid,
  p_staff_id uuid,
  p_duration_seconds int,
  p_summary text,
  p_occurred_at timestamptz,
  p_is_final boolean
) returns communications_log
language plpgsql
as $$
declare
  v_row communications_log;
begin
  insert into communications_log
    (patient_id, clinic_id, staff_id, comm_type, direction, duration_seconds, summary, twilio_sid, occurred_at)
  values
    (p_patient_id, p_clinic_id, p_staff_id, 'call', 'inbound', p_duration_seconds, p_summary, p_twilio_sid, p_occurred_at)
  on conflict (twilio_sid) do update set
    staff_id         = coalesce(communications_log.staff_id, excluded.staff_id),
    duration_seconds = case when p_is_final then excluded.duration_seconds else communications_log.duration_seconds end,
    summary          = case when p_is_final then excluded.summary else communications_log.summary end
  returning * into v_row;
  return v_row;
end;
$$;
