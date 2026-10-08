import { Module } from '@nestjs/common';
import { AbuseProtectionModule } from './abuse-protection/abuse-protection.module';
import { AppRegistryModule } from './app-registry/app-registry.module';
import { PasswordManagementModule } from './password-management/password-management.module';
import { PlatformModule } from './platform/platform.module';
import { SessionAuthModule } from './session-auth/session-auth.module';
import { SharedKernelModule } from './shared-kernel/shared-kernel.module';
import { TokenLifecycleModule } from './token-lifecycle/token-lifecycle.module';
import { TransactionalEmailModule } from './transactional-email/transactional-email.module';
import { UserAccountsModule } from './user-accounts/user-accounts.module';

@Module({
  imports: [
    SharedKernelModule,
    PlatformModule,
    AppRegistryModule,
    AbuseProtectionModule,
    TransactionalEmailModule,
    UserAccountsModule,
    TokenLifecycleModule,
    SessionAuthModule,
    PasswordManagementModule,
  ],
})
export class AppModule {}
