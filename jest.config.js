module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/__tests__/**',
  ],
  transform: {
    '^.+\\.ts$': 'ts-jest',
  },
  // Permission tests share a global temp directory (os.tmpdir()/forkoff-permissions)
  // and must run serially to avoid cross-test contamination.
  maxWorkers: 1,
};
