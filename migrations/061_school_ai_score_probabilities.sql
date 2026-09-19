-- Additive: persist fit-derived outcome probabilities on school_ai_scores.
-- Never deletes or truncates existing data.

ALTER TABLE public.school_ai_scores
  ADD COLUMN IF NOT EXISTS interview_probability NUMERIC,
  ADD COLUMN IF NOT EXISTS acceptance_probability NUMERIC,
  ADD COLUMN IF NOT EXISTS waitlist_probability NUMERIC,
  ADD COLUMN IF NOT EXISTS reject_probability NUMERIC,
  ADD COLUMN IF NOT EXISTS probability_kind TEXT;

COMMENT ON COLUMN public.school_ai_scores.interview_probability IS
  'Fit-derived interview probability estimate 0-100 (probability_kind documents the method).';
COMMENT ON COLUMN public.school_ai_scores.acceptance_probability IS
  'Fit-derived acceptance probability estimate 0-100 — not calibrated admissions odds.';
COMMENT ON COLUMN public.school_ai_scores.waitlist_probability IS
  'Fit-derived waitlist probability estimate 0-100.';
COMMENT ON COLUMN public.school_ai_scores.reject_probability IS
  'Fit-derived reject probability estimate 0-100.';
COMMENT ON COLUMN public.school_ai_scores.probability_kind IS
  'Method tag, e.g. fit_score_derived_v1.';
