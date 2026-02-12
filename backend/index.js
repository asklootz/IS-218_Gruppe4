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

// Helper to safely quote identifiers
function quoteIdent(s) { return '"' + String(s).replace(/"/g, '""') + '"'; }

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
    console.log(`[REQ] GET /layers/${name} from ${req.ip || req.headers['x-forwarded-for'] || (req.connection && req.connection.remoteAddress)}`);
    // Support schema-qualified names like schema.table
    let schema = 'public';
    let table = name;
    if (name.includes('.')) {
      const parts = name.split('.');
      schema = parts[0];
      table = parts[1];
    }

    // check geometry_columns for the given schema.table to discover geometry column
    const geomRow = await pool.query(
      `SELECT f_geometry_column FROM public.geometry_columns WHERE f_table_schema = $1 AND f_table_name = $2 LIMIT 1`,
      [schema, table]
    );
    if (geomRow.rowCount === 0) {
      // try to find a geometry typed column via information_schema
      const geomFind = await pool.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND udt_name = 'geometry' LIMIT 1`,
        [schema, table]
      );
      if (geomFind.rowCount === 0) {
        return res.status(404).json({ error: 'Layer not found or has no geometry' });
      }
      geomCol = geomFind.rows[0].column_name;
    } else {
      var geomCol = geomRow.rows[0].f_geometry_column;
    }

    // Try to discover a primary key column
    const pk = await pool.query(
      `SELECT kcu.column_name FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = $1 AND tc.table_name = $2 LIMIT 1`,
      [schema, table]
    );
    let idCol = null;
    if (pk.rowCount > 0) {
      idCol = pk.rows[0].column_name;
    } else {
      // fallback: look for common id-like column names
      const candidates = await pool.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND (column_name = 'id' OR column_name LIKE '%_id') LIMIT 1`,
        [schema, table]
      );
      if (candidates.rowCount > 0) idCol = candidates.rows[0].column_name;
    }

    // quote identifiers to avoid SQL injection
    function quoteIdent(s) { return '"' + s.replace(/"/g, '""') + '"'; }
    const ident = `${quoteIdent(schema)}.${quoteIdent(table)}`;
    const geomIdent = quoteIdent(geomCol);
    const propRemove = `'${geomCol}'`;

    // Always include the row's CTID under a safe alias so we can fallback to it
    // reduce row limit to avoid large transfer / DB load when loading many layers
    const innerSelect = `SELECT *, ctid as __ctid FROM ${ident} LIMIT 500`;
    const idLeft = idCol ? `${quoteIdent('t')}.${quoteIdent(idCol)}` : `t.__ctid`;

    const q = `SELECT json_build_object(
      'type', 'FeatureCollection',
      'features', coalesce(json_agg(feature), '[]'::json)
    ) as geojson
    FROM (
      SELECT json_build_object(
        'type','Feature',
        'id', COALESCE((${idLeft})::text, t.__ctid::text),
        'geometry', ST_AsGeoJSON(ST_Transform(${quoteIdent('t')}.${geomIdent}, 4326))::json,
        'properties', to_jsonb(t) - ${propRemove}
      ) as feature
      FROM (${innerSelect}) t
    ) as features;`;
    // Log the SQL being executed (truncated)
    try {
      console.log('[SQL] Executing for', `${schema}.${table}`, 'geom=', geomCol, 'id=', idCol);
      console.log('[SQL] Query start:', q.slice(0, 1000));
    } catch (e) {
      console.error('Failed to log SQL', e && e.message);
    }

    try {
      const result = await pool.query(q);
      res.json(result.rows[0].geojson);
    } catch (sqlErr) {
      console.error('[SQL ERROR] while querying', `${schema}.${table}`, sqlErr && sqlErr.stack);
      return res.status(500).json({ error: sqlErr.message });
    }
  } catch (err) {
    console.error('[REQ ERROR] processing /layers/:name', { name, err: err && err.stack });
    res.status(500).json({ error: err.message });
  }
});

// Return all tables (across schemas) that have geometry/geography columns
// For each table return only an id (primary key or ctid) and the spatial columns
app.get('/spatial', async (req, res) => {
  const limit = Number(req.query.limit) || 500;
  try {
    // Find all tables that have geometry/geography typed columns
    const tablesQ = await pool.query(
      `SELECT table_schema, table_name, coalesce(array_to_json(array_agg(column_name)), '[]') AS geom_columns
       FROM information_schema.columns
       WHERE udt_name IN ('geometry','geography')
       GROUP BY table_schema, table_name
       ORDER BY table_schema, table_name`
    );

    const tables = tablesQ.rows;

    // For each table, fetch primary key if available and then select only pk/ctid and geom cols
    const results = [];
    for (const t of tables) {
      const schema = t.table_schema;
      const table = t.table_name;
      const geomCols = t.geom_columns || [];

      // find primary key column for this table (if any)
      const pkQ = await pool.query(
        `SELECT kcu.column_name FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = $1 AND tc.table_name = $2 LIMIT 1`,
        [schema, table]
      );
      const pkCol = pkQ.rowCount > 0 ? pkQ.rows[0].column_name : null;

      // Build select list: id (pk or ctid) plus each geom column as GeoJSON
      const selectParts = [];
      if (pkCol) {
        selectParts.push(`${quoteIdent(pkCol)} as id`);
      } else {
        selectParts.push(`ctid::text as id`);
      }
      geomCols.forEach((gc, i) => {
        // alias safe name
        const alias = gc.replace(/[^a-zA-Z0-9_]/g, '_');
        selectParts.push(`ST_AsGeoJSON(ST_Transform(${quoteIdent(gc)}, 4326))::json AS ${quoteIdent(alias)}`);
      });

      const ident = `${quoteIdent(schema)}.${quoteIdent(table)}`;
      const q = `SELECT ${selectParts.join(', ')} FROM ${ident} LIMIT $1`;

      try {
        const r = await pool.query(q, [limit]);
        results.push({ schema, table, geom_columns: geomCols, rows: r.rows });
      } catch (err) {
        // if a table is inaccessible or transform fails, include error message instead of rows
        results.push({ schema, table, geom_columns: geomCols, error: err.message });
      }
    }

    // Log a brief summary for debugging
    try {
      console.log('[SPATIAL] tables found:', results.length);
      if (results.length > 0) {
        const sample = results[0];
        console.log('[SPATIAL] sample:', { schema: sample.schema, table: sample.table, geom_columns: sample.geom_columns, rows: (sample.rows||[]).length });
      }
    } catch (e) {
      console.error('Failed to log spatial summary', e && e.message);
    }

    res.json({ tables: results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Legacy endpoint used by some frontends/tools: list schemas that contain spatial tables
app.get('/geom-schemas', async (req, res) => {
  try {
    const q = `SELECT table_schema, array_agg(table_name ORDER BY table_name) AS tables
               FROM (
                 SELECT table_schema, table_name
                 FROM information_schema.columns
                 WHERE udt_name IN ('geometry','geography')
                 GROUP BY table_schema, table_name
               ) x
               GROUP BY table_schema
               ORDER BY table_schema`;
    const r = await pool.query(q);
    res.json({ schemas: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

const port = process.env.PORT || 3000;
testDbConnection().then(() => {
  app.listen(port, () => {
    console.log('Backend listening on', port);
  });
});
