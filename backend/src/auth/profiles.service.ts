import { Inject, Injectable } from '@nestjs/common';
import { and, count, eq } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module.js';
import { profiles, submissions, votes } from '../db/schema.js';
import type { AuthUser } from './auth.types.js';

export interface SupabaseClaims {
  sub: string;
  email: string;
  user_metadata?: Record<string, unknown>;
}

@Injectable()
export class ProfilesService {
  private readonly cache = new Map<string, { user: AuthUser & { displayName: string; avatarUrl: string | null }; expiresAt: number }>();
  private readonly adminEmails: Set<string>;

  constructor(@Inject(DB) private readonly db: Database) {
    this.adminEmails = new Set((process.env.ADMIN_EMAILS ?? '').split(',').map((email) => email.trim().toLowerCase()).filter(Boolean));
  }

  async findOrCreate(claims: SupabaseClaims) {
    const cached = this.cache.get(claims.sub);
    if (cached && cached.expiresAt > Date.now()) return cached.user;
    const displayName = this.metadataText(claims.user_metadata, 'full_name')
      ?? this.metadataText(claims.user_metadata, 'name')
      ?? claims.email;
    const avatarUrl = this.metadataText(claims.user_metadata, 'avatar_url')
      ?? this.metadataText(claims.user_metadata, 'picture')
      ?? null;
    const user = await this.upsert({
      id: claims.sub,
      email: claims.email,
      displayName,
      avatarUrl,
      promoteAdmin: this.adminEmails.has(claims.email.toLowerCase()),
    });
    this.cache.set(claims.sub, { user, expiresAt: Date.now() + 60_000 });
    return user;
  }

  async get(id: string) {
    return this.db.query.profiles.findFirst({ where: eq(profiles.id, id) });
  }

  invalidate(id: string) {
    this.cache.delete(id);
  }

  async verifyHuman(id: string) {
    const [profile] = await this.db.update(profiles).set({ humanVerifiedAt: new Date() })
      .where(eq(profiles.id, id)).returning();
    if (!profile) throw new Error('Profile disappeared while verifying human');
    this.invalidate(id);
    return profile;
  }

  async getUsage(id: string) {
    const [submissionRows, voteRows] = await Promise.all([
      this.db.select({ category: submissions.category, total: count() }).from(submissions)
        .where(and(eq(submissions.authorId, id), eq(submissions.status, 'published'))).groupBy(submissions.category),
      this.db.select({ category: votes.category, total: count() }).from(votes)
        .where(eq(votes.voterId, id)).groupBy(votes.category),
    ]);
    const submissionsByCategory = { photo: 0, sticker: 0 };
    const votesByCategory = { photo: 0, sticker: 0 };
    for (const row of submissionRows) submissionsByCategory[row.category] = row.total;
    for (const row of voteRows) votesByCategory[row.category] = row.total;
    return { submissions: submissionsByCategory, votes: votesByCategory };
  }

  async updateDisplayName(id: string, displayName: string) {
    const [profile] = await this.db.update(profiles).set({ displayName }).where(eq(profiles.id, id)).returning();
    if (!profile) throw new Error('Profile disappeared while updating its name');
    this.invalidate(id);
    return profile;
  }

  private async upsert(input: { id: string; email: string; displayName: string; avatarUrl: string | null; promoteAdmin: boolean }) {
    const [profile] = await this.db.insert(profiles).values({
      id: input.id,
      email: input.email,
      displayName: input.displayName,
      avatarUrl: input.avatarUrl,
      ...(input.promoteAdmin ? { role: 'admin' as const } : {}),
      lastSeenAt: new Date(),
    }).onConflictDoUpdate({
      target: profiles.id,
      set: {
        email: input.email,
        avatarUrl: input.avatarUrl,
        lastSeenAt: new Date(),
        ...(input.promoteAdmin ? { role: 'admin' as const } : {}),
      },
    }).returning();
    return {
      id: profile.id,
      email: profile.email,
      role: profile.role,
      isBlocked: profile.isBlocked,
      humanVerifiedAt: profile.humanVerifiedAt,
      displayName: profile.displayName,
      avatarUrl: profile.avatarUrl,
    };
  }

  private metadataText(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
    const value = metadata?.[key];
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  }
}
