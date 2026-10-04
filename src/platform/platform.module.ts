import { Module } from '@nestjs/common';
import { AppConfigModule } from './config/app-config.module';
import { HealthController } from './health.controller';
import { PersistenceModule } from './persistence/persistence.module';
import { WelcomeController } from './welcome.controller';

/** Cross-cutting infrastructure: config, persistence and the root routes. */
@Module({
  imports: [AppConfigModule, PersistenceModule],
  controllers: [WelcomeController, HealthController],
})
export class PlatformModule {}
