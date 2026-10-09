import { BadRequestException, Body, Controller, Headers, HttpCode, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import type { ServerResponse } from 'node:http';
import { z } from 'zod';
import { ClientIp } from '../../abuse-protection/domain/client-ip';
import { RateLimitedException } from '../../abuse-protection/http/abuse-exception.filter';
import { CorsGrant } from '../../platform/http/cors-grant';
import { grantUnlessClientRejected, parseBody, unwrap, type RequestSource } from '../../platform/http/request-helpers';
import { ChangePasswordUseCase } from '../application/change-password.use-case';
import { ForgotPasswordUseCase } from '../application/forgot-password.use-case';
import { ResetPasswordUseCase } from '../application/reset-password.use-case';

/** `client_id` is looked up in the database, so its length is bounded before it gets there. */
const forgotBody = z.object({ client_id: z.string().max(128), email: z.string() });
const resetBody = z.object({ token: z.string(), new_password: z.string() });

/** The same body for a confirmed, an unconfirmed, an unknown and an other-app-only address. */
const FORGOT_ACCEPTED = { message: 'If an account exists for this address, an email is on its way.' };
/** Every bearer failure is this one body, whatever the cause (ADR 43). */
const INVALID_TOKEN = { error: 'invalid_token', message: 'Missing or invalid access token' };
const INVALID_CURRENT_PASSWORD = { error: 'invalid_current_password', message: 'The current password is incorrect.' };

/** One body for a malformed, unknown, used, expired, superseded, wrong-purpose or origin-unbound token (ADR 40). */
const INVALID_LINK = { error: 'invalid_or_expired_link', message: 'The reset link is invalid or has expired' };

@Controller('password')
export class PasswordController {
  constructor(
    private readonly forgotUseCase: ForgotPasswordUseCase,
    private readonly resetUseCase: ResetPasswordUseCase,
    private readonly changeUseCase: ChangePasswordUseCase,
  ) {}

  @Post('forgot')
  @HttpCode(202)
  async forgot(
    @Body() body: unknown,
    @Headers('origin') origin: string | undefined,
    @Req() req: RequestSource,
    @CorsGrant() grantCors: () => void,
  ): Promise<typeof FORGOT_ACCEPTED> {
    const input = parseBody(forgotBody, body, 'client_id and email must be strings', grantCors);
    const result = await this.forgotUseCase.execute({
      clientId: input.client_id,
      email: input.email,
      origin,
      ip: ClientIp.from(req.ip, req.socket.remoteAddress),
    });
    grantUnlessClientRejected(result, grantCors);
    unwrap(result);
    return FORGOT_ACCEPTED;
  }

  @Post('reset')
  @HttpCode(204)
  async reset(
    @Body() body: unknown,
    @Headers('origin') origin: string | undefined,
    @Req() req: RequestSource,
    @CorsGrant() grantCors: () => void,
  ): Promise<void> {
    const input = parseBody(resetBody, body, 'token and new_password must be strings', grantCors);
    const result = await this.resetUseCase.execute({
      token: input.token,
      newPassword: input.new_password,
      origin,
      ip: ClientIp.from(req.ip, req.socket.remoteAddress),
    });
    if (!result.ok) {
      const failure = result.error;
      // The exception filter grants CORS to a 429: it carries no app data.
      if (failure.kind === 'rate_limited') throw new RateLimitedException(failure.retryAfterSeconds);
      // A weak password depends only on the caller's own input, like a malformed body.
      if (failure.kind === 'invalid_password') {
        grantCors();
        throw new BadRequestException({ error: failure.error.code, message: failure.error.message });
      }
      // Fail-closed (ADR 38, 40): only a page whose origin is bound to the token's app may read the answer.
      if (failure.clientBound) grantCors();
      throw new BadRequestException(INVALID_LINK);
    }
    grantCors();
  }

  @Post('change')
  @HttpCode(204)
  async change(
    @Body() body: unknown,
    @Headers('authorization') authorization: string | undefined,
    @Headers('origin') origin: string | undefined,
    @Req() req: RequestSource,
    @Res({ passthrough: true }) res: ServerResponse,
    @CorsGrant() grantCors: () => void,
  ): Promise<void> {
    // The body is read loosely: the bearer comes first, so its shape is judged inside the use case, in order.
    const fields = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    const result = await this.changeUseCase.execute({
      authorization,
      origin,
      currentPassword: fields['current_password'],
      newPassword: fields['new_password'],
      ip: ClientIp.from(req.ip, req.socket.remoteAddress),
    });
    if (!result.ok) {
      const failure = result.error;
      if (failure.kind === 'unauthorized') {
        // RFC 6750: a failed bearer call names the scheme. No allow header: the origin was not bound (ADR 38).
        res.setHeader('WWW-Authenticate', 'Bearer');
        throw new UnauthorizedException(INVALID_TOKEN);
      }
      // The bearer bound the origin to the token's app, so the browser may read every answer from here on.
      grantCors();
      if (failure.kind === 'invalid_request') {
        throw new BadRequestException({ error: 'invalid_request', message: 'current_password and new_password must be strings' });
      }
      if (failure.kind === 'invalid_password') {
        throw new BadRequestException({ error: failure.error.code, message: failure.error.message });
      }
      throw new BadRequestException(INVALID_CURRENT_PASSWORD);
    }
    grantCors();
  }
}
