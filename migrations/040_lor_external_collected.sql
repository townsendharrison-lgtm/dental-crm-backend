-- Manual LOR count when student uses an external letter service (not Letter Vault)

ALTER TABLE public.student_profiles
  ADD COLUMN IF NOT EXISTS lor_external_collected INTEGER NOT NULL DEFAULT 0
  CHECK (lor_external_collected >= 0);
