import { randomBytes, randomUUID } from 'node:crypto';
import type { IdGenerator } from '../application/id-generator';

export class CryptoIdGenerator implements IdGenerator {
  appId(): string {
    return randomUUID();
  }

  /** Format: `app_` + 32 lowercase hex chars (128 random bits). Never starts with "-", so CLIs never parse it as an option. */
  clientId(): string {
    return `app_${randomBytes(16).toString('hex')}`;
  }
}
