import { Body, Controller, Get, Param, Put, Req, UnprocessableEntityException, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import type { AuthRequest } from '../auth/auth.types.js';
import { HumanVerifiedGuard } from '../auth/verification.guard.js';
import { RankingService } from './ranking.service.js';
import { VotesService } from './votes.service.js';
import { VoteAttemptGuard } from './vote-attempt.guard.js';
import { SkipThrottle } from '@nestjs/throttler';

const categorySchema = z.enum(['photo', 'sticker']);
const ballotSchema = z.object({
  submission_ids: z.array(z.uuid()).max(10),
}).superRefine((body, context) => {
  if (new Set(body.submission_ids).size !== body.submission_ids.length) {
    context.addIssue({ code: 'custom', path: ['submission_ids'], message: 'La papeleta no puede repetir candidatos.' });
  }
});

@Controller('votes')
export class VotesController {
  constructor(private readonly votes: VotesService, private readonly ranking: RankingService) {}

  @Get('me')
  getMine(@Req() request: AuthRequest) {
    return this.votes.getBallots(request.user!.id);
  }

  @Put(':category')
  @SkipThrottle()
  @UseGuards(VoteAttemptGuard, HumanVerifiedGuard)
  replace(
    @Param('category', { schema: categorySchema }) category: 'photo' | 'sticker',
    @Body({ schema: ballotSchema }) body: z.infer<typeof ballotSchema>,
    @Req() request: AuthRequest,
  ) {
    if (body.submission_ids.length > 10) {
      throw new UnprocessableEntityException({ code: 'VALIDATION_ERROR', message: 'La papeleta no es válida.' });
    }
    return this.votes.replace(request.user!.id, category, body.submission_ids, request.ip, request.get('user-agent'));
  }
}
