import { Controller, Get, Post, Body, Req, HttpCode, Patch } from '@nestjs/common';
import { z } from 'zod';
import type { AuthRequest } from './auth.types.js';
import { AllowBlocked } from './auth.decorators.js';
import { TurnstileService } from './turnstile.service.js';
import { ProfilesService } from './profiles.service.js';
import { Throttle } from '@nestjs/throttler';

const verificationSchema = z.object({ turnstile_token: z.string().min(1).max(4096) });

@Controller('me')
export class MeController {
  constructor(private readonly turnstile: TurnstileService, private readonly profiles: ProfilesService) {}

  @Get()
  @AllowBlocked()
  async me(@Req() request: AuthRequest) {
    const user = request.user!;
    const usage = await this.profiles.getUsage(user.id);
    return { id: user.id, email: user.email, display_name: user.displayName,
      avatar_url: user.avatarUrl,
      role: user.role, human_verified: Boolean(user.humanVerifiedAt),
      usage };
  }

  @Patch()
  async updateProfile(
    @Body({ schema: z.object({ display_name: z.string().trim().min(2).max(60) }) }) body: { display_name: string },
    @Req() request: AuthRequest,
  ) {
    const profile = await this.profiles.updateDisplayName(request.user!.id, body.display_name);
    return { id: profile.id, display_name: profile.displayName };
  }

  @Post('verify-human')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(204)
  async verifyHuman(@Body({ schema: verificationSchema }) body: z.infer<typeof verificationSchema>, @Req() request: AuthRequest) {
    await this.turnstile.verify(request.user!.id, body.turnstile_token);
  }
}
