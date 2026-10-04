import { Inject } from '@nestjs/common';
import { CommandRunner, SubCommand } from 'nest-commander';
import { DeactivateAppUseCase } from '../../application/deactivate-app.use-case';
import { CliError } from './app-options.command';
import { CLI_OUTPUT, type CliOutput } from './cli-output';

@SubCommand({ name: 'deactivate', description: 'Deactivate an app by client_id', arguments: '<client_id>' })
export class DeactivateAppCommand extends CommandRunner {
  constructor(
    @Inject(DeactivateAppUseCase) private readonly deactivateApp: DeactivateAppUseCase,
    @Inject(CLI_OUTPUT) private readonly output: CliOutput,
  ) {
    super();
  }

  async run([clientId]: string[]): Promise<void> {
    const result = await this.deactivateApp.execute({ clientId });
    if (!result.ok) throw new CliError(result.error.message);

    this.output.out(`deactivated: ${result.value.clientId}`);
  }
}
