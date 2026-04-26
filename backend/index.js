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
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const xml2js = require('xml2js');
const { v4: uuidv4 } = require('uuid');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

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

function toFiniteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function logisticsJobKey(resourceType, targetType, targetId) {
  return `${resourceType}:${targetType}:${targetId}`;
}

function clonePlanJobs(jobs = []) {
  return jobs.map((job) => ({
    ...job,
    source: job.source ? { ...job.source } : job.source,
    target: job.target ? { ...job.target } : job.target,
    route: job.route ? { ...job.route, geometry: job.route.geometry ? { ...job.route.geometry } : job.route.geometry } : job.route
  }));
}

function logisticsSnapshotHash(snapshot, settings) {
  return crypto.createHash('sha1').update(JSON.stringify({ snapshot, settings })).digest('hex');
}

function interpolatePointAlongLine(coordinates, progress) {
  if (!Array.isArray(coordinates) || coordinates.length === 0) return null;
  if (coordinates.length === 1) return coordinates[0];

  const clampedProgress = Math.min(1, Math.max(0, progress));
  const segmentLengths = [];
  let totalLength = 0;

  for (let index = 0; index < coordinates.length - 1; index += 1) {
    const start = coordinates[index];
    const end = coordinates[index + 1];
    const segmentLength = haversineMeters(start[1], start[0], end[1], end[0]);
    segmentLengths.push(segmentLength);
    totalLength += segmentLength;
  }

  if (totalLength <= 0) return coordinates[0];

  const targetDistance = totalLength * clampedProgress;
  let traversed = 0;

  for (let index = 0; index < segmentLengths.length; index += 1) {
    const start = coordinates[index];
    const end = coordinates[index + 1];
    const segmentLength = segmentLengths[index];

    if (traversed + segmentLength >= targetDistance) {
      const segmentProgress = segmentLength === 0 ? 0 : (targetDistance - traversed) / segmentLength;
      return [
        start[0] + (end[0] - start[0]) * segmentProgress,
        start[1] + (end[1] - start[1]) * segmentProgress
      ];
    }

    traversed += segmentLength;
  }

  return coordinates[coordinates.length - 1];
}

function getFeaturePoint(feature) {
  const coordinates = feature?.geometry?.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
  const lon = Number(coordinates[0]);
  const lat = Number(coordinates[1]);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  return { lon, lat };
}

function createLogisticsJobId() {
  return uuidv4();
}

function buildTruckJobsFromDemand({ sinks, sources, resourceType, truckCapacity, settings }) {
  const validSinks = (sinks || [])
    .map((sink) => ({ ...sink, remainingDemand: toFiniteNumber(sink.remainingDemand, 0) }))
    .filter((sink) => sink.remainingDemand > 0)
    .sort((a, b) => b.remainingDemand - a.remainingDemand);

  const validSources = (sources || [])
    .map((source) => {
      const point = getFeaturePoint(source);
      if (point) {
        return { ...source, lon: point.lon, lat: point.lat };
      }

      // Snapshot sources are plain objects ({ lon, lat }) rather than GeoJSON features.
      const lon = toFiniteNumber(source?.lon, Number.NaN);
      const lat = toFiniteNumber(source?.lat, Number.NaN);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
        return null;
      }

      return { ...source, lon, lat };
    })
    .filter(Boolean);

  const sourceLoadCounts = new Map();
  const jobs = [];

  for (const sink of validSinks) {
    let remainingDemand = sink.remainingDemand;

    while (remainingDemand > 0 && validSources.length > 0) {
      const loadAmount = Math.min(truckCapacity, remainingDemand);
      let selectedSource = null;
      let selectedScore = Number.POSITIVE_INFINITY;

      for (const source of validSources) {
        const sourceKey = String(source.id ?? source.name ?? `${source.lon},${source.lat}`);
        const assignedLoads = sourceLoadCounts.get(sourceKey) || 0;
        const distanceMeters = haversineMeters(source.lat, source.lon, sink.lat, sink.lon);
        const score = distanceMeters + assignedLoads * 15000;

        if (score < selectedScore) {
          selectedScore = score;
          selectedSource = source;
        }
      }

      if (!selectedSource) break;

      const sourceKey = String(selectedSource.id ?? selectedSource.name ?? `${selectedSource.lon},${selectedSource.lat}`);
      sourceLoadCounts.set(sourceKey, (sourceLoadCounts.get(sourceKey) || 0) + 1);

      jobs.push({
        id: createLogisticsJobId(),
        resourceType,
        source: {
          id: selectedSource.id,
          name: selectedSource.name,
          lon: selectedSource.lon,
          lat: selectedSource.lat
        },
        target: {
          id: sink.id,
          name: sink.name,
          kind: sink.kind,
          lon: sink.lon,
          lat: sink.lat,
          live_users_count: sink.live_users_count
        },
        amount: loadAmount,
        truckCapacity,
        demand: sink.remainingDemand,
        unitsPerPerson: settings[resourceType === 'water' ? 'waterUnitsPerPerson' : 'foodUnitsPerPerson'],
        sourceScore: Math.round(selectedScore),
        status: 'planned',
        progress: 0,
        startedAt: null,
        completedAt: null,
        route: null,
        currentPosition: [selectedSource.lon, selectedSource.lat]
      });

      remainingDemand -= loadAmount;
    }
  }

  return jobs;
}

function assignLiveUsersToNearestSinks(liveUsers, sinks) {
  const sinkCounts = new Map();

  for (const user of liveUsers || []) {
    const userLon = toFiniteNumber(user.lon, Number.NaN);
    const userLat = toFiniteNumber(user.lat, Number.NaN);

    if (!Number.isFinite(userLon) || !Number.isFinite(userLat)) {
      continue;
    }

    let nearestSink = null;
    let nearestDistance = Number.POSITIVE_INFINITY;

    for (const sink of sinks || []) {
      const sinkLon = toFiniteNumber(sink.lon, Number.NaN);
      const sinkLat = toFiniteNumber(sink.lat, Number.NaN);

      if (!Number.isFinite(sinkLon) || !Number.isFinite(sinkLat)) {
        continue;
      }

      const distanceMeters = haversineMeters(userLat, userLon, sinkLat, sinkLon);

      if (distanceMeters < nearestDistance) {
        nearestDistance = distanceMeters;
        nearestSink = sink;
      }
    }

    if (!nearestSink) {
      continue;
    }

    const sinkKey = logisticsJobKey('nearest', nearestSink.kind || 'sink', nearestSink.id);
    sinkCounts.set(sinkKey, (sinkCounts.get(sinkKey) || 0) + 1);
  }

  return sinkCounts;
}

async function computeRouteBetweenPoints({ originLon, originLat, destLon, destLat, mode = 'walk' }) {
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

    return {
      mode,
      source: 'osrm',
      distance_m: Math.round(route.distance || 0),
      duration_s: Math.round(route.duration || 0),
      geometry: {
        type: 'LineString',
        coordinates: route.geometry.coordinates
      },
      steps
    };
  } catch (proxyError) {
    const distance = haversineMeters(originLat, originLon, destLat, destLon);
    const speedKmh = mode === 'car' ? 60 : mode === 'bike' ? 20 : 5;
    const durationS = Math.round((distance / 1000) / speedKmh * 3600);

    return {
      mode,
      source: 'fallback-straight-line',
      distance_m: Math.round(distance),
      duration_s: durationS,
      geometry: {
        type: 'LineString',
        coordinates: [[originLon, originLat], [destLon, destLat]]
      },
      steps: [
        { distance_m: Math.round(distance), duration_s: durationS, instruction: 'Gå mot valgt mål' }
      ]
    };
  }
}

async function ensureLogisticsStateTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.mock_logistics_state (
      id INT PRIMARY KEY DEFAULT 1,
      plan JSONB NOT NULL DEFAULT '{}'::jsonb,
      snapshot_key TEXT,
      settings JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    INSERT INTO public.mock_logistics_state (id, plan, snapshot_key, settings)
    VALUES (1, '{}'::jsonb, NULL, '{}'::jsonb)
    ON CONFLICT (id) DO NOTHING
  `);
}

async function readLogisticsState() {
  await ensureLogisticsStateTable();
  const result = await pool.query(`
    SELECT id, plan, snapshot_key, settings, updated_at
    FROM public.mock_logistics_state
    WHERE id = 1
  `);

  return result.rows[0] || {
    id: 1,
    plan: { jobs: [] },
    snapshot_key: null,
    settings: {},
    updated_at: null
  };
}

async function saveLogisticsState({ plan, snapshotKey, settings }) {
  await ensureLogisticsStateTable();
  await pool.query(`
    UPDATE public.mock_logistics_state
    SET plan = $1::jsonb,
        snapshot_key = $2,
        settings = $3::jsonb,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = 1
  `, [JSON.stringify(plan), snapshotKey, JSON.stringify(settings)]);
}

async function fetchLogisticsSnapshot() {
  const { latestUsersCte } = await buildLatestUsersSubquery();

  const [shelterResult, safeAreaExistsResult, farmResult, waterResult, liveUsersResult] = await Promise.all([
    pool.query(`
      ${latestUsersCte}
      SELECT
        s.id,
        s.shelter_id,
        s.name,
        ST_X(s.location) AS lon,
        ST_Y(s.location) AS lat,
        COUNT(lu.user_id)::int AS live_users_count
      FROM tilfluktsromoffentlige.tilfluktsrom s
      LEFT JOIN latest lu ON ST_DWithin(lu.location::geography, s.location::geography, 150)
      GROUP BY s.id, s.shelter_id, s.name, s.location
      ORDER BY s.id
    `),
    pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = 'safe_areas'
      ) AS exists
    `),
    pool.query(`
      SELECT id, name, ST_X(location) AS lon, ST_Y(location) AS lat
      FROM overture.farms
      ORDER BY id
    `),
    pool.query(`
      SELECT id, name, ST_X(location) AS lon, ST_Y(location) AS lat
      FROM overture.water_sources
      ORDER BY id
    `),
    pool.query(`
      ${latestUsersCte}
      SELECT
        user_id,
        ST_X(location) AS lon,
        ST_Y(location) AS lat
      FROM latest
    `)
  ]);

  let safeAreaRows = [];
  if (safeAreaExistsResult.rows[0]?.exists) {
    const safeAreaResult = await pool.query(`
      ${latestUsersCte}
      SELECT
        sa.id,
        sa.name,
        ST_X(sa.location) AS lon,
        ST_Y(sa.location) AS lat,
        COUNT(lu.user_id)::int AS live_users_count
      FROM public.safe_areas sa
      LEFT JOIN latest lu ON ST_DWithin(lu.location::geography, sa.location::geography, 150)
      GROUP BY sa.id, sa.name, sa.location
      ORDER BY sa.id
    `);
    safeAreaRows = safeAreaResult.rows || [];
  }

  const sinks = [
    ...(shelterResult.rows || []).map((row) => ({
      id: Number(row.id),
      name: row.name,
      kind: 'shelter',
      lon: Number(row.lon),
      lat: Number(row.lat),
      live_users_count: Number(row.live_users_count || 0)
    })),
    ...(safeAreaRows.map((row) => ({
      id: Number(row.id),
      name: row.name,
      kind: 'safe_area',
      lon: Number(row.lon),
      lat: Number(row.lat),
      live_users_count: Number(row.live_users_count || 0)
    })))
  ];

  const foodSources = (farmResult.rows || []).map((row) => ({
    id: String(row.id),
    name: row.name,
    lon: Number(row.lon),
    lat: Number(row.lat)
  }));

  const waterSources = (waterResult.rows || []).map((row) => ({
    id: String(row.id),
    name: row.name,
    lon: Number(row.lon),
    lat: Number(row.lat)
  }));

  const liveUsers = (liveUsersResult.rows || []).map((row) => ({
    user_id: String(row.user_id),
    lon: Number(row.lon),
    lat: Number(row.lat)
  }));

  return {
    sinks,
    foodSources,
    waterSources,
    liveUsers
  };
}

