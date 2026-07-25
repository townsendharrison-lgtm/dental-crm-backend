-- Expanded student profile details for Profile & Docs editing

ALTER TABLE public.student_profiles
  ADD COLUMN IF NOT EXISTS sgpa NUMERIC,
  ADD COLUMN IF NOT EXISTS major TEXT,
  ADD COLUMN IF NOT EXISTS took_online_classes BOOLEAN,
  ADD COLUMN IF NOT EXISTS took_cc_classes BOOLEAN,
  ADD COLUMN IF NOT EXISTS additional_schooling JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS additional_schooling_other TEXT,
  ADD COLUMN IF NOT EXISTS applicant_type TEXT
    CHECK (applicant_type IS NULL OR applicant_type IN ('FIRST_TIME', 'REAPPLICANT')),
  ADD COLUMN IF NOT EXISTS previous_application_doc_id UUID,
  ADD COLUMN IF NOT EXISTS reapplicant_schools JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS dat_type TEXT
    CHECK (dat_type IS NULL OR dat_type IN ('NOT_TAKEN', 'AMERICAN', 'CANADIAN')),
  ADD COLUMN IF NOT EXISTS dat_pat NUMERIC,
  ADD COLUMN IF NOT EXISTS dat_bio NUMERIC,
  ADD COLUMN IF NOT EXISTS dat_gc NUMERIC,
  ADD COLUMN IF NOT EXISTS dat_oc NUMERIC,
  ADD COLUMN IF NOT EXISTS dat_rc NUMERIC,
  ADD COLUMN IF NOT EXISTS dat_qr NUMERIC,
  ADD COLUMN IF NOT EXISTS dat_sns NUMERIC,
  ADD COLUMN IF NOT EXISTS dat_mdt NUMERIC,
  ADD COLUMN IF NOT EXISTS considering_schools JSONB DEFAULT '[]'::jsonb;

-- Allow "Previous Application" document uploads for reapplicants
ALTER TABLE public.student_documents
  DROP CONSTRAINT IF EXISTS student_documents_type_check;

ALTER TABLE public.student_documents
  ADD CONSTRAINT student_documents_type_check
  CHECK (type IN (
    'Transcript',
    'Resume',
    'Letter of Recommendation',
    'Post-Bac Transcript',
    'DAT Report',
    'Essay',
    'Previous Application',
    'Other'
  ));
