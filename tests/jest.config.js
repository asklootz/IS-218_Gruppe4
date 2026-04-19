module.exports = {
  testEnvironment: 'jsdom',
  setupFilesAfterEnv: ['<rootDir>/setupTests.js'],
  moduleNameMapping: {
    '\\.(css|less|scss|sass)$': 'identity-obj-proxy',
  },
  testMatch: [
    '<rootDir>/**/*.test.js',
    '<rootDir>/**/*.test.jsx',
  ],
  transform: {
    '^.+\\.(js|jsx)$': 'babel-jest',
  },
};