async function buildOrRefreshLogisticsPlan(settingsOverride = {}) {
  const storedState = await readLogisticsState();
  const settings = {
    foodUnitsPerPerson: 1,
    waterUnitsPerPerson: 2,
    foodTruckCapacity: 120,
    waterTruckCapacity: 200,
    routeMode: 'car',
    ...(storedState.settings || {}),
    ...settingsOverride
  };

  const snapshot = await fetchLogisticsSnapshot();
  const snapshotKey = logisticsSnapshotHash(snapshot, settings);

  if (storedState.snapshot_key === snapshotKey && Array.isArray(storedState.plan?.jobs)) {
    return {
      plan: storedState.plan,
      snapshotKey,
      settings
    };
  }

  const existingJobs = Array.isArray(storedState.plan?.jobs) ? clonePlanJobs(storedState.plan.jobs) : [];
  const fixedJobs = existingJobs.filter((job) => ['moving', 'arrived'].includes(job.status));
  const committedByKey = new Map();

  for (const job of fixedJobs) {
    const key = logisticsJobKey(job.resourceType, job.target?.kind || 'sink', job.target?.id);
    committedByKey.set(key, (committedByKey.get(key) || 0) + toFiniteNumber(job.amount, 0));
  }

  const nearestSinkCounts = assignLiveUsersToNearestSinks(snapshot.liveUsers, snapshot.sinks);

  const sinksForFood = snapshot.sinks.map((sink) => {
    const nearestCount = nearestSinkCounts.get(logisticsJobKey('nearest', sink.kind, sink.id)) || 0;
    const key = logisticsJobKey('food', sink.kind, sink.id);
    const demand = Math.max(0, Math.round(toFiniteNumber(nearestCount, 0) * toFiniteNumber(settings.foodUnitsPerPerson, 1)));
    const remainingDemand = Math.max(0, demand - (committedByKey.get(key) || 0));
    return { ...sink, remainingDemand };
  });

  const sinksForWater = snapshot.sinks.map((sink) => {
    const nearestCount = nearestSinkCounts.get(logisticsJobKey('nearest', sink.kind, sink.id)) || 0;
    const key = logisticsJobKey('water', sink.kind, sink.id);
    const demand = Math.max(0, Math.round(toFiniteNumber(nearestCount, 0) * toFiniteNumber(settings.waterUnitsPerPerson, 2)));
    const remainingDemand = Math.max(0, demand - (committedByKey.get(key) || 0));
    return { ...sink, remainingDemand };
  });

  const foodJobs = buildTruckJobsFromDemand({
    sinks: sinksForFood,
    sources: snapshot.foodSources,
    resourceType: 'food',
    truckCapacity: toFiniteNumber(settings.foodTruckCapacity, 120),
    settings
  });

  const waterJobs = buildTruckJobsFromDemand({
    sinks: sinksForWater,
    sources: snapshot.waterSources,
    resourceType: 'water',
    truckCapacity: toFiniteNumber(settings.waterTruckCapacity, 200),
    settings
  });

  const jobsToEnrich = [...fixedJobs, ...foodJobs, ...waterJobs];
  const enrichedJobs = await Promise.all(jobsToEnrich.map(async (job) => {
    if (job.route?.geometry?.coordinates?.length && job.status !== 'planned') {
      return job;
    }
    const route = await computeRouteBetweenPoints({
      originLon: job.source.lon,
      originLat: job.source.lat,
      destLon: job.target.lon,
      destLat: job.target.lat,
      mode: settings.routeMode
    });
    return {
      ...job,
      route,
      etaMinutes: Math.max(1, Math.round(Number(route.duration_s || 0) / 60)),
      distanceKm: (Number(route.distance_m || 0) / 1000).toFixed(2),
      etaLabel: `${Math.max(1, Math.round(Number(route.duration_s || 0) / 60))} min`,
      currentPosition: job.currentPosition || [job.source.lon, job.source.lat]
    };
  }));

  const plan = {
    version: snapshotKey,
    generated_at: new Date().toISOString(),
    settings,
    jobs: enrichedJobs
  };

  await saveLogisticsState({ plan, snapshotKey, settings });

  return { plan, snapshotKey, settings };
}

async function updateLogisticsTruck(truckId, update) {
  const state = await readLogisticsState();
  const jobs = Array.isArray(state.plan?.jobs) ? clonePlanJobs(state.plan.jobs) : [];
  const nextJobs = jobs.map((job) => {
    if (job.id !== truckId) return job;
    return {
      ...job,
      ...update,
      source: update.source ? { ...update.source } : job.source,
      target: update.target ? { ...update.target } : job.target,
      route: update.route ? { ...update.route, geometry: update.route.geometry ? { ...update.route.geometry } : update.route.geometry } : job.route
    };
  });

  const plan = {
    ...(state.plan || {}),
    updated_at: new Date().toISOString(),
    jobs: nextJobs
  };

  await saveLogisticsState({
    plan,
    snapshotKey: state.snapshot_key,
    settings: state.settings || {}
  });

  return plan;
}

let logisticsRefreshInFlight = false;
let logisticsRefreshQueued = false;

async function queueLogisticsRefresh(reason = 'mutation') {
  if (logisticsRefreshInFlight) {
    logisticsRefreshQueued = true;
    return;
  }

  logisticsRefreshInFlight = true;
  try {
    do {
      logisticsRefreshQueued = false;
      await buildOrRefreshLogisticsPlan();
    } while (logisticsRefreshQueued);
  } catch (error) {
    console.warn(`Automatic logistics refresh failed (${reason}):`, error.message);
  } finally {
    logisticsRefreshInFlight = false;
  }
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

const TILFLUKTSROM_WFS_BASE_URL = 'https://wfs.geonorge.no/skwms1/wfs.tilfluktsrom_offentlige';
const TILFLUKTSROM_WFS_TYPE_NAME = 'app:Tilfluktsrom';
// BBOX limits the WFS request to the Agder region only, avoiding 504 timeouts from fetching all of Norway.
const AGDER_WFS_BBOX_4326 = '7.0,57.8,9.5,59.0,EPSG:4326';
const TILFLUKTSROM_WFS_GML_URL = `${TILFLUKTSROM_WFS_BASE_URL}?service=WFS&version=2.0.0&request=GetFeature&typeNames=${encodeURIComponent(TILFLUKTSROM_WFS_TYPE_NAME)}&srsName=EPSG:4326&outputFormat=${encodeURIComponent('application/gml+xml; version=3.2')}&BBOX=${AGDER_WFS_BBOX_4326}`;
const TILFLUKTSROM_ZIP_FALLBACK_URL = 'https://nedlasting.geonorge.no/geonorge/Samfunnssikkerhet/TilfluktsromOffentlige/GeoJSON/Samfunnssikkerhet_0000_Norge_25833_TilfluktsromOffentlige_GeoJSON.zip';

const POPULATION_WFS_BASE_URL = 'https://wfs.geonorge.no/skwms1/wfs.befolkningpagrunnkretsniva';
const POPULATION_WFS_TYPE_NAME = 'app:BefolkningPåGrunnkrets';
const POPULATION_WFS_GML_URL = `${POPULATION_WFS_BASE_URL}?service=WFS&version=2.0.0&request=GetFeature&typeNames=${encodeURIComponent(POPULATION_WFS_TYPE_NAME)}&srsName=EPSG:4326&outputFormat=${encodeURIComponent('text/xml; subtype=gml/3.2.1')}&BBOX=${AGDER_WFS_BBOX_4326}`;
const POPULATION_ZIP_FALLBACK_URL = 'https://nedlasting.geonorge.no/geonorge/Befolkning/BefolkningPaGrunnkretsniva2025/GML/Befolkning_0000_Norge_25833_BefolkningPaGrunnkretsniva2025_GML.zip';

const FIRESTATIONS_WFS_BASE_URL = 'https://wfs.geonorge.no/skwms1/wfs.brannstasjoner';
const FIRESTATIONS_WFS_TYPE_NAME = 'app:Brannstasjon';
const FIRESTATIONS_WFS_GML_URL = `${FIRESTATIONS_WFS_BASE_URL}?service=WFS&version=2.0.0&request=GetFeature&typeNames=${encodeURIComponent(FIRESTATIONS_WFS_TYPE_NAME)}&srsName=EPSG:4326&outputFormat=${encodeURIComponent('text/xml; subtype=gml/3.2.1')}&BBOX=${AGDER_WFS_BBOX_4326}`;
const FIRESTATIONS_ZIP_FALLBACK_URL = 'https://nedlasting.geonorge.no/api/download/order/9e8cd748-a26f-4f93-8448-37a10fff8b35/ebba84f5-0e8c-4eb0-84e9-39e58cd40cf2';

const KARTVERKET_API_BASE = 'https://api.kartverket.no/kommuneinfo/v1';
const GEONORGE_COUNTIES_ZIP = 'https://nedlasting.geonorge.no/geonorge/Basisdata/Fylker/GeoJSON/Basisdata_0000_Norge_25833_Fylker_GeoJSON.zip';
const GEONORGE_MUNICIPALITIES_ZIP = 'https://nedlasting.geonorge.no/geonorge/Basisdata/Kommuner/GeoJSON/Basisdata_0000_Norge_25833_Kommuner_GeoJSON.zip';

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

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function xmlValue(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) return xmlValue(value[0]);
  if (typeof value === 'object') {
    if (value._ !== undefined && value._ !== null) return String(value._);
  }
  return undefined;
}

