import { randomBytes, randomUUID } from 'node:crypto';
import type { IdGenerator } from '../application/id-generator';

export class CryptoIdGenerator implements IdGenerator {
  appId(): string {
    return randomUUID();
  }

  clientId(): string {
    return randomBytes(16).toString('base64url');
  }
}
