import { loadWmsConnections } from '../wmsStorage.js';

// Base URL for the backend API
export const backendBase = 'http://localhost:3000/';

// MapLibre map instance (requires <div id="map"> to exist already)
export const map = new maplibregl.Map({
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

// The list of available spatial tables (populated by loadLayers)
export let availableTables = [];

// Map of fullName -> table object for fast lookup (populated by loadLayers)
export const tablesByName = new Map();

// Persisted WMS layers stored in localStorage via wmsStorage.js
export let wmsLayers = loadWmsConnections();

export function setAvailableTables(tables) {
  availableTables = tables;
}

export function setWmsLayers(layers) {
  wmsLayers = layers;
}