function extractPrefixedFields(record, prefix) {
  const out = {};
  if (!record || typeof record !== 'object') return out;
  for (const [key, raw] of Object.entries(record)) {
    if (!String(key).startsWith(prefix)) continue;
    const clean = String(key).slice(prefix.length);
    const value = xmlValue(raw);
    if (value !== undefined) {
      out[clean] = value;
    }
  }
  return out;
}

function extractSridFromSrsName(srsName) {
  const match = String(srsName || '').match(/(?:EPSG[:/]{1,2}|EPSG::)(\d+)/i);
  return match ? Number(match[1]) : null;
}

function normalizePointCoordinates(coords) {
  if (!Array.isArray(coords) || coords.length < 2) return null;
  const first = Number(coords[0]);
  const second = Number(coords[1]);
  if (!Number.isFinite(first) || !Number.isFinite(second)) return null;

  if (Math.abs(first) > 180 || Math.abs(second) > 180) {
    return [first, second];
  }

  // WFS/GML sources may emit geographic coordinates as lat lon. Normalize to lon lat.
  if (first > 40 && second < 40) {
    return [second, first];
  }

  return [first, second];
}

function findFirstObjectWithPointGeometry(node) {
  if (!node) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findFirstObjectWithPointGeometry(item);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;

  const directPointText = xmlValue(node['gml:pos']) || xmlValue(node['gml:coordinates']) || xmlValue(node['gml:posList']);
  if (directPointText) return node;

  if (node['gml:Point'] || node['gml32:Point']) return node;

  for (const value of Object.values(node)) {
    const found = findFirstObjectWithPointGeometry(value);
    if (found) return found;
  }

  return null;
}

function extractPointFromGmlNode(node) {
  if (!node || typeof node !== 'object') return null;

  const pointNode = node['gml:Point'] || node['gml32:Point'] || node;
  const posText =
    xmlValue(pointNode['gml:pos']) ||
    xmlValue(pointNode['gml:coordinates']) ||
    xmlValue(pointNode['gml:posList']) ||
    xmlValue(pointNode['pos']);

  if (!posText) return null;

  const coords = posText.split(/\s+/).map(Number).filter(Number.isFinite);
  const normalized = normalizePointCoordinates(coords);
  if (!normalized) return null;

  return {
    coordinates: normalized,
    srid: extractSridFromSrsName(pointNode.srsName || node.srsName || pointNode['gml:srsName'] || node['gml:srsName'])
  };
}

function findFirstObjectWithPolygonGeometry(node) {
  if (!node) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findFirstObjectWithPolygonGeometry(item);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;

  if (node['gml:Polygon'] || node['gml32:Polygon'] || node['gml:Surface'] || node['gml:MultiSurface']) {
    return node;
  }

  for (const value of Object.values(node)) {
    const found = findFirstObjectWithPolygonGeometry(value);
    if (found) return found;
  }

  return null;
}

function parsePosListCoordinates(posText) {
  if (!posText) return [];
  const values = String(posText).trim().split(/\s+/).map(Number).filter(Number.isFinite);
  const coordinates = [];

  for (let i = 0; i + 1 < values.length; i += 2) {
    const normalized = normalizePointCoordinates([values[i], values[i + 1]]);
    if (normalized) coordinates.push(normalized);
  }

  return coordinates;
}

function extractLinearRingCoordinates(ringContainer) {
  const ringNode = ringContainer?.['gml:LinearRing'] || ringContainer;
  const posListText =
    xmlValue(ringNode?.['gml:posList']) ||
    xmlValue(ringNode?.['gml:coordinates']);
  return parsePosListCoordinates(posListText);
}

function extractPolygonCoordinates(polygonNode) {
  const exteriorContainer = polygonNode?.['gml:exterior'];
  const exterior = extractLinearRingCoordinates(exteriorContainer);
  if (!Array.isArray(exterior) || exterior.length < 4) return null;

  const rings = [exterior];
  for (const interior of asArray(polygonNode?.['gml:interior'])) {
    const interiorRing = extractLinearRingCoordinates(interior);
    if (Array.isArray(interiorRing) && interiorRing.length >= 4) {
      rings.push(interiorRing);
    }
  }

  return rings;
}

function extractPolygonFromGmlNode(node) {
  if (!node || typeof node !== 'object') return null;

  const srid = extractSridFromSrsName(
    node?.srsName ||
    node?.['gml:srsName'] ||
    node?.['gml:Polygon']?.srsName ||
    node?.['gml:Polygon']?.['gml:srsName'] ||
    node?.['gml:Surface']?.srsName ||
    node?.['gml:Surface']?.['gml:srsName'] ||
    node?.['gml:MultiSurface']?.srsName ||
    node?.['gml:MultiSurface']?.['gml:srsName']
  );

  const polygonNode = node['gml:Polygon'] || node['gml32:Polygon'] || node;
  const polygonCoords = extractPolygonCoordinates(polygonNode);
  if (polygonCoords) {
    return {
      geometry: { type: 'Polygon', coordinates: polygonCoords },
      srid,
    };
  }

  const surfaceNode = node['gml:Surface'];
  if (surfaceNode) {
    const patch = asArray(surfaceNode?.['gml:patches']?.['gml:PolygonPatch'])[0];
    const patchCoords = extractPolygonCoordinates(patch);
    if (patchCoords) {
      return {
        geometry: { type: 'Polygon', coordinates: patchCoords },
        srid,
      };
    }
  }

  const multiSurfaceNode = node['gml:MultiSurface'];
  if (multiSurfaceNode) {
    const polygons = [];
    const surfaceMembers = asArray(multiSurfaceNode?.['gml:surfaceMember']);
    for (const member of surfaceMembers) {
      const memberPolygon = extractPolygonFromGmlNode(member);
      if (!memberPolygon?.geometry) continue;

      if (memberPolygon.geometry.type === 'Polygon') {
        polygons.push(memberPolygon.geometry.coordinates);
      } else if (memberPolygon.geometry.type === 'MultiPolygon') {
        polygons.push(...memberPolygon.geometry.coordinates);
      }
    }

    if (polygons.length > 0) {
      return {
        geometry: { type: 'MultiPolygon', coordinates: polygons },
        srid,
      };
    }
  }

  return null;
}

function collectGmlFeaturesByLocalName(node, localName, results = []) {
  if (!node) return results;
  if (Array.isArray(node)) {
    for (const item of node) {
      collectGmlFeaturesByLocalName(item, localName, results);
    }
    return results;
  }

  if (typeof node !== 'object') return results;

  for (const [key, value] of Object.entries(node)) {
    const suffix = String(key).split(':').pop();
    if (suffix && suffix.toLowerCase() === String(localName).toLowerCase()) {
      for (const item of asArray(value)) {
        if (item && typeof item === 'object') {
          results.push(item);
        }
      }
    }

    collectGmlFeaturesByLocalName(value, localName, results);
  }

  return results;
}

async function extractTilfluktsromFromGmlZip(buffer) {
  try {
    const zip = new AdmZip(buffer);
    const entries = zip.getEntries();
    const gmlEntry = entries.find((entry) => {
      const lower = String(entry.name || '').toLowerCase();
      return !entry.isDirectory && lower.endsWith('.gml');
    });

    if (!gmlEntry) return { type: 'FeatureCollection', features: [] };

    const xml = gmlEntry.getData().toString('utf8').replace(/^\uFEFF/, '');
    const parsed = await xml2js.parseStringPromise(xml, {
      explicitArray: false,
      mergeAttrs: true,
      trim: true,
    });

    const stations = collectGmlFeaturesByLocalName(parsed, 'Tilfluktsrom');
    const features = [];

    for (const station of stations) {
      const geometryNode = findFirstObjectWithPointGeometry(station);
      const point = extractPointFromGmlNode(geometryNode);
      if (!point || !point.coordinates) continue;

      const properties = {
        ...extractPrefixedFields(station, 'app:'),
        gml_id: station?.['gml:id'] || undefined,
      };

      features.push({
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: point.coordinates,
        },
        properties,
      });
    }

    return { type: 'FeatureCollection', features };
  } catch (error) {
    console.error('GML extraction error:', error.message);
    return { type: 'FeatureCollection', features: [] };
  }
}

