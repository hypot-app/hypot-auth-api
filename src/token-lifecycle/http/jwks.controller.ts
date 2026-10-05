import { Controller, Get, Header, Inject } from '@nestjs/common';
import { KEY_STORE, type JsonWebKeySet, type KeyStore } from '../domain/key-store';

/** Served at the root, outside the API prefix (ADR 28, RFC 8615). Matches the design's 5 minute JWKS cache. */
@Controller('.well-known')
export class JwksController {
  constructor(@Inject(KEY_STORE) private readonly keyStore: KeyStore) {}

  @Get('jwks.json')
  @Header('Cache-Control', 'public, max-age=300')
  jwks(): JsonWebKeySet {
    return this.keyStore.publicJwks();
  }
}
