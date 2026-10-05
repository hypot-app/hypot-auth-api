import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import type { Clock } from '../../shared-kernel/clock';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  ACCESS_TOKEN_TYP,
  type AccessTokenIssuer,
  type IssueAccessTokenInput,
  type IssuedAccessToken,
} from '../domain/access-token';
import type { KeyStore } from '../domain/key-store';

export class JoseAccessTokenIssuer implements AccessTokenIssuer {
  private readonly keyStore: KeyStore;
  private readonly clock: Clock;
  private readonly issuer: string;

  constructor(deps: { keyStore: KeyStore; clock: Clock; issuer: string }) {
    this.keyStore = deps.keyStore;
    this.clock = deps.clock;
    this.issuer = deps.issuer;
  }

  async issue({ accountId, clientId }: IssueAccessTokenInput): Promise<IssuedAccessToken> {
    const key = this.keyStore.activeSigningKey();
    const issuedAt = Math.floor(this.clock.now().getTime() / 1000);
    const expiresAt = issuedAt + ACCESS_TOKEN_TTL_SECONDS;

    const token = await new SignJWT({})
      .setProtectedHeader({ alg: key.alg, kid: key.kid, typ: ACCESS_TOKEN_TYP })
      .setIssuer(this.issuer)
      .setAudience(clientId)
      .setSubject(accountId)
      .setIssuedAt(issuedAt)
      .setExpirationTime(expiresAt)
      .setJti(randomUUID())
      .sign(key.privateKey);

    return { token, expiresAt: new Date(expiresAt * 1000) };
  }
}