async function extractTilfluktsromFromWfsGml(buffer) {
  try {
    const xml = buffer.toString('utf8').replace(/^﻿/, '');
    const parsed = await xml2js.parseStringPromise(xml, {
      explicitArray: false,
      mergeAttrs: true,
      trim: true,
    });

    const stations = collectGmlFeaturesByLocalName(parsed, 'Tilfluktsrom');
    const features = [];

    for (const station of stations) {
      const geometryNode = findFirstObjectWithPointGeometry(station);
      const point = extractPointFromGmlNode(geometryNode);
      if (!point || !point.coordinates) continue;

      const properties = {
        ...extractPrefixedFields(station, 'app:'),
        gml_id: station?.['gml:id'] || undefined,
      };

      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: point.coordinates },
        properties,
      });
    }

    return { type: 'FeatureCollection', features };
  } catch (error) {
    console.error('WFS GML extraction error:', error.message);
    return { type: 'FeatureCollection', features: [] };
  }
}

function extractPopulationFeatureCollectionFromParsedGml(parsed) {
  const rows = collectGmlFeaturesByLocalName(parsed, 'BefolkningPåGrunnkrets');
  const features = [];

  for (const row of rows) {
    const areaNode = row?.['app:område'] || row?.['område'];
    const geometryNode = areaNode || findFirstObjectWithPolygonGeometry(row);
    const polygon = extractPolygonFromGmlNode(geometryNode);
    if (!polygon?.geometry) continue;

    const properties = {
      ...extractPrefixedFields(row, 'app:'),
      gml_id: row?.['gml:id'] || undefined,
    };

    if (properties.totalBefolkning !== undefined && properties.population === undefined) {
      properties.population = properties.totalBefolkning;
    }

    features.push({
      type: 'Feature',
      geometry: polygon.geometry,
      properties,
    });
  }

  return { type: 'FeatureCollection', features };
}

async function extractPopulationFromWfsGml(buffer) {
  try {
    const xml = buffer.toString('utf8').replace(/^﻿/, '');
    const parsed = await xml2js.parseStringPromise(xml, {
      explicitArray: false,
      mergeAttrs: true,
      trim: true,
    });

    return extractPopulationFeatureCollectionFromParsedGml(parsed);
  } catch (error) {
    console.error('Population WFS GML extraction error:', error.message);
    return { type: 'FeatureCollection', features: [] };
  }
}

async function extractPopulationFromGmlZip(buffer) {
  try {
    const zip = new AdmZip(buffer);
    const entries = zip.getEntries();
    const gmlEntry = entries.find((entry) => {
      const lower = String(entry.name || '').toLowerCase();
      return !entry.isDirectory && lower.endsWith('.gml');
    });

    if (!gmlEntry) return { type: 'FeatureCollection', features: [] };

    const xml = gmlEntry.getData().toString('utf8').replace(/^\uFEFF/, '');
    const parsed = await xml2js.parseStringPromise(xml, {
      explicitArray: false,
      mergeAttrs: true,
      trim: true,
    });

    return extractPopulationFeatureCollectionFromParsedGml(parsed);
  } catch (error) {
    console.error('Population ZIP GML extraction error:', error.message);
    return { type: 'FeatureCollection', features: [] };
  }
}

async function extractFireStationsFromWfsGml(buffer) {
  try {
    const xml = buffer.toString('utf8').replace(/^﻿/, '');
    const parsed = await xml2js.parseStringPromise(xml, {
      explicitArray: false,
      mergeAttrs: true,
      trim: true,
    });

    const stations = collectGmlFeaturesByLocalName(parsed, 'Brannstasjon');
    const features = [];

    for (const station of stations) {
      const geometryNode = station?.['app:posisjon'] || station?.['posisjon'] || findFirstObjectWithPointGeometry(station);
      const point = extractPointFromGmlNode(geometryNode);
      if (!point || !point.coordinates) continue;

      const properties = {
        ...extractPrefixedFields(station, 'app:'),
        gml_id: station?.['gml:id'] || undefined,
      };

      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: point.coordinates },
        properties,
      });
    }

    return { type: 'FeatureCollection', features };
  } catch (error) {
    console.error('Fire stations WFS GML extraction error:', error.message);
    return { type: 'FeatureCollection', features: [] };
  }
}

async function extractFireStationsFromGmlZip(buffer) {
  try {
    const zip = new AdmZip(buffer);
    const entries = zip.getEntries();
    const gmlEntry = entries.find((entry) => {
      const lower = String(entry.name || '').toLowerCase();
      return !entry.isDirectory && lower.endsWith('.gml');
    });

    if (!gmlEntry) return { type: 'FeatureCollection', features: [] };

    const xml = gmlEntry.getData().toString('utf8').replace(/^\uFEFF/, '');
    const parsed = await xml2js.parseStringPromise(xml, {
      explicitArray: false,
      mergeAttrs: true,
      trim: true,
    });

    const members = asArray(parsed?.['gml:FeatureCollection']?.['gml:featureMember']);
    const features = [];

    for (const member of members) {
      const station = member?.['app:Brannstasjon'];
      if (!station) continue;

      const posText = xmlValue(station?.['app:posisjon']?.['gml:Point']?.['gml:pos']);
      if (!posText) continue;

      const coords = posText.split(/\s+/).map(Number).filter(Number.isFinite);
      if (coords.length < 2) continue;

      // In EPSG:4258 GML, positions are typically stored as lat lon.
      const lat = coords[0];
      const lon = coords[1];
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;

      const properties = {
        ...extractPrefixedFields(station, 'app:'),
        gml_id: station?.['gml:id'] || undefined,
      };

      features.push({
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [lon, lat],
        },
        properties,
      });
    }

    return { type: 'FeatureCollection', features };
  } catch (error) {
    console.error('GML extraction error:', error.message);
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

async function cacheTilfluktsromGeoJson() {
  const cacheFile = path.join(CACHE_DIR, 'shelters.geojson');

  if (fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (Array.isArray(cached?.features) && cached.features.length > 0) {
        return cached;
      }
      fs.unlinkSync(cacheFile);
    } catch (error) {
      fs.unlinkSync(cacheFile);
    }
  }

  try {
    console.log('Downloading shelters from Geonorge WFS GML (Agder BBOX)...');
    const wfsBuffer = await downloadBuffer(TILFLUKTSROM_WFS_GML_URL, 60000);
    const wfsGeoJson = await extractTilfluktsromFromWfsGml(wfsBuffer);
    const transformedWfsGeoJson = await transformProjectedFeatureCollection(wfsGeoJson);

    if (Array.isArray(transformedWfsGeoJson.features) && transformedWfsGeoJson.features.length > 0) {
      fs.writeFileSync(cacheFile, JSON.stringify(transformedWfsGeoJson));
      console.log(`✓ Shelters loaded from WFS GML: ${transformedWfsGeoJson.features.length}`);
      return transformedWfsGeoJson;
    }

    console.warn('WFS GML returned no shelter features, falling back to nedlasting.geonorge.no zip...');
  } catch (error) {
    console.warn(`WFS shelter download failed, falling back to zip: ${error.message}`);
  }

  const fallbackGeoJson = await cacheGeoJsonFromZip('shelters', TILFLUKTSROM_ZIP_FALLBACK_URL);
  const transformedFallback = await transformProjectedFeatureCollection(fallbackGeoJson);
  fs.writeFileSync(cacheFile, JSON.stringify(transformedFallback));
  return transformedFallback;
}

async function cachePopulationGeoJson() {
  const cacheFile = path.join(CACHE_DIR, 'population.geojson');

  if (fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (Array.isArray(cached?.features) && cached.features.length > 0) {
        return cached;
      }
      fs.unlinkSync(cacheFile);
    } catch (error) {
      fs.unlinkSync(cacheFile);
    }
  }

  try {
    console.log('Downloading population from Geonorge WFS GML (Agder BBOX)...');
    const wfsBuffer = await downloadBuffer(POPULATION_WFS_GML_URL, 90000);
    const wfsGeoJson = await extractPopulationFromWfsGml(wfsBuffer);
    const transformedWfsGeoJson = await transformProjectedFeatureCollection(wfsGeoJson);

    if (Array.isArray(transformedWfsGeoJson.features) && transformedWfsGeoJson.features.length > 0) {
      fs.writeFileSync(cacheFile, JSON.stringify(transformedWfsGeoJson));
      console.log(`✓ Population loaded from WFS GML: ${transformedWfsGeoJson.features.length}`);
      return transformedWfsGeoJson;
    }

    console.warn('WFS GML returned no population features, falling back to nedlasting.geonorge.no zip...');
  } catch (error) {
    console.warn(`WFS population download failed, falling back to zip: ${error.message}`);
  }

  try {
    const fallbackBuffer = await downloadBuffer(POPULATION_ZIP_FALLBACK_URL);
    const fallbackGeoJson = await extractPopulationFromGmlZip(fallbackBuffer);
    const transformedFallback = await transformProjectedFeatureCollection(fallbackGeoJson);
    fs.writeFileSync(cacheFile, JSON.stringify(transformedFallback));
    return transformedFallback;
  } catch (error) {
    console.error('Population fallback failed:', error.message);
    return { type: 'FeatureCollection', features: [] };
  }
}

