import { Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req, UploadedFiles, UseGuards, UseInterceptors, Body } from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { tmpdir } from 'node:os';
import { rm } from 'node:fs/promises';
import { z } from 'zod';
import { UploadedFilesCleanupInterceptor } from '../common/uploaded-files-cleanup.interceptor.js';
import { Throttle } from '@nestjs/throttler';
import type { AuthRequest } from '../auth/auth.types.js';
import { HumanVerifiedGuard } from '../auth/verification.guard.js';
import { SubmissionsService } from './submissions.service.js';

const categorySchema = z.enum(['photo', 'sticker']);
const idSchema = z.uuid();
const createSchema = z.object({
  category: categorySchema,
  title: z.string().trim().min(3).max(120),
  description: z.string().trim().min(10).max(1000),
});
const updateSchema = z.object({
  title: z.string().trim().min(3).max(120).optional(),
  description: z.string().trim().min(10).max(1000).optional(),
}).refine((body) => Object.keys(body).length > 0, 'At least one field is required');

@Controller('submissions')
export class SubmissionsController {
  constructor(private readonly submissions: SubmissionsService) {}

  @Get()
  list(@Query('category', { schema: categorySchema }) category: 'photo' | 'sticker', @Req() request: AuthRequest) {
    return this.submissions.list(category, request.user!.id);
  }

  @Get(':id')
  getOne(@Param('id', { schema: idSchema }) id: string, @Req() request: AuthRequest) {
    return this.submissions.getOne(id, request.user!.id);
  }

  @Post()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UseGuards(HumanVerifiedGuard)
  @UseInterceptors(FilesInterceptor('files', 10, {
    storage: diskStorage({ destination: tmpdir() }),
    limits: { files: 10, fileSize: Math.max(Number(process.env.MAX_IMAGE_BYTES ?? 10_485_760), Number(process.env.MAX_STICKER_BYTES ?? 10_485_760)) },
  }), UploadedFilesCleanupInterceptor)
  async create(
    @Body({ schema: createSchema }) body: z.infer<typeof createSchema>,
    @UploadedFiles() files: Express.Multer.File[] | undefined,
    @Req() request: AuthRequest,
  ) {
    const uploads = files ?? [];
    try {
      return await this.submissions.create(request.user!.id, body, uploads);
    } finally {
      await Promise.all(uploads.map((file) => rm(file.path, { force: true }).catch(() => undefined)));
    }
  }

  @Patch(':id')
  @UseGuards(HumanVerifiedGuard)
  edit(@Param('id', { schema: idSchema }) id: string, @Body({ schema: updateSchema }) body: z.infer<typeof updateSchema>, @Req() request: AuthRequest) {
    return this.submissions.edit(request.user!.id, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @UseGuards(HumanVerifiedGuard)
  async remove(@Param('id', { schema: idSchema }) id: string, @Req() request: AuthRequest) {
    await this.submissions.remove(request.user!.id, id);
  }
}

@Controller('me')
export class MySubmissionsController {
  constructor(private readonly submissions: SubmissionsService) {}

  @Get('submissions')
  listMine(@Req() request: AuthRequest) {
    return this.submissions.listMine(request.user!.id);
  }
}
