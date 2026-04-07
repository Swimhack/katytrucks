module.exports = {
  testEnvironment: 'node',
  testTimeout: 10000,
  collectCoverageFrom: ['server.js'],
  transformIgnorePatterns: [
    'node_modules/(?!(uuid)/)'
  ],
  moduleNameMapper: {
    '^uuid$': 'uuid'
  },
  coveragePathIgnorePatterns: [
    '/node_modules/',
    '/__tests__/'
  ]
};
