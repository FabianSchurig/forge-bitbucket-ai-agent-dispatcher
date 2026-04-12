/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts', '**/__tests__/**/*.test.tsx'],
  transform: {
    '^.+\\.(ts|tsx|js|jsx)$': 'babel-jest',
  },
  moduleNameMapper: {
    '^@forge/api$': '<rootDir>/src/__mocks__/@forge/api.ts',
    '^@forge/react$': '<rootDir>/src/__mocks__/@forge/react.tsx',
    '^@forge/resolver$': '<rootDir>/src/__mocks__/@forge/resolver.ts',
    '^@forge/bridge$': '<rootDir>/src/__mocks__/@forge/bridge.ts',
  },
  projects: [
    {
      displayName: 'node',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/src/__tests__/**/*.test.ts'],
      transform: { '^.+\\.(ts|js)$': 'babel-jest' },
      moduleNameMapper: {
        '^@forge/api$': '<rootDir>/src/__mocks__/@forge/api.ts',
        '^@forge/resolver$': '<rootDir>/src/__mocks__/@forge/resolver.ts',
        '^@forge/bridge$': '<rootDir>/src/__mocks__/@forge/bridge.ts',
      },
    },
    {
      displayName: 'jsdom',
      testEnvironment: 'jsdom',
      testMatch: ['<rootDir>/src/__tests__/**/*.test.tsx'],
      transform: { '^.+\\.(ts|tsx|js|jsx)$': 'babel-jest' },
      setupFilesAfterEnv: ['<rootDir>/src/__tests__/setup.ts'],
      moduleNameMapper: {
        '^@forge/api$': '<rootDir>/src/__mocks__/@forge/api.ts',
        '^@forge/react$': '<rootDir>/src/__mocks__/@forge/react.tsx',
        '^@forge/bridge$': '<rootDir>/src/__mocks__/@forge/bridge.ts',
        '^@forge/egress$': '<rootDir>/src/__mocks__/@forge/egress.ts',
      },
    },
  ],
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/__tests__/**',
    '!src/__mocks__/**',
  ],
  coverageReporters: ['text', 'lcov'],
};
