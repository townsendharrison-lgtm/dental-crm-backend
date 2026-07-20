-- Refine meeting audiences to match product rules:
-- ADMIN_DIRECT | STUDENT | MENTORS | STAFF | GLOBAL

ALTER TABLE public.meetings
  DROP CONSTRAINT IF EXISTS meetings_audience_check;

-- Remap previous CUSTOM → STAFF
UPDATE public.meetings
SET audience = 'STAFF'
WHERE audience = 'CUSTOM';

ALTER TABLE public.meetings
  ADD CONSTRAINT meetings_audience_check
  CHECK (
    audience IS NULL OR audience IN (
      'ADMIN_DIRECT',
      'STUDENT',
      'MENTORS',
      'STAFF',
      'GLOBAL'
    )
  );
