import { Inject } from '@nestjs/common';
import { Option, SubCommand } from 'nest-commander';
import { APP_CONFIG, type AppConfig } from '../../../platform/config/app-config';
import { UpdateAppUseCase } from '../../application/update-app.use-case';
import { AppOptionsCommand, CliError, type SharedAppOptions } from './app-options.command';
import { CLI_OUTPUT, type CliOutput } from './cli-output';

interface UpdateOptions extends SharedAppOptions {
  clearPostResetRedirectUri?: boolean;
}

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

  @Option({ flags: '--clear-post-reset-redirect-uri', description: 'Remove the post-reset redirect URI' })
  parseClear(): boolean {
    return true;
  }

  async run([clientId]: string[], options: UpdateOptions = {}): Promise<void> {
    if (options.clearPostResetRedirectUri && options.postResetRedirectUri !== undefined) {
      throw new CliError('Use either --post-reset-redirect-uri or --clear-post-reset-redirect-uri, not both');
    }

    const result = await this.updateApp.execute({
      clientId,
      name: options.name,
      redirectUris: options.redirectUri,
      allowedOrigins: options.origin,
      emailFrom: options.emailFrom,
      postResetRedirectUri: options.clearPostResetRedirectUri ? null : options.postResetRedirectUri,
      isProduction: this.config.isProduction,
    });
    if (!result.ok) throw new CliError(result.error.message);

    this.output.out(`updated: ${result.value.clientId}`);
  }
}
