const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const axios = require('axios');
const AdmZip = require('adm-zip');
const { v4: uuidv4 } = require('uuid');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// Database configuration
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:password@postgres:5432/gis'
});

// Cache directory for downloaded data
const CACHE_DIR = '/tmp/geonorge_cache';
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

// ========== DATA BOOTSTRAP UTILITIES ==========

async function downloadBuffer(url, timeout = 300000) {
  try {
    const response = await axios.get(url, { 
      timeout, 
      responseType: 'arraybuffer',
      headers: { 'User-Agent': 'Beredskapskart/1.0' }
    });
    return Buffer.from(response.data);
  } catch (error) {
    console.error(`Download failed for ${url}:`, error.message);
    throw error;
  }
}

async function extractGeoJsonFromZip(buffer) {
  try {
    const zip = new AdmZip(buffer);
    const entries = zip.getEntries();
    
    let bestCandidate = null;
    let maxFeatures = 0;
    
    for (const entry of entries) {
      const lowerName = entry.name.toLowerCase();
      if (entry.isDirectory || (!lowerName.endsWith('.json') && !lowerName.endsWith('.geojson'))) continue;
      try {
        const content = entry.getData().toString('utf8');
        const json = JSON.parse(content);
        if (json.features && Array.isArray(json.features)) {
          if (json.features.length > maxFeatures) {
            bestCandidate = json;
            maxFeatures = json.features.length;
          }
        }
      } catch (e) {
        // continue on parse error
      }
    }
    
    return bestCandidate || { type: 'FeatureCollection', features: [] };
  } catch (error) {
    console.error('ZIP extraction error:', error.message);
    return { type: 'FeatureCollection', features: [] };
  }
}

async function cacheGeoJsonFromZip(layer, url) {
  const cacheFile = path.join(CACHE_DIR, `${layer}.geojson`);
  
  if (fs.existsSync(cacheFile)) {
    try {
      return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    } catch (e) {
      fs.unlinkSync(cacheFile); // delete corrupt cache
    }
  }
  
  try {
    console.log(`Downloading ${layer} from ${url.substring(0, 60)}...`);
    const buffer = await downloadBuffer(url);
    const geojson = await extractGeoJsonFromZip(buffer);
    fs.writeFileSync(cacheFile, JSON.stringify(geojson));
    return geojson;
  } catch (error) {
    console.error(`Failed to cache ${layer}:`, error.message);
    return { type: 'FeatureCollection', features: [] };
  }
}

function firstCoordinate(geometry) {
  if (!geometry) return null;
  const coords = geometry.coordinates;
  if (!coords) return null;
  
  if (geometry.type === 'Point') return coords;
  if (geometry.type === 'LineString' || geometry.type === 'MultiPoint') return coords[0];
  if (geometry.type === 'Polygon' || geometry.type === 'MultiLineString') return coords[0][0];
  if (geometry.type === 'MultiPolygon') return coords[0][0][0];
  return null;
}

function looksProjected(coord) {
  if (!coord || coord.length < 2) return false;
  const [lon, lat] = coord;
  return lon < -180 || lon > 180 || lat < -90 || lat > 90;
}

