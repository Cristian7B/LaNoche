import { ForbiddenException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module.js';
import { profiles, submissionMedia, submissions, voteAudit, votes } from '../db/schema.js';
import { EventService } from '../event/event.service.js';
import { StorageService } from '../media/storage.service.js';
import { RankingService } from './ranking.service.js';

type Category = 'photo' | 'sticker';

@Injectable()
export class VotesService {
  constructor(@Inject(DB) private readonly db: Database, private readonly events: EventService, private readonly storage: StorageService,
    private readonly ranking: RankingService) {}

  async replace(userId: string, category: Category, ids: string[], ip: string | undefined, userAgent: string | undefined) {
    const ballot = await this.db.transaction(async (tx) => {
      const settings = await this.events.assertOpen(tx);
      const [profile] = await tx.select().from(profiles).where(eq(profiles.id, userId)).for('update');
      if (!profile) throw new NotFoundException({ code: 'NOT_FOUND', message: 'No se encontró el perfil.' });
      if (profile.isBlocked) throw new ForbiddenException({ code: 'ACCOUNT_BLOCKED', message: 'La cuenta está bloqueada.' });
      if (ids.length > settings.maxVotesPerCategory || new Set(ids).size !== ids.length) throw this.validationError();
      const candidates = ids.length ? await tx.select().from(submissions).where(and(
        inArray(submissions.id, ids), eq(submissions.category, category), eq(submissions.status, 'published'),
      )).for('share') : [];
      if (candidates.length !== ids.length) throw this.validationError();
      if (!settings.allowSelfVote && candidates.some((candidate) => candidate.authorId === userId)) {
        throw new UnprocessableEntityException({ code: 'SELF_VOTE_NOT_ALLOWED', message: 'No puedes votar por tu propia postulación.' });
      }
      await tx.delete(votes).where(and(eq(votes.voterId, userId), eq(votes.category, category)));
      if (ids.length) await tx.insert(votes).values(ids.map((submissionId, index) => ({
        voterId: userId, category, submissionId, position: index + 1,
      })));
      await tx.insert(voteAudit).values({
        voterId: userId,
        category,
        ballot: ids,
        ip: ip ?? null,
        userAgent: userAgent?.slice(0, 500) ?? null,
      });
      const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
      const orderedCandidates = ids.map((id) => candidateById.get(id)!);
      const media = ids.length ? await tx.select().from(submissionMedia).where(inArray(submissionMedia.submissionId, ids)) : [];
      return this.mapBallot(userId, category, orderedCandidates, media);
    });
    this.ranking.invalidate(category);
    return ballot;
  }

  async getBallots(userId: string) {
    const rows = await this.db.select({ vote: votes, submission: submissions })
      .from(votes).innerJoin(submissions, eq(votes.submissionId, submissions.id))
      .innerJoin(profiles, eq(votes.voterId, profiles.id))
      .where(and(eq(votes.voterId, userId), eq(submissions.status, 'published'), eq(profiles.isBlocked, false)))
      .orderBy(asc(votes.category), asc(votes.position));
    const ids = rows.map((row) => row.submission.id);
    const media = ids.length ? await this.db.select().from(submissionMedia).where(inArray(submissionMedia.submissionId, ids)) : [];
    const photo = this.mapBallot(userId, 'photo', rows.filter((row) => row.vote.category === 'photo').map((row) => row.submission), media);
    const sticker = this.mapBallot(userId, 'sticker', rows.filter((row) => row.vote.category === 'sticker').map((row) => row.submission), media);
    return { photo, sticker };
  }

  private mapBallot(userId: string, category: Category, candidates: (typeof submissions.$inferSelect)[], media: (typeof submissionMedia.$inferSelect)[]) {
    const mediaById = new Map<string, typeof media>();
    for (const item of media) mediaById.set(item.submissionId, [...(mediaById.get(item.submissionId) ?? []), item]);
    const items = candidates.map((candidate, index) => ({
      position: index + 1,
      submission: {
        id: candidate.id,
        category: candidate.category,
        title: candidate.title,
        description: candidate.description,
        is_mine: candidate.authorId === userId,
        created_at: candidate.createdAt.toISOString(),
        media: (mediaById.get(candidate.id) ?? []).sort((a, b) => a.position - b.position).map((item) => ({
          id: item.id, kind: item.kind, url: this.storage.publicUrl(item.storagePath),
          thumb_url: this.storage.publicUrl(item.thumbPath), width: item.width, height: item.height,
          ...(item.durationMs === null ? {} : { duration_ms: item.durationMs }), position: item.position,
        })),
      },
    }));
    return { category, items };
  }

  private validationError() {
    return new UnprocessableEntityException({ code: 'VALIDATION_ERROR', message: 'La papeleta no es válida.' });
  }
}
