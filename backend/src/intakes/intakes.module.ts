import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../db/db.module.js';
import { EventModule } from '../event/event.module.js';
import { MediaModule } from '../media/media.module.js';
import { CryptoService } from '../whatsapp/crypto.service.js';
import { IntakesController } from './intakes.controller.js';
import { IntakesService } from './intakes.service.js';
import { VotesModule } from '../votes/votes.module.js';

@Module({
  imports: [AuthModule, DbModule, EventModule, MediaModule, VotesModule],
  controllers: [IntakesController],
  providers: [CryptoService, IntakesService],
  exports: [IntakesService],
})
export class IntakesModule {}