function getPropIgnoreCase(properties, candidates) {
  if (!properties || typeof properties !== 'object') return undefined;
  const map = {};
  Object.keys(properties).forEach((k) => {
    map[String(k).toLowerCase()] = properties[k];
  });
  for (const key of candidates) {
    const value = map[String(key).toLowerCase()];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function parseNumber(value, fallback = 0) {
  if (value === undefined || value === null) return fallback;
  const normalized = String(value).replace(/\s/g, '').replace(',', '.');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function transformProjectedFeatureCollection(geojson) {
  if (!geojson.features || geojson.features.length === 0) return geojson;
  
  const firstCoord = firstCoordinate(geojson.features[0].geometry);
  if (!firstCoord || !looksProjected(firstCoord)) return geojson; // already correct
  
  try {
    console.log('Transforming projected coordinates via PostGIS...');
    const transformed = {
      type: 'FeatureCollection',
      features: []
    };
    
    for (const feature of geojson.features) {
      try {
        const geomJson = JSON.stringify(feature.geometry);
        const result = await pool.query(
          `SELECT ST_AsGeoJSON(ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON($1), 25833), 4326))::json AS geom`,
          [geomJson]
        );
        
        if (result.rows[0] && result.rows[0].geom) {
          transformed.features.push({
            ...feature,
            geometry: result.rows[0].geom
          });
        }
      } catch (e) {
        console.error('Transform error for feature:', e.message);
      }
    }

    return transformed.features.length > 0 ? transformed : geojson;
  } catch (error) {
    console.error('PostGIS transform failed:', error.message);
    return geojson;
  }
}

// ========== DATABASE INITIALIZATION ==========

async function initSchema() {
  try {
    // Enable PostGIS
    await pool.query('CREATE EXTENSION IF NOT EXISTS postgis');
    
    // Create schema if doesn't exist
    await pool.query('CREATE SCHEMA IF NOT EXISTS tilfluktsromoffentlige');
    
    // Create shelters table (tilfluktsrom)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tilfluktsromoffentlige.tilfluktsrom (
        id SERIAL PRIMARY KEY,
        shelter_id VARCHAR(100) UNIQUE,
        name VARCHAR(255),
        capacity INT,
        location GEOMETRY(Point, 4326),
        raw_properties JSONB
      )
    `);
    
    // Create spatial index
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_tilfluktsrom_location ON tilfluktsromoffentlige.tilfluktsrom USING GIST(location)
    `);
    
    // Create population grid table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS public.population_cells (
        id SERIAL PRIMARY KEY,
        population INT,
        location GEOMETRY(Point, 4326)
      )
    `);
    
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_population_location ON public.population_cells USING GIST(location)
    `);
    
    // Create users table for tracking
    await pool.query(`
      CREATE TABLE IF NOT EXISTS public.app_users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        created_at TIMESTAMP DEFAULT NOW(),
        opt_tracking BOOLEAN DEFAULT false
      )
    `);
    
    // Create user locations table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS public.user_locations (
        id SERIAL PRIMARY KEY,
        user_id UUID REFERENCES public.app_users(id),
        location GEOMETRY(Point, 4326),
        timestamp TIMESTAMP DEFAULT NOW()
      )
    `);
    
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_user_locations_user_id ON public.user_locations(user_id)
    `);
    
    console.log('✓ Database schema initialized');
  } catch (error) {
    console.error('Schema init error:', error.message);
  }
}

// ========== DATA INGESTION ==========

async function ingestShelters(geojson) {
  if (!geojson.features) return 0;
  
  let inserted = 0;
  for (const feature of geojson.features) {
    try {
      const { properties, geometry } = feature;
      const coord = firstCoordinate(geometry);
      if (!coord || coord.length < 2) continue;
      const lon = Number(coord[0]);
      const lat = Number(coord[1]);
      const stableId = `${lon.toFixed(6)}_${lat.toFixed(6)}`;

      const shelter_id = String(
        getPropIgnoreCase(properties, ['id', 'shelter_id', 'objid', 'lokalid']) || stableId
      );
      const name = String(
        getPropIgnoreCase(properties, ['name', 'navn', 'tilfluktsromnavn']) || 'Tilfluktsrom'
      );
      const capacity = Math.max(0, Math.round(parseNumber(
        getPropIgnoreCase(properties, ['capacity', 'kapasitet', 'plasser', 'antall', 'personer']),
        0
      )));
      
      if (Number.isFinite(lon) && Number.isFinite(lat)) {
        await pool.query(`
          INSERT INTO tilfluktsromoffentlige.tilfluktsrom (shelter_id, name, capacity, location, raw_properties)
          VALUES ($1, $2, $3, ST_SetSRID(ST_MakePoint($4, $5), 4326), $6)
          ON CONFLICT (shelter_id) DO UPDATE SET 
            name = EXCLUDED.name,
            capacity = EXCLUDED.capacity,
            location = EXCLUDED.location,
            raw_properties = EXCLUDED.raw_properties
        `, [shelter_id, name, capacity, lon, lat, JSON.stringify(properties)]);
        
        inserted++;
      }
    } catch (error) {
      console.error('Ingest shelter error:', error.message);
    }
  }
  
  return inserted;
}

async function ingestPopulation(geojson) {
  if (!geojson.features) return 0;
  
  let inserted = 0;
  for (const feature of geojson.features) {
    try {
      const { properties, geometry } = feature;
      const population = Math.max(0, Math.round(parseNumber(
        getPropIgnoreCase(properties, ['population', 'befolkning', 'personer', 'antall']),
        0
      )));
      if (population <= 0) continue;

      const coord = firstCoordinate(geometry);
      if (coord && coord.length >= 2) {
        const lon = Number(coord[0]);
        const lat = Number(coord[1]);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
        
        await pool.query(`
          INSERT INTO public.population_cells (population, location)
          VALUES ($1, ST_SetSRID(ST_MakePoint($2, $3), 4326))
        `, [population, lon, lat]);
        
        inserted++;
      }
    } catch (error) {
      console.error('Ingest population error:', error.message);
    }
  }
  
  return inserted;
}

