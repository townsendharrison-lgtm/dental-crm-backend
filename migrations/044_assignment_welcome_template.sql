-- Mentor → student welcome message sent when a mentor accepts an assignment.
-- Distinct from welcome_template_student / welcome_template_mentor (platform signup DMs).

ALTER TABLE public.admin_settings
  ADD COLUMN IF NOT EXISTS welcome_template_assignment TEXT;

UPDATE public.admin_settings
SET welcome_template_assignment = COALESCE(
  welcome_template_assignment,
  E'Hi [Mentee Name],\n\nYour mentor, [Mentor Name], is thrilled to be working with you! They look forward to helping you pursue your dream of becoming a dentist.\n\nTo get started, please use the link below to schedule a 30-minute meet-and-greet meeting:\n\n[Meeting Times]\n\n[Timezone]\n\nFeel free to reach out if you have any questions—we are here to support you every step of the way!\n\nLooking forward to your progress!'
)
WHERE id = 1;
