export function renderAppLinks() {
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

export function setupAppLinks() {
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
}
