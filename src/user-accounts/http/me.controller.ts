import { Controller, Get, Headers, Res, UnauthorizedException } from '@nestjs/common';
import type { ServerResponse } from 'node:http';
import { CorsGrant } from '../../platform/http/cors-grant';
import { GetProfileUseCase } from '../application/get-profile.use-case';
import { toProfileResponse, type ProfileResponse } from './profile-response';

/** Every bearer failure is this one body, whatever the cause (ADR 43). */
const INVALID_TOKEN = { error: 'invalid_token', message: 'Missing or invalid access token' };

@Controller('me')
export class MeController {
  constructor(private readonly getProfile: GetProfileUseCase) {}

  @Get()
  async me(
    @Headers('authorization') authorization: string | undefined,
    @Headers('origin') origin: string | undefined,
    @Res({ passthrough: true }) res: ServerResponse,
    @CorsGrant() grantCors: () => void,
  ): Promise<ProfileResponse> {
    const result = await this.getProfile.execute({ authorization, origin });
    if (!result.ok) {
      // RFC 6750: a failed bearer call names the scheme. No allow header: the origin was not bound (ADR 38).
      res.setHeader('WWW-Authenticate', 'Bearer');
      throw new UnauthorizedException(INVALID_TOKEN);
    }
    // The origin is bound to the token's app (or absent), so the browser may read the profile.
    grantCors();
    return toProfileResponse(result.value);
  }
}