async function cacheFireStationsGeoJson() {
  const cacheFile = path.join(CACHE_DIR, 'firestations.geojson');

  if (fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (Array.isArray(cached?.features) && cached.features.length > 0) {
        return cached;
      }
      fs.unlinkSync(cacheFile);
    } catch (error) {
      fs.unlinkSync(cacheFile);
    }
  }

  try {
    console.log('Downloading fire stations from Geonorge WFS GML (Agder BBOX)...');
    const wfsBuffer = await downloadBuffer(FIRESTATIONS_WFS_GML_URL, 90000);
    const wfsGeoJson = await extractFireStationsFromWfsGml(wfsBuffer);
    const transformedWfsGeoJson = await transformProjectedFeatureCollection(wfsGeoJson);

    if (Array.isArray(transformedWfsGeoJson.features) && transformedWfsGeoJson.features.length > 0) {
      fs.writeFileSync(cacheFile, JSON.stringify(transformedWfsGeoJson));
      console.log(`✓ Fire stations loaded from WFS GML: ${transformedWfsGeoJson.features.length}`);
      return transformedWfsGeoJson;
    }

    console.warn('WFS GML returned no fire station features, falling back to nedlasting.geonorge.no zip...');
  } catch (error) {
    console.warn(`WFS fire station download failed, falling back to zip: ${error.message}`);
  }

  try {
    const fallbackBuffer = await downloadBuffer(FIRESTATIONS_ZIP_FALLBACK_URL);
    const fallbackGeoJson = await extractFireStationsFromGmlZip(fallbackBuffer);
    const transformedFallback = await transformProjectedFeatureCollection(fallbackGeoJson);
    fs.writeFileSync(cacheFile, JSON.stringify(transformedFallback));
    return transformedFallback;
  } catch (error) {
    console.error('Fire stations fallback failed:', error.message);
    return { type: 'FeatureCollection', features: [] };
  }
}

function kartverketOmradeToGeometry(omrade) {
  if (!omrade || !omrade.type || !omrade.coordinates) return null;
  return { type: omrade.type, coordinates: omrade.coordinates };
}

async function fetchFylkerFromKartverket() {
  console.log('Fetching fylker from Kartverket API...');
  const listResp = await axios.get(`${KARTVERKET_API_BASE}/fylkerkommuner`, { timeout: 30000 });
  const fylkerData = Array.isArray(listResp.data) ? listResp.data : [];
  if (fylkerData.length === 0) throw new Error('Kartverket API returned empty fylke list');

  const features = [];
  const batchSize = 5;
  for (let i = 0; i < fylkerData.length; i += batchSize) {
    const batch = fylkerData.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      batch.map(async (fylke) => {
        const resp = await axios.get(
          `${KARTVERKET_API_BASE}/fylker/${fylke.fylkesnummer}/omrade`,
          { timeout: 15000 }
        );
        const geometry = kartverketOmradeToGeometry(resp.data.omrade);
        if (!geometry) throw new Error(`No omrade in response for fylke ${fylke.fylkesnummer}`);
        return {
          type: 'Feature',
          properties: { fylkesnummer: fylke.fylkesnummer, fylkesnavn: fylke.fylkesnavn },
          geometry
        };
      })
    );
    for (const r of results) {
      if (r.status === 'fulfilled') features.push(r.value);
      else console.warn(`Fylke omrade fetch failed: ${r.reason?.message}`);
    }
  }
  if (features.length === 0) throw new Error('No fylker fetched from Kartverket API');
  console.log(`✓ Fetched ${features.length} fylker from Kartverket API`);
  return { type: 'FeatureCollection', features };
}

async function fetchKommunerFromKartverket() {
  console.log('Fetching kommuner from Kartverket API...');
  const listResp = await axios.get(`${KARTVERKET_API_BASE}/fylkerkommuner`, { timeout: 30000 });
  const fylkerData = Array.isArray(listResp.data) ? listResp.data : [];

  const kommuneList = [];
  for (const fylke of fylkerData) {
    for (const k of (fylke.kommuner || [])) {
      kommuneList.push({
        kommunenummer: k.kommunenummer,
        kommunenavn: k.kommunenavnNorsk || k.kommunenavn,
        fylkesnavn: fylke.fylkesnavn,
        fylkesnummer: fylke.fylkesnummer
      });
    }
  }
  if (kommuneList.length === 0) throw new Error('Kartverket API returned no kommuner');

  const features = [];
  const batchSize = 10;
  for (let i = 0; i < kommuneList.length; i += batchSize) {
    const batch = kommuneList.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      batch.map(async (k) => {
        const resp = await axios.get(
          `${KARTVERKET_API_BASE}/kommuner/${k.kommunenummer}/omrade`,
          { timeout: 15000 }
        );
        const geometry = kartverketOmradeToGeometry(resp.data.omrade);
        if (!geometry) throw new Error(`No omrade for kommune ${k.kommunenummer}`);
        return {
          type: 'Feature',
          properties: {
            kommunenummer: k.kommunenummer,
            kommunenavn: k.kommunenavn,
            fylkesnavn: k.fylkesnavn,
            fylkesnummer: k.fylkesnummer
          },
          geometry
        };
      })
    );
    for (const r of results) {
      if (r.status === 'fulfilled') features.push(r.value);
      else console.warn(`Kommune omrade fetch failed: ${r.reason?.message}`);
    }
  }
  if (features.length === 0) throw new Error('No kommuner fetched from Kartverket API');
  console.log(`✓ Fetched ${features.length} kommuner from Kartverket API`);
  return { type: 'FeatureCollection', features };
}

async function refreshBoundaryLayer(layer) {
  if (layer !== 'counties' && layer !== 'municipalities') {
    return { type: 'FeatureCollection', features: [] };
  }

  // Primary: Kartverket API (ETRS89 ≈ WGS84, no reprojection needed)
  try {
    const geojson = layer === 'counties'
      ? await fetchFylkerFromKartverket()
      : await fetchKommunerFromKartverket();
    if (geojson?.features?.length > 0) {
      fs.writeFileSync(path.join(CACHE_DIR, `${layer}.geojson`), JSON.stringify(geojson));
      return geojson;
    }
  } catch (error) {
    console.warn(`Kartverket API unavailable for ${layer}: ${error.message}. Falling back to Geonorge ZIP.`);
  }

  // Fallback: download ZIP from Geonorge and reproject from EPSG:25833
  const fallbackUrl = layer === 'counties' ? GEONORGE_COUNTIES_ZIP : GEONORGE_MUNICIPALITIES_ZIP;
  const rawCacheFile = path.join(CACHE_DIR, `${layer}_raw.geojson`);
  let raw;
  if (fs.existsSync(rawCacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(rawCacheFile, 'utf8'));
      if (Array.isArray(cached?.features) && cached.features.length > 0) raw = cached;
    } catch (e) {
      fs.unlinkSync(rawCacheFile);
    }
  }
  if (!raw) {
    console.log(`Downloading ${layer} from Geonorge (${fallbackUrl.substring(0, 60)}...)...`);
    const buffer = await downloadBuffer(fallbackUrl);
    raw = await extractGeoJsonFromZip(buffer, layer);
    fs.writeFileSync(rawCacheFile, JSON.stringify(raw));
  }
  const transformed = await transformProjectedFeatureCollection(raw);
  fs.writeFileSync(path.join(CACHE_DIR, `${layer}.geojson`), JSON.stringify(transformed));
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

async function getBoundaryLayerGeoJsonFiltered(layer) {
  const fullGeoJson = await getBoundaryLayerGeoJson(layer);
  
  // Agder fylke bounds (approximate coordinates for Agder region in southern Norway)
  const agderBBox = {
    type: 'Polygon',
    coordinates: [[[7.0, 57.8], [9.5, 57.8], [9.5, 59.0], [7.0, 59.0], [7.0, 57.8]]]
  };
  
  // Filter features that intersect with Agder bounds
  const filteredFeatures = fullGeoJson.features.filter(feature => {
    try {
      // Simple bounding box intersection check
      const geom = feature.geometry;
      if (!geom) return false;
      
      // Get bounds of the feature
      let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
      
      function processCoords(coords) {
        if (Array.isArray(coords[0])) {
          coords.forEach(processCoords);
        } else {
          minLon = Math.min(minLon, coords[0]);
          maxLon = Math.max(maxLon, coords[0]);
          minLat = Math.min(minLat, coords[1]);
          maxLat = Math.max(maxLat, coords[1]);
        }
      }
      
      if (geom.type === 'Polygon' || geom.type === 'MultiPolygon') {
        processCoords(geom.coordinates);
      } else if (geom.type === 'Point') {
        minLon = maxLon = geom.coordinates[0];
        minLat = maxLat = geom.coordinates[1];
      }
      
      // Check if feature bounds intersect with Agder bounds
      const agderMinLon = 7.0, agderMaxLon = 9.5, agderMinLat = 57.8, agderMaxLat = 59.0;
      
      return !(maxLon < agderMinLon || minLon > agderMaxLon || maxLat < agderMinLat || minLat > agderMaxLat);
    } catch (e) {
      console.warn(`Error filtering feature:`, e.message);
      return false;
    }
  });
  
  return {
    type: 'FeatureCollection',
    features: filteredFeatures
  };
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
  return transformProjectedFeatureCollectionWithSrid(geojson, 25833);
}

