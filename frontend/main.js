// When running locally with docker-compose, the backend is reachable on localhost:3000
const backendBase = 'http://localhost:3000/';
// Default schema to use for schema-qualified layers
const defaultSchema = 'n50kartdata_6fb26822f7d04ad6b889894a37c29e1c';

const map = new maplibregl.Map({
  container: 'map',
  style: {
    version: 8,
    sources: {
      'osm-tiles': {
        type: 'raster',
        tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
        tileSize: 256,
      },
    },
    layers: [
      {
        id: 'osm-tiles-layer',
        type: 'raster',
        source: 'osm-tiles',
      },
    ],
  },
  center: [10.75, 59.91],
  zoom: 10,
});

// available tables/geomTables stored for global actions
let availableTables = [];
let availableGeomTables = new Set();

async function loadLayers() {
  // Fetch tables/geometry info for configured schema
  const r = await fetch(backendBase + 'schema/' + encodeURIComponent(defaultSchema));
  const data = await r.json();
  const container = document.getElementById('layers');
  container.innerHTML = '';
  const tables = data.tables || [];
  const geomTables = new Set((data.geometry_columns || []).map(g => g.f_table_name));
  // store for global actions
  availableTables = tables;
  availableGeomTables = geomTables;

  // auto-display candidate: lufthavn_posisjon if present
  let autoShow = null;

  tables.forEach(t => {
    const name = t.table_name;
    const full = `${defaultSchema}.${name}`;
    const id = `chk_${name}`;
    const div = document.createElement('div');
    div.className = 'layer-item';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = id;
    input.disabled = !geomTables.has(name);
    input.onchange = async (e) => {
      if (e.target.checked) {
        await addLayerToMap(full);
      } else {
        removeLayerFromMap(full);
      }
    };
    const label = document.createElement('label');
    label.htmlFor = id;
    label.innerText = name + (geomTables.has(name) ? '' : ' (no geometry)');
    div.appendChild(input);
    div.appendChild(label);
    container.appendChild(div);

    if (name === 'lufthavn_posisjon' && geomTables.has(name)) {
      autoShow = full;
    }
  });

  if (autoShow) {
    // check the checkbox and add layer
    const autoId = `chk_${autoShow.split('.').pop()}`;
    const el = document.getElementById(autoId);
    if (el) {
      el.checked = true;
      await addLayerToMap(autoShow);
    }
  }
}

// Show all geometry-enabled layers
async function showAllLayers() {
  for (const t of availableTables) {
    const name = t.table_name;
    if (!availableGeomTables.has(name)) continue;
    const full = `${defaultSchema}.${name}`;
    const chk = document.getElementById(`chk_${name}`);
    if (chk && !chk.checked) chk.checked = true;
    await addLayerToMap(full);
  }
}

// Hide all loaded layers
function hideAllLayers() {
  for (const t of availableTables) {
    const name = t.table_name;
    const full = `${defaultSchema}.${name}`;
    const chk = document.getElementById(`chk_${name}`);
    if (chk && chk.checked) chk.checked = false;
    removeLayerFromMap(full);
  }
}

// attach buttons after DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  const showBtn = document.getElementById('showAll');
  const hideBtn = document.getElementById('hideAll');
  if (showBtn) showBtn.addEventListener('click', () => { showAllLayers(); });
  if (hideBtn) hideBtn.addEventListener('click', () => { hideAllLayers(); });
});

async function addLayerToMap(name) {
  try {
    const r = await fetch(backendBase + 'layers/' + encodeURIComponent(name));
    if (!r.ok) throw new Error('Failed to load layer');
    const geojson = await r.json();
    // ids cannot contain dots; replace with underscore
    const idSafe = name.replace(/\./g, '_');
    const srcId = `src_${idSafe}`;
    if (map.getSource(srcId)) return;
    map.addSource(srcId, { type: 'geojson', data: geojson });

    // Decide layer type by geometry
    const geomType = (geojson.features && geojson.features[0] && geojson.features[0].geometry && geojson.features[0].geometry.type) || 'Point';
    let layer = null;
    if (geomType === 'Point' || geomType === 'MultiPoint') {
      layer = {
        id: `layer_${idSafe}`,
        type: 'circle',
        source: srcId,
        paint: { 'circle-radius': 6, 'circle-color': '#007cbf' },
      };
    } else if (geomType === 'LineString' || geomType === 'MultiLineString') {
      layer = {
        id: `layer_${idSafe}`,
        type: 'line',
        source: srcId,
        paint: { 'line-color': '#ff6600', 'line-width': 2 },
      };
    } else {
      layer = {
        id: `layer_${idSafe}`,
        type: 'fill',
        source: srcId,
        paint: { 'fill-color': '#00aa55', 'fill-opacity': 0.4 },
      };
    }
    map.addLayer(layer);
    // zoom to layer bounds
    const bbox = turf.bbox(geojson);
    if (bbox) map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], { padding: 20 });
  } catch (err) {
    alert('Error loading layer: ' + err.message);
  }
}

function removeLayerFromMap(name) {
  const layerId = `layer_${name}`;
  const srcId = `src_${name}`;
  if (map.getLayer(layerId)) map.removeLayer(layerId);
  if (map.getSource(srcId)) map.removeSource(srcId);
}

// Load Turf.js for bbox calculation
const turfScript = document.createElement('script');
turfScript.src = 'https://cdn.jsdelivr.net/npm/@turf/turf@6/turf.min.js';
turfScript.onload = () => loadLayers();
document.head.appendChild(turfScript);
