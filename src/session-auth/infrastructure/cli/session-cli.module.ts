import { Module } from '@nestjs/common';
import { SessionRevocationModule } from '../../session-revocation.module';
import { RevokeAllCommand } from './revoke-all.command';

/**
 * Operator commands of session-auth. It imports the revocation module only: no signing key, no HTTP.
 * The host module must provide CLI_OUTPUT.
 */
@Module({
  imports: [SessionRevocationModule],
  providers: [RevokeAllCommand],
})
export class SessionCliModule {}
