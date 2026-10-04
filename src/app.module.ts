import { Module } from '@nestjs/common';
import { WelcomeController } from './platform/welcome.controller';

@Module({
  controllers: [WelcomeController],
})
export class AppModule {}