async function transformProjectedFeatureCollectionWithSrid(geojson, sourceSrid = 25833) {
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
          `SELECT ST_AsGeoJSON(ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON($1), $2), 4326))::json AS geom`,
          [geomJson, sourceSrid]
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
    await pool.query('CREATE SCHEMA IF NOT EXISTS brannstasjoner');
    await pool.query('CREATE SCHEMA IF NOT EXISTS overture');
    
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

    // Fire stations used by analysis endpoints.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS brannstasjoner.brannstasjon (
        id SERIAL PRIMARY KEY,
        objid TEXT UNIQUE,
        brannstasjon TEXT,
        brannvesen TEXT,
        stasjonstype TEXT,
        kasernert TEXT,
        opphav TEXT,
        posisjon GEOMETRY(Point, 4326),
        raw_properties JSONB
      )
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_brannstasjon_posisjon ON brannstasjoner.brannstasjon USING GIST(posisjon)
    `);

    // Overture Maps data tables
    await pool.query(`
      CREATE TABLE IF NOT EXISTS overture.farms (
        id TEXT PRIMARY KEY,
        name VARCHAR(255),
        location GEOMETRY(Point, 4326),
        raw_properties JSONB
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_farms_location ON overture.farms USING GIST(location)
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS overture.water_sources (
        id TEXT PRIMARY KEY,
        name VARCHAR(255),
        location GEOMETRY(Point, 4326),
        raw_properties JSONB
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_water_sources_location ON overture.water_sources USING GIST(location)
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS overture.doctors (
        id TEXT PRIMARY KEY,
        name VARCHAR(255),
        location GEOMETRY(Point, 4326),
        raw_properties JSONB
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_doctors_location ON overture.doctors USING GIST(location)
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS overture.hospitals (
        id TEXT PRIMARY KEY,
        name VARCHAR(255),
        location GEOMETRY(Point, 4326),
        raw_properties JSONB
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_hospitals_location ON overture.hospitals USING GIST(location)
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

    await ensureLogisticsStateTable();
    
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

async function ingestFireStations(geojson) {
  if (!geojson.features) return 0;

  let inserted = 0;
  for (const feature of geojson.features) {
    try {
      const properties = feature.properties || {};
      const coord = firstCoordinate(feature.geometry);
      if (!coord || coord.length < 2) continue;

      const lon = Number(coord[0]);
      const lat = Number(coord[1]);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;

      const fallbackId = `${lon.toFixed(6)}_${lat.toFixed(6)}`;
      const objid = String(getPropIgnoreCase(properties, ['objid', 'anleggid', 'gml_id']) || fallbackId);
      const brannstasjon = String(getPropIgnoreCase(properties, ['brannstasjon', 'name', 'navn']) || 'Brannstasjon');
      const brannvesen = String(getPropIgnoreCase(properties, ['brannvesen']) || '');
      const stasjonstype = String(getPropIgnoreCase(properties, ['stasjonstype']) || '');
      const kasernert = String(getPropIgnoreCase(properties, ['kasernert']) || '');
      const opphav = String(getPropIgnoreCase(properties, ['opphav']) || '');

      await pool.query(`
        INSERT INTO brannstasjoner.brannstasjon
          (objid, brannstasjon, brannvesen, stasjonstype, kasernert, opphav, posisjon, raw_properties)
        VALUES
          ($1, $2, $3, $4, $5, $6, ST_SetSRID(ST_MakePoint($7, $8), 4326), $9)
        ON CONFLICT (objid) DO UPDATE SET
          brannstasjon = EXCLUDED.brannstasjon,
          brannvesen = EXCLUDED.brannvesen,
          stasjonstype = EXCLUDED.stasjonstype,
          kasernert = EXCLUDED.kasernert,
          opphav = EXCLUDED.opphav,
          posisjon = EXCLUDED.posisjon,
          raw_properties = EXCLUDED.raw_properties
      `, [objid, brannstasjon, brannvesen, stasjonstype, kasernert, opphav, lon, lat, JSON.stringify(properties)]);

      inserted++;
    } catch (error) {
      console.error('Ingest fire station error:', error.message);
    }
  }

  return inserted;
}

async function ingestOvertureLayer(table, features) {
  if (!features || features.length === 0) return 0;

  let inserted = 0;
  for (const feature of features) {
    try {
      const properties = feature.properties || {};
      const geometry = feature.geometry;
      if (!geometry || !geometry.coordinates) continue;

      const id = String(properties.id || feature.id || `${geometry.coordinates[0]}_${geometry.coordinates[1]}`);
      const name = String(properties.name || properties.names?.primary || 'Unknown');
      const lon = Number(geometry.coordinates[0]);
      const lat = Number(geometry.coordinates[1]);

      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;

      await pool.query(`
        INSERT INTO overture.${table}
          (id, name, location, raw_properties)
        VALUES
          ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326), $5)
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          location = EXCLUDED.location,
          raw_properties = EXCLUDED.raw_properties
      `, [id, name, lon, lat, JSON.stringify(properties)]);

      inserted++;
    } catch (error) {
      console.error(`Ingest ${table} error:`, error.message);
    }
  }

  return inserted;
}

async function downloadAndIngestOvertureData() {
  try {
    const geoJsonFile = '/app/places_agder.geojson';
    
    // Download if not already present
    if (!fs.existsSync(geoJsonFile)) {
      console.log('Running Overture Maps download for Agder...');
      try {
        execSync('python3 /app/download_overture.py', { stdio: 'inherit', timeout: 300000 });
      } catch (error) {
        console.warn('Overture download warning:', error.message);
        return 0;
      }
    }
    
    if (!fs.existsSync(geoJsonFile)) {
      console.warn('Overture GeoJSON file not found');
      return 0;
    }
    
    // Parse GeoJSON and categorize by place type
    const geojson = JSON.parse(fs.readFileSync(geoJsonFile, 'utf8'));
    if (!geojson.features) return 0;
    
    console.log(`Processing ${geojson.features.length} Overture place features...`);
    
    let inserted = 0;
    const typeMap = {
      farms: [],
      water_sources: [],
      doctors: [],
      hospitals: [],
      other: []
    };
    
    for (const feature of geojson.features) {
      const props = feature.properties || {};
      const geometry = feature.geometry;
      if (!geometry || geometry.type !== 'Point') continue;
      
      const id = props.id || uuidv4();
      const name = props.name || props.names?.primary || 'Unknown Place';
      const lon = geometry.coordinates[0];
      const lat = geometry.coordinates[1];
      const categories = props.categories || {};
      const categoryPrimary = (categories.primary || '').toLowerCase();
      
      // Categorize by primary category
      let category = 'other';
      if (categoryPrimary.includes('farm') || categoryPrimary.includes('agricultural')) {
        category = 'farms';
      } else if (categoryPrimary.includes('water')) {
        category = 'water_sources';
      } else if (categoryPrimary.includes('doctor') || categoryPrimary.includes('clinic') || categoryPrimary.includes('urgent_care')) {
        category = 'doctors';
      } else if (categoryPrimary.includes('hospital')) {
        category = 'hospitals';
      }
      
      if (category !== 'other') {
        typeMap[category].push({ id, name, lon, lat, props });
        inserted++;
      }
    }
    
    // Ingest categorized places
    for (const [table, places] of Object.entries(typeMap)) {
      if (table === 'other' || places.length === 0) continue;
      
      for (const place of places) {
        try {
          await pool.query(`
            INSERT INTO overture.${table} (id, name, location, raw_properties)
            VALUES ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326), $5)
            ON CONFLICT (id) DO UPDATE SET
              name = EXCLUDED.name,
              location = EXCLUDED.location,
              raw_properties = EXCLUDED.raw_properties
          `, [place.id, place.name, place.lon, place.lat, JSON.stringify(place.props)]);
        } catch (error) {
          console.error(`Error ingesting ${table}:`, error.message);
        }
      }
      console.log(`✓ Ingested ${places.length} places into ${table}`);
    }
    
    return inserted;
  } catch (error) {
    console.error('Overture data ingestion error:', error.message);
    return 0;
  }
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
      (SELECT COALESCE(SUM(population), 0)::bigint FROM public.population_cells) AS population_sum,
      (SELECT COUNT(*)::int FROM brannstasjoner.brannstasjon) AS fire_stations
  `);
  let existingShelters = Number(existing.rows[0]?.shelters || 0);
  let existingPopulation = Number(existing.rows[0]?.population || 0);
  let existingPopulationSum = Number(existing.rows[0]?.population_sum || 0);
  const existingFireStations = Number(existing.rows[0]?.fire_stations || 0);

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

  // Download and ingest shelters
  if (existingShelters === 0) {
    try {
      console.log('Downloading shelters...');
      const sheltersGeo = await cacheTilfluktsromGeoJson();
      const count = await ingestShelters(sheltersGeo);
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
      const popGeo = await cachePopulationGeoJson();
      const count = await ingestPopulation(popGeo);
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

  // Download and ingest fire stations from provided Geonorge GML ZIP.
  if (existingFireStations === 0) {
    try {
      console.log('Downloading fire stations...');
      const fireGeo = await cacheFireStationsGeoJson();
      const fireCount = await ingestFireStations(fireGeo);
      console.log(`✓ Fire stations ingested: ${fireCount}`);
    } catch (error) {
      console.error('Fire stations bootstrap failed:', error.message);
    }
  } else {
    console.log(`Skipping fire station ingest (already ${existingFireStations} rows).`);
  }

  // Download and ingest real Overture Maps data for Agder
  try {
    const farmCountResult = await pool.query('SELECT COUNT(*) as count FROM overture.farms');
    const farmCount = Number(farmCountResult.rows[0]?.count || 0);
    if (farmCount === 0) {
      console.log('Downloading real Overture Maps data for Agder...');
      const count = await downloadAndIngestOvertureData();
      if (count > 0) {
        console.log(`✓ Overture data loaded: ${count} features across all categories`);
      } else {
        console.log('No Overture data ingested, using sample data fallback...');
        // Sample farms in Agder region (fallback if download fails)
        const farmSamples = [
          { id: 'farm_1', name: 'Gård Kristiansand', lon: 8.767, lat: 58.015 },
          { id: 'farm_2', name: 'Økogård Lillesand', lon: 8.376, lat: 58.267 },
          { id: 'farm_3', name: 'Appelsinhagen', lon: 7.751, lat: 58.469 }
        ];
        for (const farm of farmSamples) {
          await pool.query(`
            INSERT INTO overture.farms (id, name, location, raw_properties)
            VALUES ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326), $5)
            ON CONFLICT (id) DO NOTHING
          `, [farm.id, farm.name, farm.lon, farm.lat, JSON.stringify(farm)]);
        }
        
        // Sample water sources
        const waterSamples = [
          { id: 'water_1', name: 'Vannverk Mandal', lon: 7.467, lat: 58.031 },
          { id: 'water_2', name: 'Vannbehandling Arendal', lon: 8.769, lat: 58.460 }
        ];
        for (const water of waterSamples) {
          await pool.query(`
            INSERT INTO overture.water_sources (id, name, location, raw_properties)
            VALUES ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326), $5)
            ON CONFLICT (id) DO NOTHING
          `, [water.id, water.name, water.lon, water.lat, JSON.stringify(water)]);
        }
        
        // Sample doctors/urgent care
        const doctorSamples = [
          { id: 'doc_1', name: 'Legevakt Kristiansand', lon: 8.772, lat: 58.010 },
          { id: 'doc_2', name: 'Legevakt Arendal', lon: 8.769, lat: 58.462 },
          { id: 'doc_3', name: 'Legevakt Mandal', lon: 7.467, lat: 58.032 }
        ];
        for (const doctor of doctorSamples) {
          await pool.query(`
            INSERT INTO overture.doctors (id, name, location, raw_properties)
            VALUES ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326), $5)
            ON CONFLICT (id) DO NOTHING
          `, [doctor.id, doctor.name, doctor.lon, doctor.lat, JSON.stringify(doctor)]);
        }
        
        // Sample hospitals
        const hospitalSamples = [
          { id: 'hosp_1', name: 'Sykehuset i Kristiansand', lon: 8.767, lat: 58.015 },
          { id: 'hosp_2', name: 'Sykehuset i Arendal', lon: 8.769, lat: 58.462 }
        ];
        for (const hospital of hospitalSamples) {
          await pool.query(`
            INSERT INTO overture.hospitals (id, name, location, raw_properties)
            VALUES ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326), $5)
            ON CONFLICT (id) DO NOTHING
          `, [hospital.id, hospital.name, hospital.lon, hospital.lat, JSON.stringify(hospital)]);
        }
        console.log('✓ Sample Overture data loaded');
      }
    } else {
      console.log(`Skipping Overture ingest (already ${farmCount} farm rows).`);
    }
  } catch (error) {
    console.error('Overture data loading failed:', error.message);
  }

  // Cache counties and municipalities as GeoJSON layers for frontend toggles (Agder-filtered)
  // Primary source: Kartverket API. Fallback: Geonorge ZIP download.
  try {
    await refreshBoundaryLayer('counties');
    const countiesFiltered = await getBoundaryLayerGeoJsonFiltered('counties');
    fs.writeFileSync(path.join(CACHE_DIR, 'counties.geojson'), JSON.stringify(countiesFiltered));
    console.log(`✓ Counties cached (Agder-filtered): ${(countiesFiltered.features || []).length}`);
  } catch (error) {
    console.error('Counties cache failed:', error.message);
  }

  try {
    await refreshBoundaryLayer('municipalities');
    const municipalitiesFiltered = await getBoundaryLayerGeoJsonFiltered('municipalities');
    fs.writeFileSync(path.join(CACHE_DIR, 'municipalities.geojson'), JSON.stringify(municipalitiesFiltered));
    console.log(`✓ Municipalities cached (Agder-filtered): ${(municipalitiesFiltered.features || []).length}`);
  } catch (error) {
    console.error('Municipalities cache failed:', error.message);
  }

  try {
    await buildOrRefreshLogisticsPlan();
    console.log('✓ Logistics plan initialized at startup');
  } catch (error) {
    console.warn('Startup logistics plan initialization failed:', error.message);
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
    const route = await computeRouteBetweenPoints({ originLon, originLat, destLon, destLat, mode });
    res.json(route);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/admin/logistics/plan', async (req, res) => {
  try {
    const state = await readLogisticsState();
    const snapshot = await buildOrRefreshLogisticsPlan(state.settings || {});
    res.json(snapshot.plan);
  } catch (error) {
    console.error('Error loading logistics plan:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/admin/logistics/plan', async (req, res) => {
  try {
    const settings = req.body?.settings || req.body || {};
    const snapshot = await buildOrRefreshLogisticsPlan(settings);
    res.json(snapshot.plan);
  } catch (error) {
    console.error('Error building logistics plan:', error);
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/admin/logistics/plan', async (req, res) => {
  try {
    await ensureLogisticsStateTable();
    await pool.query(`
      UPDATE public.mock_logistics_state
      SET plan = '{}'::jsonb,
          snapshot_key = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = 1
    `);
    res.json({ ok: true });
  } catch (error) {
    console.error('Error clearing logistics plan:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/admin/logistics/dispatch-all', async (req, res) => {
  try {
    const state = await readLogisticsState();
    const jobs = Array.isArray(state.plan?.jobs) ? clonePlanJobs(state.plan.jobs) : [];
    const startedAt = Date.now();
    const nextJobs = jobs.map((job) => {
      if (job.status === 'arrived' || job.status === 'moving') return job;
      return {
        ...job,
        status: 'moving',
        startedAt,
        completedAt: null,
        progress: 0,
        currentPosition: [job.source?.lon, job.source?.lat]
      };
    });

    const plan = {
      ...(state.plan || {}),
      jobs: nextJobs,
      updated_at: new Date().toISOString()
    };

    await saveLogisticsState({
      plan,
      snapshotKey: state.snapshot_key,
      settings: state.settings || {}
    });

    res.json(plan);
  } catch (error) {
    console.error('Error dispatching all logistics trucks:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/admin/logistics/trucks/:truckId/dispatch', async (req, res) => {
  try {
    const { truckId } = req.params;
    const state = await readLogisticsState();
    const jobs = Array.isArray(state.plan?.jobs) ? clonePlanJobs(state.plan.jobs) : [];
    const currentJob = jobs.find((job) => job.id === truckId);

    if (!currentJob) {
      return res.status(404).json({ error: 'Truck not found' });
    }

    if (currentJob.status === 'moving' || currentJob.status === 'arrived') {
      return res.json(state.plan);
    }

    const plan = {
      ...(state.plan || {}),
      updated_at: new Date().toISOString(),
      jobs: jobs.map((job) => {
        if (job.id !== truckId) return job;
        return {
          ...job,
          status: 'moving',
          startedAt: Date.now(),
          completedAt: null,
          progress: 0,
          currentPosition: [job.source?.lon, job.source?.lat]
        };
      })
    };

    await saveLogisticsState({
      plan,
      snapshotKey: state.snapshot_key,
      settings: state.settings || {}
    });

    res.json(plan);
  } catch (error) {
    console.error('Error dispatching logistics truck:', error);
    res.status(500).json({ error: error.message });
  }
});

app.patch('/api/admin/logistics/trucks/:truckId', async (req, res) => {
  try {
    const { truckId } = req.params;
    const { status, startedAt, completedAt } = req.body || {};
    const state = await readLogisticsState();
    const jobs = Array.isArray(state.plan?.jobs) ? clonePlanJobs(state.plan.jobs) : [];
    const currentJob = jobs.find((job) => job.id === truckId);

    if (!currentJob) {
      return res.status(404).json({ error: 'Truck not found' });
    }

    const plan = {
      ...(state.plan || {}),
      updated_at: new Date().toISOString(),
      jobs: jobs.map((job) => {
        if (job.id !== truckId) return job;
        return {
          ...job,
          status: status || job.status,
          startedAt: startedAt || job.startedAt || null,
          completedAt: completedAt || job.completedAt || null,
          currentPosition: req.body?.currentPosition || job.currentPosition || [job.source?.lon, job.source?.lat],
          progress: Number.isFinite(Number(req.body?.progress)) ? Number(req.body.progress) : job.progress || 0
        };
      })
    };

    await saveLogisticsState({
      plan,
      snapshotKey: state.snapshot_key,
      settings: state.settings || {}
    });

    res.json(plan);
  } catch (error) {
    console.error('Error updating logistics truck:', error);
    res.status(500).json({ error: error.message });
  }
});

// User: track user location
app.post('/api/users/:userId/location', async (req, res) => {
  try {
    const { userId } = req.params;
    const { lon, lat } = req.body;
    const lonNum = Number(lon);
    const latNum = Number(lat);
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    
    if (!Number.isFinite(lonNum) || !Number.isFinite(latNum)) {
      return res.status(400).json({ error: 'Missing or invalid lon/lat' });
    }

    // If this deployment uses UUID + FK schema, ensure user exists.
    if (uuidRegex.test(userId)) {
      await pool.query(`
        INSERT INTO public.app_users (id, opt_tracking)
        VALUES ($1::uuid, true)
        ON CONFLICT (id) DO NOTHING
      `, [userId]);
    }
    
    await pool.query(`
      INSERT INTO public.user_locations (user_id, location)
      VALUES ($1, ST_SetSRID(ST_MakePoint($2, $3), 4326))
    `, [userId, lonNum, latNum]);

    queueLogisticsRefresh('user-location');
    
    res.json({ ok: true });
  } catch (error) {
    console.error('Error saving user location:', error);
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/admin/mock-users', async (req, res) => {
  try {
    const { userIds } = req.body || {};
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const ids = Array.isArray(userIds)
      ? userIds.map((id) => String(id).trim()).filter((id) => uuidRegex.test(id))
      : [];

    if (ids.length === 0) {
      return res.json({ ok: true, deleted: 0 });
    }

    await pool.query(`
      DELETE FROM public.user_locations
      WHERE user_id = ANY($1::uuid[])
    `, [ids]);

    await pool.query(`
      DELETE FROM public.app_users
      WHERE id = ANY($1::uuid[])
    `, [ids]);

    queueLogisticsRefresh('mock-users-cleared');

    res.json({ ok: true, deleted: ids.length });
  } catch (error) {
    console.error('Error deleting mock users:', error);
    res.status(500).json({ error: error.message });
  }
});

// Admin: latest known position for each tracked user
app.get('/api/admin/live-users', async (req, res) => {
  try {
    const columnCheck = await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'user_locations'
        AND column_name IN ('timestamp', 'created_at')
    `);

    const columns = new Set(columnCheck.rows.map((r) => r.column_name));
    const timeColumn = columns.has('timestamp')
      ? 'timestamp'
      : columns.has('created_at')
        ? 'created_at'
        : null;

    const orderExpr = timeColumn ? `"${timeColumn}" DESC NULLS LAST, id DESC` : 'id DESC';
    const selectTimeExpr = timeColumn ? `"${timeColumn}"` : 'NOW()';

    const result = await pool.query(`
      WITH latest AS (
        SELECT DISTINCT ON (user_id)
          user_id::text AS user_id,
          location,
          ${selectTimeExpr} AS last_seen
        FROM public.user_locations
        WHERE location IS NOT NULL
        ORDER BY user_id, ${orderExpr}
      )
      SELECT
        user_id,
        ST_X(location) AS lon,
        ST_Y(location) AS lat,
        last_seen
      FROM latest
    `);

    const features = result.rows.map((row) => ({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [Number(row.lon), Number(row.lat)]
      },
      properties: {
        user_id: row.user_id,
        last_seen: row.last_seen
      }
    }));

    res.json({
      type: 'FeatureCollection',
      features
    });
  } catch (error) {
    console.error('Error loading live users:', error);
    res.json({
      type: 'FeatureCollection',
      features: []
    });
  }
});

