import { BadRequestException, Body, Controller, Headers, HttpCode, Post, Req, UnauthorizedException } from '@nestjs/common';
import { z } from 'zod';
import { ClientIp } from '../../abuse-protection/domain/client-ip';
import { RateLimitedException } from '../../abuse-protection/http/abuse-exception.filter';
import { CorsGrant } from '../../platform/http/cors-grant';
import { LoginUseCase, type LoginTokens } from '../application/login.use-case';
import { RefreshSessionUseCase } from '../application/refresh-session.use-case';

/** `client_id` is looked up in the database, so its length is bounded before it gets there. */
const loginBody = z.object({ client_id: z.string().max(128), email: z.string(), password: z.string() });

const refreshBody = z.object({ client_id: z.string().max(128), refresh_token: z.string() });

/** One body for every login failure (ADR 43). It never says which check failed. */
const INVALID_CREDENTIALS = { error: 'invalid_credentials', message: 'Email or password is incorrect.' };

/** One body for every refresh token problem (unknown, malformed, expired, reused, another app, unbound origin). */
const INVALID_GRANT = { error: 'invalid_grant', message: 'The refresh token is invalid or has expired.' };

interface LoginResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
}

type RequestSource = { ip?: string; socket: { remoteAddress?: string } };

function tokenResponse(tokens: LoginTokens): LoginResponse {
  return {
    access_token: tokens.accessToken,
    token_type: 'Bearer',
    expires_in: tokens.expiresIn,
    refresh_token: tokens.refreshToken,
  };
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly loginUseCase: LoginUseCase,
    private readonly refreshUseCase: RefreshSessionUseCase,
  ) {}

  @Post('login')
  @HttpCode(200)
  async login(
    @Body() body: unknown,
    @Headers('origin') origin: string | undefined,
    @Req() req: RequestSource,
    @CorsGrant() grantCors: () => void,
  ): Promise<LoginResponse> {
    const parsed = loginBody.safeParse(body);
    if (!parsed.success) {
      // A malformed body carries no app data, so the browser may read the 400 from an active app's origin.
      grantCors();
      throw new BadRequestException({ error: 'invalid_request', message: 'client_id, email and password must be strings' });
    }
    const result = await this.loginUseCase.execute({
      clientId: parsed.data.client_id,
      origin,
      email: parsed.data.email,
      password: parsed.data.password,
      ip: ClientIp.from(req.ip, req.socket.remoteAddress),
    });
    if (!result.ok) {
      // Fail-closed (ADR 38): the generic 401 is readable only once the origin is bound to the client.
      if (result.error.clientBound) grantCors();
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }
    grantCors();
    return tokenResponse(result.value);
  }

  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Body() body: unknown,
    @Headers('origin') origin: string | undefined,
    @Req() req: RequestSource,
    @CorsGrant() grantCors: () => void,
  ): Promise<LoginResponse> {
    const parsed = refreshBody.safeParse(body);
    if (!parsed.success) {
      grantCors();
      throw new BadRequestException({ error: 'invalid_request', message: 'client_id and refresh_token must be strings' });
    }
    const result = await this.refreshUseCase.execute({
      clientId: parsed.data.client_id,
      origin,
      refreshToken: parsed.data.refresh_token,
      ip: ClientIp.from(req.ip, req.socket.remoteAddress),
    });
    if (!result.ok) {
      const failure = result.error;
      // The exception filter grants CORS to a 429: it carries no app data.
      if (failure.kind === 'rate_limited') throw new RateLimitedException(failure.retryAfterSeconds);
      // Fail-closed (ADR 38): neither an unknown client nor an unbound origin may read the answer.
      if (failure.kind === 'invalid_client') {
        throw new BadRequestException({ error: 'invalid_client', message: 'Unknown or inactive client' });
      }
      if (failure.clientBound) grantCors();
      throw new UnauthorizedException(INVALID_GRANT);
    }
    grantCors();
    return tokenResponse(result.value);
  }
}
