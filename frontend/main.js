// --- Sidebar Toggle ---
function setupSidebarToggle() {
  const sidebar = document.getElementById('sidebar');
  const sidebarToggle = document.getElementById('sidebarToggle');
  const sidebarShowBtn = document.getElementById('sidebarShowBtn');
  const mapDiv = document.getElementById('map');
  if (sidebar && sidebarToggle && sidebarShowBtn && mapDiv) {
    sidebarToggle.onclick = () => {
      sidebar.classList.add('hide');
      mapDiv.classList.add('sidebar-hidden');
      sidebarShowBtn.style.display = 'block';
    };
    sidebarShowBtn.onclick = () => {
      sidebar.classList.remove('hide');
      mapDiv.classList.remove('sidebar-hidden');
      sidebarShowBtn.style.display = 'none';
    };
  }
}
window.addEventListener('DOMContentLoaded', setupSidebarToggle);
// --- Dark Mode Toggle ---
window.addEventListener('DOMContentLoaded', () => {
  const darkModeToggle = document.getElementById('darkModeToggle');
  // Persist dark mode preference
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const saved = localStorage.getItem('darkMode');
  if ((saved === 'dark') || (!saved && prefersDark)) {
    document.body.classList.remove('light-mode');
  } else if (saved === 'light') {
    document.body.classList.add('light-mode');
  }
  if (darkModeToggle) {
    darkModeToggle.onclick = () => {
      document.body.classList.toggle('light-mode');
      localStorage.setItem('darkMode', document.body.classList.contains('light-mode') ? 'light' : 'dark');
    };
  }
});
// --- WMS Tree Menu ---
async function fetchWmsCapabilities(baseUrl) {
  const url = `${baseUrl}?service=WMS&request=GetCapabilities`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Failed to fetch WMS capabilities');
  return await res.text();
}

function parseWmsCapabilities(xmlStr) {
  const parser = new DOMParser();
  const xml = parser.parseFromString(xmlStr, 'application/xml');
  const layers = [];
  function walkLayer(node) {
    const name = node.querySelector('Name')?.textContent;
    const title = node.querySelector('Title')?.textContent;
    const children = Array.from(node.querySelectorAll(':scope > Layer'));
    const layerObj = { name, title, children: [] };
    children.forEach(child => layerObj.children.push(walkLayer(child)));
    return layerObj;
  }
  const rootLayers = xml.querySelectorAll('Layer');
  rootLayers.forEach(layer => layers.push(walkLayer(layer)));
  return layers;
}

function renderWmsTreeMenu(layers, container, onSelect) {
  container.innerHTML = '';
  function renderNode(layer, parentEl, depth = 0) {
    const div = document.createElement('div');
    div.style.marginLeft = `${depth * 12}px`;
    const label = document.createElement('label');
    label.innerText = layer.title || layer.name || '(unnamed)';
    if (layer.name) {
      const btn = document.createElement('button');
      btn.innerText = 'Select';
      btn.style.marginLeft = '6px';
      btn.onclick = () => onSelect(layer);
      label.appendChild(btn);
    }
    div.appendChild(label);
    parentEl.appendChild(div);
    layer.children.forEach(child => renderNode(child, div, depth + 1));
  }
  layers.forEach(layer => renderNode(layer, container));
}

