-- Normalize stored patient phone numbers to E.164 format.
-- Only adds +1 for bare 10-digit numbers (US/CA).
-- Numbers with + prefix or 00 prefix: strip formatting but keep country code.
-- 11-digit starting with 1: US with leading 1 → +1XXXXXXXXXX.
-- Anything else (international without prefix): prepend + and leave digits as-is.

UPDATE public.patients
SET phone = CASE
  -- Already has + prefix — strip non-digits and re-add +
  WHEN phone ~ '^\+'
    THEN '+' || regexp_replace(phone, '\D', '', 'g')
  -- International dialing prefix 00 → replace with +
  WHEN phone ~ '^00'
    THEN '+' || substr(regexp_replace(phone, '\D', '', 'g'), 3)
  -- Bare 10 digits → assume US/CA
  WHEN length(regexp_replace(phone, '\D', '', 'g')) = 10
    THEN '+1' || regexp_replace(phone, '\D', '', 'g')
  -- 11 digits starting with 1 → US with country code
  WHEN length(regexp_replace(phone, '\D', '', 'g')) = 11
   AND regexp_replace(phone, '\D', '', 'g') ~ '^1'
    THEN '+' || regexp_replace(phone, '\D', '', 'g')
  -- Everything else (UAE 971XXXXXXXXX etc.) — strip formatting, keep digits with +
  ELSE '+' || regexp_replace(phone, '\D', '', 'g')
END
WHERE phone IS NOT NULL
  AND phone != ''
  AND phone NOT LIKE '+%';  -- skip already-correct E.164 numbers
