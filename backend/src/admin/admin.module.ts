import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../db/db.module.js';
import { EventModule } from '../event/event.module.js';
import { VotesModule } from '../votes/votes.module.js';
import { SubmissionsModule } from '../submissions/submissions.module.js';
import { AdminController } from './admin.controller.js';
import { AdminService } from './admin.service.js';

@Module({
  imports: [AuthModule, DbModule, EventModule, VotesModule, SubmissionsModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
