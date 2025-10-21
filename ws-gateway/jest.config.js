/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  setupFilesAfterEnv: ['./src/tests/setup.ts'],
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],
  testTimeout: 10000,
  forceExit: true,
};
