import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module.js';
import { MediaModule } from '../media/media.module.js';
import { VotesModule } from '../votes/votes.module.js';
import { ResultsController } from './results.controller.js';

@Module({ imports: [DbModule, MediaModule, VotesModule], controllers: [ResultsController] })
export class ResultsModule {}
