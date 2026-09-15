-- Additive: legacy school_evidence is retained for audit, never auto-promoted.
CREATE TABLE IF NOT EXISTS public.school_research_profiles (
  school_id text PRIMARY KEY REFERENCES public.schools(id) ON DELETE CASCADE,
  profile jsonb NOT NULL,
  revision bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.school_research_profiles ENABLE ROW LEVEL SECURITY;
-- Only the AI server's service role may read source text or mutate evidence.
REVOKE ALL ON public.school_research_profiles FROM anon, authenticated;
GRANT ALL ON public.school_research_profiles TO service_role;

CREATE OR REPLACE FUNCTION public.save_school_research_profile(
  p_school_id text, p_profile jsonb, p_expected_revision bigint
) RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE changed integer;
BEGIN
  IF p_expected_revision = 0 THEN
    INSERT INTO school_research_profiles(school_id, profile, revision)
      VALUES (p_school_id, p_profile, 1) ON CONFLICT DO NOTHING;
  ELSE
    UPDATE school_research_profiles SET profile = p_profile, revision = revision + 1, updated_at = now()
      WHERE school_id = p_school_id AND revision = p_expected_revision;
  END IF;
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed = 1 THEN
    UPDATE schools SET name = p_profile->>'name', location = p_profile->>'location' WHERE id = p_school_id;
  END IF;
  RETURN changed = 1;
END;
$$;
REVOKE ALL ON FUNCTION public.save_school_research_profile(text,jsonb,bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_school_research_profile(text,jsonb,bigint) TO service_role;

CREATE OR REPLACE FUNCTION public.create_school_research_profile(p_profile jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
BEGIN
  INSERT INTO schools(id, name, location) VALUES(p_profile->>'id', p_profile->>'name', p_profile->>'location');
  INSERT INTO school_research_profiles(school_id, profile, revision) VALUES(p_profile->>'id', p_profile, 1);
  RETURN true;
EXCEPTION WHEN unique_violation THEN
  RETURN false;
END;
$$;
REVOKE ALL ON FUNCTION public.create_school_research_profile(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_school_research_profile(jsonb) TO service_role;

-- Explicit optional CRM facts. NULL means unknown; no historical backfill guesses.
ALTER TABLE public.student_profiles ADD COLUMN IF NOT EXISTS dat_score_scale text;
ALTER TABLE public.student_profiles ADD COLUMN IF NOT EXISTS completed_courses jsonb DEFAULT '[]'::jsonb;
ALTER TABLE public.student_profiles ADD COLUMN IF NOT EXISTS criteria_details jsonb DEFAULT '{}'::jsonb;
