function logStartup() {
  if (process.env.LOG_STARTUP === 'true') {
    console.info('[startup] backend/index.js loaded');
  }
}

logStartup();
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

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

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

function scoreZipEntryForLayer(entryName, layerHint) {
  const lower = String(entryName || '').toLowerCase();
  const hint = String(layerHint || '').toLowerCase();
  let score = 0;

  // Prefer semantic matches for administrative layers over generic border datasets.
  if (hint === 'counties') {
    if (lower.includes('fylke')) score += 5000;
    if (lower.includes('grense')) score -= 5000;
  }
  if (hint === 'municipalities') {
    if (lower.includes('kommune')) score += 5000;
    if (lower.includes('grense')) score -= 5000;
  }

  return score;
}

async function extractGeoJsonFromZip(buffer, layerHint = '') {
  try {
    const zip = new AdmZip(buffer);
    const entries = zip.getEntries();
    
    let bestCandidate = null;
    let bestScore = Number.NEGATIVE_INFINITY;
    
    // Map layer hints to expected nested keys
    const keyMap = {
      counties: 'Fylke',
      municipalities: 'Kommune'
    };
    const expectedKey = keyMap[layerHint] || layerHint;
    
    console.log(`Extracting ${layerHint}, expected key: ${expectedKey}`);
    
    for (const entry of entries) {
      const lowerName = entry.name.toLowerCase();
      if (entry.isDirectory || (!lowerName.endsWith('.json') && !lowerName.endsWith('.geojson'))) continue;
      console.log(`Processing entry: ${entry.name}`);
      try {
        const content = entry
          .getData()
          .toString('utf8')
          .replace(/^\uFEFF/, '')
          .trim();
        const json = JSON.parse(content);
        
        // Handle nested GeoJSON structures like { "Fylke": { "type": "FeatureCollection", ... } }
        let geojson = json;
        if (json[expectedKey]) {
          console.log(`Found nested key ${expectedKey}`);
          geojson = json[expectedKey];
        }
        
        if (geojson.features && Array.isArray(geojson.features)) {
          const score = scoreZipEntryForLayer(entry.name, layerHint) + Math.min(geojson.features.length, 100);
          console.log(`Valid GeoJSON with ${geojson.features.length} features, score: ${score}`);
          if (score > bestScore) {
            bestCandidate = geojson;
            bestScore = score;
          }
        } else {
          console.log(`No features found in ${entry.name}`);
        }
      } catch (e) {
        console.log(`Parse error for ${entry.name}: ${e.message}`);
      }
    }
    
    console.log(`Best candidate has ${bestCandidate?.features?.length || 0} features`);
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
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (Array.isArray(cached?.features) && cached.features.length > 0) {
        return cached;
      }
      // Force refresh if cache is present but unusable.
      fs.unlinkSync(cacheFile);
    } catch (e) {
      fs.unlinkSync(cacheFile); // delete corrupt cache
    }
  }
  
  try {
    console.log(`Downloading ${layer} from ${url.substring(0, 60)}...`);
    const buffer = await downloadBuffer(url);
    const geojson = await extractGeoJsonFromZip(buffer, layer);
    fs.writeFileSync(cacheFile, JSON.stringify(geojson));
    return geojson;
  } catch (error) {
    console.error(`Failed to cache ${layer}:`, error.message);
    return { type: 'FeatureCollection', features: [] };
  }
}

async function refreshBoundaryLayer(layer) {
  const urlByLayer = {
    counties:
      'https://nedlasting.geonorge.no/geonorge/Basisdata/Fylker/GeoJSON/Basisdata_0000_Norge_25833_Fylker_GeoJSON.zip',
    municipalities:
      'https://nedlasting.geonorge.no/geonorge/Basisdata/Kommuner/GeoJSON/Basisdata_0000_Norge_25833_Kommuner_GeoJSON.zip'
  };

  const url = urlByLayer[layer];
  if (!url) return { type: 'FeatureCollection', features: [] };

  const raw = await cacheGeoJsonFromZip(layer, url);
  const transformed = await transformProjectedFeatureCollection(raw);
  const cacheFile = path.join(CACHE_DIR, `${layer}.geojson`);
  fs.writeFileSync(cacheFile, JSON.stringify(transformed));
  return transformed;
}

