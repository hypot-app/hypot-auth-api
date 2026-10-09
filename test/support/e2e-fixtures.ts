import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type request from 'supertest';
import { DataSource } from 'typeorm';
import { App } from '../../src/app-registry/domain/app';
import { TypeOrmAppRepository } from '../../src/app-registry/infrastructure/persistence/typeorm-app.repository';
import { User } from '../../src/user-accounts/domain/user';
import { TypeOrmUserRepository } from '../../src/user-accounts/infrastructure/persistence/typeorm-user.repository';

/** Registers an active app straight into the database, with both email link URLs unless told otherwise. */
export async function registerTestApp(
  app: INestApplication,
  name: string,
  origin: string,
  urls: { emailConfirmationUrl: string | null; passwordResetUrl: string | null } = {
    emailConfirmationUrl: `${origin}/confirm`,
    passwordResetUrl: `${origin}/reset`,
  },
): Promise<App> {
  const now = new Date();
  const created = App.restore({
    id: randomUUID(),
    clientId: `app_${randomUUID().replaceAll('-', '')}`,
    name,
    clientType: 'public',
    clientSecretHash: null,
    redirectUris: [],
    allowedOrigins: [origin],
    emailFrom: null,
    ...urls,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  });
  await new TypeOrmAppRepository(app.get(DataSource)).save(created);
  return created;
}

/** Inserts an account with a ready-made password hash, confirmed unless told otherwise. */
export async function addTestUser(
  app: INestApplication,
  input: { appId: string; email: string; passwordHash: string; confirmed?: boolean },
): Promise<User> {
  const registered = User.register({
    id: randomUUID(),
    appId: input.appId,
    email: input.email,
    passwordHash: input.passwordHash,
    now: new Date(),
  });
  const user = input.confirmed === false ? registered : registered.confirm(new Date());
  await new TypeOrmUserRepository(app.get(DataSource)).add(user);
  return user;
}

/** Everything a client can observe except the clock, so two answers can be compared byte for byte. */
export function fingerprint(response: request.Response) {
  const { date: _date, ...headers } = response.headers;
  return { status: response.status, text: response.text, headers };
}
