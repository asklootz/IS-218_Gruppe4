INSERT INTO overture.farms (id, name, location, raw_properties) VALUES
  ('farm_1', 'Gård Kristiansand', ST_SetSRID(ST_MakePoint(8.767, 58.015), 4326), '{"type":"farm"}'),
  ('farm_2', 'Økogård Lillesand', ST_SetSRID(ST_MakePoint(8.376, 58.267), 4326), '{"type":"farm"}'),
  ('farm_3', 'Appelsinhagen', ST_SetSRID(ST_MakePoint(7.751, 58.469), 4326), '{"type":"farm"}');

INSERT INTO overture.water_sources (id, name, location, raw_properties) VALUES
  ('water_1', 'Vannverk Mandal', ST_SetSRID(ST_MakePoint(7.467, 58.031), 4326), '{"type":"water"}'),
  ('water_2', 'Vannbehandling Arendal', ST_SetSRID(ST_MakePoint(8.769, 58.460), 4326), '{"type":"water"}');

INSERT INTO overture.doctors (id, name, location, raw_properties) VALUES
  ('doc_1', 'Legevakt Kristiansand', ST_SetSRID(ST_MakePoint(8.772, 58.010), 4326), '{"type":"doctor"}'),
  ('doc_2', 'Legevakt Arendal', ST_SetSRID(ST_MakePoint(8.769, 58.462), 4326), '{"type":"doctor"}'),
  ('doc_3', 'Legevakt Mandal', ST_SetSRID(ST_MakePoint(7.467, 58.032), 4326), '{"type":"doctor"}');

INSERT INTO overture.hospitals (id, name, location, raw_properties) VALUES
  ('hosp_1', 'Sykehuset i Kristiansand', ST_SetSRID(ST_MakePoint(8.767, 58.015), 4326), '{"type":"hospital"}'),
  ('hosp_2', 'Sykehuset i Arendal', ST_SetSRID(ST_MakePoint(8.769, 58.462), 4326), '{"type":"hospital"}');
