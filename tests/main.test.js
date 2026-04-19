import { JSDOM } from 'jsdom';

// Setup JSDOM for DOM manipulation
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
global.window = dom.window;
global.document = dom.window.document;
global.navigator = dom.window.navigator;

// Mock localStorage
const localStorageMock = {
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
  clear: jest.fn(),
};
global.localStorage = localStorageMock;

// Import the functions to test
import './main.js'; // Assuming main.js exports or we can test global functions

describe('Sidebar Toggle', () => {
  beforeEach(() => {
    // Reset DOM
    document.body.innerHTML = `
      <div id="sidebar"></div>
      <button id="sidebarToggle"></button>
      <button id="sidebarShowBtn"></button>
      <div id="map"></div>
    `;
  });

  test('should hide sidebar and show show button on toggle click', () => {
    const sidebar = document.getElementById('sidebar');
    const sidebarToggle = document.getElementById('sidebarToggle');
    const sidebarShowBtn = document.getElementById('sidebarShowBtn');
    const mapDiv = document.getElementById('map');

    // Trigger DOMContentLoaded to setup
    window.dispatchEvent(new Event('DOMContentLoaded'));

    // Click toggle
    sidebarToggle.click();

    expect(sidebar.classList.contains('hide')).toBe(true);
    expect(mapDiv.classList.contains('sidebar-hidden')).toBe(true);
    expect(sidebarShowBtn.style.display).toBe('block');
  });

  test('should show sidebar and hide show button on show button click', () => {
    const sidebar = document.getElementById('sidebar');
    const sidebarShowBtn = document.getElementById('sidebarShowBtn');
    const mapDiv = document.getElementById('map');

    // First hide
    sidebar.classList.add('hide');
    mapDiv.classList.add('sidebar-hidden');
    sidebarShowBtn.style.display = 'block';

    // Trigger DOMContentLoaded
    window.dispatchEvent(new Event('DOMContentLoaded'));

    // Click show
    sidebarShowBtn.click();

    expect(sidebar.classList.contains('hide')).toBe(false);
    expect(mapDiv.classList.contains('sidebar-hidden')).toBe(false);
    expect(sidebarShowBtn.style.display).toBe('none');
  });
});

describe('Dark Mode Toggle', () => {
  beforeEach(() => {
    document.body.innerHTML = '<button id="darkModeToggle"></button>';
    localStorageMock.getItem.mockClear();
    localStorageMock.setItem.mockClear();
  });

  test('should toggle light-mode class and save to localStorage', () => {
    const darkModeToggle = document.getElementById('darkModeToggle');

    // Trigger DOMContentLoaded
    window.dispatchEvent(new Event('DOMContentLoaded'));

    // Click toggle
    darkModeToggle.click();

    expect(document.body.classList.contains('light-mode')).toBe(true);
    expect(localStorageMock.setItem).toHaveBeenCalledWith('darkMode', 'light');
  });
});