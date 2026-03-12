import { backendBase, map, wmsLayers, setWmsLayers } from './state.js';
import { saveWmsConnections, removeWmsConnection } from '../wmsStorage.js';

export async function fetchWmsCapabilities(baseUrl) {
  const url = `${baseUrl}?service=WMS&request=GetCapabilities`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Failed to fetch WMS capabilities');
  return await res.text();
}

export function parseWmsCapabilities(xmlStr) {
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

export function renderWmsTreeMenu(layers, container, onSelect) {
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

export function addWmsToUI(id, title, tileUrlTemplate) {
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
  const btnRemove = document.createElement('button');
  btnRemove.innerText = '✕';
  btnRemove.title = 'Remove WMS connection';
  btnRemove.style.marginLeft = '6px';
  btnRemove.style.background = 'none';
  btnRemove.style.border = 'none';
  btnRemove.style.cursor = 'pointer';
  btnRemove.onclick = () => {
    const updated = removeWmsConnection(id);
    setWmsLayers(updated);
    renderWmsConnections();
  };
  div.appendChild(input);
  div.appendChild(label);
  div.appendChild(btnRemove);
  container.insertBefore(div, container.firstChild);
}

export function renderWmsConnections(sortBy = 'recent') {
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

export function setupWmsTreeMenu() {
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
      const id = encodeURIComponent(layerName);
      const title = layerName;
      const tileUrlTemplate = `${baseUrl}?service=WMS&request=GetMap&layers=${layerName}&styles=&format=image/png&transparent=true&version=1.1.1&width=256&height=256&srs=EPSG:3857&bbox={bbox-epsg-3857}`;
      addWmsToUI(id, title, tileUrlTemplate);
    };
  }
}

export function setupWmsForm() {
  try {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar) return;

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
    ['1.1.1', '1.3.0'].forEach(v => {
      const o = document.createElement('option');
      o.value = v;
      o.text = v;
      selVersion.appendChild(o);
    });
    selVersion.style.width = '100%';

    const selCrs = document.createElement('select');
    selCrs.id = 'wms_crs';
    ['EPSG:4326', 'EPSG:3857'].forEach(v => {
      const o = document.createElement('option');
      o.value = v;
      o.text = v;
      selCrs.appendChild(o);
    });
    selCrs.style.width = '100%';

    const selFormat = document.createElement('select');
    selFormat.id = 'wms_format';
    ['image/png', 'image/jpeg'].forEach(v => {
      const o = document.createElement('option');
      o.value = v;
      o.text = v;
      selFormat.appendChild(o);
    });
    selFormat.style.width = '100%';

    const btn = document.createElement('button');
    btn.innerText = 'Add WMS';
    btn.type = 'button';
    btn.style.marginTop = '4px';
    btn.addEventListener('click', () => {
      try {
        const base = (inpUrl && inpUrl.value) ? inpUrl.value.trim() : '';
        const layers = (inpLayers && inpLayers.value) ? inpLayers.value.trim() : '';
        const version = (selVersion && selVersion.value) ? selVersion.value : '1.3.0';
        const crs = (selCrs && selCrs.value) ? selCrs.value : 'EPSG:3857';
        const format = (selFormat && selFormat.value) ? selFormat.value : 'image/png';
        if (!base) return alert('Enter WMS base URL');
        const id = String(Date.now());
        const baseClean = base.split('?')[0];
        const tileTemplate = `${backendBase}wms/tile/{z}/{x}/{y}?wms=${encodeURIComponent(baseClean)}&layers=${encodeURIComponent(layers)}&version=${encodeURIComponent(version)}&crs=${encodeURIComponent(crs)}&format=${encodeURIComponent(format)}`;
        wmsLayers.push({ id, base, layers, tileTemplate });
        saveWmsConnections(wmsLayers);
        renderWmsConnections();
      } catch (e) {
        console.warn('Add WMS failed', e && e.message);
      }
    });

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

    const layersEl = document.getElementById('layers');
    sidebar.insertBefore(wmsDiv, layersEl);

    renderWmsConnections();
  } catch (e) {
    console.warn('add WMS form failed', e && e.message);
  }
}