window.addEventListener('DOMContentLoaded', () => {
  const wmsTreeMenuContainer = document.getElementById('wmsTreeMenuContainer');
  const wmsUrlInput = document.getElementById('wms_base_url');
  const wmsLayersInput = document.getElementById('wms_layers');
  const showWmsLayersBtn = document.getElementById('showWmsLayersBtn');
  const addWmsLayerBtn = document.getElementById('addWmsLayerBtn');
  if (wmsTreeMenuContainer && wmsUrlInput && wmsLayersInput && showWmsLayersBtn && addWmsLayerBtn) {
    showWmsLayersBtn.onclick = async () => {
      try {
        const baseUrl = wmsUrlInput.value.trim();
        if (!baseUrl) return alert('Enter WMS base URL');
        wmsTreeMenuContainer.innerHTML = 'Loading...';
        const xml = await fetchWmsCapabilities(baseUrl);
        const layers = parseWmsCapabilities(xml);
        renderWmsTreeMenu(layers, wmsTreeMenuContainer, layer => {
          wmsLayersInput.value = layer.name;
        });
      } catch (err) {
        wmsTreeMenuContainer.innerHTML = 'Failed to load layers.';
      }
    };
    addWmsLayerBtn.onclick = () => {
      const baseUrl = wmsUrlInput.value.trim();
      const layerName = wmsLayersInput.value.trim();
      if (!baseUrl || !layerName) return alert('Please provide both WMS URL and layer name');
      // Add to UI and map
      const id = encodeURIComponent(layerName);
      const title = layerName;
      const tileUrlTemplate = `${baseUrl}?service=WMS&request=GetMap&layers=${layerName}&styles=&format=image/png&transparent=true&version=1.1.1&width=256&height=256&srs=EPSG:3857&bbox={bbox-epsg-3857}`;
      addWmsToUI(id, title, tileUrlTemplate);
    };
  }
});
// --- App Link Management ---
function renderAppLinks() {
  const listDiv = document.getElementById('appLinksList');
  if (!listDiv) return;
  const links = JSON.parse(localStorage.getItem('appLinks') || '[]');
  listDiv.innerHTML = '';
  links.forEach((url, idx) => {
    const a = document.createElement('a');
    a.href = url;
    a.innerText = url;
    a.target = '_blank';
    a.style.display = 'block';
    a.style.marginBottom = '2px';
    // Remove button
    const btn = document.createElement('button');
    btn.innerText = '✕';
    btn.title = 'Remove link';
    btn.style.marginLeft = '6px';
    btn.onclick = () => {
      links.splice(idx, 1);
      localStorage.setItem('appLinks', JSON.stringify(links));
      renderAppLinks();
    };
    const wrapper = document.createElement('div');
    wrapper.style.display = 'flex';
    wrapper.style.alignItems = 'center';
    wrapper.appendChild(a);
    wrapper.appendChild(btn);
    listDiv.appendChild(wrapper);
  });
}

window.addEventListener('DOMContentLoaded', () => {
  const addAppLinkBtn = document.getElementById('addAppLinkBtn');
  const appLinkInput = document.getElementById('appLinkInput');
  if (addAppLinkBtn && appLinkInput) {
    addAppLinkBtn.onclick = () => {
      const url = appLinkInput.value.trim();
      if (!url) return;
      let links = JSON.parse(localStorage.getItem('appLinks') || '[]');
      if (!links.includes(url)) {
        links.push(url);
        localStorage.setItem('appLinks', JSON.stringify(links));
        renderAppLinks();
      }
      appLinkInput.value = '';
    };
    renderAppLinks();
  }
});

// --- Save/Load Chosen Layers ---
function getChosenLayerIds() {
  return Array.from(document.querySelectorAll('#layers input[type=checkbox]'))
    .filter(cb => cb.checked)
    .map(cb => cb.id);
}

function setChosenLayerIds(ids) {
  document.querySelectorAll('#layers input[type=checkbox]').forEach(cb => {
    cb.checked = ids.includes(cb.id);
    cb.dispatchEvent(new Event('change'));
  });
}

window.addEventListener('DOMContentLoaded', () => {
  const saveBtn = document.getElementById('saveLayersBtn');
  const loadBtn = document.getElementById('loadLayersBtn');
  const loadInput = document.getElementById('loadLayersInput');
  if (saveBtn) {
    saveBtn.onclick = () => {
      const ids = getChosenLayerIds();
      const blob = new Blob([JSON.stringify(ids)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'chosen_layers.json';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 100);
    };
  }
  if (loadBtn && loadInput) {
    loadBtn.onclick = () => loadInput.click();
    loadInput.onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (evt) => {
        try {
          const ids = JSON.parse(evt.target.result);
          if (Array.isArray(ids)) setChosenLayerIds(ids);
        } catch (err) { alert('Invalid file'); }
      };
      reader.readAsText(file);
    };
  }
});
// Backend base URL
const backendBase = 'http://localhost:3000/';

