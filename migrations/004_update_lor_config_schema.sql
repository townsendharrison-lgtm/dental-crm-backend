-- ==============================================
-- Update LOR Email Config Schema for Reminder Targets
-- Run this in your Supabase SQL Editor
-- ==============================================

-- Add new column for JSONB format
ALTER TABLE public.lor_email_config
ADD COLUMN reminder_schedule_jsonb JSONB;

-- Migrate existing data from integer[] to JSONB with target field
UPDATE public.lor_email_config
SET reminder_schedule_jsonb = (
  SELECT jsonb_agg(jsonb_build_object('days', elem, 'target', 'writer'))
  FROM unnest(reminder_schedule) AS elem
)
WHERE reminder_schedule IS NOT NULL;

-- Drop old column
ALTER TABLE public.lor_email_config
DROP COLUMN reminder_schedule;

-- Rename new column to original name
ALTER TABLE public.lor_email_config
RENAME COLUMN reminder_schedule_jsonb TO reminder_schedule;

-- Add writerReminderBody and requesterReminderBody to content if they don't exist
UPDATE public.lor_email_config 
SET content = jsonb_set(
  content, 
  '{writerReminderBody}', 
  '"Dear {{writer_name}},\n\nThis is a reminder that the letter for {{student_name}} is due on {{due_date}}. Please upload it at your earliest convenience.\n\nThank you for your support!"'::jsonb
)
WHERE content->>'writerReminderBody' IS NULL;

UPDATE public.lor_email_config 
SET content = jsonb_set(
  content, 
  '{requesterReminderBody}', 
  '"Dear {{student_name}},\n\nThis is an update regarding your letter of recommendation from {{writer_name}}. The letter is due on {{due_date}} and has not yet been uploaded.\n\nPlease follow up with your writer if needed."'::jsonb
)
WHERE content->>'requesterReminderBody' IS NULL;
