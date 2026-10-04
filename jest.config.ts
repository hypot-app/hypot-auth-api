import type { Config } from 'jest';

const config: Config = {
  testEnvironment: 'node',
  rootDir: '.',
  roots: ['<rootDir>/src', '<rootDir>/test'],
  testRegex: '.*\\.(spec|e2e-spec|int-spec)\\.ts$',
  moduleFileExtensions: ['ts', 'js', 'json'],
  // @nestjs/typeorm ships ESM only; compile it to CommonJS for Jest.
  transformIgnorePatterns: ['/node_modules/(?!@nestjs/typeorm/)'],
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
