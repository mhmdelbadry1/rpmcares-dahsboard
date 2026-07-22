-- Fix get_comm_summaries: only count inbound SMS as "unread", not inbound
-- calls. A missed/answered call already shows its own status in the thread
-- (Missed call / Inbound call · duration) — it doesn't need a "read"
-- receipt, and counting it toward the unread badge made the badge show
-- "1 unread" with no corresponding unread text message to find.

CREATE OR REPLACE FUNCTION public.get_comm_summaries(p_staff_id uuid)
RETURNS TABLE(
  patient_id      uuid,
  unread_count    bigint,
  last_at         timestamptz,
  last_summary    text,
  last_comm_type  text,
  has_call        boolean,
  has_sms         boolean
)
LANGUAGE sql STABLE
AS $$
  WITH latest AS (
    SELECT DISTINCT ON (patient_id)
      patient_id, occurred_at, summary, comm_type
    FROM public.communications_log
    ORDER BY patient_id, occurred_at DESC
  )
  SELECT
    l.patient_id,
    COUNT(
      CASE
        WHEN cl.direction = 'inbound'
         AND cl.comm_type = 'sms'
         AND cl.occurred_at > COALESCE(lv.viewed_at, '1970-01-01'::timestamptz)
        THEN 1
      END
    )::bigint                                AS unread_count,
    l.occurred_at                            AS last_at,
    l.summary                                AS last_summary,
    l.comm_type                              AS last_comm_type,
    BOOL_OR(cl.comm_type = 'call')           AS has_call,
    BOOL_OR(cl.comm_type = 'sms')            AS has_sms
  FROM latest l
  JOIN public.communications_log cl ON cl.patient_id = l.patient_id
  LEFT JOIN public.comm_last_viewed lv
    ON lv.patient_id = l.patient_id
   AND lv.staff_id   = p_staff_id
  GROUP BY l.patient_id, l.occurred_at, l.summary, l.comm_type;
$$;
