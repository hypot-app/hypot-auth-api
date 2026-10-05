import { Inject } from '@nestjs/common';
import { SubCommand } from 'nest-commander';
import { APP_CONFIG, type AppConfig } from '../../../platform/config/app-config';
import { UpdateAppUseCase } from '../../application/update-app.use-case';
import { AppOptionsCommand, CliError, type SharedAppOptions } from './app-options.command';
import { CLI_OUTPUT, type CliOutput } from './cli-output';

@SubCommand({
  name: 'update',
  description: 'Update an app by client_id',
  arguments: '<client_id>',
})
export class UpdateAppCommand extends AppOptionsCommand {
  constructor(
    @Inject(UpdateAppUseCase) private readonly updateApp: UpdateAppUseCase,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLI_OUTPUT) private readonly output: CliOutput,
  ) {
    super();
  }

  async run([clientId]: string[], options: SharedAppOptions = {}): Promise<void> {
    const result = await this.updateApp.execute({
      clientId,
      name: options.name,
      redirectUris: options.redirectUri,
      allowedOrigins: options.origin,
      emailFrom: options.emailFrom,
      isProduction: this.config.isProduction,
    });
    if (!result.ok) throw new CliError(result.error.message);

    this.output.out(`updated: ${result.value.clientId}`);
  }
}