async function getBoundaryLayerGeoJson(layer) {
  const cacheFile = path.join(CACHE_DIR, `${layer}.geojson`);
  if (fs.existsSync(cacheFile)) {
    try {
      const geojson = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (Array.isArray(geojson?.features) && geojson.features.length > 0) {
        return geojson;
      }
    } catch (error) {
      // Rebuild cache below.
    }
  }

  try {
    return await refreshBoundaryLayer(layer);
  } catch (error) {
    console.error(`Failed to refresh boundary layer ${layer}:`, error.message);
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
      // Guard against wrong numeric fields accidentally parsed from source attributes.
      if (population > 50000) continue;
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
    // Reset fallback population to avoid accumulation across repeated bootstrap runs.
    await pool.query('TRUNCATE public.population_cells');

    // Generate synthetic population around shelters, normalized to realistic national scale.
    const shelters = await pool.query(`
      SELECT ST_X(location) AS lon, ST_Y(location) AS lat, GREATEST(capacity, 1) AS capacity
      FROM tilfluktsromoffentlige.tilfluktsrom
      WHERE location IS NOT NULL
    `);

    const points = [];
    const pointsPerShelter = 8;
    for (const s of shelters.rows) {
      const lon = Number(s.lon);
      const lat = Number(s.lat);
      const cap = Number(s.capacity || 1);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      
      for (let i = 0; i < pointsPerShelter; i++) {
        const angle = Math.random() * Math.PI * 2;
        const distance = Math.random() * 0.05; // approx <= 5km
        const newLon = lon + distance * Math.cos(angle);
        const newLat = lat + distance * Math.sin(angle);
        const weight = Math.max(1, cap * (0.7 + Math.random() * 0.6));
        points.push({ lon: newLon, lat: newLat, weight });
      }
    }

    const targetPopulation = 5_500_000;
    const totalWeight = points.reduce((sum, p) => sum + p.weight, 0) || 1;

    for (const p of points) {
      const population = Math.max(20, Math.round((targetPopulation * p.weight) / totalWeight));
      await pool.query(
        `INSERT INTO public.population_cells (population, location)
         VALUES ($1, ST_SetSRID(ST_MakePoint($2, $3), 4326))`,
        [population, p.lon, p.lat]
      );
    }
    
    console.log(`✓ Synthetic population generated (${points.length} points, target ${targetPopulation.toLocaleString('en-US')})`);
  } catch (error) {
    console.error('Synthetic population error:', error.message);
  }
}

