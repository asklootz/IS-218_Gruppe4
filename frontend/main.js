// When running locally with docker-compose, the backend is reachable on localhost:3000
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

async function loadLayers() {
  const r = await fetch(backendBase + 'layers');
  const data = await r.json();
  const container = document.getElementById('layers');
  container.innerHTML = '';
  (data.layers || []).forEach(name => {
    const id = `chk_${name}`;
    const div = document.createElement('div');
    div.className = 'layer-item';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = id;
    input.onchange = async (e) => {
      if (e.target.checked) {
        await addLayerToMap(name);
      } else {
        removeLayerFromMap(name);
      }
    };
    const label = document.createElement('label');
    label.htmlFor = id;
    label.innerText = name;
    div.appendChild(input);
    div.appendChild(label);
    container.appendChild(div);
  });
}

async function addLayerToMap(name) {
  try {
    const r = await fetch(backendBase + 'layers/' + encodeURIComponent(name));
    if (!r.ok) throw new Error('Failed to load layer');
    const geojson = await r.json();
    const srcId = `src_${name}`;
    if (map.getSource(srcId)) return;
    map.addSource(srcId, { type: 'geojson', data: geojson });

    // Decide layer type by geometry
    const geomType = (geojson.features && geojson.features[0] && geojson.features[0].geometry && geojson.features[0].geometry.type) || 'Point';
    let layer = null;
    if (geomType === 'Point' || geomType === 'MultiPoint') {
      layer = {
        id: `layer_${name}`,
        type: 'circle',
        source: srcId,
        paint: { 'circle-radius': 6, 'circle-color': '#007cbf' },
      };
    } else if (geomType === 'LineString' || geomType === 'MultiLineString') {
      layer = {
        id: `layer_${name}`,
        type: 'line',
        source: srcId,
        paint: { 'line-color': '#ff6600', 'line-width': 2 },
      };
    } else {
      layer = {
        id: `layer_${name}`,
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
