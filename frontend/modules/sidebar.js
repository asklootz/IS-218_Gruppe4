// Sidebar toggle and dark mode handling
export function setupSidebarToggle() {
  const sidebar = document.getElementById('sidebar');
  const sidebarToggle = document.getElementById('sidebarToggle');
  const sidebarShowBtn = document.getElementById('sidebarShowBtn');
  const mapDiv = document.getElementById('map');
  if (sidebar && sidebarToggle && sidebarShowBtn && mapDiv) {
    sidebarToggle.onclick = () => {
      sidebar.classList.add('hide');
      mapDiv.classList.add('sidebar-hidden');
      sidebarShowBtn.style.display = 'block';
    };
    sidebarShowBtn.onclick = () => {
      sidebar.classList.remove('hide');
      mapDiv.classList.remove('sidebar-hidden');
      sidebarShowBtn.style.display = 'none';
    };
  }
}

export function setupDarkModeToggle() {
  const darkModeToggle = document.getElementById('darkModeToggle');
  // Persist dark mode preference
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const saved = localStorage.getItem('darkMode');
  if ((saved === 'dark') || (!saved && prefersDark)) {
    document.body.classList.remove('light-mode');
  } else if (saved === 'light') {
    document.body.classList.add('light-mode');
  }
  if (darkModeToggle) {
    darkModeToggle.onclick = () => {
      document.body.classList.toggle('light-mode');
      localStorage.setItem('darkMode', document.body.classList.contains('light-mode') ? 'light' : 'dark');
    };
  }
}
