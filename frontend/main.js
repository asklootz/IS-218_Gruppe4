// Backend base URL
const backendBase = 'http://localhost:3000/';

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
let availableTables = []; // array of { schema, table, geom_columns, rows }

// Map of fullName -> table object for quick lookup
let tablesByName = new Map();

async function loadLayers() {
  console.debug && console.debug('loadLayers: start');
  const r = await fetch(backendBase + 'spatial');
  const data = await r.json();
  console.debug && console.debug('loadLayers: fetched data', data && (data.tables || []).length);
  const container = document.getElementById('layers');
  if (!container) return;
  container.innerHTML = '';
  const tables = data.tables || [];
  console.debug && console.debug('loadLayers: tables sample', tables[0]);
  availableTables = tables;
  tablesByName.clear();

  const previouslyChecked = new Set();
  document.querySelectorAll('#layers input[type=checkbox]').forEach(cb => { if (cb.checked) previouslyChecked.add(cb.id); });

  const schemas = {};
  for (const t of tables) {
    const s = t.schema || 'public';
    schemas[s] = schemas[s] || [];
    schemas[s].push(t);
    const full = `${t.schema}.${t.table}`;
    tablesByName.set(full, t);
  }

  const schemaNames = Object.keys(schemas).sort((a,b) => a.localeCompare(b));
  for (const schema of schemaNames) {
    const list = schemas[schema];
    const details = document.createElement('details');
    details.className = 'schema-block';
    const summary = document.createElement('summary');
    summary.innerText = `${schema} (${list.length})`;

    const btnShow = document.createElement('button');
    btnShow.type = 'button';
    btnShow.innerText = 'Show all';
    btnShow.style.marginLeft = '8px';
    btnShow.addEventListener('click', (e) => { e.stopPropagation(); showSchema(schema); });

    const btnHide = document.createElement('button');
    btnHide.type = 'button';
    btnHide.innerText = 'Hide all';
    btnHide.style.marginLeft = '4px';
    btnHide.addEventListener('click', (e) => { e.stopPropagation(); hideSchema(schema); });

    summary.appendChild(btnShow);
    summary.appendChild(btnHide);
    details.appendChild(summary);

    const inner = document.createElement('div');
    inner.style.paddingLeft = '10px';
    inner.style.marginBottom = '8px';

    for (const t of list) {
      const full = `${t.schema}.${t.table}`;
      const idSafe = full.replace(/[^a-zA-Z0-9_]/g, '_');
      const id = `chk_${idSafe}`;
      const div = document.createElement('div');
      div.className = 'layer-item';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.id = id;
      const hasGeom = Array.isArray(t.geom_columns) && t.geom_columns.length > 0 && Array.isArray(t.rows);
      input.disabled = !hasGeom;
      input.onchange = async (e) => {
        if (e.target.checked) {
          await addLayerToMap(full);
        } else {
          removeLayerFromMap(full);
        }
      };
      const label = document.createElement('label');
      label.htmlFor = id;
      label.innerText = t.table + (hasGeom ? '' : ' (no geometry)');
      div.appendChild(input);
      div.appendChild(label);
      inner.appendChild(div);

      if (previouslyChecked.has(id)) {
        input.checked = true;
        if (!input.disabled) await addLayerToMap(full);
      }
    }

    details.appendChild(inner);
    container.appendChild(details);
  }
}

async function loadSchemaSelector() {
  try {
    const targetIdCandidates = ['schemaSelector', 'schema', 'schema-list', 'schemas'];
    let el = null;
    for (const id of targetIdCandidates) {
      el = document.getElementById(id);
      if (el) break;
    }
    if (!el) return;

    const res = await fetch(backendBase + 'geom-schemas');
    if (!res.ok) {
      el.innerHTML = '<option value="">(no schemas)</option>';
      return;
    }
    const data = await res.json();
    const rows = data.schemas || [];
    el.innerHTML = '';
    for (const r of rows) {
      const opt = document.createElement('option');
      opt.value = r.table_schema;
      opt.text = r.table_schema + ' (' + (r.tables ? r.tables.length : 0) + ')';
      el.appendChild(opt);
    }
  } catch (err) {
    console.warn('Failed to load schema selector', err && err.message);
  }
}

console.debug && console.debug('frontend/main.js loaded');

async function showAllLayers() {
  for (const t of availableTables) {
    const full = `${t.schema}.${t.table}`;
    const idSafe = full.replace(/[^a-zA-Z0-9_]/g, '_');
    const chk = document.getElementById(`chk_${idSafe}`);
    if (chk && !chk.checked) chk.checked = true;
    await addLayerToMap(full);
  }
}

function hideAllLayers() {
  for (const t of availableTables) {
    const full = `${t.schema}.${t.table}`;
    const idSafe = full.replace(/[^a-zA-Z0-9_]/g, '_');
    const chk = document.getElementById(`chk_${idSafe}`);
    if (chk && chk.checked) chk.checked = false;
    removeLayerFromMap(full);
  }
}

