import 'reflect-metadata';
import { CommandFactory } from 'nest-commander';
import { CliModule } from './cli.module';

async function main(): Promise<void> {
  await CommandFactory.run(CliModule, {
    // Nest logs would add noise to the operator output and must never carry secrets.
    logger: ['error', 'warn'],
    serviceErrorHandler: (error: Error) => {
      process.stderr.write(`error: ${error.message}\n`);
      process.exitCode = 1;
    },
  });
}

main().catch((error: Error) => {
  process.stderr.write(`error: ${error.message}\n`);
  process.exit(1);
});
