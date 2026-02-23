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

async function resolveSchemaForTable(schema, table) {
  const exact = await pool.query(
    `SELECT table_schema FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2 LIMIT 1`,
    [schema, table]
  );
  if (exact.rowCount > 0) return schema;

  const anySchema = await pool.query(
    `SELECT table_schema FROM information_schema.tables WHERE table_name = $1 ORDER BY table_schema LIMIT 1`,
    [table]
  );
  if (anySchema.rowCount > 0) return anySchema.rows[0].table_schema;

  throw new Error(`Table not found: ${schema}.${table}`);
}

async function assertColumnExists(schema, table, column) {
  const r = await pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = $3 LIMIT 1`,
    [schema, table, column]
  );
  if (r.rowCount === 0) throw new Error(`Column not found: ${schema}.${table}.${column}`);
}

function getFylkeConfig(req) {
  return {
    nameSchema: req.query.name_schema || process.env.FYLKE_NAME_SCHEMA || 'fylker',
    nameTable: req.query.name_table || process.env.FYLKE_NAME_TABLE || 'administrativenhetsnavn',
    nameColumn: req.query.name_col || process.env.FYLKE_NAME_COL || 'navn',
    geomSchema: req.query.geom_schema || process.env.FYLKE_GEOM_SCHEMA || 'fylker',
    geomTable: req.query.geom_table || process.env.FYLKE_GEOM_TABLE || 'grense',
    geomColumn: req.query.geom_col || process.env.FYLKE_GEOM_COL || 'grense',
    joinColumn: req.query.join_col || process.env.FYLKE_JOIN_COL || 'id',
    geomNameColumn: req.query.geom_name_col || process.env.FYLKE_GEOM_NAME_COL || null,
    nameMatchMode: req.query.name_match || process.env.FYLKE_NAME_MATCH || 'join',
  };
}

function getBrannConfig(req) {
  return {
    brannSchema: req.query.brann_schema || process.env.BRANN_SCHEMA || 'brannstasjoner',
    brannTable: req.query.brann_table || process.env.BRANN_TABLE || 'brannstasjon',
    brannGeomColumn: req.query.brann_geom_col || process.env.BRANN_GEOM_COL || 'posisjon',
  };
}

async function getFirstGeomColumn(schema, table) {
  const q = `SELECT f_geometry_column FROM public.geometry_columns WHERE f_table_schema = $1 AND f_table_name = $2 LIMIT 1`;
  const r = await pool.query(q, [schema, table]);
  return r.rowCount > 0 ? r.rows[0].f_geometry_column : null;
}

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

//Romlig SQL som viser objekter innen 1km
app.get('/analysis/near', async (req, res) => {
    const { table, lon, lat, distance } = req.query;

    try {
        const query = `
      SELECT *
      FROM ${tilfluktsromoffentlige.tilfluktsrom}
      WHERE ST_DWithin(
        posisjon,
        ST_Transform(
        ST_SetSRID(ST_MakePoint(10.75, 59.91), 4326)::geography,
        25833
      ),
      1000  
    `;

        const result = await pool.query(query, [lon, lat, distance]);
        res.json(result.rows);

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// Filter tilfluktsrom by minimum plasser and return GeoJSON
app.get('/analysis/tilfluktsrom-min', async (req, res) => {
  const minPlasser = Number(req.query.min_plasser) || 500;
  const schema = 'tilfluktsromoffentlige';
  const table = 'tilfluktsrom';

  try {
    const geomCol = await getFirstGeomColumn(schema, table);
    if (!geomCol) {
      return res.status(404).json({ error: 'Geometry column not found for tilfluktsrom' });
    }

    const q = `
      SELECT json_build_object(
        'type', 'FeatureCollection',
        'features', COALESCE(json_agg(
          json_build_object(
            'type', 'Feature',
            'geometry', ST_AsGeoJSON(ST_Transform(${quoteIdent(geomCol)}, 4326))::json,
            'properties', to_jsonb(row) - $2
          )
        ), '[]'::json)
      ) AS geojson
      FROM ${quoteIdent(schema)}.${quoteIdent(table)} row
      WHERE plasser >= $1;
    `;

    const result = await pool.query(q, [minPlasser, geomCol]);
    res.json(result.rows[0].geojson);
  } catch (err) {
    console.error('tilfluktsrom-min failed', err && err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// List fylker for dropdown
app.get('/analysis/fylke-list', async (req, res) => {
  const cfg = getFylkeConfig(req);
  try {
    const nameSchema = await resolveSchemaForTable(cfg.nameSchema, cfg.nameTable);
    const geomSchema = await resolveSchemaForTable(cfg.geomSchema, cfg.geomTable);

    await assertColumnExists(nameSchema, cfg.nameTable, cfg.nameColumn);
    const isSameTable = (geomSchema === nameSchema && cfg.geomTable === cfg.nameTable);
    const useNameMatch = cfg.nameMatchMode && cfg.nameMatchMode !== 'join';
    if (!isSameTable) {
      if (useNameMatch) {
        if (!cfg.geomNameColumn) throw new Error('Missing geom_name_col for name matching');
        await assertColumnExists(geomSchema, cfg.geomTable, cfg.geomNameColumn);
      } else {
        await assertColumnExists(nameSchema, cfg.nameTable, cfg.joinColumn);
        await assertColumnExists(geomSchema, cfg.geomTable, cfg.joinColumn);
      }
    }

    const nameIdent = `${quoteIdent(nameSchema)}.${quoteIdent(cfg.nameTable)}`;
    let fromSql = `${nameIdent} n`;
    if (!isSameTable) {
      const geomIdent = `${quoteIdent(geomSchema)}.${quoteIdent(cfg.geomTable)}`;
      if (useNameMatch) {
        const nameExpr = `LOWER(n.${quoteIdent(cfg.nameColumn)})`;
        const geomNameExpr = `LOWER(g.${quoteIdent(cfg.geomNameColumn)})`;
        const matchSql = (cfg.nameMatchMode === 'equals')
          ? `${geomNameExpr} = ${nameExpr}`
          : `${geomNameExpr} LIKE '%' || ${nameExpr} || '%'`;
        fromSql = `${nameIdent} n JOIN ${geomIdent} g ON ${matchSql}`;
      } else {
        fromSql = `${nameIdent} n JOIN ${geomIdent} g ON n.${quoteIdent(cfg.joinColumn)} = g.${quoteIdent(cfg.joinColumn)}`;
      }
    }

    const q = `SELECT DISTINCT n.${quoteIdent(cfg.nameColumn)} AS name
               FROM ${fromSql}
               WHERE n.${quoteIdent(cfg.nameColumn)} IS NOT NULL
               ORDER BY n.${quoteIdent(cfg.nameColumn)}`;
    const r = await pool.query(q);
    res.json({ names: r.rows.map(row => row.name) });
  } catch (err) {
    console.error('fylke-list failed', err && err.message);
    res.status(500).json({ error: err.message || 'Database error' });
  }
});

// Discover candidate tables for fylke configuration
app.get('/analysis/fylke-discover', async (req, res) => {
  try {
    const nameCols = await pool.query(
      `SELECT table_schema, table_name, array_agg(column_name ORDER BY column_name) AS columns
       FROM information_schema.columns
       WHERE column_name ILIKE 'navn'
       GROUP BY table_schema, table_name
       ORDER BY table_schema, table_name`
    );

    const geomCols = await pool.query(
      `SELECT table_schema, table_name, array_agg(column_name ORDER BY column_name) AS geom_columns
       FROM information_schema.columns
       WHERE udt_name IN ('geometry','geography')
       GROUP BY table_schema, table_name
       ORDER BY table_schema, table_name`
    );

    const nameSet = new Map();
    nameCols.rows.forEach(r => { nameSet.set(`${r.table_schema}.${r.table_name}`, r.columns); });

    const geomSet = new Map();
    geomCols.rows.forEach(r => { geomSet.set(`${r.table_schema}.${r.table_name}`, r.geom_columns); });

    const tablesWithBoth = [];
    for (const [key, cols] of nameSet.entries()) {
      if (geomSet.has(key)) {
        tablesWithBoth.push({
          table: key,
          name_columns: cols,
          geom_columns: geomSet.get(key),
        });
      }
    }

    res.json({
      name_tables: nameCols.rows,
      geom_tables: geomCols.rows,
      tables_with_both: tablesWithBoth,
    });
  } catch (err) {
    console.error('fylke-discover failed', err && err.message);
    res.status(500).json({ error: err.message || 'Database error' });
  }
});

// Outline a fylke as GeoJSON
app.get('/analysis/fylke-outline', async (req, res) => {
  const fylkeName = req.query.fylke_name;
  if (!fylkeName) return res.status(400).json({ error: 'Missing fylke_name' });
  const cfg = getFylkeConfig(req);
  try {
    const nameSchema = await resolveSchemaForTable(cfg.nameSchema, cfg.nameTable);
    const geomSchema = await resolveSchemaForTable(cfg.geomSchema, cfg.geomTable);

    await assertColumnExists(nameSchema, cfg.nameTable, cfg.nameColumn);
    await assertColumnExists(geomSchema, cfg.geomTable, cfg.geomColumn);
    const isSameTable = (geomSchema === nameSchema && cfg.geomTable === cfg.nameTable);
    const useNameMatch = cfg.nameMatchMode && cfg.nameMatchMode !== 'join';
    if (!isSameTable) {
      if (useNameMatch) {
        if (!cfg.geomNameColumn) throw new Error('Missing geom_name_col for name matching');
        await assertColumnExists(geomSchema, cfg.geomTable, cfg.geomNameColumn);
      } else {
        await assertColumnExists(nameSchema, cfg.nameTable, cfg.joinColumn);
        await assertColumnExists(geomSchema, cfg.geomTable, cfg.joinColumn);
      }
    }

    const nameIdent = `${quoteIdent(nameSchema)}.${quoteIdent(cfg.nameTable)}`;
    const geomIdent = `${quoteIdent(geomSchema)}.${quoteIdent(cfg.geomTable)}`;
    const nameCol = `n.${quoteIdent(cfg.nameColumn)}`;
    const geomCol = `g.${quoteIdent(cfg.geomColumn)}`;

    let fromSql = `${nameIdent} n`;
    if (!isSameTable) {
      if (useNameMatch) {
        const nameExpr = `LOWER(n.${quoteIdent(cfg.nameColumn)})`;
        const geomNameExpr = `LOWER(g.${quoteIdent(cfg.geomNameColumn)})`;
        const matchSql = (cfg.nameMatchMode === 'equals')
          ? `${geomNameExpr} = ${nameExpr}`
          : `${geomNameExpr} LIKE '%' || ${nameExpr} || '%'`;
        fromSql = `${nameIdent} n JOIN ${geomIdent} g ON ${matchSql}`;
      } else {
        fromSql = `${nameIdent} n JOIN ${geomIdent} g ON n.${quoteIdent(cfg.joinColumn)} = g.${quoteIdent(cfg.joinColumn)}`;
      }
    }

    const q = `
      SELECT json_build_object(
        'type', 'FeatureCollection',
        'features', COALESCE(json_agg(
          json_build_object(
            'type', 'Feature',
            'geometry', ST_AsGeoJSON(ST_Transform(${geomCol}, 4326))::json,
            'properties', to_jsonb(n) - $2
          )
        ), '[]'::json)
      ) AS geojson
      FROM ${fromSql}
      WHERE ${nameCol} = $1;
    `;

    const r = await pool.query(q, [fylkeName, cfg.geomColumn]);
    res.json(r.rows[0].geojson);
  } catch (err) {
    console.error('fylke-outline failed', err && err.message);
    res.status(500).json({ error: err.message || 'Database error' });
  }
});

// Return brannstasjoner inside a fylke
app.get('/analysis/brannstasjoner-in-fylke', async (req, res) => {
  const fylkeName = req.query.fylke_name;
  if (!fylkeName) return res.status(400).json({ error: 'Missing fylke_name' });
  const fylkeCfg = getFylkeConfig(req);
  const brannCfg = getBrannConfig(req);

  try {
    const nameSchema = await resolveSchemaForTable(fylkeCfg.nameSchema, fylkeCfg.nameTable);
    const geomSchema = await resolveSchemaForTable(fylkeCfg.geomSchema, fylkeCfg.geomTable);
    const brannSchema = await resolveSchemaForTable(brannCfg.brannSchema, brannCfg.brannTable);

    await assertColumnExists(nameSchema, fylkeCfg.nameTable, fylkeCfg.nameColumn);
    await assertColumnExists(geomSchema, fylkeCfg.geomTable, fylkeCfg.geomColumn);
    const isSameTable = (geomSchema === nameSchema && fylkeCfg.geomTable === fylkeCfg.nameTable);
    const useNameMatch = fylkeCfg.nameMatchMode && fylkeCfg.nameMatchMode !== 'join';
    if (!isSameTable) {
      if (useNameMatch) {
        if (!fylkeCfg.geomNameColumn) throw new Error('Missing geom_name_col for name matching');
        await assertColumnExists(geomSchema, fylkeCfg.geomTable, fylkeCfg.geomNameColumn);
      } else {
        await assertColumnExists(nameSchema, fylkeCfg.nameTable, fylkeCfg.joinColumn);
        await assertColumnExists(geomSchema, fylkeCfg.geomTable, fylkeCfg.joinColumn);
      }
    }
    await assertColumnExists(brannSchema, brannCfg.brannTable, brannCfg.brannGeomColumn);

    const nameIdent = `${quoteIdent(nameSchema)}.${quoteIdent(fylkeCfg.nameTable)}`;
    const geomIdent = `${quoteIdent(geomSchema)}.${quoteIdent(fylkeCfg.geomTable)}`;
    const nameCol = `n.${quoteIdent(fylkeCfg.nameColumn)}`;
    const geomCol = `g.${quoteIdent(fylkeCfg.geomColumn)}`;

    let fromSql = `${nameIdent} n`;
    if (!isSameTable) {
      if (useNameMatch) {
        const nameExpr = `LOWER(n.${quoteIdent(fylkeCfg.nameColumn)})`;
        const geomNameExpr = `LOWER(g.${quoteIdent(fylkeCfg.geomNameColumn)})`;
        const matchSql = (fylkeCfg.nameMatchMode === 'equals')
          ? `${geomNameExpr} = ${nameExpr}`
          : `${geomNameExpr} LIKE '%' || ${nameExpr} || '%'`;
        fromSql = `${nameIdent} n JOIN ${geomIdent} g ON ${matchSql}`;
      } else {
        fromSql = `${nameIdent} n JOIN ${geomIdent} g ON n.${quoteIdent(fylkeCfg.joinColumn)} = g.${quoteIdent(fylkeCfg.joinColumn)}`;
      }
    }

    const brannIdent = `${quoteIdent(brannSchema)}.${quoteIdent(brannCfg.brannTable)}`;
    const brannGeom = `b.${quoteIdent(brannCfg.brannGeomColumn)}`;

    const q = `
      WITH fylke AS (
        SELECT ${geomCol} AS geom
        FROM ${fromSql}
        WHERE ${nameCol} = $1
      )
      SELECT json_build_object(
        'type', 'FeatureCollection',
        'features', COALESCE(json_agg(
          json_build_object(
            'type', 'Feature',
            'geometry', ST_AsGeoJSON(ST_Transform(${brannGeom}, 4326))::json,
            'properties', to_jsonb(b) - $2
          )
        ), '[]'::json)
      ) AS geojson
      FROM ${brannIdent} b
      WHERE EXISTS (
        SELECT 1 FROM fylke f
        WHERE ST_Within(ST_Transform(${brannGeom}, 4326), ST_Transform(f.geom, 4326))
      );
    `;

    const r = await pool.query(q, [fylkeName, brannCfg.brannGeomColumn]);
    res.json(r.rows[0].geojson);
  } catch (err) {
    console.error('brannstasjoner-in-fylke failed', err && err.message);
    res.status(500).json({ error: err.message || 'Database error' });
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

