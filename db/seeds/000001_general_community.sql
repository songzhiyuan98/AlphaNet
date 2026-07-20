BEGIN;

INSERT INTO platform.communities (
  id,
  slug,
  name,
  description,
  settings
)
VALUES (
  '00000000-0000-4000-8000-000000000001',
  'general',
  'General Market Research',
  'Cross-market research, questions, counterarguments, and source discovery.',
  '{"seeded": true}'::jsonb
)
ON CONFLICT DO NOTHING;

COMMIT;
