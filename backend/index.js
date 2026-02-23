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
    const DEFAULT_ROW_LIMIT = 500;
    const MIN_ROW_LIMIT = 1;
    const MAX_ROW_LIMIT = 5000;
    let rowLimit = DEFAULT_ROW_LIMIT;
    if (process.env.ROW_LIMIT) {
      const parsed = Number.parseInt(process.env.ROW_LIMIT, 10);
      if (Number.isFinite(parsed) && parsed >= MIN_ROW_LIMIT && parsed <= MAX_ROW_LIMIT) {
        rowLimit = parsed;
      }
    }
    const innerSelect = `SELECT *, ctid as __ctid FROM ${ident} LIMIT ${rowLimit}`;
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

      // Fetch all columns to include in the data (needed for color gradients)
      const allColsQ = await pool.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
        [schema, table]
      );
      const allCols = allColsQ.rows.map(r => r.column_name);

      // Build select list: id (pk or ctid) + all non-geometry columns + each geom column as GeoJSON
      const selectParts = [];
      if (pkCol) {
        selectParts.push(`${quoteIdent(pkCol)} as id`);
      } else {
        selectParts.push(`ctid::text as id`);
      }

      // Add all non-geometry columns
      allCols.forEach(col => {
        if (col === pkCol || geomCols.includes(col)) return; // skip pk and geom cols (handle separately)
        selectParts.push(`${quoteIdent(col)}`);
      });

      // Add geometry columns as GeoJSON
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

// Proxy WMS GetMap requests into XYZ tiles: /wms/tile/:z/:x/:y?wms=<base>&layers=<layers>&format=...
// Converts tile z/x/y to WGS84 bbox and forwards the request to the WMS server (VERSION=1.1.1, SRS=EPSG:4326)
const http = require('http');
const https = require('https');

function tile2bbox(z, x, y, options) {
  // options: { crs: 'EPSG:4326'|'EPSG:3857', version: '1.1.1'|'1.3.0' }
  const n = Math.pow(2, z);
  const lon_left = x / n * 360.0 - 180.0;
  const lon_right = (x + 1) / n * 360.0 - 180.0;
  const lat_rad_top = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n)));
  const lat_rad_bottom = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / n)));
  const lat_top = lat_rad_top * 180.0 / Math.PI;
  const lat_bottom = lat_rad_bottom * 180.0 / Math.PI;

  const crs = options && options.crs ? options.crs : 'EPSG:4326';
  const version = options && options.version ? options.version : '1.1.1';

  if (crs === 'EPSG:3857') {
    // convert lon/lat to WebMercator meters
    function lonToX(lon) { return lon * 20037508.34 / 180.0; }
    function latToY(lat) {
      const rad = lat * Math.PI / 180.0;
      return Math.log(Math.tan((Math.PI / 4) + (rad / 2))) * 20037508.34 / Math.PI;
    }
    const minx = lonToX(lon_left);
    const maxx = lonToX(lon_right);
    const miny = latToY(lat_bottom);
    const maxy = latToY(lat_top);
    return [minx, miny, maxx, maxy];
  }

  // default EPSG:4326
  // For WMS 1.3.0 with EPSG:4326 the axis order is lat,lon (y,x)
  if (version === '1.3.0') {
    return [lat_bottom, lon_left, lat_top, lon_right];
  }
  return [lon_left, lat_bottom, lon_right, lat_top];
}

app.get('/wms/tile/:z/:x/:y', async (req, res) => {
  try {
    const { z, x, y } = req.params;
    const base = req.query.wms;
    if (!base) return res.status(400).send('missing wms param');
    const layers = req.query.layers || req.query.LAYERS || '';
    const format = req.query.format || req.query.FORMAT || 'image/png';
    const width = req.query.width || 256;
    const height = req.query.height || 256;

    const version = req.query.version || req.query.VERSION || '1.1.1';
    const crs = req.query.crs || req.query.CRS || req.query.srs || req.query.SRS || 'EPSG:4326';

    const bboxArr = tile2bbox(Number(z), Number(x), Number(y), { crs, version });
    const bboxStr = `${bboxArr[0]},${bboxArr[1]},${bboxArr[2]},${bboxArr[3]}`;

    // Build WMS GetMap URL
    const separator = base.includes('?') ? '&' : '?';
    // choose parameter name for CRS based on WMS version
    const crsParamName = (version === '1.3.0') ? 'CRS' : 'SRS';
    const params = `SERVICE=WMS&REQUEST=GetMap&VERSION=${encodeURIComponent(version)}&FORMAT=${encodeURIComponent(format)}&TRANSPARENT=true&${crsParamName}=${encodeURIComponent(crs)}&BBOX=${encodeURIComponent(bboxStr)}&WIDTH=${width}&HEIGHT=${height}&LAYERS=${encodeURIComponent(layers)}`;
    const finalUrl = base + separator + params;

    const lib = finalUrl.startsWith('https') ? https : http;
    const prox = lib.get(finalUrl, (proxRes) => {
      res.statusCode = proxRes.statusCode || 200;
      // copy content-type
      if (proxRes.headers['content-type']) res.setHeader('Content-Type', proxRes.headers['content-type']);
      // pipe
      proxRes.pipe(res);
    });
    prox.on('error', (e) => {
      console.error('WMS proxy error', e && e.message);
      res.status(502).send('WMS proxy error');
    });
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

// Get a single feature by table and id
app.get('/feature/:table/:id', async (req, res) => {
  const { table, id } = req.params;
  try {
    let schema = 'public';
    let tbl = table;
    if (table.includes('.')) {
      const parts = table.split('.');
      schema = parts[0];
      tbl = parts[1];
    }

    // Find geometry column
    const geomRow = await pool.query(
      `SELECT f_geometry_column FROM public.geometry_columns WHERE f_table_schema = $1 AND f_table_name = $2 LIMIT 1`,
      [schema, tbl]
    );
    if (geomRow.rowCount === 0) {
      const geomFind = await pool.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND udt_name = 'geometry' LIMIT 1`,
        [schema, tbl]
      );
      if (geomFind.rowCount === 0) {
        return res.status(404).json({ error: 'Table not found or has no geometry' });
      }
      var geomCol = geomFind.rows[0].column_name;
    } else {
      var geomCol = geomRow.rows[0].f_geometry_column;
    }

    // Find primary key
    const pk = await pool.query(
      `SELECT kcu.column_name FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = $1 AND tc.table_name = $2 LIMIT 1`,
      [schema, tbl]
    );
    let idCol = null;
    if (pk.rowCount > 0) {
      idCol = pk.rows[0].column_name;
    }

    const ident = `${quoteIdent(schema)}.${quoteIdent(tbl)}`;
    const geomIdent = quoteIdent(geomCol);

    let whereClause;
    if (idCol) {
      whereClause = `${quoteIdent(idCol)} = $1`;
    } else {
      whereClause = `ctid = $1`;
    }

    const q = `SELECT *, ST_AsGeoJSON(ST_Transform(${geomIdent}, 4326))::json AS geometry_json FROM ${ident} WHERE ${whereClause} LIMIT 1`;

    const result = await pool.query(q, [id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Feature not found' });
    }

    const row = result.rows[0];
    const properties = { ...row };
    delete properties[geomCol];
    delete properties.geometry_json;

    const feature = {
      type: 'Feature',
      id: id,
      geometry: row.geometry_json,
      properties: properties
    };

    res.json(feature);
  } catch (err) {
    console.error('Error fetching feature:', err);
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
