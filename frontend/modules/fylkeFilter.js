import { backendBase, map, availableTables } from './state.js';

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

export function buildFylkeQueryParams() {
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

export function removeFylkeFilterLayers() {
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

export function hideBrannstasjonBaseLayers() {
  const brannTables = availableTables
    .filter(t => String(t.table).toLowerCase() === String(fylkeFilterConfig.brannTable).toLowerCase());

  for (const t of brannTables) {
    const full = `${t.schema}.${t.table}`;
    const idSafe = encodeURIComponent(full);
    const checkbox = document.getElementById(`chk_${idSafe}`);
    if (checkbox) checkbox.checked = false;
    const layerId = `layer_${idSafe}`;
    const srcId = `src_${idSafe}`;
    if (map.getLayer(layerId)) {
      try { map.removeLayer(layerId); } catch (e) { console.warn('remove layer failed', e && e.message); }
    }
    if (map.getSource(srcId)) {
      try { map.removeSource(srcId); } catch (e) { console.warn('remove source failed', e && e.message); }
    }
  }
}

export async function loadFylkeOptions() {
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

export async function applyFylkeFilter() {
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
