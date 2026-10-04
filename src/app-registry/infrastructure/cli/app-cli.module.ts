import { Module } from '@nestjs/common';
import { AppRegistryModule } from '../../app-registry.module';
import { AppCommand } from './app.command';
import { CreateAppCommand } from './create-app.command';
import { DeactivateAppCommand } from './deactivate-app.command';
import { UpdateAppCommand } from './update-app.command';

/** Operator commands. The host module must provide APP_CONFIG and CLI_OUTPUT. */
@Module({
  imports: [AppRegistryModule],
  providers: [AppCommand, CreateAppCommand, UpdateAppCommand, DeactivateAppCommand],
})
export class AppCliModule {}
