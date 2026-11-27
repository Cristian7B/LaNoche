import { ConflictException, ForbiddenException, GoneException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { OnApplicationBootstrap } from '@nestjs/common';
import { and, count, eq, gt, lt, ne, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { DB, type Database } from '../db/db.module.js';
import { profiles, submissionMedia, submissions, whatsappIntakes } from '../db/schema.js';
import { EventService } from '../event/event.service.js';
import { StorageService } from '../media/storage.service.js';
import { CryptoService } from '../whatsapp/crypto.service.js';
import { RankingService } from '../votes/ranking.service.js';

@Injectable()
export class IntakesService implements OnApplicationBootstrap {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly events: EventService,
    private readonly storage: StorageService,
    private readonly crypto: CryptoService,
    private readonly ranking: RankingService,
  ) {}

  onApplicationBootstrap() {
    void this.expireReady().catch(() => undefined);
  }

  async preview(token: string) {
    const [intake] = await this.db.select().from(whatsappIntakes).where(eq(whatsappIntakes.tokenHash, this.crypto.hashToken(token)));
    if (!intake) throw new NotFoundException({ code: 'NOT_FOUND', message: 'No se encontró el intake.' });
    const [clock] = await this.db.select({ serverTime: sql<Date>`clock_timestamp()`.mapWith({ mapFromDriverValue: (value) => new Date(value as string | number) }) })
      .from(whatsappIntakes).where(eq(whatsappIntakes.id, intake.id));
    if (intake.expiresAt <= clock.serverTime || intake.status === 'expired') throw new GoneException({ code: 'INTAKE_EXPIRED', message: 'El enlace venció.' });
    if (intake.status === 'claimed') throw new ConflictException({ code: 'INTAKE_ALREADY_CLAIMED', message: 'Este intake ya fue reclamado.' });
    if (intake.status !== 'ready' || !intake.storagePath || !intake.thumbPath || !intake.kind || !intake.mimeType) {
      return { notReady: true } as const;
    }
    return {
      status: intake.status,
      category: intake.category,
      media: {
        id: intake.id,
        kind: intake.kind,
        url: this.storage.publicUrl(intake.storagePath),
        thumb_url: this.storage.publicUrl(intake.thumbPath),
        width: intake.width,
        height: intake.height,
        ...(intake.durationMs === null ? {} : { duration_ms: intake.durationMs }),
        position: 1,
      },
      expires_at: intake.expiresAt.toISOString(),
    };
  }

  async claim(userId: string, token: string, input: { title: string; description: string }) {
    const tokenHash = this.crypto.hashToken(token);
    const title = input.title.trim();
    const description = input.description.trim();
    if (title.length < 3 || title.length > 120 || description.length < 10 || description.length > 1000) {
      throw new UnprocessableEntityException({ code: 'VALIDATION_ERROR', message: 'El título o descripción no cumplen los límites.' });
    }
    const submissionId = randomUUID();
    await this.db.transaction(async (tx) => {
      const event = await this.events.assertOpen(tx);
      const [profile] = await tx.select().from(profiles).where(eq(profiles.id, userId)).for('update');
      if (!profile) throw new NotFoundException({ code: 'NOT_FOUND', message: 'No se encontró el perfil.' });
      if (profile.isBlocked) throw new ForbiddenException({ code: 'ACCOUNT_BLOCKED', message: 'La cuenta está bloqueada.' });
      if (!profile.humanVerifiedAt) throw new ForbiddenException({ code: 'HUMAN_VERIFICATION_REQUIRED', message: 'Completa la verificación humana.' });
      const [intake] = await tx.select().from(whatsappIntakes).where(eq(whatsappIntakes.tokenHash, tokenHash)).for('update');
      if (!intake) throw new NotFoundException({ code: 'NOT_FOUND', message: 'No se encontró el intake.' });
      const [clock] = await tx.select({ serverTime: sql<Date>`clock_timestamp()`.mapWith({ mapFromDriverValue: (value) => new Date(value as string | number) }) })
        .from(whatsappIntakes).where(eq(whatsappIntakes.id, intake.id));
      if (intake.expiresAt <= clock.serverTime || intake.status === 'expired') throw new GoneException({ code: 'INTAKE_EXPIRED', message: 'El enlace venció.' });
      if (intake.status === 'claimed') throw new ConflictException({ code: 'INTAKE_ALREADY_CLAIMED', message: 'Este intake ya fue reclamado.' });
      if (intake.status !== 'ready' || !intake.storagePath || !intake.thumbPath || !intake.kind || !intake.mimeType) {
        throw new ConflictException({ code: 'INTAKE_NOT_READY', message: 'El sticker aún se está procesando.' });
      }
      const quota = event.maxStickerSubmissions;
      const [current] = await tx.select({ value: count() }).from(submissions).where(and(
        eq(submissions.authorId, userId), eq(submissions.category, 'sticker'), eq(submissions.status, 'published'), ne(submissions.source, 'admin'),
      ));
      if (current.value >= quota) throw new ConflictException({ code: 'QUOTA_EXCEEDED', message: 'Alcanzaste el límite de postulaciones.' });
      const [claimed] = await tx.update(whatsappIntakes).set({ status: 'claimed', claimedBy: userId, claimedAt: new Date(), waId: null, tokenCiphertext: null, updatedAt: new Date() })
        .where(and(eq(whatsappIntakes.id, intake.id), eq(whatsappIntakes.status, 'ready'), gt(whatsappIntakes.expiresAt, sql`clock_timestamp()`))).returning();
      if (!claimed) throw new ConflictException({ code: 'INTAKE_ALREADY_CLAIMED', message: 'Este intake ya no está disponible.' });
      await tx.insert(submissions).values({ id: submissionId, category: 'sticker', title, description, authorId: userId, source: 'whatsapp', intakeId: intake.id });
      await tx.insert(submissionMedia).values({
        submissionId, position: 1, kind: intake.kind, storagePath: intake.storagePath, thumbPath: intake.thumbPath,
        mimeType: intake.mimeType, width: intake.width ?? 0, height: intake.height ?? 0,
        durationMs: intake.durationMs, sizeBytes: intake.sizeBytes ?? 0,
      });
    });
    this.ranking.invalidate('sticker');
    const [submission] = await this.db.select().from(submissions).where(eq(submissions.id, submissionId));
    const [media] = await this.db.select().from(submissionMedia).where(and(eq(submissionMedia.submissionId, submissionId), eq(submissionMedia.position, 1)));
    return {
      id: submission.id, category: submission.category, title: submission.title, description: submission.description,
      is_mine: true, status: submission.status, source: submission.source, created_at: submission.createdAt.toISOString(),
      media: [{ id: media.id, kind: media.kind, url: this.storage.publicUrl(media.storagePath), thumb_url: this.storage.publicUrl(media.thumbPath),
        width: media.width, height: media.height, ...(media.durationMs === null ? {} : { duration_ms: media.durationMs }), position: media.position }],
    };
  }

  @Interval(3_600_000)
  async expireReady() {
    await this.db.update(whatsappIntakes).set({ status: 'expired', waId: null, tokenCiphertext: null, updatedAt: new Date() })
      .where(and(eq(whatsappIntakes.status, 'ready'), lt(whatsappIntakes.expiresAt, sql`clock_timestamp()`)));
    const expired = await this.db.select({ id: whatsappIntakes.id, storagePath: whatsappIntakes.storagePath, thumbPath: whatsappIntakes.thumbPath })
      .from(whatsappIntakes).where(and(eq(whatsappIntakes.status, 'expired'), sql`(${whatsappIntakes.storagePath} is not null or ${whatsappIntakes.thumbPath} is not null)`));
    for (const intake of expired) {
      const paths = [intake.storagePath, intake.thumbPath].filter((path): path is string => path !== null);
      try {
        await this.storage.remove(paths);
        await this.db.update(whatsappIntakes).set({ storagePath: null, thumbPath: null, updatedAt: new Date() })
          .where(and(eq(whatsappIntakes.id, intake.id), eq(whatsappIntakes.status, 'expired')));
      } catch {
        // Keep paths in the row so the next scheduled sweep can retry cleanup.
      }
    }
  }
}
