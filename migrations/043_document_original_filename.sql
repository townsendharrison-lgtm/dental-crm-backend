-- Store original uploaded filename for display (storage path uses a UUID)

ALTER TABLE public.student_documents
  ADD COLUMN IF NOT EXISTS original_filename TEXT;
