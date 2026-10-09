import type { Config } from 'jest';

const config: Config = {
  testEnvironment: 'node',
  rootDir: '.',
  roots: ['<rootDir>/src', '<rootDir>/test'],
  testRegex: '.*\\.(spec|e2e-spec|int-spec)\\.ts$',
  moduleFileExtensions: ['ts', 'js', 'json'],
  // Integration and e2e suites start Postgres containers in parallel workers. The default 5 s is too tight for the
  // race tests (parallel refreshes, two workers) when the machine is busy, and they then fail at random.
  testTimeout: 15_000,
  // Half the cores: with every core busy, 11 workers each starting a container starved each other (the pool's 5 s
  // connection timeout and the race tests failed at random). The full run is also faster this way.
  maxWorkers: '50%',
  // @nestjs/typeorm and jose ship ESM only; compile them to CommonJS for Jest.
  transformIgnorePatterns: ['/node_modules/(?!(@nestjs/typeorm|jose)/)'],
  transform: {
    '^.+\\.js$': ['@swc/jest', { module: { type: 'commonjs' } }],
    '^.+\\.ts$': [
      '@swc/jest',
      {
        jsc: {
          target: 'es2023',
          parser: { syntax: 'typescript', decorators: true },
          transform: { legacyDecorator: true, decoratorMetadata: true },
        },
        module: { type: 'commonjs' },
      },
    ],
  },
  collectCoverageFrom: ['src/**/*.ts', '!src/main.ts'],
  coverageDirectory: 'coverage',
};

export default config;
