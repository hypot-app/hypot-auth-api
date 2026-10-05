import { BadRequestException, Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import type { DomainError } from '../../shared-kernel/domain-error';
import type { Result } from '../../shared-kernel/result';
import { ConfirmEmailUseCase } from '../application/confirm-email.use-case';
import { ResendConfirmationUseCase } from '../application/resend-confirmation.use-case';
import { SignupUseCase } from '../application/signup.use-case';

/** `client_id` is looked up in the database, so its length is bounded before it gets there. */
const clientId = z.string().max(128);
const signupBody = z.object({ client_id: clientId, email: z.string(), password: z.string() });
const resendBody = z.object({ client_id: clientId, email: z.string() });

/** Same body for a new account and for a duplicate: it must not reveal which one happened. */
const SIGNUP_ACCEPTED = { message: 'If this address can be registered, a confirmation email is on its way.' };
const RESEND_ACCEPTED = {
  message: 'If an unconfirmed account exists for this address, a new confirmation email is on its way.',
};

function parseBody<T>(schema: z.ZodType<T>, body: unknown, description: string): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new BadRequestException({ error: 'invalid_request', message: `${description} must be strings` });
  }
  return parsed.data;
}

/** Every use case failure here is the caller's input: a 400 with the stable code and message. */
function unwrap(result: Result<void, DomainError>): void {
  if (!result.ok) throw new BadRequestException({ error: result.error.code, message: result.error.message });
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
  async signup(@Body() body: unknown): Promise<typeof SIGNUP_ACCEPTED> {
    const input = parseBody(signupBody, body, 'client_id, email and password');
    unwrap(await this.signupUseCase.execute({ clientId: input.client_id, email: input.email, password: input.password }));
    return SIGNUP_ACCEPTED;
  }

  @Get('confirm')
  async confirm(@Query('token') token: unknown): Promise<{ message: string }> {
    unwrap(await this.confirmUseCase.execute(token));
    return { message: 'Your email address is confirmed.' };
  }

  @Post('resend-confirmation')
  @HttpCode(202)
  async resend(@Body() body: unknown): Promise<typeof RESEND_ACCEPTED> {
    const input = parseBody(resendBody, body, 'client_id and email');
    unwrap(await this.resendUseCase.execute({ clientId: input.client_id, email: input.email }));
    return RESEND_ACCEPTED;
  }
}
