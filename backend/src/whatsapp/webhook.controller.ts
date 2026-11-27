import { createHmac, timingSafeEqual } from 'node:crypto';
import { Controller, ForbiddenException, Get, HttpCode, Post, Query, Req, Res, UnauthorizedException } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import type { Response } from 'express';
import { Public } from '../auth/auth.decorators.js';
import { WhatsappService } from './whatsapp.service.js';
import { SkipThrottle } from '@nestjs/throttler';

@Controller('webhooks/whatsapp')
@Public()
@SkipThrottle()
export class WebhookController {
  constructor(private readonly whatsapp: WhatsappService) {}

  @Get()
  verify(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
    @Res() response: Response,
  ) {
    if (mode !== 'subscribe' || token !== process.env.WA_VERIFY_TOKEN) {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Token de verificación inválido.' });
    }
    return response.type('text/plain').send(challenge);
  }

  @Post()
  @HttpCode(200)
  async receive(@Req() request: RawBodyRequest<Request>) {
    const raw = request.rawBody;
    const header = request.headers['x-hub-signature-256'];
    if (!raw || typeof header !== 'string' || !this.isValidSignature(raw, header)) {
      throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'Firma de webhook inválida.' });
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'Payload de webhook inválido.' });
    }
    await this.whatsapp.accept(payload);
    return { received: true };
  }

  private isValidSignature(raw: Buffer, supplied: string) {
    const secret = process.env.WA_APP_SECRET;
    if (!secret || !/^sha256=[a-f\d]{64}$/i.test(supplied)) return false;
    const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`, 'utf8');
    const actual = Buffer.from(supplied, 'utf8');
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }
}
