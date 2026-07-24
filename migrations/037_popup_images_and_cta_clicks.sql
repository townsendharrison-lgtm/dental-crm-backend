-- ==============================================
-- Popup images (Supabase Storage) + CTA click analytics
-- ==============================================

CREATE TABLE IF NOT EXISTS public.popup_cta_clicks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  popup_id UUID NOT NULL REFERENCES public.popup_advertisements(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  clicked_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL,
  UNIQUE (popup_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_popup_cta_clicks_popup
  ON public.popup_cta_clicks(popup_id, clicked_at DESC);

ALTER TABLE public.popup_cta_clicks ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'popup_cta_clicks' AND policyname = 'Admins can view popup CTA clicks'
  ) THEN
    CREATE POLICY "Admins can view popup CTA clicks" ON public.popup_cta_clicks
      FOR SELECT USING (
        EXISTS (
          SELECT 1 FROM public.users
          WHERE id = auth.uid() AND role IN ('ADMIN', 'MENTOR_MANAGER')
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'popup_cta_clicks' AND policyname = 'Users can record own popup CTA clicks'
  ) THEN
    CREATE POLICY "Users can record own popup CTA clicks" ON public.popup_cta_clicks
      FOR INSERT WITH CHECK (auth.uid() = user_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'popup_cta_clicks' AND policyname = 'Users can update own popup CTA clicks'
  ) THEN
    CREATE POLICY "Users can update own popup CTA clicks" ON public.popup_cta_clicks
      FOR UPDATE USING (auth.uid() = user_id);
  END IF;
END $$;

-- Public bucket for popup campaign images (writes via service role)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'popup-images',
  'popup-images',
  true,
  5242880,
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
    WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'popup_images_public_read'
  ) THEN
    CREATE POLICY popup_images_public_read
      ON storage.objects FOR SELECT TO public
      USING (bucket_id = 'popup-images');
  END IF;
END $$;