async function buildLatestUsersSubquery() {
  const columnCheck = await pool.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'user_locations'
      AND column_name IN ('timestamp', 'created_at')
  `);

  const columns = new Set(columnCheck.rows.map((r) => r.column_name));
  const timeColumn = columns.has('timestamp')
    ? 'timestamp'
    : columns.has('created_at')
      ? 'created_at'
      : null;

  const orderExpr = timeColumn ? `"${timeColumn}" DESC NULLS LAST, id DESC` : 'id DESC';
  const selectTimeExpr = timeColumn ? `"${timeColumn}"` : 'NOW()';

  return {
    latestUsersCte: `
      WITH latest AS (
        SELECT DISTINCT ON (user_id)
          user_id::text AS user_id,
          location,
          ${selectTimeExpr} AS last_seen
        FROM public.user_locations
        WHERE location IS NOT NULL
        ORDER BY user_id, ${orderExpr}
      )
    `,
  };
}

app.get('/api/admin/shelters/:id/live-users', async (req, res) => {
  try {
    const shelterId = Number(req.params.id);
    const radiusM = Number.parseInt(req.query.radius, 10) || 150;

    if (!Number.isFinite(shelterId)) {
      return res.status(400).json({ error: 'Invalid shelter id' });
    }

    const { latestUsersCte } = await buildLatestUsersSubquery();
    const result = await pool.query(`
      ${latestUsersCte}
      SELECT
        COUNT(*)::int AS live_users_count
      FROM latest lu
      JOIN tilfluktsromoffentlige.tilfluktsrom s ON s.id = $1
      WHERE ST_DWithin(lu.location::geography, s.location::geography, $2)
    `, [shelterId, radiusM]);

    res.json({
      id: shelterId,
      radius_m: radiusM,
      live_users_count: Number(result.rows[0]?.live_users_count || 0),
      updated_at: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Error counting live users near shelter:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/admin/safe-areas/:id/live-users', async (req, res) => {
  try {
    const safeAreaId = Number(req.params.id);
    const radiusM = Number.parseInt(req.query.radius, 10) || 150;

    if (!Number.isFinite(safeAreaId)) {
      return res.status(400).json({ error: 'Invalid safe area id' });
    }

    const { latestUsersCte } = await buildLatestUsersSubquery();
    const result = await pool.query(`
      ${latestUsersCte}
      SELECT
        COUNT(*)::int AS live_users_count
      FROM latest lu
      JOIN public.safe_areas sa ON sa.id = $1
      WHERE ST_DWithin(lu.location::geography, sa.location::geography, $2)
    `, [safeAreaId, radiusM]);

    res.json({
      id: safeAreaId,
      radius_m: radiusM,
      live_users_count: Number(result.rows[0]?.live_users_count || 0),
      updated_at: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Error counting live users near safe area:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/admin/shelters/live-users', async (req, res) => {
  try {
    const radiusM = Number.parseInt(req.query.radius, 10) || 150;
    const { latestUsersCte } = await buildLatestUsersSubquery();

    const result = await pool.query(`
      ${latestUsersCte}
      SELECT
        s.id,
        COUNT(lu.user_id)::int AS live_users_count
      FROM tilfluktsromoffentlige.tilfluktsrom s
      LEFT JOIN latest lu ON ST_DWithin(lu.location::geography, s.location::geography, $1)
      GROUP BY s.id
      ORDER BY s.id
    `, [radiusM]);

    res.json({
      radius_m: radiusM,
      counts: result.rows.map((row) => ({
        id: Number(row.id),
        live_users_count: Number(row.live_users_count || 0),
      })),
      updated_at: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Error counting live users near shelters:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/admin/safe-areas/live-users', async (req, res) => {
  try {
    const radiusM = Number.parseInt(req.query.radius, 10) || 150;

    const tableExists = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = 'safe_areas'
      )
    `);

    if (!tableExists.rows[0]?.exists) {
      return res.json({
        radius_m: radiusM,
        counts: [],
        updated_at: new Date().toISOString(),
      });
    }

    const { latestUsersCte } = await buildLatestUsersSubquery();
    const result = await pool.query(`
      ${latestUsersCte}
      SELECT
        sa.id,
        COUNT(lu.user_id)::int AS live_users_count
      FROM public.safe_areas sa
      LEFT JOIN latest lu ON ST_DWithin(lu.location::geography, sa.location::geography, $1)
      GROUP BY sa.id
      ORDER BY sa.id
    `, [radiusM]);

    res.json({
      radius_m: radiusM,
      counts: result.rows.map((row) => ({
        id: Number(row.id),
        live_users_count: Number(row.live_users_count || 0),
      })),
      updated_at: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Error counting live users near safe areas:', error);
    res.status(500).json({ error: error.message });
  }
});

