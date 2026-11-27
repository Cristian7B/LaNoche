import { ConflictException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { and, count, desc, eq, ilike, ne, sql } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module.js';
import { adminActions, eventSettings, profiles, submissions, voteAudit, votes, whatsappIntakes } from '../db/schema.js';
import { EventService } from '../event/event.service.js';
import { ProfilesService } from '../auth/profiles.service.js';
import { RankingService } from '../votes/ranking.service.js';

type Transition = 'close' | 'reopen' | 'publish-results' | 'unpublish-results';

@Injectable()
export class AdminService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly events: EventService,
    private readonly profiles: ProfilesService,
    private readonly ranking: RankingService,
  ) {}

  async transition(adminId: string, transition: Transition) {
    await this.db.transaction(async (tx) => {
      const [event] = await tx.select().from(eventSettings).where(eq(eventSettings.id, 1)).for('update');
      const target = {
        close: { from: 'open', to: 'closed', action: 'event.close' },
        reopen: { from: 'closed', to: 'open', action: 'event.reopen' },
        'publish-results': { from: 'closed', to: 'results_published', action: 'event.publish_results' },
        'unpublish-results': { from: 'results_published', to: 'closed', action: 'event.unpublish_results' },
      }[transition] as { from: string; to: 'open' | 'closed' | 'results_published'; action: string };
      if (!event || event.status !== target.from) throw new ConflictException({ code: 'INVALID_TRANSITION', message: 'La transición de evento no está permitida.' });
      await tx.update(eventSettings).set({ status: target.to, resultsPublishedAt: target.to === 'results_published' ? new Date() : null, updatedBy: adminId, updatedAt: new Date() }).where(eq(eventSettings.id, 1));
      await this.logAction(tx, adminId, target.action, 'event', '1');
    });
    this.ranking.invalidate();
    return this.events.getEvent();
  }

  async updateSettings(adminId: string, changes: {
    closes_at?: string | null;
    max_votes_per_category?: number;
    max_photo_submissions?: number;
    max_sticker_submissions?: number;
    allow_self_vote?: boolean;
    show_author_in_public_results?: boolean;
  }) {
    await this.db.transaction(async (tx) => {
      const [event] = await tx.select().from(eventSettings).where(eq(eventSettings.id, 1)).for('update');
      if (!event) throw new Error('event_settings singleton row is missing');
      if (changes.max_votes_per_category !== undefined && changes.max_votes_per_category !== event.maxVotesPerCategory) {
        const [history] = await tx.select({ total: count() }).from(voteAudit).where(sql`cardinality(${voteAudit.ballot}) > 0`);
        if (history.total > 0) throw new UnprocessableEntityException({ code: 'VALIDATION_ERROR', message: 'El máximo no puede cambiar después de registrar una papeleta.', details: { reason: 'votes_exist' } });
      }
      await tx.update(eventSettings).set({
        ...(changes.closes_at !== undefined ? { closesAt: changes.closes_at ? new Date(changes.closes_at) : null } : {}),
        ...(changes.max_votes_per_category !== undefined ? { maxVotesPerCategory: changes.max_votes_per_category } : {}),
        ...(changes.max_photo_submissions !== undefined ? { maxPhotoSubmissions: changes.max_photo_submissions } : {}),
        ...(changes.max_sticker_submissions !== undefined ? { maxStickerSubmissions: changes.max_sticker_submissions } : {}),
        ...(changes.allow_self_vote !== undefined ? { allowSelfVote: changes.allow_self_vote } : {}),
        ...(changes.show_author_in_public_results !== undefined ? { showAuthorInPublicResults: changes.show_author_in_public_results } : {}),
        updatedBy: adminId, updatedAt: new Date(),
      }).where(eq(eventSettings.id, 1));
      await this.logAction(tx, adminId, 'event.settings.update', 'event', '1', changes);
    });
    this.ranking.invalidate();
    return this.events.getEvent();
  }

  async blockUser(adminId: string, id: string, isBlocked: boolean) {
    await this.db.transaction(async (tx) => {
      const [profile] = await tx.select().from(profiles).where(eq(profiles.id, id)).for('update');
      if (!profile) throw new NotFoundException({ code: 'NOT_FOUND', message: 'No se encontró el usuario.' });
      await tx.update(profiles).set({ isBlocked }).where(eq(profiles.id, id));
      await this.logAction(tx, adminId, isBlocked ? 'user.block' : 'user.unblock', 'profile', id, { is_blocked: isBlocked });
    });
    this.profiles.invalidate(id);
    this.ranking.invalidate();
    return { id, is_blocked: isBlocked };
  }

  async deleteSubmission(adminId: string, id: string, reason?: string) {
    await this.db.transaction(async (tx) => {
      const [submission] = await tx.select().from(submissions).where(eq(submissions.id, id)).for('update');
      if (!submission || submission.status !== 'published') throw new NotFoundException({ code: 'NOT_FOUND', message: 'No se encontró la postulación.' });
      await tx.update(submissions).set({ status: 'deleted', deletedAt: new Date(), deletedBy: adminId, deleteReason: reason?.trim() || null, updatedAt: new Date() }).where(eq(submissions.id, id));
      await this.logAction(tx, adminId, 'submission.delete', 'submission', id, { reason: reason?.trim() || null });
    });
    this.ranking.invalidate();
  }

  async restoreSubmission(adminId: string, id: string) {
    await this.db.transaction(async (tx) => {
      const [snapshot] = await tx.select().from(submissions).where(eq(submissions.id, id));
      if (!snapshot) throw new NotFoundException({ code: 'NOT_FOUND', message: 'No se encontró la postulación.' });
      await tx.select({ id: eventSettings.id }).from(eventSettings).where(eq(eventSettings.id, 1)).for('share');
      if (snapshot.source !== 'admin' && snapshot.authorId) {
        const [profile] = await tx.select().from(profiles).where(eq(profiles.id, snapshot.authorId)).for('update');
        if (!profile) throw new NotFoundException({ code: 'NOT_FOUND', message: 'No se encontró el perfil.' });
      }
      const [submission] = await tx.select().from(submissions).where(eq(submissions.id, id)).for('update');
      if (!submission || submission.status !== 'deleted') throw new NotFoundException({ code: 'NOT_FOUND', message: 'No se encontró la postulación.' });
      if (submission.source !== 'admin' && submission.authorId) {
        const [settings] = await tx.select().from(eventSettings).where(eq(eventSettings.id, 1));
        const limit = submission.category === 'photo' ? settings.maxPhotoSubmissions : settings.maxStickerSubmissions;
        const [current] = await tx.select({ value: count() }).from(submissions).where(and(
          eq(submissions.authorId, submission.authorId), eq(submissions.category, submission.category), eq(submissions.status, 'published'), ne(submissions.source, 'admin'),
        ));
        if (current.value >= limit) throw new ConflictException({ code: 'QUOTA_EXCEEDED', message: 'El usuario ya alcanzó el cupo para restaurar esta postulación.' });
      }
      await tx.update(submissions).set({ status: 'published', deletedAt: null, deletedBy: null, deleteReason: null, updatedAt: new Date() }).where(eq(submissions.id, id));
      await this.logAction(tx, adminId, 'submission.restore', 'submission', id);
    });
    this.ranking.invalidate();
    return { id, status: 'published' };
  }

  async dashboard() {
    const [users, submissionsByState, votersByCategory, voteTotal, intakesByState] = await Promise.all([
      this.db.select({ total: count() }).from(profiles),
      this.db.select({ category: submissions.category, status: submissions.status, total: count() }).from(submissions).groupBy(submissions.category, submissions.status),
      this.db.select({ category: votes.category, total: sql<number>`count(distinct ${votes.voterId})::int` }).from(votes).groupBy(votes.category),
      this.db.select({ total: count() }).from(votes),
      this.db.select({ status: whatsappIntakes.status, total: count() }).from(whatsappIntakes).groupBy(whatsappIntakes.status),
    ]);
    const sub = { photo: 0, sticker: 0, deleted: 0 };
    for (const row of submissionsByState) {
      if (row.status === 'deleted') sub.deleted += row.total;
      else sub[row.category] += row.total;
    }
    const voters = { photo: 0, sticker: 0 };
    for (const row of votersByCategory) voters[row.category] = row.total;
    const intakes = { ready: 0, claimed: 0, failed: 0 };
    for (const row of intakesByState) if (row.status in intakes) intakes[row.status as keyof typeof intakes] = row.total;
    return { event: await this.events.getEvent(), users: users[0].total, submissions: sub, voters, votes_total: voteTotal[0].total, intakes };
  }

  async listUsers(query: string | undefined, blocked: boolean | undefined, limit = 50, cursor?: string) {
    const pageSize = Math.min(100, Math.max(1, limit));
    const conditions = [
      ...(query ? [ilike(profiles.email, `%${query}%`)] : []),
      ...(blocked === undefined ? [] : [eq(profiles.isBlocked, blocked)]),
      ...(cursor ? [sql`${profiles.id} > ${cursor}::uuid`] : []),
    ];
    const rows = await this.db.select({ id: profiles.id, email: profiles.email, name: profiles.displayName, role: profiles.role, is_blocked: profiles.isBlocked, created_at: profiles.createdAt })
      .from(profiles).where(conditions.length ? and(...conditions) : undefined).orderBy(profiles.id).limit(pageSize + 1);
    const items = rows.slice(0, pageSize);
    return { items, next_cursor: rows.length > limit ? items.at(-1)?.id ?? null : null };
  }

  async listSubmissions(category: 'photo' | 'sticker' | undefined, status: 'published' | 'deleted' | 'all', query?: string, limit = 50, cursor?: string) {
    const pageSize = Math.min(200, Math.max(1, limit));
    const conditions = [
      ...(category ? [eq(submissions.category, category)] : []),
      ...(status === 'all' ? [] : [eq(submissions.status, status)]),
      ...(query ? [ilike(submissions.title, `%${query}%`)] : []),
      ...(cursor ? [sql`${submissions.id} > ${cursor}::uuid`] : []),
    ];
    const rows = await this.db.select({
      submission: submissions,
      author: { id: profiles.id, name: profiles.displayName, email: profiles.email },
    }).from(submissions).leftJoin(profiles, eq(submissions.authorId, profiles.id))
      .where(conditions.length ? and(...conditions) : undefined).orderBy(submissions.id).limit(pageSize + 1);
    const items = rows.slice(0, pageSize);
    const ids = items.map((item) => item.submission.id);
    const voteCounts = ids.length ? await this.db.execute(sql`
      SELECT submission_id, COUNT(*)::int AS total,
        ARRAY[COUNT(*) FILTER (WHERE position = 1)::int, COUNT(*) FILTER (WHERE position = 2)::int,
          COUNT(*) FILTER (WHERE position = 3)::int, COUNT(*) FILTER (WHERE position = 4)::int,
          COUNT(*) FILTER (WHERE position = 5)::int, COUNT(*) FILTER (WHERE position = 6)::int,
          COUNT(*) FILTER (WHERE position = 7)::int, COUNT(*) FILTER (WHERE position = 8)::int,
          COUNT(*) FILTER (WHERE position = 9)::int, COUNT(*) FILTER (WHERE position = 10)::int] AS by_position
      FROM votes WHERE submission_id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)}) GROUP BY submission_id
    `) as unknown as { submission_id: string; total: number; by_position: number[] }[] : [];
    const tally = new Map(voteCounts.map((row) => [row.submission_id, row]));
    return { items: items.map(({ submission, author }) => ({
      id: submission.id, category: submission.category, title: submission.title, description: submission.description,
      status: submission.status, source: submission.source,
      author: author?.id ? { id: author.id, name: submission.authorLabel ?? author.name, email: author.email } : submission.authorLabel ? { id: null, name: submission.authorLabel, email: null } : null,
      created_at: submission.createdAt.toISOString(), delete_reason: submission.deleteReason,
      votes: { total: Number(tally.get(submission.id)?.total ?? 0), by_position: (tally.get(submission.id)?.by_position ?? Array(10).fill(0)).map(Number) },
    })), next_cursor: rows.length > limit ? items.at(-1)?.submission.id ?? null : null };
  }

  async listActions(limit = 50, cursor?: string) {
    const pageSize = Math.min(100, Math.max(1, limit));
    const rows = await this.db.select().from(adminActions).where(cursor ? sql`${adminActions.id} < ${cursor}::bigint` : undefined)
      .orderBy(desc(adminActions.id)).limit(pageSize + 1);
    const items = rows.slice(0, pageSize);
    return { items, next_cursor: rows.length > limit ? String(items.at(-1)?.id) : null };
  }

  async listVoteAudit(voterId?: string, category?: 'photo' | 'sticker', limit = 50, cursor?: string) {
    const pageSize = Math.min(100, Math.max(1, limit));
    const conditions = [
      ...(voterId ? [eq(voteAudit.voterId, voterId)] : []),
      ...(category ? [eq(voteAudit.category, category)] : []),
      ...(cursor ? [sql`${voteAudit.id} < ${cursor}::bigint`] : []),
    ];
    const rows = await this.db.select().from(voteAudit).where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(voteAudit.id)).limit(pageSize + 1);
    const items = rows.slice(0, pageSize);
    return { items, next_cursor: rows.length > limit ? String(items.at(-1)?.id) : null };
  }

  async auditSignals() {
    const [early, sharedIp, identical, highAttempts] = await Promise.all([
      this.db.select({ voterId: votes.voterId, email: profiles.email, votedAt: votes.createdAt, createdAt: profiles.createdAt })
        .from(votes).innerJoin(profiles, eq(votes.voterId, profiles.id))
        .where(sql`${votes.createdAt} < ${profiles.createdAt} + interval '1 hour'`),
      this.db.execute(sql`SELECT ip::text AS ip, COUNT(DISTINCT voter_id)::int AS voters FROM vote_audit
        WHERE ip IS NOT NULL AND created_at > clock_timestamp() - interval '10 minutes' GROUP BY ip HAVING COUNT(DISTINCT voter_id) > 5`),
      this.db.execute(sql`SELECT ballot, COUNT(DISTINCT voter_id)::int AS voters FROM vote_audit
        GROUP BY ballot HAVING COUNT(DISTINCT voter_id) >= 10`),
      this.db.execute(sql`SELECT voter_id, COUNT(*)::int AS attempts FROM vote_attempts
        WHERE created_at > clock_timestamp() - interval '1 minute' GROUP BY voter_id HAVING COUNT(*) > 30`),
    ]);
    return { early_account_votes: early, shared_ip_bursts: sharedIp, identical_ballots: identical, high_vote_attempts: highAttempts };
  }

  private async logAction(tx: Pick<Database, 'insert'>, adminId: string, action: string, targetType?: string, targetId?: string, payload?: unknown) {
    await tx.insert(adminActions).values({ adminId, action, targetType, targetId, payload: payload ?? null });
  }
}