async function showSchema(schema) {
  for (const t of availableTables) {
    if (t.schema !== schema) continue;
    const full = `${t.schema}.${t.table}`;
    const idSafe = full.replace(/[^a-zA-Z0-9_]/g, '_');
    const chk = document.getElementById(`chk_${idSafe}`);
    if (chk && !chk.checked) chk.checked = true;
    await addLayerToMap(full);
  }
}

function hideSchema(schema) {
  for (const t of availableTables) {
    if (t.schema !== schema) continue;
    const full = `${t.schema}.${t.table}`;
    const idSafe = full.replace(/[^a-zA-Z0-9_]/g, '_');
    const chk = document.getElementById(`chk_${idSafe}`);
    if (chk && chk.checked) chk.checked = false;
    removeLayerFromMap(full);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const showBtn = document.getElementById('showAll');
  const hideBtn = document.getElementById('hideAll');
  if (showBtn) showBtn.addEventListener('click', () => { showAllLayers(); });
  if (hideBtn) hideBtn.addEventListener('click', () => { hideAllLayers(); });

  try {
    if (typeof loadSchemaSelector === 'function') {
      loadSchemaSelector().catch(err => console.warn('loadSchemaSelector failed', err));
    }
  } catch (e) {
    console.warn('loadSchemaSelector call error', e && e.message);
  }

  loadLayers().catch(err => console.warn('initial loadLayers failed', err));
});

async function addLayerToMap(name) {
  try {
    const tbl = tablesByName.get(name);
    if (!tbl) throw new Error('Table not found: ' + name);
    const rows = tbl.rows || [];
    const features = [];
    for (const r of rows) {
      let geom = null;
      let geomKey = null;
      for (const k of Object.keys(r)) {
        if (k === 'id') continue;
        let val = r[k];
        if (typeof val === 'string') {
          try { val = JSON.parse(val); } catch (e) { }
        }
        if (val && typeof val === 'object' && typeof val.type === 'string') {
          geom = val;
          geomKey = k;
          break;
        }
      }
      if (!geom) continue;
      const props = Object.assign({}, r);
      delete props[geomKey];
      const feature = { type: 'Feature', id: r.id ? String(r.id) : undefined, geometry: geom, properties: props };
      features.push(feature);
    }

    if (features.length === 0) throw new Error('No geometry rows for table: ' + name);

    const geojson = { type: 'FeatureCollection', features };
    const idSafe = name.replace(/\./g, '_');
    const srcId = `src_${idSafe}`;
    if (map.getSource(srcId)) return;
    map.addSource(srcId, { type: 'geojson', data: geojson });

    const geomType = (features[0].geometry && features[0].geometry.type) || 'Point';
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

    // ---------------------------------------------------------
    // >>> POPUP START
    // ---------------------------------------------------------

    const layerId = layer.id;

    if (!map.__registered) map.__registered = {};
    if (!map.__registered[layerId]) {
      map.__registered[layerId] = true;

      map.on("click", layerId, (e) => {
        if (!e.features || !e.features.length) return;

        const props = e.features[0].properties;

        let html = "<h3>Objektinfo</h3><table>";
        for (const key in props) {
          html += `<tr><td><strong>${key}</strong></td><td>${props[key]}</td></tr>`;
        }
        html += "</table>";

        new maplibregl.Popup()
          .setLngLat(e.lngLat)
          .setHTML(html)
          .addTo(map);
      });

      map.on("mouseenter", layerId, () => {
        map.getCanvas().style.cursor = "pointer";
      });

      map.on("mouseleave", layerId, () => {
        map.getCanvas().style.cursor = "";
      });
    }

    // ---------------------------------------------------------
    // >>> POPUP SLUTT
    // ---------------------------------------------------------

    let bbox = null;
    try {
      if (typeof turf !== 'undefined' && turf && typeof turf.bbox === 'function') bbox = turf.bbox(geojson);
    } catch (e) {
      console.warn('turf.bbox failed', e && e.message);
    }
    if (bbox) map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], { padding: 20 });
  } catch (err) {
    alert('Error loading layer: ' + err.message);
  }
}

function removeLayerFromMap(name) {
  const idSafe = name.replace(/[^a-zA-Z0-9_]/g, '_');
  const layerId = `layer_${idSafe}`;
  const srcId = `src_${idSafe}`;
  if (map.getLayer(layerId)) {
    try { map.removeLayer(layerId); } catch (e) { console.warn('removeLayer failed', e && e.message); }
  }
  if (map.getSource(srcId)) {
    try { map.removeSource(srcId); } catch (e) { console.warn('removeSource failed', e && e.message); }
  }
}

const turfScript = document.createElement('script');
turfScript.src = 'https://cdn.jsdelivr.net/npm/@turf/turf@6/turf.min.js';
turfScript.onload = () => loadLayers();
document.head.appendChild(turfScript);

setInterval(() => {
  loadLayers().catch(err => console.error('Failed to refresh layers', err));
}, 30000);
