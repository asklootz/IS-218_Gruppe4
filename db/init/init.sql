-- Create a sample polygons table named parks with a geometry column
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS parks (
  id serial primary key,
  name text
);

SELECT AddGeometryColumn('public','parks','geom',4326,'POLYGON',2) WHERE NOT EXISTS (SELECT 1 FROM geometry_columns WHERE f_table_name='parks');

INSERT INTO parks (name, geom) VALUES
('Central Park', ST_SetSRID(ST_GeomFromText('POLYGON((10.73 59.9, 10.78 59.9, 10.78 59.94, 10.73 59.94, 10.73 59.9))'),4326))
ON CONFLICT DO NOTHING;
