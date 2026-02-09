const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'example',
  database: process.env.PGDATABASE || 'gis',
  port: process.env.PGPORT ? Number(process.env.PGPORT) : 5432,
});

app.get('/layers', async (req, res) => {
  try {
    // Try geometry_columns first
    const geomRes = await pool.query("SELECT f_table_name as table_name FROM public.geometry_columns");
    const names = geomRes.rows.map(r => r.table_name);
    res.json({ layers: names });
  } catch (err) {
    // fallback: list tables and hope
    try {
      const tbl = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'");
      res.json({ layers: tbl.rows.map(r => r.table_name) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
});

app.get('/layers/:name', async (req, res) => {
  const name = req.params.name;
  try {
    // Validate name against geometry_columns
    const check = await pool.query('SELECT f_table_name FROM public.geometry_columns WHERE f_table_name = $1', [name]);
    if (check.rowCount === 0) {
      return res.status(404).json({ error: 'Layer not found or has no geometry' });
    }

    const q = `SELECT json_build_object(
      'type', 'FeatureCollection',
      'features', coalesce(json_agg(feature), '[]'::json)
    ) as geojson
    FROM (
      SELECT json_build_object(
        'type','Feature',
        'id', id,
        'geometry', ST_AsGeoJSON(geom)::json,
        'properties', to_jsonb(t) - 'geom'
      ) as feature
      FROM (SELECT * FROM ${name} LIMIT 2000) t
    ) as features;`;

    const result = await pool.query(q);
    res.json(result.rows[0].geojson);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log('Backend listening on', port);
});
