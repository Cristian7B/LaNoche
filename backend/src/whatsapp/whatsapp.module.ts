import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module.js';
import { EventModule } from '../event/event.module.js';
import { MediaModule } from '../media/media.module.js';
import { CryptoService } from './crypto.service.js';
import { GraphClient } from './graph-client.js';
import { WebhookController } from './webhook.controller.js';
import { WhatsappService } from './whatsapp.service.js';

@Module({
  imports: [DbModule, EventModule, MediaModule],
  controllers: [WebhookController],
  providers: [CryptoService, GraphClient, WhatsappService],
  exports: [WhatsappService],
})
export class WhatsappModule {}