async function generateSyntheticPopulation() {
  try {
    // Generate population grid around shelters
    const shelters = await pool.query(`
      SELECT ST_X(location) AS lon, ST_Y(location) AS lat
      FROM tilfluktsromoffentlige.tilfluktsrom
      WHERE location IS NOT NULL
    `);
    
    for (const s of shelters.rows) {
      const lon = Number(s.lon);
      const lat = Number(s.lat);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      
      // Generate ~20 points in a 5km radius
      for (let i = 0; i < 20; i++) {
        const angle = Math.random() * Math.PI * 2;
        const distance = Math.random() * 0.05; // ~5km at equator
        const newLon = lon + distance * Math.cos(angle);
        const newLat = lat + distance * Math.sin(angle);
        const population = Math.floor(Math.random() * 200) + 50;
        
        await pool.query(`
          INSERT INTO public.population_cells (population, location)
          VALUES ($1, ST_SetSRID(ST_MakePoint($2, $3), 4326))
        `, [population, newLon, newLat]);
      }
    }
    
    console.log('✓ Synthetic population generated');
  } catch (error) {
    console.error('Synthetic population error:', error.message);
  }
}

async function bootstrap() {
  const checkFile = path.join(CACHE_DIR, '.bootstrapped');
  if (fs.existsSync(checkFile)) {
    console.log('Data already initialized, skipping remote bootstrap.');
    return;
  }
  
  console.log('🚀 Starting data bootstrap...');
  
  await initSchema();
  
  // Download and ingest shelters
  try {
    console.log('Downloading shelters...');
    const sheltersGeo = await cacheGeoJsonFromZip('shelters', 
      'https://nedlasting.geonorge.no/geonorge/Samfunnssikkerhet/TilfluktsromOffentlige/GeoJSON/Samfunnssikkerhet_0000_Norge_25833_TilfluktsromOffentlige_GeoJSON.zip');
    const transformed = await transformProjectedFeatureCollection(sheltersGeo);
    const count = await ingestShelters(transformed);
    console.log(`✓ Shelters ingested: ${count}`);
  } catch (error) {
    console.error('Shelters bootstrap failed:', error.message);
  }
  
  // Download and ingest population
  try {
    console.log('Downloading population...');
    const popGeo = await cacheGeoJsonFromZip('population',
      'https://nedlasting.geonorge.no/geonorge/Befolkning/BefolkningPaGrunnkretsniva2025/GML/Befolkning_0000_Norge_25833_BefolkningPaGrunnkretsniva2025_GML.zip');
    const transformed = await transformProjectedFeatureCollection(popGeo);
    const count = await ingestPopulation(transformed);
    if (count > 0) {
      console.log(`✓ Population ingested: ${count}`);
    } else {
      console.log('Population source returned zero rows, generating synthetic population fallback...');
      await generateSyntheticPopulation();
    }
  } catch (error) {
    console.error('Population bootstrap failed, generating synthetic:', error.message);
    await generateSyntheticPopulation();
  }

  // Cache counties and municipalities as GeoJSON layers for frontend toggles
  try {
    const counties = await cacheGeoJsonFromZip(
      'counties',
      'https://nedlasting.geonorge.no/geonorge/Basisdata/Fylker/GeoJSON/Basisdata_0000_Norge_25833_Fylker_GeoJSON.zip'
    );
    const countiesWgs84 = await transformProjectedFeatureCollection(counties);
    fs.writeFileSync(path.join(CACHE_DIR, 'counties.geojson'), JSON.stringify(countiesWgs84));
    console.log(`✓ Counties cached: ${(countiesWgs84.features || []).length}`);
  } catch (error) {
    console.error('Counties cache failed:', error.message);
  }

  try {
    const municipalities = await cacheGeoJsonFromZip(
      'municipalities',
      'https://nedlasting.geonorge.no/geonorge/Basisdata/Kommuner/GeoJSON/Basisdata_0000_Norge_25833_Kommuner_GeoJSON.zip'
    );
    const municipalitiesWgs84 = await transformProjectedFeatureCollection(municipalities);
    fs.writeFileSync(path.join(CACHE_DIR, 'municipalities.geojson'), JSON.stringify(municipalitiesWgs84));
    console.log(`✓ Municipalities cached: ${(municipalitiesWgs84.features || []).length}`);
  } catch (error) {
    console.error('Municipalities cache failed:', error.message);
  }
  
  fs.writeFileSync(checkFile, Date.now().toString());
  console.log('✓ Bootstrap complete');
}