const fylkeFilterConfig = {
  nameSchema: 'fylker',
  nameTable: 'administrativenhetnavn',
  nameColumn: 'navn',
  geomSchema: 'fylker',
  geomTable: 'fylke',
  geomColumn: 'omrade',
  geomNameColumn: 'fylkesnavn',
  nameMatchMode: 'contains',
  joinColumn: 'id',
  brannSchema: 'brannstasjoner',
  brannTable: 'brannstasjon',
  brannGeomColumn: 'posisjon',
};

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

import { saveWmsConnections, loadWmsConnections, removeWmsConnection } from './wmsStorage.js';
// WMS layers tracked locally and persisted
let wmsLayers = loadWmsConnections();

function addWmsToUI(id, title, tileUrlTemplate) {
  const container = document.getElementById('layers');
  if (!container) return;
  const div = document.createElement('div');
  div.className = 'layer-item';
  div.style.display = 'flex';
  div.style.alignItems = 'center';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.id = `wms_${id}`;
  input.style.marginRight = '6px';
  input.onchange = async (e) => {
    if (e.target.checked) {
      const srcId = `src_wms_${id}`;
      if (!map.getSource(srcId)) {
        map.addSource(srcId, { type: 'raster', tiles: [tileUrlTemplate], tileSize: 256 });
      }
      if (!map.getLayer(`layer_wms_${id}`)) {
        map.addLayer({ id: `layer_wms_${id}`, type: 'raster', source: srcId });
      }
    } else {
      const layerId = `layer_wms_${id}`;
      const srcId = `src_wms_${id}`;
      try { if (map.getLayer(layerId)) map.removeLayer(layerId); } catch (e) {}
      try { if (map.getSource(srcId)) map.removeSource(srcId); } catch (e) {}
    }
  };
  const label = document.createElement('label');
  label.htmlFor = input.id;
  label.innerText = title;
  label.style.flex = '1';
  // Remove button
  const btnRemove = document.createElement('button');
  btnRemove.innerText = '✕';
  btnRemove.title = 'Remove WMS connection';
  btnRemove.style.marginLeft = '6px';
  btnRemove.style.background = 'none';
  btnRemove.style.border = 'none';
  btnRemove.style.cursor = 'pointer';
  btnRemove.onclick = () => {
    wmsLayers = removeWmsConnection(id);
    saveWmsConnections(wmsLayers);
    renderWmsConnections();
  };
  div.appendChild(input);
  div.appendChild(label);
  div.appendChild(btnRemove);
  container.insertBefore(div, container.firstChild);
}

function renderWmsConnections(sortBy = 'recent') {
  // Remove all WMS UI entries first
  const container = document.getElementById('layers');
  if (!container) return;
  // Remove only WMS entries (by id prefix)
  Array.from(container.children).forEach(child => {
    if (child.querySelector && child.querySelector('input[id^="wms_"]')) {
      container.removeChild(child);
    }
  });
  let sorted = [...wmsLayers];
  if (sortBy === 'name') {
    sorted.sort((a, b) => (a.layers || a.base || '').localeCompare(b.layers || b.base || ''));
  } else if (sortBy === 'recent') {
    sorted.sort((a, b) => b.id.localeCompare(a.id));
  }
  for (const wms of sorted) {
    addWmsToUI(wms.id, wms.layers || wms.base, wms.tileTemplate);
  }
}

async function loadLayers() {
  console.debug && console.debug('loadLayers: start');
  // Fetch all spatial tables across schemas
  const r = await fetch(backendBase + 'spatial');
  const data = await r.json();
  console.debug && console.debug('loadLayers: fetched data', data && (data.tables || []).length);
  const container = document.getElementById('layers');
  if (!container) return; // defensive: avoid exceptions if DOM missing
  container.innerHTML = '';
  const tables = data.tables || [];
  console.debug && console.debug('loadLayers: tables sample', tables[0]);
  availableTables = tables;
  tablesByName.clear();

  // Preserve checked state for controls so user selections survive refresh
  const previouslyChecked = new Set();
  document.querySelectorAll('#layers input[type=checkbox]').forEach(cb => { if (cb.checked) previouslyChecked.add(cb.id); });
  // Group tables by schema and build collapsible sections
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

    // per-schema buttons
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

      // restore previous checked state
      if (previouslyChecked.has(id)) {
        input.checked = true;
        if (!input.disabled) await addLayerToMap(full);
      }
    }

    details.appendChild(inner);
    container.appendChild(details);
  }
}

