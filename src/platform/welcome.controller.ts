import { Controller, Get } from '@nestjs/common';

@Controller()
export class WelcomeController {
  @Get()
  welcome(): { message: string } {
    return { message: 'Welcome to the API' };
  }
}
