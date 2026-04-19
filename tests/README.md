# Unit Tests for User Interactions

This folder contains unit tests for parts of the application that involve user interactions.

## Setup

To run these tests, you need to install the necessary dependencies in the respective project folders.

### For frontend (React and vanilla JS tests):

In `/frontend` directory, run:

```bash
npm install --save-dev jest @testing-library/react @testing-library/jest-dom @testing-library/user-event jsdom
```

Add to `package.json` scripts:
```json
"scripts": {
  "test": "jest"
}
```

### For backend (if needed):

In `/backend` directory, run:

```bash
npm install --save-dev jest supertest
```

## Running Tests

From the frontend directory:
```bash
npm test
```

## Test Files

- `main.test.js`: Tests for vanilla JavaScript user interactions in `frontend/main.js` (sidebar toggle, dark mode).
- `App.test.jsx`: Tests for React component user interactions in `frontend/src/App.jsx`.

Note: These are basic examples. You may need to expand them based on specific user interaction scenarios.