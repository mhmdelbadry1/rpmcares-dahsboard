-- Tracks when each staff member last viewed a patient's conversation.
-- Unread count = comm logs where occurred_at > viewed_at.

CREATE TABLE IF NOT EXISTS public.comm_last_viewed (
  patient_id  text        NOT NULL,
  staff_id    uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  viewed_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (patient_id, staff_id)
);

CREATE INDEX IF NOT EXISTS comm_last_viewed_staff_idx ON public.comm_last_viewed(staff_id);

-- Returns per-patient unread counts + last message preview for a given staff member.
CREATE OR REPLACE FUNCTION public.get_comm_summaries(p_staff_id uuid)
RETURNS TABLE(
  patient_id      text,
  unread_count    bigint,
  last_at         timestamptz,
  last_summary    text,
  last_comm_type  text
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
      CASE WHEN cl.occurred_at > COALESCE(lv.viewed_at, '1970-01-01'::timestamptz)
           THEN 1 END
    )::bigint                      AS unread_count,
    l.occurred_at                  AS last_at,
    l.summary                      AS last_summary,
    l.comm_type                    AS last_comm_type
  FROM latest l
  JOIN public.communications_log cl ON cl.patient_id = l.patient_id
  LEFT JOIN public.comm_last_viewed lv
    ON lv.patient_id = l.patient_id
   AND lv.staff_id   = p_staff_id
  GROUP BY l.patient_id, l.occurred_at, l.summary, l.comm_type;
$$;
