import { Global, Module } from '@nestjs/common';
import { CLOCK, SystemClock } from './clock';
import { CryptoTokenGenerator, TOKEN_GENERATOR } from './token-generator';

/** Wires the shared-kernel ports to their production adapters. */
@Global()
@Module({
  providers: [
    { provide: CLOCK, useClass: SystemClock },
    { provide: TOKEN_GENERATOR, useClass: CryptoTokenGenerator },
  ],
  exports: [CLOCK, TOKEN_GENERATOR],
})
export class SharedKernelModule {}
