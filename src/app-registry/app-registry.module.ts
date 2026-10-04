import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CLOCK, type Clock } from '../shared-kernel/clock';
import { TOKEN_GENERATOR, type TokenGenerator } from '../shared-kernel/token-generator';
import { UNIT_OF_WORK, type UnitOfWork } from '../shared-kernel/unit-of-work';
import { ID_GENERATOR, type IdGenerator } from './application/id-generator';
import { RegisterAppUseCase } from './application/register-app.use-case';
import { ResolveClientUseCase } from './application/resolve-client.use-case';
import { APP_REPOSITORY, type AppRepository } from './domain/app.repository';
import { CryptoIdGenerator } from './infrastructure/crypto-id-generator';
import { AppSchema } from './infrastructure/persistence/app.schema';
import { TypeOrmAppRepository } from './infrastructure/persistence/typeorm-app.repository';

/** Use cases are plain classes (no Nest decorators); they are wired with factories here (ADR 2). */
@Module({
  imports: [TypeOrmModule.forFeature([AppSchema])],
  providers: [
    TypeOrmAppRepository,
    { provide: APP_REPOSITORY, useExisting: TypeOrmAppRepository },
    { provide: ID_GENERATOR, useClass: CryptoIdGenerator },
    {
      provide: RegisterAppUseCase,
      inject: [APP_REPOSITORY, TOKEN_GENERATOR, CLOCK, ID_GENERATOR, UNIT_OF_WORK],
      useFactory: (apps: AppRepository, tokens: TokenGenerator, clock: Clock, ids: IdGenerator, uow: UnitOfWork) =>
        new RegisterAppUseCase({ apps, tokens, clock, ids, uow }),
    },
    {
      provide: ResolveClientUseCase,
      inject: [APP_REPOSITORY],
      useFactory: (apps: AppRepository) => new ResolveClientUseCase(apps),
    },
  ],
  exports: [APP_REPOSITORY, RegisterAppUseCase, ResolveClientUseCase],
})
export class AppRegistryModule {}
