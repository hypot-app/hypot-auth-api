import { Inject } from '@nestjs/common';
import { Command, CommandRunner, Option } from 'nest-commander';
import { CliError } from '../../../app-registry/infrastructure/cli/app-options.command';
import { CLI_OUTPUT, type CliOutput } from '../../../app-registry/infrastructure/cli/cli-output';
import { RevokeAllSessionsUseCase } from '../../application/revoke-all-sessions.use-case';

interface RevokeAllOptions {
  yes?: boolean;
}

/**
 * Key-compromise procedure: ends every open session of every app. Access tokens already issued stay valid
 * until `exp`; rotate the signing key as well when a key leaked.
 */
@Command({
  name: 'ops:revoke-all',
  description: 'Revoke every open session of every app (key-compromise procedure). Requires --yes',
})
export class RevokeAllCommand extends CommandRunner {
  constructor(
    @Inject(RevokeAllSessionsUseCase) private readonly revokeAll: RevokeAllSessionsUseCase,
    @Inject(CLI_OUTPUT) private readonly output: CliOutput,
  ) {
    super();
  }

  @Option({ flags: '--yes', description: 'Confirm that every user of every app will have to log in again' })
  parseYes(): boolean {
    return true;
  }

  async run(_args: string[], options: RevokeAllOptions = {}): Promise<void> {
    // Checked by hand, not with a commander `required` option: commander calls process.exit on its own errors.
    if (options.yes !== true) {
      throw new CliError('refusing to revoke every session without --yes (every user of every app would have to log in again)');
    }
    const revoked = await this.revokeAll.execute();
    this.output.out(`revoked sessions: ${revoked}`);
  }
}
