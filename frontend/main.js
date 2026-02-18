// When running locally with docker-compose, the backend is reachable on localhost:3000
const backendBase = 'http://localhost:3000/';

// Holder styr på hvilke layers som allerede har registrert events
const registeredEvents = new Set();

// Opprett kartet
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


// ===============================
// Last liste over lag fra backend
// ===============================
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


// ===============================
// Legg til lag i kartet
// ===============================
async function addLayerToMap(name) {
  try {
    const r = await fetch(backendBase + 'layers/' + encodeURIComponent(name));
    if (!r.ok) throw new Error('Failed to load layer');

    const geojson = await r.json();

    const idSafe = name.replace(/\./g, '_');
    const srcId = `src_${idSafe}`;
    const layerId = `layer_${idSafe}`;

    if (map.getSource(srcId)) return;

    map.addSource(srcId, {
      type: 'geojson',
      data: geojson
    });

    // Bestem type basert på geometri
    const geomType =
      geojson.features &&
      geojson.features[0] &&
      geojson.features[0].geometry &&
      geojson.features[0].geometry.type;

    let layer;

    if (geomType === 'Point' || geomType === 'MultiPoint') {
      layer = {
        id: layerId,
        type: 'circle',
        source: srcId,
        paint: {
          'circle-radius': 6,
          'circle-color': '#007cbf'
        }
      };
    } else if (geomType === 'LineString' || geomType === 'MultiLineString') {
      layer = {
        id: layerId,
        type: 'line',
        source: srcId,
        paint: {
          'line-color': '#ff6600',
          'line-width': 2
        }
      };
    } else {
      layer = {
        id: layerId,
        type: 'fill',
        source: srcId,
        paint: {
          'fill-color': '#00aa55',
          'fill-opacity': 0.4
        }
      };
    }

    map.addLayer(layer);


    // ===============================
    // POPUP + CURSOR (registreres kun én gang)
    // ===============================
    if (!registeredEvents.has(layerId)) {
      registeredEvents.add(layerId);

      map.on('click', layerId, (e) => {
        if (!e.features || !e.features.length) return;

        const props = e.features[0].properties;

        let html = '<h3>Objektinfo</h3><table>';

        for (const key in props) {
          html += `
            <tr>
              <td><strong>${key}</strong></td>
              <td>${props[key]}</td>
            </tr>
          `;
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


    // ===============================
    // Zoom til layer
    // ===============================
    const bbox = turf.bbox(geojson);
    if (bbox) {
      map.fitBounds(
        [
          [bbox[0], bbox[1]],
          [bbox[2], bbox[3]]
        ],
        { padding: 20 }
      );
    }

  } catch (err) {
    alert('Error loading layer: ' + err.message);
  }
}

map.on('click', (e) => {
  new maplibregl.Popup()
    .setLngLat(e.lngLat)
    .setHTML("<b>Test popup</b>")
    .addTo(map);
});



// =========
