-- Configurable mentor session types + summary DM presets (Rules Engine).
-- Shape: [{ "id": "uuid", "label": "DAT Strategy & Planning", "summaryTemplate": "Hi {name}, ..." }, ...]

ALTER TABLE public.admin_settings
  ADD COLUMN IF NOT EXISTS meeting_types JSONB;

UPDATE public.admin_settings
SET meeting_types = COALESCE(
  meeting_types,
  '[
    {
      "id": "introductory-call",
      "label": "Introductory Call",
      "summaryTemplate": "Hi {name}, it was great meeting you today! We covered your background and set some initial goals. I''ve assigned a few tasks to get us started. Looking forward to our next session!"
    },
    {
      "id": "dat-strategy",
      "label": "DAT Strategy & Planning",
      "summaryTemplate": "Hi {name}, great work on our DAT strategy session today. We''ve identified your target scores and a study timeline. Make sure to check the resources I''ve attached to your new tasks."
    },
    {
      "id": "application-review",
      "label": "Application Review",
      "summaryTemplate": "Hi {name}, we made good progress on your application review. Focus on the sections we discussed, especially the experiences descriptions. I''ll review your next draft soon."
    },
    {
      "id": "personal-statement",
      "label": "Personal Statement Workshop",
      "summaryTemplate": "Hi {name}, your personal statement is coming along well. Focus on the ''why dentistry'' narrative we brainstormed. I''m looking forward to seeing the revised version."
    },
    {
      "id": "interview-prep",
      "label": "Interview Preparation",
      "summaryTemplate": "Hi {name}, you did well in our mock interview. Remember to keep your answers concise and focus on specific examples. Practice the ''Tell me about yourself'' pitch we refined."
    },
    {
      "id": "post-interview",
      "label": "Post-Interview Debrief",
      "summaryTemplate": "Hi {name}, thanks for sharing how your interview went. It sounds like you handled the ethical questions well. Now we wait for the next steps!"
    },
    {
      "id": "other",
      "label": "Other",
      "summaryTemplate": "Hi {name}, thanks for our meeting today. We discussed {notes}. I''ve updated your action items accordingly."
    }
  ]'::jsonb
)
WHERE id = 1;
