import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

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

// Holder styr på hvilke lag som har event-handlers registrert
const registeredEvents = new Set();

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

    // Håndter tomme lag
    if (!geojson.features || geojson.features.length === 0) {
      alert(`Layer "${name}" is empty`);
      return;
    }

    const srcId = `src_${name}`;
    const layerId = `layer_${name}`;

    if (!map.getSource(srcId)) {
      map.addSource(srcId, { type: 'geojson', data: geojson });
    }

    // Bestem lagtype
    const first = geojson.features[0];
    const geomType = first?.geometry?.type || 'Point';

    let layer = null;
    if (geomType.includes('Point')) {
      layer = {
        id: layerId,
        type: 'circle',
        source: srcId,
        paint: { 'circle-radius': 6, 'circle-color': '#007cbf' },
      };
    } else if (geomType.includes('Line')) {
      layer = {
        id: layerId,
        type: 'line',
        source: srcId,
        paint: { 'line-color': '#ff6600', 'line-width': 2 },
      };
    } else {
      layer = {
        id: layerId,
        type: 'fill',
        source: srcId,
        paint: { 'fill-color': '#00aa55', 'fill-opacity': 0.4 },
      };
    }

    if (!map.getLayer(layerId)) {
      map.addLayer(layer);
    }

    // Registrer event-handlers kun én gang
    if (!registeredEvents.has(layerId)) {
      registeredEvents.add(layerId);

      map.on('click', layerId, (e) => {
        const props = e.features[0].properties;

        let html = '<h3>Objektinfo</h3><table>';
        for (const key in props) {
          html += `<tr><td><strong>${key}</strong></td><td>${props[key]}</td></tr>`;
        }
        html += '</table>';

        new maplibregl.Popup()
          .setLngLat(e.lngLat)
          .setHTML(html)
          .addTo(map);
      });

      map.on('mouseenter', layerId, () => {
        map.getCanvas().style.cursor = 'pointer';
      });

      map.on('mouseleave', layerId, () => {
        map.getCanvas().style.cursor = '';
      });
    }

    // Zoom til lagets utstrekning
    const bbox = turf.bbox(geojson);
    map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], { padding: 20 });

  } catch (err) {
    alert('Error loading layer: ' + err.message);
  }
}

function removeLayerFromMap(name) {
  const layerId = `layer_${name}`;
  const srcId = `src_${name}`;

  if (map.getLayer(layerId)) {
    map.removeLayer(layerId);
  }
  if (map.getSource(srcId)) {
    map.removeSource(srcId);
  }

  // Fjern event-handlers
  if (registeredEvents.has(layerId)) {
    map.off('click', layerId);
    map.off('mouseenter', layerId);
    map.off('mouseleave', layerId);
    registeredEvents.delete(layerId);
  }
}

// Load Turf.js for bbox calculation
const turfScript = document.createElement('script');
turfScript.src = 'https://cdn.jsdelivr.net/npm/@turf/turf@6/turf.min.js';
turfScript.onload = () => loadLayers();
document.head.appendChild(turfScript);