// ========== API ENDPOINTS ==========

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, bootstrapReady: true });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Admin: compute coverage statistics within radius
app.get('/api/admin/coverage', async (req, res) => {
  try {
    const radius = parseInt(req.query.radius) || 1000;
    
    const result = await pool.query(`
      SELECT 
        s.id,
        s.shelter_id,
        s.name,
        s.capacity,
        ST_X(s.location) AS lon,
        ST_Y(s.location) AS lat,
        COALESCE(COUNT(p.id), 0) AS population_within_radius,
        COALESCE(SUM(p.population), 0) AS population_sum,
        CASE WHEN s.capacity >= COALESCE(SUM(p.population), 0) THEN true ELSE false END AS enough_capacity,
        GREATEST(0, COALESCE(SUM(p.population), 0) - s.capacity) AS missing_capacity
      FROM tilfluktsromoffentlige.tilfluktsrom s
      LEFT JOIN public.population_cells p ON ST_DWithin(s.location, p.location, $1)
      GROUP BY s.id, s.shelter_id, s.name, s.capacity, s.location
      ORDER BY s.id
    `, [radius]);
    
    const shelters = result.rows;
    const totalCovered = shelters.reduce((sum, s) => sum + Number(s.population_sum || 0), 0);
    const totalCapacity = shelters.reduce((sum, s) => sum + Number(s.capacity || 0), 0);
    const totalMissing = shelters.reduce((sum, s) => sum + Number(s.missing_capacity || 0), 0);
    const adequateShelters = shelters.filter(s => s.enough_capacity).length;
    
    res.json({
      radius,
      summary: {
        total_shelters: shelters.length,
        adequate_shelters: adequateShelters,
        total_capacity: totalCapacity,
        total_population_within_radius: totalCovered,
        coverage_percent: totalCovered > 0 ? Math.round((totalCapacity / totalCovered) * 100) : 0,
        total_missing_capacity: totalMissing
      },
      shelters
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: export coverage data to CSV
app.get('/api/admin/export/csv', async (req, res) => {
  try {
    const radius = parseInt(req.query.radius) || 1000;
    
    const result = await pool.query(`
      SELECT 
        s.shelter_id,
        s.name,
        s.capacity,
        ST_X(s.location) AS lon,
        ST_Y(s.location) AS lat,
        COALESCE(SUM(p.population), 0) AS population_sum,
        CASE WHEN s.capacity >= COALESCE(SUM(p.population), 0) THEN 'Ja' ELSE 'Nei' END AS enough_capacity,
        GREATEST(0, COALESCE(SUM(p.population), 0) - s.capacity) AS missing_capacity
      FROM tilfluktsromoffentlige.tilfluktsrom s
      LEFT JOIN public.population_cells p ON ST_DWithin(s.location, p.location, $1)
      GROUP BY s.id, s.shelter_id, s.name, s.capacity, s.location
      ORDER BY s.id
    `, [radius]);
    
    const csv = [
      'Tilfluktsrom ID,Navn,Kapasitet,Lon,Lat,Befolkning i Radius,Tilstrekkelig Kapasitet,Manglende Kapasitet'
    ];
    
    result.rows.forEach(row => {
      csv.push([
        row.shelter_id,
        `"${row.name}"`,
        row.capacity,
        row.lon.toFixed(6),
        row.lat.toFixed(6),
        row.population_sum,
        row.enough_capacity,
        row.missing_capacity
      ].join(','));
    });
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="coverage-${radius}m.csv"`);
    res.send(csv.join('\n'));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: export to XLSX
app.get('/api/admin/export/xlsx', async (req, res) => {
  try {
    const radius = parseInt(req.query.radius) || 1000;
    
    const result = await pool.query(`
      SELECT 
        s.shelter_id,
        s.name,
        s.capacity,
        ST_X(s.location) AS lon,
        ST_Y(s.location) AS lat,
        COALESCE(SUM(p.population), 0) AS population_sum,
        CASE WHEN s.capacity >= COALESCE(SUM(p.population), 0) THEN 'Ja' ELSE 'Nei' END AS enough_capacity,
        GREATEST(0, COALESCE(SUM(p.population), 0) - s.capacity) AS missing_capacity
      FROM tilfluktsromoffentlige.tilfluktsrom s
      LEFT JOIN public.population_cells p ON ST_DWithin(s.location, p.location, $1)
      GROUP BY s.id, s.shelter_id, s.name, s.capacity, s.location
      ORDER BY s.id
    `, [radius]);
    
    const ws = XLSX.utils.json_to_sheet(result.rows.map(r => ({
      'Tilfluktsrom ID': r.shelter_id,
      'Navn': r.name,
      'Kapasitet': r.capacity,
      'Lon': parseFloat(r.lon.toFixed(6)),
      'Lat': parseFloat(r.lat.toFixed(6)),
      'Befolkning i Radius': r.population_sum,
      'Tilstrekkelig Kapasitet': r.enough_capacity,
      'Manglende Kapasitet': r.missing_capacity
    })));
    
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Dekning');
    
    const buffer = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="coverage-${radius}m.xlsx"`);
    res.send(buffer);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// User: get nearest shelters and routing info
app.get('/api/routing/nearest-shelters', async (req, res) => {
  try {
    const { lon, lat, mode = 'walk' } = req.query;
    const strategy = req.query.strategy || 'nearest'; // 'nearest' or 'hasSpace'
    
    if (!lon || !lat) {
      return res.status(400).json({ error: 'Missing lon/lat' });
    }
    
    // Speed modes in km/h
    const speeds = { walk: 5, bike: 20, car: 60 };
    const speed = speeds[mode] || 5;
    
    const result = await pool.query(`
      SELECT 
        s.id,
        s.shelter_id,
        s.name,
        s.capacity,
        ST_X(s.location) AS lon,
        ST_Y(s.location) AS lat,
        ST_DistanceSphere(ST_MakePoint($1::float, $2::float), s.location) AS distance_m,
        COALESCE(SUM(p.population), 0) AS population_nearby,
        s.capacity - COALESCE(SUM(p.population), 0) AS free_spots
      FROM tilfluktsromoffentlige.tilfluktsrom s
      LEFT JOIN public.population_cells p ON ST_DWithin(s.location, p.location, 1000)
      GROUP BY s.id, s.shelter_id, s.name, s.capacity, s.location
      ORDER BY ${strategy === 'hasSpace' ? 'free_spots DESC, distance_m' : 'distance_m'}
      LIMIT 20
    `, [parseFloat(lon), parseFloat(lat)]);
    
    const shelters = result.rows.map(s => ({
      ...s,
      distance_km: (s.distance_m / 1000).toFixed(2),
      travel_time_minutes: Math.round((s.distance_m / 1000) / speed * 60)
    }));
    
    res.json({ mode, strategy, shelters });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// User: track user location
app.post('/api/users/:userId/location', async (req, res) => {
  try {
    const { userId } = req.params;
    const { lon, lat } = req.body;
    
    if (!lon || !lat) {
      return res.status(400).json({ error: 'Missing lon/lat' });
    }
    
    await pool.query(`
      INSERT INTO public.user_locations (user_id, location)
      VALUES ($1, ST_SetSRID(ST_MakePoint($2, $3), 4326))
    `, [userId, parseFloat(lon), parseFloat(lat)]);
    
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all layers as GeoJSON
app.get('/api/layers/:layer', async (req, res) => {
  try {
    const { layer } = req.params;
    
    let query = '';
    let result;
    
    if (layer === 'shelters') {
      query = `
        SELECT json_build_object(
          'type', 'FeatureCollection',
          'features', json_agg(json_build_object(
            'type', 'Feature',
            'geometry', json_build_object('type', 'Point', 'coordinates', json_build_array(ST_X(location), ST_Y(location))),
            'properties', json_build_object('id', id, 'name', name, 'capacity', capacity)
          ))
        ) AS geojson
        FROM tilfluktsromoffentlige.tilfluktsrom
      `;
      result = await pool.query(query);
    } else if (layer === 'population') {
      query = `
        SELECT json_build_object(
          'type', 'FeatureCollection',
          'features', json_agg(json_build_object(
            'type', 'Feature',
            'geometry', json_build_object('type', 'Point', 'coordinates', json_build_array(ST_X(location), ST_Y(location))),
            'properties', json_build_object('population', population)
          ))
        ) AS geojson
        FROM public.population_cells LIMIT 10000
      `;
      result = await pool.query(query);
    } else if (layer === 'counties' || layer === 'municipalities') {
      const cacheFile = path.join(CACHE_DIR, `${layer}.geojson`);
      if (fs.existsSync(cacheFile)) {
        const geojson = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        return res.json(geojson);
      }
      return res.json({ type: 'FeatureCollection', features: [] });
    }
    
    if (result && result.rows[0]) {
      res.json(result.rows[0].geojson);
    } else {
      res.json({ type: 'FeatureCollection', features: [] });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ========== SERVER STARTUP ==========

const PORT = process.env.PORT || 3000;

async function start() {
  try {
    await bootstrap();
    
    app.listen(PORT, () => {
      console.log(`✓ Backend listening on port ${PORT}`);
    });
  } catch (error) {
    console.error('Startup error:', error);
    process.exit(1);
  }
}

start();
