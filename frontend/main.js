import { setupSidebarToggle, setupDarkModeToggle } from './modules/sidebar.js';
import { setupAppLinks } from './modules/appLinks.js';
import { getChosenLayerIds, setChosenLayerIds, setupSaveLoadLayers } from './modules/layerPersistence.js';
import { setupWmsTreeMenu, setupWmsForm } from './modules/wmsMenu.js';
import { loadLayers, loadSchemaSelector, showAllLayers, hideAllLayers, showTilfluktsromMinPlasser } from './modules/layers.js';
import { loadFylkeOptions, applyFylkeFilter, removeFylkeFilterLayers } from './modules/fylkeFilter.js';
import { map } from './modules/state.js';

console.debug && console.debug('frontend/main.js loaded');

// Expose for legacy scripts (some older UI code may call this directly)
window.loadSchemaSelector = loadSchemaSelector;

window.addEventListener('DOMContentLoaded', () => {
  setupSidebarToggle();
  setupDarkModeToggle();
  setupAppLinks();
  setupSaveLoadLayers({ getChosenLayerIds, setChosenLayerIds });
  setupWmsTreeMenu();
  setupWmsForm();

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

  loadLayers().catch(err => console.warn('initial loadLayers failed', err));
  loadFylkeOptions().catch(err => console.warn('load fylke options failed', err && err.message));
});

// Load Turf.js for bbox calculation and reload layers when it's ready.
const turfScript = document.createElement('script');
turfScript.src = 'https://cdn.jsdelivr.net/npm/@turf/turf@6/turf.min.js';
turfScript.onload = () => loadLayers();
document.head.appendChild(turfScript);

// Poll for schema/table changes so new tables appear automatically.
setInterval(() => {
  loadLayers().catch(err => console.error('Failed to refresh layers', err));
}, 30000);

map.on('load', () => {
  map.on('click', async (e) => {
    const features = map.queryRenderedFeatures(e.point);
    if (!features.length) return;

    const feature = features.find(f => f.layer.id.startsWith('layer_'));
    if (!feature) return;

    const layerId = feature.layer.id;
    const table = layerId.replace(/^layer_/, '').replace(/_/g, '.');

    const id = feature.properties?.id;
    if (!id) return;

    try {
      const response = await fetch(`${window.location.protocol}//${window.location.host}/feature/${encodeURIComponent(table)}/${encodeURIComponent(id)}`);
      if (!response.ok) throw new Error('Failed to fetch feature data');
      const fullFeature = await response.json();

      let popupHTML = '<h3>Feature Details</h3>';
      for (const [key, value] of Object.entries(fullFeature.properties || {})) {
        if (key !== 'geometry') {
          popupHTML += `<p><strong>${key}:</strong> ${value ?? 'N/A'}</p>`;
        }
      }

      new maplibregl.Popup()
        .setLngLat(e.lngLat)
        .setHTML(popupHTML)
        .addTo(map);
    } catch (error) {
      console.error('Error fetching feature data:', error);
      const idVal = feature.properties?.objid ?? 'Ingen ID';
      const plasser = feature.properties?.plasser ?? 'Ingen plasser';
      new maplibregl.Popup()
        .setLngLat(e.lngLat)
        .setHTML(`<h3>ID: ${idVal}</h3><br><h3>Plasser: ${plasser}</h3>`)
        .addTo(map);
    }
  });
});
