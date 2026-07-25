-- Popup image display controls (fit + height)
ALTER TABLE popup_advertisements
  ADD COLUMN IF NOT EXISTS image_fit TEXT NOT NULL DEFAULT 'cover'
    CHECK (image_fit IN ('cover', 'contain', 'original')),
  ADD COLUMN IF NOT EXISTS image_height TEXT NOT NULL DEFAULT 'md'
    CHECK (image_height IN ('sm', 'md', 'lg'));

COMMENT ON COLUMN popup_advertisements.image_fit IS
  'How the campaign image is scaled: cover (crop), contain (letterbox), original (natural height).';
COMMENT ON COLUMN popup_advertisements.image_height IS
  'Image band height when fit is cover/contain: sm, md, or lg.';
