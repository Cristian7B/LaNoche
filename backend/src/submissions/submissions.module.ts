import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../db/db.module.js';
import { EventModule } from '../event/event.module.js';
import { MediaModule } from '../media/media.module.js';
import { MySubmissionsController, SubmissionsController } from './submissions.controller.js';
import { SubmissionsService } from './submissions.service.js';
import { UploadedFilesCleanupInterceptor } from '../common/uploaded-files-cleanup.interceptor.js';
import { VotesModule } from '../votes/votes.module.js';

@Module({
  imports: [AuthModule, DbModule, EventModule, MediaModule, VotesModule],
  controllers: [SubmissionsController, MySubmissionsController],
  providers: [SubmissionsService, UploadedFilesCleanupInterceptor],
  exports: [SubmissionsService],
})
export class SubmissionsModule {}