// Compatibility: some older frontend code expects a global loadSchemaSelector()
// Provide a safe implementation that only runs if a target element exists.
async function loadSchemaSelector() {
  try {
    const targetIdCandidates = ['schemaSelector', 'schema', 'schema-list', 'schemas'];
    let el = null;
    for (const id of targetIdCandidates) {
      el = document.getElementById(id);
      if (el) break;
    }
    if (!el) return; // nothing to do in modern UI

    // fetch legacy endpoint if available
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

// Add a small log so we can see when the legacy selector runs
console.debug && console.debug('frontend/main.js loaded');

// Show all geometry-enabled layers
async function showAllLayers() {
  for (const t of availableTables) {
    const full = `${t.schema}.${t.table}`;
    const idSafe = full.replace(/[^a-zA-Z0-9_]/g, '_');
    const chk = document.getElementById(`chk_${idSafe}`);
    if (chk && !chk.checked) chk.checked = true;
    await addLayerToMap(full);
  }
}

// Hide all loaded layers
function hideAllLayers() {
  for (const t of availableTables) {
    const full = `${t.schema}.${t.table}`;
    const idSafe = encodeURIComponent(full);
    const chk = document.getElementById(`chk_${idSafe}`);
    if (chk && chk.checked) chk.checked = false;
    removeLayerFromMap(full);
  }
  // Also remove special filtered layers
  removeFylkeFilterLayers();
  removeFilteredTilfluktsromLayer();
}

// Show all tables in a schema
async function showSchema(schema) {
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

// Hide all tables in a schema
function hideSchema(schema) {
  for (const t of availableTables) {
    if (t.schema !== schema) continue;
    const full = `${t.schema}.${t.table}`;
    const idSafe = encodeURIComponent(full);
    const chk = document.getElementById(`chk_${idSafe}`);
    if (chk && chk.checked) chk.checked = false;
    removeLayerFromMap(full);
  }
}

function buildFylkeQueryParams() {
  const p = new URLSearchParams();
  p.set('name_schema', fylkeFilterConfig.nameSchema);
  p.set('name_table', fylkeFilterConfig.nameTable);
  p.set('name_col', fylkeFilterConfig.nameColumn);
  p.set('geom_schema', fylkeFilterConfig.geomSchema);
  p.set('geom_table', fylkeFilterConfig.geomTable);
  p.set('geom_col', fylkeFilterConfig.geomColumn);
  if (fylkeFilterConfig.geomNameColumn) {
    p.set('geom_name_col', fylkeFilterConfig.geomNameColumn);
  }
  if (fylkeFilterConfig.nameMatchMode) {
    p.set('name_match', fylkeFilterConfig.nameMatchMode);
  }
  p.set('join_col', fylkeFilterConfig.joinColumn);
  p.set('brann_schema', fylkeFilterConfig.brannSchema);
  p.set('brann_table', fylkeFilterConfig.brannTable);
  p.set('brann_geom_col', fylkeFilterConfig.brannGeomColumn);
  return p;
}

function removeFylkeFilterLayers() {
  const outlineFillId = 'layer_fylke_outline_fill';
  const outlineLineId = 'layer_fylke_outline_line';
  const outlineSrcId = 'src_fylke_outline';
  const brannLayerId = 'layer_brannstasjoner_fylke';
  const brannSrcId = 'src_brannstasjoner_fylke';

  if (map.getLayer(outlineFillId)) {
    try { map.removeLayer(outlineFillId); } catch (e) { console.warn('remove outline fill failed', e && e.message); }
  }
  if (map.getLayer(outlineLineId)) {
    try { map.removeLayer(outlineLineId); } catch (e) { console.warn('remove outline line failed', e && e.message); }
  }
  if (map.getSource(outlineSrcId)) {
    try { map.removeSource(outlineSrcId); } catch (e) { console.warn('remove outline source failed', e && e.message); }
  }
  if (map.getLayer(brannLayerId)) {
    try { map.removeLayer(brannLayerId); } catch (e) { console.warn('remove brann layer failed', e && e.message); }
  }
  if (map.getSource(brannSrcId)) {
    try { map.removeSource(brannSrcId); } catch (e) { console.warn('remove brann source failed', e && e.message); }
  }
}

function hideBrannstasjonBaseLayers() {
  const brannTables = availableTables
    .filter(t => String(t.table).toLowerCase() === String(fylkeFilterConfig.brannTable).toLowerCase());

  for (const t of brannTables) {
    const full = `${t.schema}.${t.table}`;
    const idSafe = encodeURIComponent(full);
    const checkbox = document.getElementById(`chk_${idSafe}`);
    if (checkbox) checkbox.checked = false;
    removeLayerFromMap(full);
  }
}

async function loadFylkeOptions() {
  const select = document.getElementById('fylkeSelect');
  if (!select) return;
  select.innerHTML = '';
  const params = buildFylkeQueryParams();
  const url = `${backendBase}analysis/fylke-list?${params.toString()}`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('Failed to load fylker list');
    const data = await res.json();
    const names = Array.isArray(data.names) ? data.names : [];
    if (names.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.text = '(no fylker)';
      select.appendChild(opt);
      return;
    }
    for (const name of names) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.text = name;
      select.appendChild(opt);
    }
  } catch (err) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.text = 'Failed to load fylker';
    select.appendChild(opt);
    console.warn('load fylker failed', err && err.message);
  }
}

