import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { UNIT_OF_WORK } from '../../shared-kernel/unit-of-work';
import { buildTypeOrmOptions } from './typeorm.options';
import { TypeOrmUnitOfWork } from './typeorm-unit-of-work';

@Global()
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        ...buildTypeOrmOptions({ url: config.databaseUrl }),
        // Each feature module registers its schemas through forFeature.
        autoLoadEntities: true,
      }),
    }),
  ],
  providers: [TypeOrmUnitOfWork, { provide: UNIT_OF_WORK, useExisting: TypeOrmUnitOfWork }],
  exports: [UNIT_OF_WORK],
})
export class PersistenceModule {}
