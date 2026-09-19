-- Additive: CRM-side cache for school-ai-service results so the Admission
-- Research page loads instantly without re-calling the Python service each time.
-- Never deletes or truncates existing data. Safe to re-run (IF NOT EXISTS / upsert-friendly).

-- Cached extracted facts + rubric snapshot, one row per CRM school.
CREATE TABLE IF NOT EXISTS public.school_ai_facts_cache (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id     TEXT NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  ai_school_id  UUID,
  raw_facts     JSONB NOT NULL DEFAULT '[]'::jsonb,
  rubric        JSONB,
  fact_count    INTEGER NOT NULL DEFAULT 0,
  rubric_status TEXT,
  refreshed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_school_ai_facts_cache_school UNIQUE (school_id)
);

COMMENT ON TABLE public.school_ai_facts_cache IS
  'Cached school-ai-service raw facts + rubric snapshot per CRM school (source of truth remains the Python service).';

CREATE INDEX IF NOT EXISTS idx_school_ai_facts_cache_ai_school
  ON public.school_ai_facts_cache (ai_school_id)
  WHERE ai_school_id IS NOT NULL;

-- Persisted student ↔ school fit comparisons; latest run per (school, student).
CREATE TABLE IF NOT EXISTS public.school_ai_scores (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id            TEXT NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  student_id           UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  ai_school_id         UUID,
  score                NUMERIC,
  score_kind           TEXT,
  reasoning            TEXT,
  per_factor_breakdown JSONB NOT NULL DEFAULT '[]'::jsonb,
  skipped              JSONB NOT NULL DEFAULT '[]'::jsonb,
  attributes_used      JSONB NOT NULL DEFAULT '{}'::jsonb,
  scoring_run_id       UUID,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_school_ai_scores_school_student UNIQUE (school_id, student_id)
);

COMMENT ON TABLE public.school_ai_scores IS
  'Latest persisted deterministic fit score (0-100) per CRM school + student. Not an acceptance probability.';

CREATE INDEX IF NOT EXISTS idx_school_ai_scores_student
  ON public.school_ai_scores (student_id);

CREATE INDEX IF NOT EXISTS idx_school_ai_scores_school
  ON public.school_ai_scores (school_id);
