import { backendBase, map, availableTables, setAvailableTables, tablesByName } from './state.js';
import { removeFylkeFilterLayers } from './fylkeFilter.js';

export async function loadLayers() {
  console.debug && console.debug('loadLayers: start');
  const r = await fetch(backendBase + 'spatial');
  const data = await r.json();
  console.debug && console.debug('loadLayers: fetched data', data && (data.tables || []).length);
  const container = document.getElementById('layers');
  if (!container) return;
  container.innerHTML = '';
  const tables = data.tables || [];
  console.debug && console.debug('loadLayers: tables sample', tables[0]);
  setAvailableTables(tables);
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

  const schemaNames = Object.keys(schemas).sort((a, b) => a.localeCompare(b));
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
      const idSafe = encodeURIComponent(full);
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

export async function loadSchemaSelector() {
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

export async function showAllLayers() {
  for (const t of availableTables) {
    const full = `${t.schema}.${t.table}`;
    const idSafe = full.replace(/[^a-zA-Z0-9_]/g, '_');
    const chk = document.getElementById(`chk_${idSafe}`);
    if (chk && !chk.checked) chk.checked = true;
    await addLayerToMap(full);
  }
}

export function hideAllLayers() {
  for (const t of availableTables) {
    const full = `${t.schema}.${t.table}`;
    const idSafe = encodeURIComponent(full);
    const chk = document.getElementById(`chk_${idSafe}`);
    if (chk && chk.checked) chk.checked = false;
    removeLayerFromMap(full);
  }
  removeFylkeFilterLayers();
  removeFilteredTilfluktsromLayer();
}

export async function showSchema(schema) {
  const hasTilfluktsrom = availableTables.some(t => t.schema === schema && String(t.table).toLowerCase() === 'tilfluktsrom');
  if (hasTilfluktsrom) removeFilteredTilfluktsromLayer();
  for (const t of availableTables) {
    if (t.schema !== schema) continue;
    const full = `${t.schema}.${t.table}`;
    const idSafe = full.replace(/[^a-zA-Z0-9_]/g, '_');
    const chk = document.getElementById(`chk_${idSafe}`);
    if (chk && !chk.checked) chk.checked = true;
    await addLayerToMap(full);
  }
}

export function hideSchema(schema) {
  for (const t of availableTables) {
    if (t.schema !== schema) continue;
    const full = `${t.schema}.${t.table}`;
    const idSafe = encodeURIComponent(full);
    const chk = document.getElementById(`chk_${idSafe}`);
    if (chk && chk.checked) chk.checked = false;
    removeLayerFromMap(full);
  }
}

export async function addLayerToMap(name) {
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
    const idSafe = encodeURIComponent(name);
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

export function removeLayerFromMap(name) {
  const idSafe = encodeURIComponent(name);
  const layerId = `layer_${idSafe}`;
  const srcId = `src_${idSafe}`;
  if (map.getLayer(layerId)) {
    try { map.removeLayer(layerId); } catch (e) { console.warn('removeLayer failed', e && e.message); }
  }
  if (map.getSource(srcId)) {
    try { map.removeSource(srcId); } catch (e) { console.warn('removeSource failed', e && e.message); }
  }
}

export function removeFilteredTilfluktsromLayer() {
  const layerId = 'layer_tilfluktsrom_min_500';
  const srcId = 'src_tilfluktsrom_min_500';
  if (map.getLayer(layerId)) {
    try { map.removeLayer(layerId); } catch (e) { console.warn('remove filtered layer failed', e && e.message); }
  }
  if (map.getSource(srcId)) {
    try { map.removeSource(srcId); } catch (e) { console.warn('remove filtered source failed', e && e.message); }
  }
}

export async function showTilfluktsromMinPlasser(minPlasser) {
  try {
    const tilfluktsromTables = availableTables
      .filter(t => String(t.table).toLowerCase() === 'tilfluktsrom')
      .map(t => `${t.schema}.${t.table}`);

    for (const full of tilfluktsromTables) {
      const idSafe = encodeURIComponent(full);
      const checkbox = document.getElementById(`chk_${idSafe}`);
      if (checkbox) checkbox.checked = false;
      removeLayerFromMap(full);
    }
    removeFilteredTilfluktsromLayer();

    const url = `${backendBase}analysis/tilfluktsrom-min?min_plasser=${encodeURIComponent(minPlasser)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('Failed to load tilfluktsrom filter');
    const geojson = await res.json();
    const features = (geojson && geojson.features) ? geojson.features : [];
    if (features.length === 0) {
      alert('No tilfluktsrom found for the selected filter.');
      return;
    }

    const srcId = 'src_tilfluktsrom_min_500';
    const layerId = 'layer_tilfluktsrom_min_500';
    map.addSource(srcId, { type: 'geojson', data: geojson });

    const geomType = (features[0].geometry && features[0].geometry.type) || 'Point';
    let layer = null;
    if (geomType === 'Point' || geomType === 'MultiPoint') {
      layer = {
        id: layerId,
        type: 'circle',
        source: srcId,
        paint: { 'circle-radius': 7, 'circle-color': '#22c55e' },
      };
    } else if (geomType === 'LineString' || geomType === 'MultiLineString') {
      layer = {
        id: layerId,
        type: 'line',
        source: srcId,
        paint: { 'line-color': '#ff6b6b', 'line-width': 2 },
      };
    } else {
      layer = {
        id: layerId,
        type: 'fill',
        source: srcId,
        paint: { 'fill-color': '#ff6b6b', 'fill-opacity': 0.45 },
      };
    }
    map.addLayer(layer);

    let bbox = null;
    try {
      if (typeof turf !== 'undefined' && turf && typeof turf.bbox === 'function') bbox = turf.bbox(geojson);
    } catch (e) {
      console.warn('turf.bbox failed', e && e.message);
    }
    if (bbox) map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], { padding: 20 });
  } catch (err) {
    alert('Error loading filtered tilfluktsrom: ' + err.message);
  }
}
