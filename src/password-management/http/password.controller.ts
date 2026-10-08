import { Body, Controller, Headers, HttpCode, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { ClientIp } from '../../abuse-protection/domain/client-ip';
import { CorsGrant } from '../../platform/http/cors-grant';
import { grantUnlessClientRejected, parseBody, unwrap, type RequestSource } from '../../user-accounts/http/request-helpers';
import { ForgotPasswordUseCase } from '../application/forgot-password.use-case';

/** `client_id` is looked up in the database, so its length is bounded before it gets there. */
const forgotBody = z.object({ client_id: z.string().max(128), email: z.string() });

/** The same body for a confirmed, an unconfirmed, an unknown and an other-app-only address. */
const FORGOT_ACCEPTED = { message: 'If an account exists for this address, an email is on its way.' };

@Controller('password')
export class PasswordController {
  constructor(private readonly forgotUseCase: ForgotPasswordUseCase) {}

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
}
