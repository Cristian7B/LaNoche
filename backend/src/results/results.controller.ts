import { Controller, ForbiddenException, Get, Req } from '@nestjs/common';
import type { AuthRequest } from '../auth/auth.types.js';
import { OptionalAuth } from '../auth/auth.decorators.js';
import { DB, type Database } from '../db/db.module.js';
import { Inject } from '@nestjs/common';
import { eventSettings } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { RankingService } from '../votes/ranking.service.js';

@Controller('results')
export class ResultsController {
  constructor(@Inject(DB) private readonly db: Database, private readonly ranking: RankingService) {}

  @Get()
  @OptionalAuth()
  async getResults(@Req() request: AuthRequest) {
    const [event] = await this.db.select().from(eventSettings).where(eq(eventSettings.id, 1));
    if (event.status !== 'results_published') {
      throw new ForbiddenException({ code: 'RESULTS_NOT_PUBLISHED', message: 'Los resultados aún no están publicados.' });
    }
    const [photo, sticker] = await Promise.all([
      this.ranking.ranking('photo', request.user?.id, event.showAuthorInPublicResults),
      this.ranking.ranking('sticker', request.user?.id, event.showAuthorInPublicResults),
    ]);
    return {
      photo: photo.slice(0, event.maxVotesPerCategory),
      sticker: sticker.slice(0, event.maxVotesPerCategory),
    };
  }
}
