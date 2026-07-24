-- ==============================================
-- Message attachments (Supabase Storage) + link previews
-- ==============================================

-- Allow image-only messages (caption optional)
ALTER TABLE public.messages
  ALTER COLUMN text DROP NOT NULL;

ALTER TABLE public.messages
  ALTER COLUMN text SET DEFAULT '';

UPDATE public.messages
SET text = ''
WHERE text IS NULL;

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS attachment_url TEXT,
  ADD COLUMN IF NOT EXISTS attachment_type TEXT,
  ADD COLUMN IF NOT EXISTS attachment_name TEXT,
  ADD COLUMN IF NOT EXISTS link_preview JSONB;

COMMENT ON COLUMN public.messages.attachment_url IS 'Public Supabase Storage URL for chat image/file';
COMMENT ON COLUMN public.messages.attachment_type IS 'MIME type of attachment';
COMMENT ON COLUMN public.messages.attachment_name IS 'Original filename';
COMMENT ON COLUMN public.messages.link_preview IS 'Cached Open Graph preview for first URL in text';

-- Chat media bucket (public read; writes via service role from Express)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'message-attachments',
  'message-attachments',
  true,
  10485760,
  ARRAY['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif']
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'message_attachments_public_read'
  ) THEN
    CREATE POLICY message_attachments_public_read
      ON storage.objects FOR SELECT TO public
      USING (bucket_id = 'message-attachments');
  END IF;
END $$;
