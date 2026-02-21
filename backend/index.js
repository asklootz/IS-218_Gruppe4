const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

// Configure Postgres connection - allow using a single DATABASE_URL (Supabase)
const poolConfig = {};
if (process.env.DATABASE_URL) {
  try {
    const u = new URL(process.env.DATABASE_URL);
    poolConfig.host = u.hostname;
    poolConfig.port = u.port ? Number(u.port) : 5432;
    poolConfig.user = decodeURIComponent(u.username);
    poolConfig.password = decodeURIComponent(u.password);
    poolConfig.database = u.pathname && u.pathname.length > 1 ? u.pathname.slice(1) : undefined;
    // honor explicit DB_SSL env or query params
    if (process.env.DB_SSL === 'true' || process.env.DB_SSL === '1' || u.searchParams.get('sslmode') === 'require') {
      poolConfig.ssl = { rejectUnauthorized: false };
    }
  } catch (e) {
    // fallback to raw connection string if URL parsing fails
    poolConfig.connectionString = process.env.DATABASE_URL;
    if (process.env.DB_SSL === 'true' || process.env.DB_SSL === '1') {
      poolConfig.ssl = { rejectUnauthorized: false };
    }
  }
} else {
  poolConfig.host = process.env.PGHOST || 'localhost';
  poolConfig.user = process.env.PGUSER || 'postgres';
  poolConfig.password = process.env.PGPASSWORD || 'example';
  poolConfig.database = process.env.PGDATABASE || 'gis';
  poolConfig.port = process.env.PGPORT ? Number(process.env.PGPORT) : 5432;
}

const pool = new Pool(poolConfig);

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

//----
// for å kjøre romlige spørringer:
app.get('/layers/:name', async (req, res) => {
  const name = req.params.name;

  try {

    // Support schema-qualified names like schema.table
    let schema = 'public';
    let table = name;

    if (name.includes('.')) {
      const parts = name.split('.');
      schema = parts[0];
      table = parts[1];
    }

    // Bygg SQL (GeoJSON)
    const q = `
      SELECT json_build_object(
        'type', 'FeatureCollection',
        'features', json_agg(
          json_build_object(
            'type', 'Feature',
            'geometry', ST_AsGeoJSON(geom)::json,
            'properties', to_jsonb(row) - 'geom'
          )
        )
      ) AS geojson
      FROM ${schema}.${table} row;
    `;

    // Log SQL
    try {
      console.log('[SQL] Executing for', `${schema}.${table}`);
      console.log('[SQL] Query start:', q.slice(0, 500));
    } catch (logErr) {
      console.error('Failed to log SQL', logErr && logErr.message);
    }

    // Kjør SQL
    try {
      const result = await pool.query(q);
      res.json(result.rows[0].geojson);
    } catch (sqlErr) {
      console.error('[SQL ERROR]', sqlErr && sqlErr.stack);
      return res.status(500).json({ error: sqlErr.message });
    }

  } catch (err) {
    console.error('[REQ ERROR] processing /layers/:name', err && err.stack);
    res.status(500).json({ error: err.message });
  }
});
//----

// Inspect a table name: check information_schema and geometry_columns
app.get('/inspect/:name', async (req, res) => {
  const name = req.params.name;
  try {
    const tables = await pool.query(
      `SELECT table_schema, table_name FROM information_schema.tables WHERE table_name = $1`,
      [name]
    );

    const geoms = await pool.query(
      `SELECT f_table_schema, f_table_name, type FROM public.geometry_columns WHERE f_table_name = $1`,
      [name]
    );

    res.json({ tables: tables.rows, geometry_columns: geoms.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List tables and geometry columns inside a given schema
app.get('/schema/:schema', async (req, res) => {
  const schema = req.params.schema;
  try {
    const tables = await pool.query(
      `SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name`,
      [schema]
    );

    const geoms = await pool.query(
      `SELECT f_table_schema, f_table_name, type FROM public.geometry_columns WHERE f_table_schema = $1 ORDER BY f_table_name`,
      [schema]
    );

    res.json({ schema, tables: tables.rows, geometry_columns: geoms.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function testDbConnection() {
  try {
    console.log('DB: using DATABASE_URL=', !!process.env.DATABASE_URL);
    // avoid printing the full connection string
    if (process.env.DATABASE_URL) {
      const safe = process.env.DATABASE_URL.replace(/:[^:@]*@/, ':*****@');
      console.log('DB: connectionString example:', safe);
    }
    const r = await pool.query('SELECT 1');
    console.log('DB test query result:', r.rows);
  } catch (err) {
    console.error('DB connection test failed:', err.message);
  }
}

//Romlig SQL som viser objekter innen 500m
app.get('/analysis/near', async (req, res) => {
    const { table, lon, lat, distance } = req.query;

    try {
        const query = `
      SELECT *
      FROM ${table}
      WHERE ST_DWithin(
        geom::geography,
        ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
        $3
      )
    `;

        const result = await pool.query(query, [lon, lat, distance]);
        res.json(result.rows);

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

//romlig SQL for å søke i database 
app.get('/analysis/search', async (req, res) => {
    const { table, field, value } = req.query;

    try {
        const query = `
      SELECT *
      FROM ${table}
      WHERE ${field} ILIKE $1
    `;

        const result = await pool.query(query, [`%${value}%`]);
        res.json(result.rows);

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});


const port = process.env.PORT || 3000;
testDbConnection().then(() => {
  app.listen(port, () => {
    console.log('Backend listening on', port);
  });
});

