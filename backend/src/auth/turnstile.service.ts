import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { ProfilesService } from './profiles.service.js';

@Injectable()
export class TurnstileService {
  constructor(private readonly profiles: ProfilesService) {}

  async verify(userId: string, token: string) {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: process.env.TURNSTILE_SECRET ?? '', response: token }),
      signal: AbortSignal.timeout(5_000),
    }).catch(() => null);
    const result = response?.ok ? await response.json() as { success?: boolean } : null;
    if (!result?.success) {
      throw new UnprocessableEntityException({
        code: 'VALIDATION_ERROR', message: 'La verificación humana no fue aceptada.', details: { reason: 'turnstile_failed' },
      });
    }
    const profile = await this.profiles.verifyHuman(userId);
    return { human_verified: Boolean(profile.humanVerifiedAt) };
  }
}
