-- Migration 022: Extend admin_settings for full Rules Engine
-- Adds auto-reply thresholds, application status messages

ALTER TABLE public.admin_settings
  ADD COLUMN IF NOT EXISTS auto_reply_inactivity_minutes INTEGER NOT NULL DEFAULT 120,
  ADD COLUMN IF NOT EXISTS auto_reply_rate_limit_minutes INTEGER NOT NULL DEFAULT 1440,
  ADD COLUMN IF NOT EXISTS accepted_message TEXT DEFAULT 'Congratulations! Your hard work has paid off. You''re going to be a dentist!',
  ADD COLUMN IF NOT EXISTS interview_message TEXT DEFAULT 'Great job! An interview is a huge milestone. You''ve got this!',
  ADD COLUMN IF NOT EXISTS waitlist_message TEXT DEFAULT 'You''re still in the running! A waitlist is a ''not yet'', not a ''no''. Stay positive!';

UPDATE public.admin_settings
SET
  auto_reply_inactivity_minutes = COALESCE(auto_reply_inactivity_minutes, 120),
  auto_reply_rate_limit_minutes = COALESCE(auto_reply_rate_limit_minutes, 1440),
  accepted_message = COALESCE(
    accepted_message,
    'Congratulations! Your hard work has paid off. You''re going to be a dentist!'
  ),
  interview_message = COALESCE(
    interview_message,
    'Great job! An interview is a huge milestone. You''ve got this!'
  ),
  waitlist_message = COALESCE(
    waitlist_message,
    'You''re still in the running! A waitlist is a ''not yet'', not a ''no''. Stay positive!'
  )
WHERE id = 1;