async function applyFylkeFilter() {
  const select = document.getElementById('fylkeSelect');
  if (!select || !select.value) return;

  hideBrannstasjonBaseLayers();
  removeFylkeFilterLayers();

  const params = buildFylkeQueryParams();
  params.set('fylke_name', select.value);

  const outlineUrl = `${backendBase}analysis/fylke-outline?${params.toString()}`;
  const brannUrl = `${backendBase}analysis/brannstasjoner-in-fylke?${params.toString()}`;

  try {
    const [outlineRes, brannRes] = await Promise.all([fetch(outlineUrl), fetch(brannUrl)]);
    if (!outlineRes.ok) throw new Error('Failed to load fylke outline');
    if (!brannRes.ok) throw new Error('Failed to load brannstasjoner');

    const outlineGeo = await outlineRes.json();
    const brannGeo = await brannRes.json();

    const outlineFeatures = (outlineGeo && outlineGeo.features) ? outlineGeo.features : [];
    if (outlineFeatures.length === 0) {
      alert('No fylke geometry found for the selected name.');
      return;
    }

    map.addSource('src_fylke_outline', { type: 'geojson', data: outlineGeo });
    map.addLayer({
      id: 'layer_fylke_outline_fill',
      type: 'fill',
      source: 'src_fylke_outline',
      paint: { 'fill-color': '#ffd166', 'fill-opacity': 0.08 },
    });
    map.addLayer({
      id: 'layer_fylke_outline_line',
      type: 'line',
      source: 'src_fylke_outline',
      paint: { 'line-color': '#ffd166', 'line-width': 2 },
    });

    const brannFeatures = (brannGeo && brannGeo.features) ? brannGeo.features : [];
    map.addSource('src_brannstasjoner_fylke', { type: 'geojson', data: brannGeo });
    map.addLayer({
      id: 'layer_brannstasjoner_fylke',
      type: 'circle',
      source: 'src_brannstasjoner_fylke',
      paint: { 'circle-radius': 6, 'circle-color': '#ef476f' },
    });

    let bbox = null;
    try {
      if (typeof turf !== 'undefined' && turf && typeof turf.bbox === 'function') bbox = turf.bbox(outlineGeo);
    } catch (e) {
      console.warn('turf.bbox failed', e && e.message);
    }
    if (bbox) map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], { padding: 20 });

    if (brannFeatures.length === 0) {
      alert('No brannstasjoner found inside this fylke.');
    }
  } catch (err) {
    alert('Error applying fylke filter: ' + err.message);
  }
}

