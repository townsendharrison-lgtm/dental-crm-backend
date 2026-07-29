-- Expand badge benchmark types for GPA, LOR, and experience hours.

ALTER TABLE public.badges
  DROP CONSTRAINT IF EXISTS badges_benchmark_type_check;

ALTER TABLE public.badges
  ADD CONSTRAINT badges_benchmark_type_check
  CHECK (
    benchmark_type IN (
      'PROGRESS',
      'STRENGTH_SCORE',
      'DAT',
      'TASKS_COMPLETED',
      'MEETINGS_ATTENDED',
      'GPA',
      'LOR_COLLECTED',
      'VOLUNTEER_HOURS',
      'SHADOWING_HOURS'
    )
  );
