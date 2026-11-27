import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { and, asc, count, eq, ne, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { DB, type Database } from '../db/db.module.js';
import { adminActions, profiles, submissionMedia, submissions } from '../db/schema.js';
import { EventService } from '../event/event.service.js';
import { MediaService } from '../media/media.service.js';
import { StorageService } from '../media/storage.service.js';
import { RankingService } from '../votes/ranking.service.js';

type Category = 'photo' | 'sticker';

@Injectable()
export class SubmissionsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly events: EventService,
    private readonly media: MediaService,
    private readonly storage: StorageService,
    private readonly ranking: RankingService,
  ) {}

  async list(category: Category, userId: string) {
    const rows = await this.db.select({ submission: submissions, media: submissionMedia })
      .from(submissions).leftJoin(submissionMedia, eq(submissionMedia.submissionId, submissions.id))
      .where(and(eq(submissions.category, category), eq(submissions.status, 'published')))
      .orderBy(sql`md5(${submissions.id}::text || ${userId})`, asc(submissions.createdAt), asc(submissionMedia.position));
    return this.mapRows(rows, userId);
  }

  async getOne(id: string, userId: string) {
    const rows = await this.db.select({ submission: submissions, media: submissionMedia })
      .from(submissions).leftJoin(submissionMedia, eq(submissionMedia.submissionId, submissions.id))
      .where(eq(submissions.id, id)).orderBy(asc(submissionMedia.position));
    if (!rows.length || (rows[0].submission.status === 'deleted' && rows[0].submission.authorId !== userId)) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'No se encontró la postulación.' });
    }
    return this.mapRows(rows, userId, true)[0];
  }

  async create(userId: string, input: { category: Category; title: string; description: string }, files: Express.Multer.File[]) {
    const title = input.title.trim();
    const description = input.description.trim();
    if (title.length < 3 || title.length > 120 || description.length < 10 || description.length > 1000) {
      throw new UnprocessableEntityException({ code: 'VALIDATION_ERROR', message: 'El título o la descripción no cumplen los límites.' });
    }
    const processed = await this.media.process(files, input.category);
    const id = randomUUID();
    const paths: string[] = [];
    const mediaRows: (typeof submissionMedia.$inferInsert)[] = [];
    let committed = false;
    try {
      for (const item of processed) {
        const folder = `submissions/${id}`;
        const storagePath = `${folder}/${item.position}.${item.extension}`;
        const thumbPath = `${folder}/${item.position}_thumb.webp`;
        await this.storage.upload(storagePath, item.data, item.mimeType);
        paths.push(storagePath);
        await this.storage.upload(thumbPath, item.thumbnail, 'image/webp');
        paths.push(thumbPath);
        mediaRows.push({
          submissionId: id,
          position: item.position,
          kind: item.kind,
          storagePath,
          thumbPath,
          mimeType: item.mimeType,
          width: item.width,
          height: item.height,
          durationMs: item.durationMs,
          sizeBytes: item.sizeBytes,
        });
      }
      await this.db.transaction(async (tx) => {
        const event = await this.events.assertOpen(tx);
        const [profile] = await tx.select().from(profiles).where(eq(profiles.id, userId)).for('update');
        if (!profile) throw new NotFoundException({ code: 'NOT_FOUND', message: 'No se encontró el perfil.' });
        if (profile.isBlocked) throw new ForbiddenException({ code: 'ACCOUNT_BLOCKED', message: 'La cuenta está bloqueada.' });
        const quota = input.category === 'photo' ? event.maxPhotoSubmissions : event.maxStickerSubmissions;
        const [current] = await tx.select({ value: count() }).from(submissions).where(and(
          eq(submissions.authorId, userId), eq(submissions.category, input.category), eq(submissions.status, 'published'),
          ne(submissions.source, 'admin'),
        ));
        if (current.value >= quota) throw new ConflictException({ code: 'QUOTA_EXCEEDED', message: 'Alcanzaste el límite de postulaciones.' });
        await tx.insert(submissions).values({ id, category: input.category, title, description, authorId: userId, source: 'web' });
        await tx.insert(submissionMedia).values(mediaRows);
      });
      committed = true;
      this.ranking.invalidate(input.category);
      return this.getOne(id, userId);
    } catch (error) {
      if (!committed) await this.storage.remove(paths).catch(() => undefined);
      throw error;
    }
  }

  async createAdmin(adminId: string, input: { category: Category; title: string; description: string; author_label: string; author_id?: string }, files: Express.Multer.File[]) {
    const title = input.title.trim();
    const description = input.description.trim();
    const authorLabel = input.author_label.trim();
    if (title.length < 3 || title.length > 120 || description.length < 10 || description.length > 1000 || !authorLabel) {
      throw new UnprocessableEntityException({ code: 'VALIDATION_ERROR', message: 'La postulación manual no cumple los límites.' });
    }
    const processed = await this.media.process(files, input.category);
    const id = randomUUID();
    const paths: string[] = [];
    const mediaRows: (typeof submissionMedia.$inferInsert)[] = [];
    let committed = false;
    try {
      for (const item of processed) {
        const folder = `submissions/${id}`;
        const storagePath = `${folder}/${item.position}.${item.extension}`;
        const thumbPath = `${folder}/${item.position}_thumb.webp`;
        await this.storage.upload(storagePath, item.data, item.mimeType);
        paths.push(storagePath);
        await this.storage.upload(thumbPath, item.thumbnail, 'image/webp');
        paths.push(thumbPath);
        mediaRows.push({ submissionId: id, position: item.position, kind: item.kind, storagePath, thumbPath, mimeType: item.mimeType,
          width: item.width, height: item.height, durationMs: item.durationMs, sizeBytes: item.sizeBytes });
      }
      await this.db.transaction(async (tx) => {
        if (input.author_id) {
          const [author] = await tx.select().from(profiles).where(eq(profiles.id, input.author_id)).for('update');
          if (!author) throw new NotFoundException({ code: 'NOT_FOUND', message: 'No se encontró el autor.' });
        }
        await tx.insert(submissions).values({ id, category: input.category, title, description, source: 'admin', authorLabel, authorId: input.author_id ?? null });
        await tx.insert(submissionMedia).values(mediaRows);
        await tx.insert(adminActions).values({ adminId, action: 'submission.create_manual', targetType: 'submission', targetId: id, payload: { category: input.category } });
      });
      committed = true;
      this.ranking.invalidate(input.category);
      return this.getOne(id, input.author_id ?? adminId);
    } catch (error) {
      if (!committed) await this.storage.remove(paths).catch(() => undefined);
      throw error;
    }
  }

  async edit(userId: string, id: string, changes: { title?: string; description?: string }) {
    await this.db.transaction(async (tx) => {
      await this.events.assertOpen(tx);
      const [profile] = await tx.select().from(profiles).where(eq(profiles.id, userId)).for('update');
      this.assertWritable(profile);
      const [submission] = await tx.select().from(submissions).where(eq(submissions.id, id)).for('update');
      if (!submission || submission.authorId !== userId || submission.status !== 'published') throw new NotFoundException({ code: 'NOT_FOUND', message: 'No se encontró la postulación.' });
      const title = changes.title?.trim();
      const description = changes.description?.trim();
      if ((title !== undefined && (title.length < 3 || title.length > 120)) || (description !== undefined && (description.length < 10 || description.length > 1000))) {
        throw new UnprocessableEntityException({ code: 'VALIDATION_ERROR', message: 'El título o la descripción no cumplen los límites.' });
      }
      await tx.update(submissions).set({ ...(title ? { title } : {}), ...(description ? { description } : {}), updatedAt: new Date() }).where(eq(submissions.id, id));
    });
    this.ranking.invalidate();
    return this.getOne(id, userId);
  }

  async remove(userId: string, id: string) {
    await this.db.transaction(async (tx) => {
      await this.events.assertOpen(tx);
      const [profile] = await tx.select().from(profiles).where(eq(profiles.id, userId)).for('update');
      this.assertWritable(profile);
      const [submission] = await tx.select().from(submissions).where(eq(submissions.id, id)).for('update');
      if (!submission || submission.authorId !== userId || submission.status !== 'published') throw new NotFoundException({ code: 'NOT_FOUND', message: 'No se encontró la postulación.' });
      await tx.update(submissions).set({ status: 'deleted', deletedAt: new Date(), updatedAt: new Date() }).where(eq(submissions.id, id));
    });
    this.ranking.invalidate();
  }

  async editAdmin(adminId: string, id: string, changes: { title?: string; description?: string; author_label?: string }) {
    const title = changes.title?.trim();
    const description = changes.description?.trim();
    const authorLabel = changes.author_label?.trim();
    if ((title !== undefined && (title.length < 3 || title.length > 120)) || (description !== undefined && (description.length < 10 || description.length > 1000)) || (authorLabel !== undefined && !authorLabel)) {
      throw new UnprocessableEntityException({ code: 'VALIDATION_ERROR', message: 'Los campos no cumplen los límites.' });
    }
    await this.db.transaction(async (tx) => {
      const [submission] = await tx.select().from(submissions).where(eq(submissions.id, id)).for('update');
      if (!submission) throw new NotFoundException({ code: 'NOT_FOUND', message: 'No se encontró la postulación.' });
      await tx.update(submissions).set({ ...(title ? { title } : {}), ...(description ? { description } : {}), ...(authorLabel ? { authorLabel } : {}), updatedAt: new Date() }).where(eq(submissions.id, id));
      await tx.insert(adminActions).values({ adminId, action: 'submission.update', targetType: 'submission', targetId: id, payload: changes });
    });
    this.ranking.invalidate();
    return this.getOne(id, '00000000-0000-0000-0000-000000000000');
  }

  async listMine(userId: string) {
    const rows = await this.db.select({ submission: submissions, media: submissionMedia })
      .from(submissions).leftJoin(submissionMedia, eq(submissionMedia.submissionId, submissions.id))
      .where(eq(submissions.authorId, userId))
      .orderBy(sql`md5(${submissions.id}::text || ${userId})`, asc(submissions.createdAt), asc(submissionMedia.position));
    return this.mapRows(rows, userId, true);
  }

  private assertWritable(profile: typeof profiles.$inferSelect | undefined) {
    if (!profile) throw new NotFoundException({ code: 'NOT_FOUND', message: 'No se encontró el perfil.' });
    if (profile.isBlocked) throw new ForbiddenException({ code: 'ACCOUNT_BLOCKED', message: 'La cuenta está bloqueada.' });
  }

  private mapRows(rows: { submission: typeof submissions.$inferSelect; media: typeof submissionMedia.$inferSelect | null }[], userId: string, includeOwnerStatus = false) {
    const mapped = new Map<string, Record<string, unknown>>();
    for (const { submission, media } of rows) {
      let item = mapped.get(submission.id);
      if (!item) {
        item = {
          id: submission.id,
          category: submission.category,
          title: submission.title,
          description: submission.description,
          is_mine: submission.authorId === userId,
          created_at: submission.createdAt.toISOString(),
          media: [],
          ...(includeOwnerStatus && submission.authorId === userId ? { status: submission.status, source: submission.source, ...(submission.deleteReason ? { delete_reason: submission.deleteReason } : {}) } : {}),
        };
        mapped.set(submission.id, item);
      }
      if (media) (item.media as unknown[]).push({
        id: media.id,
        kind: media.kind,
        url: this.storage.publicUrl(media.storagePath),
        thumb_url: this.storage.publicUrl(media.thumbPath),
        width: media.width,
        height: media.height,
        ...(media.durationMs === null ? {} : { duration_ms: media.durationMs }),
        position: media.position,
      });
    }
    return [...mapped.values()];
  }
}