async function bootstrap() {
  console.log('🚀 Starting data bootstrap...');
  
  await initSchema();

  const existing = await pool.query(`
    SELECT
      (SELECT COUNT(*)::int FROM tilfluktsromoffentlige.tilfluktsrom) AS shelters,
      (SELECT COUNT(*)::int FROM public.population_cells) AS population,
      (SELECT COALESCE(SUM(population), 0)::bigint FROM public.population_cells) AS population_sum
  `);
  let existingShelters = Number(existing.rows[0]?.shelters || 0);
  let existingPopulation = Number(existing.rows[0]?.population || 0);
  let existingPopulationSum = Number(existing.rows[0]?.population_sum || 0);

  // Self-heal old inflated fallback datasets from previous versions.
  if (existingPopulation > 50000 || existingPopulationSum > 6_500_000) {
    console.log(
      `Population table looks inflated (rows=${existingPopulation}, sum=${existingPopulationSum}), regenerating synthetic baseline...`
    );
    await generateSyntheticPopulation();
    const refreshed = await pool.query(`
      SELECT
        (SELECT COUNT(*)::int FROM public.population_cells) AS population,
        (SELECT COALESCE(SUM(population), 0)::bigint FROM public.population_cells) AS population_sum
    `);
    existingPopulation = Number(refreshed.rows[0]?.population || 0);
    existingPopulationSum = Number(refreshed.rows[0]?.population_sum || 0);
    console.log(`Population baseline repaired (rows=${existingPopulation}, sum=${existingPopulationSum}).`);
  }

  if (existingShelters > 0 && existingPopulation > 0) {
    console.log(`Data already in database (shelters=${existingShelters}, population=${existingPopulation}), skipping re-ingest.`);
    return;
  }
  
  // Download and ingest shelters
  if (existingShelters === 0) {
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
  } else {
    console.log(`Skipping shelter ingest (already ${existingShelters} rows).`);
  }
  
  // Download and ingest population
  if (existingPopulation === 0) {
    try {
      console.log('Downloading population...');
      await pool.query('TRUNCATE public.population_cells');
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
  } else {
    console.log(`Skipping population ingest (already ${existingPopulation} rows).`);
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

async function fetchCoverageRows(radius) {
  // Agder fylke bounds (approximate coordinates for Agder region in southern Norway)
  const agderBBox = 'POLYGON((7.0 57.8, 9.5 57.8, 9.5 59.0, 7.0 59.0, 7.0 57.8))';
  const agderGeom = `ST_GeomFromText('${agderBBox}', 4326)`;
  
  const result = await pool.query(`
    WITH shelter_buffers AS (
      SELECT
        s.id,
        s.shelter_id,
        s.name,
        s.capacity,
        s.location,
        ST_Buffer(s.location::geography, $1)::geometry AS buffer_geom
      FROM tilfluktsromoffentlige.tilfluktsrom s
      WHERE ST_Intersects(s.location, ${agderGeom})
    ),
    cluster_groups AS (
      SELECT
        row_number() OVER () AS cluster_id,
        ST_UnaryUnion(cluster_geom) AS cluster_geom
      FROM (
        SELECT unnest(ST_ClusterIntersecting(buffer_geom)) AS cluster_geom
        FROM shelter_buffers
      ) x
    ),
    shelter_cluster AS (
      SELECT
        sb.*,
        cg.cluster_id,
        cg.cluster_geom
      FROM shelter_buffers sb
      JOIN cluster_groups cg ON ST_Intersects(sb.buffer_geom, cg.cluster_geom)
    ),
    cluster_population AS (
      SELECT
        cg.cluster_id,
        COALESCE(SUM(p.population), 0)::bigint AS cluster_population
      FROM cluster_groups cg
      LEFT JOIN public.population_cells p ON ST_Within(p.location, cg.cluster_geom)
      GROUP BY cg.cluster_id
    ),
    cluster_capacity AS (
      SELECT
        cluster_id,
        COALESCE(SUM(capacity), 0)::bigint AS cluster_capacity
      FROM shelter_cluster
      GROUP BY cluster_id
    )
    SELECT
      sc.id,
      sc.shelter_id,
      sc.name,
      sc.capacity,
      ST_X(sc.location) AS lon,
      ST_Y(sc.location) AS lat,
      COALESCE((
        SELECT SUM(p.population)
        FROM public.population_cells p
        WHERE ST_Within(p.location, sc.buffer_geom)
      ), 0)::bigint AS population_within_radius,
      cp.cluster_population,
      cc.cluster_capacity,
      GREATEST(cc.cluster_capacity - cp.cluster_population, 0)::bigint AS cluster_free_spaces,
      (cc.cluster_capacity >= cp.cluster_population) AS enough_capacity,
      GREATEST(cp.cluster_population - cc.cluster_capacity, 0)::bigint AS missing_capacity,
      sc.cluster_id
    FROM shelter_cluster sc
    JOIN cluster_population cp ON cp.cluster_id = sc.cluster_id
    JOIN cluster_capacity cc ON cc.cluster_id = sc.cluster_id
    ORDER BY sc.id
  `, [radius]);

  return result.rows;
}

function summarizeCoverage(shelters) {
  const clusterMap = new Map();
  for (const s of shelters) {
    if (!clusterMap.has(s.cluster_id)) {
      clusterMap.set(s.cluster_id, {
        cluster_id: s.cluster_id,
        cluster_population: Number(s.cluster_population || 0),
        cluster_capacity: Number(s.cluster_capacity || 0),
        cluster_free_spaces: Number(s.cluster_free_spaces || 0),
      });
    }
  }

  const clusters = Array.from(clusterMap.values());
  const totalPopulation = clusters.reduce((sum, c) => sum + c.cluster_population, 0);
  const totalCapacity = clusters.reduce((sum, c) => sum + c.cluster_capacity, 0);
  const totalMissing = clusters.reduce((sum, c) => sum + Math.max(c.cluster_population - c.cluster_capacity, 0), 0);
  const adequateClusters = clusters.filter((c) => c.cluster_capacity >= c.cluster_population).length;

  return {
    total_shelters: shelters.length,
    total_clusters: clusters.length,
    adequate_clusters: adequateClusters,
    total_capacity: totalCapacity,
    total_population_within_radius: totalPopulation,
    coverage_percent: totalPopulation > 0 ? Math.round((totalCapacity / totalPopulation) * 100) : 0,
    total_missing_capacity: totalMissing,
  };
}

// Admin: compute coverage statistics within radius
app.get('/api/admin/coverage', async (req, res) => {
  try {
    const radius = parseInt(req.query.radius) || 1000;
    const shelters = await fetchCoverageRows(radius);
    const summary = summarizeCoverage(shelters);
    
    res.json({
      radius,
      summary,
      shelters
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: radius polygons for visualizing shelter influence and overlap clusters
app.get('/api/admin/radius-layer', async (req, res) => {
  try {
    const radius = parseInt(req.query.radius) || 1000;
    // Agder fylke bounds
    const agderBBox = 'POLYGON((7.0 57.8, 9.5 57.8, 9.5 59.0, 7.0 59.0, 7.0 57.8))';
    const agderGeom = `ST_GeomFromText('${agderBBox}', 4326)`;
    
    const result = await pool.query(`
      WITH shelter_buffers AS (
        SELECT
          s.id,
          s.shelter_id,
          s.name,
          s.capacity,
          ST_Buffer(s.location::geography, $1)::geometry AS buffer_geom
        FROM tilfluktsromoffentlige.tilfluktsrom s
        WHERE ST_Intersects(s.location, ${agderGeom})
      ),
      cluster_groups AS (
        SELECT
          row_number() OVER () AS cluster_id,
          ST_UnaryUnion(cluster_geom) AS cluster_geom
        FROM (
          SELECT unnest(ST_ClusterIntersecting(buffer_geom)) AS cluster_geom
          FROM shelter_buffers
        ) x
      ),
      shelter_cluster AS (
        SELECT
          sb.*,
          cg.cluster_id
        FROM shelter_buffers sb
        JOIN cluster_groups cg ON ST_Intersects(sb.buffer_geom, cg.cluster_geom)
      )
      SELECT json_build_object(
        'type', 'FeatureCollection',
        'features', COALESCE(json_agg(
          json_build_object(
            'type', 'Feature',
            'geometry', ST_AsGeoJSON(sc.buffer_geom)::json,
            'properties', json_build_object(
              'id', sc.id,
              'shelter_id', sc.shelter_id,
              'name', sc.name,
              'capacity', sc.capacity,
              'cluster_id', sc.cluster_id
            )
          )
        ), '[]'::json)
      ) AS geojson
      FROM shelter_cluster sc
    `, [radius]);

    res.json(result.rows[0].geojson || { type: 'FeatureCollection', features: [] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: export coverage data to CSV
app.get('/api/admin/export/csv', async (req, res) => {
  try {
    const radius = parseInt(req.query.radius) || 1000;
    const rows = await fetchCoverageRows(radius);
    
    const csv = [
      'Tilfluktsrom ID,Navn,Kapasitet,Lon,Lat,Befolkning i Radius,Tilstrekkelig Kapasitet,Manglende Kapasitet'
    ];
    
    rows.forEach(row => {
      csv.push([
        row.shelter_id,
        `"${row.name}"`,
        row.capacity,
        Number(row.lon).toFixed(6),
        Number(row.lat).toFixed(6),
        Number(row.cluster_population || 0),
        row.enough_capacity ? 'Ja' : 'Nei',
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
    const rows = await fetchCoverageRows(radius);
    
    const ws = XLSX.utils.json_to_sheet(rows.map(r => ({
      'Tilfluktsrom ID': r.shelter_id,
      'Navn': r.name,
      'Kapasitet': r.capacity,
      'Lon': parseFloat(Number(r.lon).toFixed(6)),
      'Lat': parseFloat(Number(r.lat).toFixed(6)),
      'Befolkning i Radius (samlet område)': Number(r.cluster_population || 0),
      'Tilstrekkelig Kapasitet': r.enough_capacity ? 'Ja' : 'Nei',
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
    
    // Agder fylke bounds
    const agderBBox = 'POLYGON((7.0 57.8, 9.5 57.8, 9.5 59.0, 7.0 59.0, 7.0 57.8))';
    const agderGeom = `ST_GeomFromText('${agderBBox}', 4326)`;
    
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
      LEFT JOIN public.population_cells p ON ST_DWithin(s.location::geography, p.location::geography, 1000)
      WHERE ST_Intersects(s.location, ${agderGeom})
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

// User: road-based route guidance (OSRM style)
app.get('/api/routing/route', async (req, res) => {
  try {
    const originLon = Number(req.query.originLon);
    const originLat = Number(req.query.originLat);
    const destLon = Number(req.query.destLon);
    const destLat = Number(req.query.destLat);
    const mode = String(req.query.mode || 'walk');

    if (![originLon, originLat, destLon, destLat].every(Number.isFinite)) {
      return res.status(400).json({ error: 'Missing or invalid coordinates' });
    }

    const profile = mode === 'car' ? 'driving' : mode === 'bike' ? 'bike' : 'foot';
    const osrmUrl = `https://router.project-osrm.org/route/v1/${profile}/${originLon},${originLat};${destLon},${destLat}?overview=full&geometries=geojson&steps=true`;

    try {
      const response = await axios.get(osrmUrl, { timeout: 15000 });
      const route = response.data?.routes?.[0];
      if (!route || !route.geometry?.coordinates) throw new Error('No route from OSRM');

      const steps = (route.legs || [])
        .flatMap((leg) => leg.steps || [])
        .slice(0, 12)
        .map((step) => ({
          distance_m: Math.round(step.distance || 0),
          duration_s: Math.round(step.duration || 0),
          instruction: step.name || step.maneuver?.instruction || 'Fortsett'
        }));

      return res.json({
        mode,
        source: 'osrm',
        distance_m: Math.round(route.distance || 0),
        duration_s: Math.round(route.duration || 0),
        geometry: {
          type: 'LineString',
          coordinates: route.geometry.coordinates
        },
        steps
      });
    } catch (proxyError) {
      const distance = haversineMeters(originLat, originLon, destLat, destLon);
      const speedKmh = mode === 'car' ? 60 : mode === 'bike' ? 20 : 5;
      const durationS = Math.round((distance / 1000) / speedKmh * 3600);

      return res.json({
        mode,
        source: 'fallback-straight-line',
        distance_m: Math.round(distance),
        duration_s: durationS,
        geometry: {
          type: 'LineString',
          coordinates: [[originLon, originLat], [destLon, destLat]]
        },
        steps: [
          { distance_m: Math.round(distance), duration_s: durationS, instruction: 'Gå mot valgt tilfluktsrom' }
        ]
      });
    }
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

// Get all spatial tables and data filtered to Agder fylke
app.get('/spatial', async (req, res) => {
  try {
    // Agder fylke bounds (approximate coordinates for Agder region in southern Norway)
    // This includes the geometry for Agder/Sørlandet region
    const agderBBox = 'POLYGON((7.0 57.8, 9.5 57.8, 9.5 59.0, 7.0 59.0, 7.0 57.8))';
    const agderGeom = `ST_GeomFromText('${agderBBox}', 4326)`;
    
    const tables = [];
    
    // Query all spatial tables in the database
    const tableQuery = `
      SELECT 
        table_schema, 
        table_name,
        json_agg(DISTINCT column_name) AS geom_columns
      FROM information_schema.columns
      WHERE table_schema NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
        AND udt_name IN ('geometry', 'geography')
      GROUP BY table_schema, table_name
      ORDER BY table_schema, table_name
    `;
    
    const tableResult = await pool.query(tableQuery);
    
    for (const tbl of tableResult.rows) {
      const { table_schema, table_name, geom_columns } = tbl;
      const geomCol = geom_columns && geom_columns.length > 0 ? geom_columns[0] : null;
      
      if (!geomCol) continue; // Skip tables without geometry
      
      try {
        // Fetch rows within Agder bounds
        const dataQuery = `
          SELECT row_to_json(t) as row
          FROM ${table_schema}.${table_name} t
          WHERE ST_Intersects(${geomCol}, ${agderGeom})
          LIMIT 5000
        `;
        
        const dataResult = await pool.query(dataQuery);
        const rows = dataResult.rows.map(r => r.row);
        
        if (rows.length > 0) {
          tables.push({
            schema: table_schema,
            table: table_name,
            geom_columns: geom_columns,
            rows: rows
          });
        }
      } catch (err) {
        console.warn(`Error fetching data from ${table_schema}.${table_name}:`, err.message);
      }
    }
    
    res.json({ tables });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all layers as GeoJSON
app.get('/api/layers/:layer', async (req, res) => {
  try {
    const { layer } = req.params;
    
    // Agder fylke bounds
    const agderBBox = 'POLYGON((7.0 57.8, 9.5 57.8, 9.5 59.0, 7.0 59.0, 7.0 57.8))';
    const agderGeom = `ST_GeomFromText('${agderBBox}', 4326)`;
    
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
        WHERE ST_Intersects(location, ${agderGeom})
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
        FROM (SELECT * FROM public.population_cells WHERE ST_Intersects(location, ${agderGeom}) LIMIT 3000) p
      `;
      result = await pool.query(query);
    } else if (layer === 'counties' || layer === 'municipalities') {
      const geojson = await getBoundaryLayerGeoJson(layer);
      return res.json(geojson);
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

// ========== ANALYSIS ENDPOINTS (Agder-filtered) ==========

// Find nearby tilfluktsrom within distance
app.get('/analysis/near', async (req, res) => {
  try {
    const { lon, lat, distance } = req.query;
    const agderBBox = 'POLYGON((7.0 57.8, 9.5 57.8, 9.5 59.0, 7.0 59.0, 7.0 57.8))';
    const agderGeom = `ST_GeomFromText('${agderBBox}', 4326)`;
    
    const query = `
      SELECT 
        id, shelter_id, name, capacity, 
        ST_X(location) AS lon, ST_Y(location) AS lat,
        ST_DistanceSphere(location, ST_MakePoint($1::float, $2::float)) AS distance_m
      FROM tilfluktsromoffentlige.tilfluktsrom
      WHERE ST_Intersects(location, ${agderGeom})
        AND ST_DWithin(location::geography, ST_MakePoint($1::float, $2::float)::geography, $3::float)
      ORDER BY distance_m
      LIMIT 20
    `;
    
    const result = await pool.query(query, [parseFloat(lon), parseFloat(lat), parseFloat(distance) || 1000]);
    res.json(result.rows);
  } catch (err) {
    console.error('analysis/near failed:', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// Filter tilfluktsrom by minimum capacity and return GeoJSON
app.get('/analysis/tilfluktsrom-min', async (req, res) => {
  try {
    const minCapacity = Number(req.query.min_plasser) || 500;
    const agderBBox = 'POLYGON((7.0 57.8, 9.5 57.8, 9.5 59.0, 7.0 59.0, 7.0 57.8))';
    const agderGeom = `ST_GeomFromText('${agderBBox}', 4326)`;
    
    const q = `
      SELECT json_build_object(
        'type', 'FeatureCollection',
        'features', COALESCE(json_agg(
          json_build_object(
            'type', 'Feature',
            'geometry', ST_AsGeoJSON(location)::json,
            'properties', json_build_object(
              'id', id, 'name', name, 'capacity', capacity, 'shelter_id', shelter_id
            )
          )
        ), '[]'::json)
      ) AS geojson
      FROM tilfluktsromoffentlige.tilfluktsrom
      WHERE ST_Intersects(location, ${agderGeom})
        AND capacity >= $1
    `;
    
    const result = await pool.query(q, [minCapacity]);
    res.json(result.rows[0].geojson);
  } catch (err) {
    console.error('analysis/tilfluktsrom-min failed:', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// List all fylker (not filtered to Agder - needed for dropdown)
app.get('/analysis/fylke-list', async (req, res) => {
  try {
    const q = `
      SELECT DISTINCT navn AS name
      FROM fylker.administrativenhetnavn
      ORDER BY navn
    `;
    const result = await pool.query(q);
    res.json({ names: result.rows.map(r => r.name) });
  } catch (err) {
    console.error('analysis/fylke-list failed:', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// List available discovery tables
app.get('/analysis/fylke-discover', async (req, res) => {
  try {
    const nameCols = await pool.query(`
      SELECT table_schema, table_name, array_agg(column_name ORDER BY column_name) AS columns
      FROM information_schema.columns
      WHERE column_name ILIKE 'navn'
      GROUP BY table_schema, table_name
      ORDER BY table_schema, table_name
    `);

    const geomCols = await pool.query(`
      SELECT table_schema, table_name, array_agg(column_name ORDER BY column_name) AS geom_columns
      FROM information_schema.columns
      WHERE udt_name IN ('geometry','geography')
      GROUP BY table_schema, table_name
      ORDER BY table_schema, table_name
    `);

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
    console.error('analysis/fylke-discover failed:', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// Get fylke outline as GeoJSON
app.get('/analysis/fylke-outline', async (req, res) => {
  try {
    const fylkeName = req.query.fylke_name;
    if (!fylkeName) return res.status(400).json({ error: 'Missing fylke_name' });
    
    const q = `
      SELECT json_build_object(
        'type', 'FeatureCollection',
        'features', COALESCE(json_agg(
          json_build_object(
            'type', 'Feature',
            'geometry', ST_AsGeoJSON(omrade)::json,
            'properties', json_build_object('fylkesnavn', fylkesnavn)
          )
        ), '[]'::json)
      ) AS geojson
      FROM fylker.fylke
      WHERE fylkesnavn = $1
    `;
    
    const result = await pool.query(q, [fylkeName]);
    res.json(result.rows[0]?.geojson || { type: 'FeatureCollection', features: [] });
  } catch (err) {
    console.error('analysis/fylke-outline failed:', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// Get brannstasjoner inside a fylke
app.get('/analysis/brannstasjoner-in-fylke', async (req, res) => {
  try {
    const fylkeName = req.query.fylke_name;
    if (!fylkeName) return res.status(400).json({ error: 'Missing fylke_name' });
    
    const q = `
      WITH fylke_geom AS (
        SELECT omrade
        FROM fylker.fylke
        WHERE fylkesnavn = $1
      )
      SELECT json_build_object(
        'type', 'FeatureCollection',
        'features', COALESCE(json_agg(
          json_build_object(
            'type', 'Feature',
            'geometry', ST_AsGeoJSON(ST_Transform(posisjon, 4326))::json,
            'properties', to_jsonb(b) - 'posisjon'
          )
        ), '[]'::json)
      ) AS geojson
      FROM brannstasjoner.brannstasjon b
      WHERE ST_Within(
        ST_Transform(b.posisjon, 4326),
        (SELECT omrade FROM fylke_geom)
      )
    `;
    
    const result = await pool.query(q, [fylkeName]);
    res.json(result.rows[0]?.geojson || { type: 'FeatureCollection', features: [] });
  } catch (err) {
    console.error('analysis/brannstasjoner-in-fylke failed:', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// Generic spatial search within Agder
app.get('/analysis/search', async (req, res) => {
  try {
    const { table, field, value } = req.query;
    if (!table || !field) return res.status(400).json({ error: 'Missing table or field' });
    
    const agderBBox = 'POLYGON((7.0 57.8, 9.5 57.8, 9.5 59.0, 7.0 59.0, 7.0 57.8))';
    const agderGeom = `ST_GeomFromText('${agderBBox}', 4326)`;
    
    // Only search within safe, known tables
    const safeTables = ['tilfluktsromoffentlige.tilfluktsrom', 'public.population_cells'];
    if (!safeTables.includes(table)) {
      return res.status(400).json({ error: 'Table not allowed' });
    }
    
    const q = `SELECT * FROM ${table} WHERE ${field} ILIKE $1 AND ST_Intersects(location, ${agderGeom})`;
    const result = await pool.query(q, [`%${value}%`]);
    res.json(result.rows);
  } catch (err) {
    console.error('analysis/search failed:', err.message);
    res.status(500).json({ error: 'Database error' });
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
