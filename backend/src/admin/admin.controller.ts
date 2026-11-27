import { Body, ConflictException, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req, UploadedFiles, UseGuards, UseInterceptors } from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { tmpdir } from 'node:os';
import { rm } from 'node:fs/promises';
import { z } from 'zod';
import type { AuthRequest } from '../auth/auth.types.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { EventService } from '../event/event.service.js';
import { RankingService } from '../votes/ranking.service.js';
import { AdminService } from './admin.service.js';
import { SubmissionsService } from '../submissions/submissions.service.js';
import { UploadedFilesCleanupInterceptor } from '../common/uploaded-files-cleanup.interceptor.js';

const idSchema = z.uuid();
const categorySchema = z.enum(['photo', 'sticker']);
const settingsSchema = z.object({
  closes_at: z.iso.datetime({ offset: true }).nullable().optional(),
  max_votes_per_category: z.number().int().min(1).max(10).optional(),
  max_photo_submissions: z.number().int().min(0).max(20).optional(),
  max_sticker_submissions: z.number().int().min(0).max(20).optional(),
  allow_self_vote: z.boolean().optional(),
  show_author_in_public_results: z.boolean().optional(),
}).refine((value) => Object.keys(value).length > 0, 'At least one setting is required');
const adminSubmissionSchema = z.object({
  category: categorySchema,
  title: z.string().trim().min(3).max(120),
  description: z.string().trim().min(10).max(1000),
  author_label: z.string().trim().min(1).max(120),
  author_id: z.uuid().optional(),
});
const adminSubmissionUpdateSchema = z.object({
  title: z.string().trim().min(3).max(120).optional(),
  description: z.string().trim().min(10).max(1000).optional(),
  author_label: z.string().trim().min(1).max(120).optional(),
}).refine((body) => Object.keys(body).length > 0, 'At least one field is required');

@Controller('admin')
@UseGuards(RolesGuard)
@Roles('admin')
export class AdminController {
  constructor(private readonly admin: AdminService, private readonly events: EventService, private readonly ranking: RankingService,
    private readonly submissions: SubmissionsService) {}

  @Get('dashboard')
  dashboard() { return this.admin.dashboard(); }

  @Post('event/close')
  @HttpCode(200)
  close(@Req() request: AuthRequest) { return this.admin.transition(request.user!.id, 'close'); }

  @Post('event/reopen')
  @HttpCode(200)
  reopen(@Req() request: AuthRequest) { return this.admin.transition(request.user!.id, 'reopen'); }

  @Post('event/publish-results')
  @HttpCode(200)
  publish(@Req() request: AuthRequest) { return this.admin.transition(request.user!.id, 'publish-results'); }

  @Post('event/unpublish-results')
  @HttpCode(200)
  unpublish(@Req() request: AuthRequest) { return this.admin.transition(request.user!.id, 'unpublish-results'); }

  @Patch('settings')
  updateSettings(@Req() request: AuthRequest, @Body({ schema: settingsSchema }) body: z.infer<typeof settingsSchema>) {
    return this.admin.updateSettings(request.user!.id, body);
  }

  @Get('submissions')
  listSubmissions(
    @Query('category', { schema: categorySchema.optional() }) category?: 'photo' | 'sticker',
    @Query('status', { schema: z.enum(['published', 'deleted', 'all']).default('published') }) status: 'published' | 'deleted' | 'all' = 'published',
    @Query('q') query?: string,
    @Query('limit', { schema: z.coerce.number().int().min(1).max(200).default(50) }) limit = 50,
    @Query('cursor') cursor?: string,
  ) { return this.admin.listSubmissions(category, status, query, limit, cursor); }

  @Post('submissions')
  @UseInterceptors(FilesInterceptor('files', 10, {
    storage: diskStorage({ destination: tmpdir() }),
    limits: { files: 10, fileSize: Math.max(Number(process.env.MAX_IMAGE_BYTES ?? 10_485_760), Number(process.env.MAX_STICKER_BYTES ?? 10_485_760)) },
  }), UploadedFilesCleanupInterceptor)
  async createManual(@Req() request: AuthRequest, @Body({ schema: adminSubmissionSchema }) body: z.infer<typeof adminSubmissionSchema>, @UploadedFiles() files?: Express.Multer.File[]) {
    const uploads = files ?? [];
    try { return await this.submissions.createAdmin(request.user!.id, body, uploads); }
    finally { await Promise.all(uploads.map((file) => rm(file.path, { force: true }).catch(() => undefined))); }
  }

  @Patch('submissions/:id')
  updateSubmission(@Param('id', { schema: idSchema }) id: string, @Req() request: AuthRequest,
    @Body({ schema: adminSubmissionUpdateSchema }) body: z.infer<typeof adminSubmissionUpdateSchema>) {
    return this.submissions.editAdmin(request.user!.id, id, body);
  }

  @Delete('submissions/:id')
  @HttpCode(204)
  deleteSubmission(@Param('id', { schema: idSchema }) id: string, @Req() request: AuthRequest, @Body({ schema: z.object({ reason: z.string().max(500).optional() }).optional() }) body?: { reason?: string }) {
    return this.admin.deleteSubmission(request.user!.id, id, body?.reason);
  }

  @Post('submissions/:id/restore')
  @HttpCode(200)
  restoreSubmission(@Param('id', { schema: idSchema }) id: string, @Req() request: AuthRequest) {
    return this.admin.restoreSubmission(request.user!.id, id);
  }

  @Get('ranking')
  rankingItems(@Query('category', { schema: categorySchema }) category: 'photo' | 'sticker') {
    return this.ranking.ranking(category, undefined, true, true);
  }

  @Get('results/onsite')
  async onsiteResults() {
    const event = await this.events.getEvent();
    if (event.effective_status === 'open') throw new ConflictException({ code: 'EVENT_STILL_OPEN', message: 'Cierra el evento antes de mostrar resultados onsite.' });
    const [photo, sticker] = await Promise.all([
      this.ranking.ranking('photo', undefined, true),
      this.ranking.ranking('sticker', undefined, true),
    ]);
    return { photo, sticker };
  }

  @Get('users')
  listUsers(
    @Query('q') query?: string,
    @Query('blocked', { schema: z.stringbool().optional() }) blocked?: boolean,
    @Query('limit', { schema: z.coerce.number().int().min(1).max(100).default(50) }) limit = 50,
    @Query('cursor') cursor?: string,
  ) { return this.admin.listUsers(query, blocked, limit, cursor); }

  @Patch('users/:id')
  blockUser(@Param('id', { schema: idSchema }) id: string, @Req() request: AuthRequest, @Body({ schema: z.object({ is_blocked: z.boolean() }) }) body: { is_blocked: boolean }) {
    return this.admin.blockUser(request.user!.id, id, body.is_blocked);
  }

  @Get('audit/signals')
  signals() { return this.admin.auditSignals(); }

  @Get('audit/votes')
  voteAudit(
    @Query('voter_id', { schema: idSchema.optional() }) voterId?: string,
    @Query('category', { schema: categorySchema.optional() }) category?: 'photo' | 'sticker',
    @Query('limit', { schema: z.coerce.number().int().min(1).max(100).default(50) }) limit = 50,
    @Query('cursor') cursor?: string,
  ) { return this.admin.listVoteAudit(voterId, category, limit, cursor); }

  @Get('actions')
  actions(
    @Query('limit', { schema: z.coerce.number().int().min(1).max(100).default(50) }) limit = 50,
    @Query('cursor') cursor?: string,
  ) { return this.admin.listActions(limit, cursor); }
}
