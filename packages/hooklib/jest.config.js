module.exports = {
  clearMocks: true,
  preset: 'ts-jest',
  moduleFileExtensions: ['js', 'ts'],
  testEnvironment: 'node',
  testMatch: ['**/*-test.ts'],
  testRunner: 'jest-circus/runner',
  verbose: true,
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts'
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['lcov', 'text-summary'],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: 'tsconfig.test.json'
      }
    ],
    '^.+\\.(js|mjs)$': ['babel-jest', {
      presets: [['@babel/preset-env', { targets: { node: 'current' } }]]
    }]
  },
  setupFilesAfterEnv: ['./jest.setup.js']
}
