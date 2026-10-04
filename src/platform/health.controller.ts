import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';

export interface HealthStatus {
  status: 'ok';
  db: 'up';
}

@Controller('health')
export class HealthController {
  constructor(private readonly dataSource: DataSource) {}

  @Get()
  async check(): Promise<HealthStatus> {
    try {
      await this.dataSource.query('SELECT 1');
    } catch {
      // Details stay in the server; the body never reveals driver errors.
      throw new ServiceUnavailableException({ status: 'error', db: 'down' });
    }
    return { status: 'ok', db: 'up' };
  }
}
