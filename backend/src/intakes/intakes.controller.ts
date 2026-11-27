import { Body, ConflictException, Controller, Get, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import type { Response } from 'express';
import type { AuthRequest } from '../auth/auth.types.js';
import { IntakesService } from './intakes.service.js';
import { Throttle } from '@nestjs/throttler';

const tokenSchema = z.string().min(1).max(128);
const claimSchema = z.object({
  title: z.string().trim().min(3).max(120),
  description: z.string().trim().min(10).max(1000),
});

@Controller('intakes')
export class IntakesController {
  constructor(private readonly intakes: IntakesService) {}

  @Get(':token')
  async preview(@Param('token', { schema: tokenSchema }) token: string, @Res({ passthrough: true }) response: Response) {
    const result = await this.intakes.preview(token);
    if ('notReady' in result) {
      response.setHeader('Retry-After', '2');
      throw new ConflictException({ code: 'INTAKE_NOT_READY', message: 'El sticker aún se está procesando.' });
    }
    return result;
  }

  @Post(':token/claim')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  claim(
    @Param('token', { schema: tokenSchema }) token: string,
    @Body({ schema: claimSchema }) body: z.infer<typeof claimSchema>,
    @Req() request: AuthRequest,
  ) {
    return this.intakes.claim(request.user!.id, token, body);
  }
}
