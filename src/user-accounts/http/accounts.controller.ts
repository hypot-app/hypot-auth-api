import { BadRequestException, Body, Controller, Headers, HttpCode, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import type { DomainError } from '../../shared-kernel/domain-error';
import type { Result } from '../../shared-kernel/result';
import { ClientIp } from '../../abuse-protection/domain/client-ip';
import { RateLimitedException } from '../../abuse-protection/http/abuse-exception.filter';
import { CorsGrant } from '../../platform/http/cors-grant';
import { ConfirmEmailUseCase } from '../application/confirm-email.use-case';
import { ResendConfirmationUseCase } from '../application/resend-confirmation.use-case';
import { SignupUseCase } from '../application/signup.use-case';

/** `client_id` is looked up in the database, so its length is bounded before it gets there. */
const clientId = z.string().max(128);
const signupBody = z.object({ client_id: clientId, email: z.string(), password: z.string() });
const resendBody = z.object({ client_id: clientId, email: z.string() });
const confirmBody = z.object({ token: z.string() });

/** Same body for a new account and for a duplicate: it must not reveal which one happened. */
const SIGNUP_ACCEPTED = { message: 'If this address can be registered, a confirmation email is on its way.' };
const CONFIRMED = { message: 'Your email address has been confirmed.' };
/** One body for a malformed, unknown, used, expired, wrong-purpose or origin-unbound token (ADR 40). */
const INVALID_LINK = { error: 'invalid_or_expired_link', message: 'The confirmation link is invalid or has expired' };
const RESEND_ACCEPTED = {
  message: 'If an unconfirmed account exists for this address, a new confirmation email is on its way.',
};

type RequestSource = { ip?: string; socket: { remoteAddress?: string } };

/** A malformed body carries no app data, so the browser may read the 400 from an active app's origin. */
function parseBody<T>(schema: z.ZodType<T>, body: unknown, message: string, grantCors: () => void): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    grantCors();
    throw new BadRequestException({ error: 'invalid_request', message });
  }
  return parsed.data;
}

/** Every use case failure here is the caller's input: a 400 with the stable code and message. */
function unwrap(result: Result<void, DomainError>): void {
  if (!result.ok) throw new BadRequestException({ error: result.error.code, message: result.error.message });
}

/**
 * The origin binding passed unless the client was rejected (unknown, inactive or origin not bound to
 * the app). Later failures (invalid email, weak password) depend only on the caller's own input.
 */
function grantUnlessClientRejected(result: Result<void, DomainError>, grantCors: () => void): void {
  if (result.ok || result.error.code !== 'invalid_client') grantCors();
}

@Controller('accounts')
export class AccountsController {
  constructor(
    private readonly signupUseCase: SignupUseCase,
    private readonly confirmUseCase: ConfirmEmailUseCase,
    private readonly resendUseCase: ResendConfirmationUseCase,
  ) {}

  @Post('signup')
  @HttpCode(202)
  async signup(
    @Body() body: unknown,
    @Headers('origin') origin: string | undefined,
    @CorsGrant() grantCors: () => void,
  ): Promise<typeof SIGNUP_ACCEPTED> {
    const input = parseBody(signupBody, body, 'client_id, email and password must be strings', grantCors);
    const result = await this.signupUseCase.execute({
      clientId: input.client_id,
      email: input.email,
      password: input.password,
      origin,
    });
    grantUnlessClientRejected(result, grantCors);
    unwrap(result);
    return SIGNUP_ACCEPTED;
  }

  @Post('confirm')
  @HttpCode(200)
  async confirm(
    @Body() body: unknown,
    @Headers('origin') origin: string | undefined,
    @Req() req: RequestSource,
    @CorsGrant() grantCors: () => void,
  ): Promise<typeof CONFIRMED> {
    const input = parseBody(confirmBody, body, 'token must be a string', grantCors);
    const result = await this.confirmUseCase.execute({
      token: input.token,
      origin,
      ip: ClientIp.from(req.ip, req.socket.remoteAddress),
    });
    if (!result.ok) {
      const failure = result.error;
      // The exception filter grants CORS to a 429: it carries no app data.
      if (failure.kind === 'rate_limited') throw new RateLimitedException(failure.retryAfterSeconds);
      // Fail-closed (ADR 38): only a page whose origin is bound to the token's app may read the answer.
      if (failure.clientBound) grantCors();
      throw new BadRequestException(INVALID_LINK);
    }
    grantCors();
    return CONFIRMED;
  }

  @Post('resend-confirmation')
  @HttpCode(202)
  async resend(
    @Body() body: unknown,
    @Headers('origin') origin: string | undefined,
    @CorsGrant() grantCors: () => void,
  ): Promise<typeof RESEND_ACCEPTED> {
    const input = parseBody(resendBody, body, 'client_id and email must be strings', grantCors);
    const result = await this.resendUseCase.execute({ clientId: input.client_id, email: input.email, origin });
    grantUnlessClientRejected(result, grantCors);
    unwrap(result);
    return RESEND_ACCEPTED;
  }
}
