import { render, screen, fireEvent } from '@testing-library/react';
import App from '../frontend/src/App.jsx';

// Mock maplibre-gl to avoid canvas issues in tests
jest.mock('maplibre-gl', () => ({
  Map: jest.fn(() => ({
    on: jest.fn(),
    addControl: jest.fn(),
    addSource: jest.fn(),
    addLayer: jest.fn(),
    remove: jest.fn(),
  })),
}));

// Mock axios
jest.mock('axios');
import axios from 'axios';

describe('App Component', () => {
  beforeEach(() => {
    // Mock axios responses
    axios.get.mockResolvedValue({ data: [] });
  });

  test('renders the app without crashing', () => {
    render(<App />);
    expect(screen.getByText(/Beredskapskart/i)).toBeInTheDocument(); // Assuming there's some text
  });

  // Add more tests for user interactions, e.g., clicking buttons, etc.
  // Since the component is complex, you might need to mock more dependencies
});