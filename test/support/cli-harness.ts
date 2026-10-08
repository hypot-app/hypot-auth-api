import { Global, Module } from '@nestjs/common';
import { CommandFactory } from 'nest-commander';
import { CommandRunnerService } from 'nest-commander/src/command-runner.service';
import { AppCliModule } from '../../src/app-registry/infrastructure/cli/app-cli.module';
import { CLI_OUTPUT, type CliOutput } from '../../src/app-registry/infrastructure/cli/cli-output';
import { APP_CONFIG, type AppConfig } from '../../src/platform/config/app-config';
import { PersistenceModule } from '../../src/platform/persistence/persistence.module';
import { SessionCliModule } from '../../src/session-auth/infrastructure/cli/session-cli.module';
import { SharedKernelModule } from '../../src/shared-kernel/shared-kernel.module';
import { buildTestConfig } from './create-test-app';

export interface CliRun {
  /** Lines written to stdout by the command. */
  out: string[];
  /** Lines written to stderr by the command. */
  err: string[];
  /** Errors thrown by the command (what the real CLI turns into exit code 1). */
  errors: Error[];
}

/**
 * Runs the real nest-commander composition against a test database.
 * A fresh Nest context per run keeps commander option state from leaking between runs.
 */
export async function runCli(
  args: string[],
  options: { databaseUrl: string; config?: Partial<AppConfig> },
): Promise<CliRun> {
  const run: CliRun = { out: [], err: [], errors: [] };
  const output: CliOutput = { out: (line) => run.out.push(line), error: (line) => run.err.push(line) };

  @Global()
  @Module({
    providers: [
      { provide: APP_CONFIG, useValue: buildTestConfig(options) },
      { provide: CLI_OUTPUT, useValue: output },
    ],
    exports: [APP_CONFIG, CLI_OUTPUT],
  })
  class TestSupportModule {}

  @Module({ imports: [SharedKernelModule, TestSupportModule, PersistenceModule, AppCliModule, SessionCliModule] })
  class TestCliModule {}

  const context = await CommandFactory.createWithoutRunning(TestCliModule, {
    logger: false,
    serviceErrorHandler: (error: Error) => {
      run.errors.push(error);
    },
  });
  try {
    await context.get(CommandRunnerService).run(['node', 'cli', ...args]);
  } finally {
    await context.close();
  }
  return run;
}
