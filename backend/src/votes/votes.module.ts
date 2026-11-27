import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../db/db.module.js';
import { EventModule } from '../event/event.module.js';
import { MediaModule } from '../media/media.module.js';
import { RankingService } from './ranking.service.js';
import { VotesController } from './votes.controller.js';
import { VotesService } from './votes.service.js';
import { VoteAttemptGuard } from './vote-attempt.guard.js';

@Module({
  imports: [AuthModule, DbModule, EventModule, MediaModule],
  controllers: [VotesController],
  providers: [RankingService, VotesService, VoteAttemptGuard],
  exports: [RankingService, VotesService, VoteAttemptGuard],
})
export class VotesModule {}