// Admin: create a new safe area
app.post('/api/admin/safe-areas', async (req, res) => {
  try {
    const { name, lon, lat, capacity } = req.body;
    
    if (!name || lon === undefined || lat === undefined) {
      return res.status(400).json({ error: 'Missing name, lon, or lat' });
    }
    
    // Ensure table exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS public.safe_areas (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        location GEOMETRY(Point, 4326) NOT NULL,
        capacity INT DEFAULT 0,
        created_by VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_safe_areas_location ON public.safe_areas USING GIST(location);
    `);
    
    const result = await pool.query(`
      INSERT INTO public.safe_areas (name, location, capacity)
      VALUES ($1, ST_SetSRID(ST_MakePoint($2, $3), 4326), $4)
      RETURNING id, name, ST_X(location) as lon, ST_Y(location) as lat, capacity, created_at
    `, [name, parseFloat(lon), parseFloat(lat), parseInt(capacity) || 0]);

    queueLogisticsRefresh('safe-area-created');
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error creating safe area:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get all safe areas as GeoJSON
app.get('/api/layers/safe-areas', async (req, res) => {
  try {
    // Check if table exists first
    const tableExists = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'safe_areas'
      );
    `);
    
    if (!tableExists.rows[0].exists) {
      console.log('safe_areas table does not exist yet');
      return res.json({
        type: 'FeatureCollection',
        features: []
      });
    }
    
    const result = await pool.query(`
      SELECT 
        id,
        name,
        capacity,
        ST_X(location) as lon,
        ST_Y(location) as lat
      FROM public.safe_areas
    `);
    
    const features = result.rows.map(row => ({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [parseFloat(row.lon), parseFloat(row.lat)]
      },
      properties: {
        id: row.id,
        name: row.name,
        capacity: row.capacity
      }
    }));
    
    res.json({
      type: 'FeatureCollection',
      features: features
    });
  } catch (error) {
    console.error('Error loading safe areas:', error);
    // Return empty collection on error instead of 500
    res.json({
      type: 'FeatureCollection',
      features: []
    });
  }
});

// Delete a safe area
app.delete('/api/admin/safe-areas/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Ensure table exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS public.safe_areas (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        location GEOMETRY(Point, 4326) NOT NULL,
        capacity INT DEFAULT 0,
        created_by VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_safe_areas_location ON public.safe_areas USING GIST(location);
    `);
    
    await pool.query('DELETE FROM public.safe_areas WHERE id = $1', [id]);

    queueLogisticsRefresh('safe-area-deleted');
    
    res.json({ ok: true });
  } catch (error) {
    console.error('Error deleting safe area:', error);
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
    } else if (layer === 'fire_stations') {
      query = `
        SELECT json_build_object(
          'type', 'FeatureCollection',
          'features', COALESCE(json_agg(json_build_object(
            'type', 'Feature',
            'geometry', ST_AsGeoJSON(posisjon)::json,
            'properties', json_build_object(
              'objid', objid,
              'brannstasjon', brannstasjon,
              'brannvesen', brannvesen,
              'stasjonstype', stasjonstype,
              'kasernert', kasernert,
              'opphav', opphav
            )
          )), '[]'::json)
        ) AS geojson
        FROM brannstasjoner.brannstasjon
        WHERE ST_Intersects(posisjon, ${agderGeom})
      `;
      result = await pool.query(query);
    } else if (layer === 'farms' || layer === 'water_sources' || layer === 'doctors' || layer === 'hospitals') {
      // Overture Maps layers
      query = `
        SELECT json_build_object(
          'type', 'FeatureCollection',
          'features', COALESCE(json_agg(json_build_object(
            'type', 'Feature',
            'geometry', json_build_object('type', 'Point', 'coordinates', json_build_array(ST_X(location), ST_Y(location))),
            'properties', json_build_object(
              'id', id,
              'name', name,
              'type', '${layer}'
            )
          )), '[]'::json)
        ) AS geojson
        FROM overture.${layer}
        WHERE ST_Intersects(location, ${agderGeom})
        LIMIT 1000
      `;
      result = await pool.query(query);
    } else if (layer === 'counties' || layer === 'municipalities') {
      const geojson = await getBoundaryLayerGeoJsonFiltered(layer);
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
