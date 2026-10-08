import { Global, Module } from '@nestjs/common';
import { AppCliModule } from './app-registry/infrastructure/cli/app-cli.module';
import { CLI_OUTPUT, processCliOutput } from './app-registry/infrastructure/cli/cli-output';
import { AppConfigModule } from './platform/config/app-config.module';
import { PersistenceModule } from './platform/persistence/persistence.module';
import { SessionCliModule } from './session-auth/infrastructure/cli/session-cli.module';
import { SharedKernelModule } from './shared-kernel/shared-kernel.module';

@Global()
@Module({
  providers: [{ provide: CLI_OUTPUT, useValue: processCliOutput }],
  exports: [CLI_OUTPUT],
})
class CliOutputModule {}

/** Composition root of the operator CLI: no HTTP server, no controllers. */
@Module({
  imports: [SharedKernelModule, AppConfigModule, PersistenceModule, CliOutputModule, AppCliModule, SessionCliModule],
})
export class CliModule {}
