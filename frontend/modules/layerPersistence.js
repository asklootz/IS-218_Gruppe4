export function getChosenLayerIds() {
  return Array.from(document.querySelectorAll('#layers input[type=checkbox]'))
    .filter(cb => cb.checked)
    .map(cb => cb.id);
}

export function setChosenLayerIds(ids) {
  document.querySelectorAll('#layers input[type=checkbox]').forEach(cb => {
    cb.checked = ids.includes(cb.id);
    cb.dispatchEvent(new Event('change'));
  });
}

export function setupSaveLoadLayers({ getChosenLayerIds, setChosenLayerIds }) {
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
}