// attach buttons after DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  const showBtn = document.getElementById('showAll');
  const hideBtn = document.getElementById('hideAll');
  const filterTilfluktsromBtn = document.getElementById('filterTilfluktsrom500Btn');
  const fylkeApplyBtn = document.getElementById('fylkeApplyBtn');
  const fylkeClearBtn = document.getElementById('fylkeClearBtn');
  if (showBtn) showBtn.addEventListener('click', () => { showAllLayers(); });
  if (hideBtn) hideBtn.addEventListener('click', () => { hideAllLayers(); });
  if (filterTilfluktsromBtn) filterTilfluktsromBtn.addEventListener('click', () => { showTilfluktsromMinPlasser(500); });
  if (fylkeApplyBtn) fylkeApplyBtn.addEventListener('click', () => { applyFylkeFilter(); });
  if (fylkeClearBtn) fylkeClearBtn.addEventListener('click', () => { removeFylkeFilterLayers(); });
  try {
    if (typeof loadSchemaSelector === 'function') {
      loadSchemaSelector().catch(err => console.warn('loadSchemaSelector failed', err));
    }
  } catch (e) {
    console.warn('loadSchemaSelector call error', e && e.message);
  }
  // Ensure layer list is loaded immediately (don't rely only on turf script load)
  loadLayers().catch(err => console.warn('initial loadLayers failed', err));
  loadFylkeOptions().catch(err => console.warn('load fylke options failed', err && err.message));
  // insert WMS form above layers
  try {
    const sidebar = document.getElementById('sidebar');
    if (sidebar) {
      const wmsDiv = document.createElement('div');
      wmsDiv.style.marginBottom = '8px';
      const inpUrl = document.createElement('input');
      inpUrl.placeholder = 'WMS base URL (e.g. https://srv/.../wms)';
      inpUrl.style.width = '100%';
      inpUrl.id = 'wms_base_url';
      const inpLayers = document.createElement('input');
      inpLayers.placeholder = 'WMS layers param (comma separated)';
      inpLayers.style.width = '100%';
      inpLayers.id = 'wms_layers';
      const selVersion = document.createElement('select');
      selVersion.id = 'wms_version';
      ['1.1.1','1.3.0'].forEach(v => { const o = document.createElement('option'); o.value=v; o.text=v; selVersion.appendChild(o); });
      selVersion.style.width = '100%';
      const selCrs = document.createElement('select');
      selCrs.id = 'wms_crs';
      ['EPSG:4326','EPSG:3857'].forEach(v => { const o = document.createElement('option'); o.value=v; o.text=v; selCrs.appendChild(o); });
      selCrs.style.width = '100%';
      const selFormat = document.createElement('select');
      selFormat.id = 'wms_format';
      ['image/png','image/jpeg'].forEach(v => { const o = document.createElement('option'); o.value=v; o.text=v; selFormat.appendChild(o); });
      selFormat.style.width = '100%';
      const btn = document.createElement('button');
      btn.innerText = 'Add WMS';
      btn.type = 'button';
      btn.style.marginTop = '4px';
      // Use the locally created input/select variables rather than querying the DOM
      btn.addEventListener('click', () => {
        try {
          const base = (inpUrl && inpUrl.value) ? inpUrl.value.trim() : '';
          const layers = (inpLayers && inpLayers.value) ? inpLayers.value.trim() : '';
          const version = (selVersion && selVersion.value) ? selVersion.value : '1.3.0';
          const crs = (selCrs && selCrs.value) ? selCrs.value : 'EPSG:3857';
          const format = (selFormat && selFormat.value) ? selFormat.value : 'image/png';
          if (!base) return alert('Enter WMS base URL');
          const id = String(Date.now());
          // strip query string from provided base if user pasted a GetCapabilities URL
          const baseClean = base.split('?')[0];
          // tile proxy route on backend (use absolute backendBase so requests go to backend port)
          const tileTemplate = `${backendBase}wms/tile/{z}/{x}/{y}?wms=${encodeURIComponent(baseClean)}&layers=${encodeURIComponent(layers)}&version=${encodeURIComponent(version)}&crs=${encodeURIComponent(crs)}&format=${encodeURIComponent(format)}`;
          wmsLayers.push({ id, base, layers, tileTemplate });
          saveWmsConnections(wmsLayers);
          renderWmsConnections();
        } catch (e) {
          console.warn('Add WMS failed', e && e.message);
        }
      });
      // Sorting dropdown
      const sortSelect = document.createElement('select');
      sortSelect.id = 'wms_sort';
      sortSelect.style.width = '100%';
      [
        { value: 'recent', text: 'Sort: Most Recent' },
        { value: 'name', text: 'Sort: Name' },
      ].forEach(opt => {
        const o = document.createElement('option');
        o.value = opt.value;
        o.text = opt.text;
        sortSelect.appendChild(o);
      });
      sortSelect.onchange = () => renderWmsConnections(sortSelect.value);

      wmsDiv.appendChild(inpUrl);
      wmsDiv.appendChild(inpLayers);
      wmsDiv.appendChild(sortSelect);
      wmsDiv.appendChild(btn);
      // insert before layers container
      const layersEl = document.getElementById('layers');
      sidebar.insertBefore(wmsDiv, layersEl);
      // Render saved WMS connections on load
      renderWmsConnections();
    }
  } catch (e) { console.warn('add WMS form failed', e && e.message); }
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

