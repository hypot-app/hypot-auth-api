import { Module } from '@nestjs/common';
import { AppRegistryModule } from './app-registry/app-registry.module';
import { PlatformModule } from './platform/platform.module';
import { SharedKernelModule } from './shared-kernel/shared-kernel.module';

@Module({
  imports: [SharedKernelModule, PlatformModule, AppRegistryModule],
})
export class AppModule {}
