// Utility for saving and loading WMS connections to localStorage
export function saveWmsConnections(wmsLayers) {
  try {
    localStorage.setItem('wmsConnections', JSON.stringify(wmsLayers));
  } catch (e) {
    console.warn('Failed to save WMS connections', e && e.message);
  }
}

export function loadWmsConnections() {
  try {
    const data = localStorage.getItem('wmsConnections');
    if (!data) return [];
    return JSON.parse(data);
  } catch (e) {
    console.warn('Failed to load WMS connections', e && e.message);
    return [];
  }
}

export function removeWmsConnection(id) {
  const wmsLayers = loadWmsConnections();
  const filtered = wmsLayers.filter(w => w.id !== id);
  saveWmsConnections(filtered);
  return filtered;
}
