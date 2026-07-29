-- Store prior (pre-signup) hours/weeks on the experience itself instead of
-- inventing dated session rows that pollute Recent Sessions and inflate weeks.

ALTER TABLE public.experiences
  ADD COLUMN IF NOT EXISTS prior_hours NUMERIC(8, 2) NOT NULL DEFAULT 0;

ALTER TABLE public.experiences
  ADD COLUMN IF NOT EXISTS prior_weeks INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.experiences.prior_hours IS
  'Hours completed before the student started logging sessions in the CRM';
COMMENT ON COLUMN public.experiences.prior_weeks IS
  'Weeks of activity before the student started logging sessions in the CRM';

-- Fold legacy synthetic "Prior hours (quick add)" sessions into the new columns, then remove them.
DO $$
DECLARE
  r RECORD;
  ph NUMERIC;
  pw INTEGER;
BEGIN
  FOR r IN
    SELECT
      experience_id,
      COALESCE(SUM(duration), 0) AS total_hours,
      COUNT(*)::INTEGER AS session_count,
      MAX(
        CASE
          WHEN notes ~ '· ([0-9]+) weeks'
            THEN (regexp_match(notes, '· ([0-9]+) weeks'))[1]::INTEGER
          ELSE NULL
        END
      ) AS notes_weeks
    FROM public.experience_sessions
    WHERE notes ILIKE 'Prior hours (quick add)%'
    GROUP BY experience_id
  LOOP
    ph := r.total_hours;
    pw := COALESCE(r.notes_weeks, r.session_count, 0);

    UPDATE public.experiences
    SET
      prior_hours = COALESCE(prior_hours, 0) + ph,
      prior_weeks = GREATEST(COALESCE(prior_weeks, 0), pw),
      updated_at = TIMEZONE('utc', NOW())
    WHERE id = r.experience_id;
  END LOOP;

  DELETE FROM public.experience_sessions
  WHERE notes ILIKE 'Prior hours (quick add)%';
END $$;
