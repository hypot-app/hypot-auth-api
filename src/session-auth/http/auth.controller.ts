import { BadRequestException, Body, Controller, Headers, HttpCode, Post, Req, UnauthorizedException } from '@nestjs/common';
import { z } from 'zod';
import { ClientIp } from '../../abuse-protection/domain/client-ip';
import { CorsGrant } from '../../platform/http/cors-grant';
import { LoginUseCase } from '../application/login.use-case';

/** `client_id` is looked up in the database, so its length is bounded before it gets there. */
const loginBody = z.object({ client_id: z.string().max(128), email: z.string(), password: z.string() });

/** One body for every login failure (ADR 43). It never says which check failed. */
const INVALID_CREDENTIALS = { error: 'invalid_credentials', message: 'Email or password is incorrect.' };

interface LoginResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
}

@Controller('auth')
export class AuthController {
  constructor(private readonly loginUseCase: LoginUseCase) {}

  @Post('login')
  @HttpCode(200)
  async login(
    @Body() body: unknown,
    @Headers('origin') origin: string | undefined,
    @Req() req: { ip?: string; socket: { remoteAddress?: string } },
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
    return {
      access_token: result.value.accessToken,
      token_type: 'Bearer',
      expires_in: result.value.expiresIn,
      refresh_token: result.value.refreshToken,
    };
  }
}
