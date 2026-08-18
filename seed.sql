-- Sample roster and leave, ported from the original project's data/*.csv.
-- Used for local testing. Replace with your real team before deploying.
DELETE FROM roster;
DELETE FROM leave;

INSERT INTO roster (id, name, handle, position) VALUES
  ('ana', 'Ana Silva',  '', 0),
  ('bo',  'Bo Chen',    '', 1),
  ('cy',  'Cy Novak',   '', 2),
  ('dee', 'Dee Okafor', '', 3);

INSERT INTO leave (member_id, from_date, to_date) VALUES
  ('bo', '2026-07-22', '2026-07-24');
