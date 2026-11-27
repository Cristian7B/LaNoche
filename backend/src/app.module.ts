import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { HealthModule } from './health/health.module.js';
import { LoggerModule } from 'nestjs-pino';
import { DbModule } from './db/db.module.js';
import { AuthModule } from './auth/auth.module.js';
import { EventModule } from './event/event.module.js';
import { SubmissionsModule } from './submissions/submissions.module.js';
import { VotesModule } from './votes/votes.module.js';
import { WhatsappModule } from './whatsapp/whatsapp.module.js';
import { IntakesModule } from './intakes/intakes.module.js';
import { ScheduleModule } from '@nestjs/schedule';
import { AdminModule } from './admin/admin.module.js';
import { ResultsModule } from './results/results.module.js';
import { RateLimitModule } from './common/rate-limit.module.js';

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        redact: {
          paths: [
            'req.headers.authorization', 'req.headers.cookie', 'req.headers.x-hub-signature-256', 'req.body.token', 'req.body.wa_id',
            'req.url', 'req.query', 'req.params',
          ],
          censor: '[REDACTED]',
        },
      },
    }),
    ScheduleModule.forRoot(),
    DbModule,
    AuthModule,
    RateLimitModule,
    EventModule,
    SubmissionsModule,
    VotesModule,
    WhatsappModule,
    IntakesModule,
    AdminModule,
    ResultsModule,
    HealthModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
