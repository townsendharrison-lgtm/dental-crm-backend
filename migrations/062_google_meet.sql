-- Google Meet automation: one DSG Workspace account owns every Meet space.
-- Mentors (co-host) and students are invited as guests; transcripts and
-- Gemini notes land in the DSG Drive and are synced back onto the meeting.

ALTER TABLE public.meetings
  ADD COLUMN IF NOT EXISTS google_space_name TEXT,
  ADD COLUMN IF NOT EXISTS google_meeting_code TEXT,
  ADD COLUMN IF NOT EXISTS google_calendar_event_id TEXT,
  ADD COLUMN IF NOT EXISTS meet_status TEXT,
  ADD COLUMN IF NOT EXISTS meet_error TEXT,
  ADD COLUMN IF NOT EXISTS conference_record_name TEXT,
  ADD COLUMN IF NOT EXISTS transcript_doc_url TEXT,
  ADD COLUMN IF NOT EXISTS notes_doc_url TEXT,
  ADD COLUMN IF NOT EXISTS artifacts_synced_at TIMESTAMPTZ;

ALTER TABLE public.meetings DROP CONSTRAINT IF EXISTS meetings_meet_status_check;
ALTER TABLE public.meetings
  ADD CONSTRAINT meetings_meet_status_check
  CHECK (
    meet_status IS NULL OR meet_status IN (
      'pending', 'provisioned', 'failed', 'ended', 'notes_ready', 'no_artifacts'
    )
  );

-- Single-row store for the DSG Google account connected from Admin settings.
-- refresh_token is AES-256-GCM encrypted by the backend; service role only.
CREATE TABLE IF NOT EXISTS public.google_integration (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  account_email TEXT NOT NULL,
  refresh_token_enc TEXT NOT NULL,
  scopes TEXT,
  connected_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.google_integration ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_meetings_meet_artifact_sync
  ON public.meetings (date)
  WHERE google_space_name IS NOT NULL AND artifacts_synced_at IS NULL;
