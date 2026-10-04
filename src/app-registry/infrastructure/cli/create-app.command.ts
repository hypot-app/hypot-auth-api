import { Inject } from '@nestjs/common';
import { Option, SubCommand } from 'nest-commander';
import { APP_CONFIG, type AppConfig } from '../../../platform/config/app-config';
import { RegisterAppUseCase } from '../../application/register-app.use-case';
import type { ClientType } from '../../domain/app';
import { AppOptionsCommand, CliError, type SharedAppOptions } from './app-options.command';
import { CLI_OUTPUT, type CliOutput } from './cli-output';

interface CreateOptions extends SharedAppOptions {
  type?: string;
}

@SubCommand({ name: 'create', description: 'Register a new app and print its client_id' })
export class CreateAppCommand extends AppOptionsCommand {
  constructor(
    @Inject(RegisterAppUseCase) private readonly registerApp: RegisterAppUseCase,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLI_OUTPUT) private readonly output: CliOutput,
  ) {
    super();
  }

  @Option({ flags: '--type <type>', description: 'Client type: public (default) or confidential' })
  parseType(value: string): string {
    return value;
  }

  async run(_args: string[], options: CreateOptions = {}): Promise<void> {
    // Validated by hand, not with commander `required`/`choices`: commander calls process.exit on sub-commands.
    if (!options.name) throw new CliError('--name is required');
    const clientType = options.type ?? 'public';
    if (clientType !== 'public' && clientType !== 'confidential') {
      throw new CliError(`--type must be "public" or "confidential", got "${clientType}"`);
    }

    const result = await this.registerApp.execute({
      name: options.name,
      clientType: clientType as ClientType,
      redirectUris: options.redirectUri ?? [],
      allowedOrigins: options.origin ?? [],
      emailFrom: options.emailFrom,
      postResetRedirectUri: options.postResetRedirectUri,
      isProduction: this.config.isProduction,
    });
    if (!result.ok) throw new CliError(result.error.message);

    this.output.out(`client_id: ${result.value.app.clientId}`);
    if (result.value.clientSecret !== null) {
      // The only time the secret exists in plain text. It is never logged or stored.
      this.output.out(`client_secret: ${result.value.clientSecret}`);
      this.output.error('Store the client secret now: it is shown only once and cannot be recovered.');
    }
  }
}