function removeLayerFromMap(name) {
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

function removeFilteredTilfluktsromLayer() {
  const layerId = 'layer_tilfluktsrom_min_500';
  const srcId = 'src_tilfluktsrom_min_500';
  if (map.getLayer(layerId)) {
    try { map.removeLayer(layerId); } catch (e) { console.warn('remove filtered layer failed', e && e.message); }
  }
  if (map.getSource(srcId)) {
    try { map.removeSource(srcId); } catch (e) { console.warn('remove filtered source failed', e && e.message); }
  }
}

async function showTilfluktsromMinPlasser(minPlasser) {
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

// Load Turf.js for bbox calculation
const turfScript = document.createElement('script');
turfScript.src = 'https://cdn.jsdelivr.net/npm/@turf/turf@6/turf.min.js';
turfScript.onload = () => loadLayers();
document.head.appendChild(turfScript);

// Poll for changes so new schemas/tables are detected automatically
setInterval(() => {
  loadLayers().catch(err => console.error('Failed to refresh layers', err));
}, 30000);

map.on('load', () => {
  map.on('click', async (e) => {
    const features = map.queryRenderedFeatures(e.point);
    if (!features.length) return;

    const feature = features.find(f => f.layer.id.startsWith('layer_'));
    if (!feature) return;

    // Extract table name from layer id
    const layerId = feature.layer.id;
    const table = layerId.replace(/^layer_/, '').replace(/_/g, '.');

    // Fetch full feature data from backend using the table and ID
    const id = feature.properties?.id;
    if (!id) return;

    try {
      const response = await fetch(`${backendBase}feature/${encodeURIComponent(table)}/${encodeURIComponent(id)}`);
      if (!response.ok) throw new Error('Failed to fetch feature data');
      const fullFeature = await response.json();

      // Build popup HTML from specific columns (adjust as needed; here showing all properties except geometry)
      let popupHTML = '<h3>Feature Details</h3>';
      for (const [key, value] of Object.entries(fullFeature.properties || {})) {
        if (key !== 'geometry') {  // Skip geometry if present
          popupHTML += `<p><strong>${key}:</strong> ${value ?? 'N/A'}</p>`;
        }
      }

      new maplibregl.Popup()
        .setLngLat(e.lngLat)
        .setHTML(popupHTML)
        .addTo(map);
    } catch (error) {
      console.error('Error fetching feature data:', error);
      // Fallback to basic popup if fetch fails
      const id = feature.properties?.objid ?? "Ingen ID";
      const plasser = feature.properties?.plasser ?? "Ingen plasser";
      new maplibregl.Popup()
        .setLngLat(e.lngLat)
        .setHTML(`<h3>ID: ${id}</h3><br><h3>Plasser: ${plasser}</h3>`)
        .addTo(map);
    }
  });
});

