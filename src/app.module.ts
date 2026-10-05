import { Module } from '@nestjs/common';
import { AppRegistryModule } from './app-registry/app-registry.module';
import { PlatformModule } from './platform/platform.module';
import { SharedKernelModule } from './shared-kernel/shared-kernel.module';
import { TokenLifecycleModule } from './token-lifecycle/token-lifecycle.module';
import { TransactionalEmailModule } from './transactional-email/transactional-email.module';
import { UserAccountsModule } from './user-accounts/user-accounts.module';

@Module({
  imports: [
    SharedKernelModule,
    PlatformModule,
    AppRegistryModule,
    TransactionalEmailModule,
    UserAccountsModule,
    TokenLifecycleModule,
  ],
})
export class AppModule {}
