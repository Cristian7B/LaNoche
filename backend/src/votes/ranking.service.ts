import { Inject, Injectable } from '@nestjs/common';
import { eq, inArray, sql } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module.js';
import { eventSettings, profiles, submissionMedia } from '../db/schema.js';
import { StorageService } from '../media/storage.service.js';

type Category = 'photo' | 'sticker';
export interface RankingItem {
  rank: number;
  submission: {
    id: string; category: Category; title: string; description: string; is_mine: boolean; created_at: string;
    media: { id: string; kind: 'image' | 'video'; url: string; thumb_url: string; width: number; height: number; duration_ms?: number; position: number }[];
  };
  score: number;
  first_place_votes: number;
  total_votes: number;
  by_position?: number[];
  author_name?: string | null;
}

@Injectable()
export class RankingService {
  private readonly cache = new Map<string, { expiresAt: number; items: RankingItem[] }>();
  private cacheVersion = 0;
  constructor(@Inject(DB) private readonly db: Database, private readonly storage: StorageService) {}

  async ranking(category: Category, userId?: string, includeAuthors = false, includePositionCounts = false) {
    const versionAtStart = this.cacheVersion;
    const cacheKey = `${category}:${includeAuthors}:${includePositionCounts}`;
    const cached = !userId ? this.cache.get(cacheKey) : undefined;
    if (cached && cached.expiresAt > Date.now()) return cached.items;
    const [settings] = await this.db.select().from(eventSettings).where(eq(eventSettings.id, 1));
    const max = settings.maxVotesPerCategory;
    const query = await this.db.execute(sql`
      WITH valid_votes AS (
        SELECT v.voter_id, v.submission_id,
          ROW_NUMBER() OVER (PARTITION BY v.voter_id ORDER BY v.position) AS eff_pos
        FROM votes v
        JOIN submissions s ON s.id = v.submission_id AND s.category = ${category} AND s.status = 'published'
        JOIN profiles p ON p.id = v.voter_id AND p.is_blocked = false
        WHERE v.category = ${category}
      )
      SELECT s.id, s.category, s.title, s.description, s.author_id, s.author_label, s.created_at,
        COALESCE(SUM(${max} - vv.eff_pos + 1), 0)::int AS score,
        COUNT(*) FILTER (WHERE vv.eff_pos = 1)::int AS first_place_votes,
        COUNT(vv.voter_id)::int AS total_votes,
        ARRAY[${sql.join(Array.from({ length: max }, (_, i) => sql`COUNT(*) FILTER (WHERE vv.eff_pos = ${i + 1})::int`), sql`, `)}] AS by_position
      FROM submissions s
      LEFT JOIN valid_votes vv ON vv.submission_id = s.id
      WHERE s.category = ${category} AND s.status = 'published'
      GROUP BY s.id
      ORDER BY score DESC, first_place_votes DESC, total_votes DESC, s.created_at ASC, s.id ASC
    `);
    const rankRows = query as unknown as {
      id: string; category: Category; title: string; description: string; author_id: string | null;
      author_label: string | null; created_at: Date; score: number; first_place_votes: number; total_votes: number; by_position: number[];
    }[];
    if (!rankRows.length) return [];
    const ids = rankRows.map((row) => row.id);
    const [media, authorRows] = await Promise.all([
      this.db.select().from(submissionMedia).where(inArray(submissionMedia.submissionId, ids)),
      includeAuthors ? this.db.select({ id: profiles.id, name: profiles.displayName }).from(profiles).where(inArray(profiles.id, rankRows.map((row) => row.author_id).filter((id): id is string => id !== null))) : Promise.resolve([]),
    ]);
    const mediaBySubmission = new Map<string, typeof media>();
    for (const item of media) mediaBySubmission.set(item.submissionId, [...(mediaBySubmission.get(item.submissionId) ?? []), item]);
    const authors = new Map(authorRows.map((row) => [row.id, row.name]));
    const items: RankingItem[] = rankRows.map((row, index) => ({
      rank: index + 1,
      submission: {
        id: row.id,
        category: row.category,
        title: row.title,
        description: row.description,
        is_mine: Boolean(userId && row.author_id === userId),
        created_at: new Date(row.created_at).toISOString(),
        media: (mediaBySubmission.get(row.id) ?? []).sort((a, b) => a.position - b.position).map((item) => ({
          id: item.id, kind: item.kind, url: this.storage.publicUrl(item.storagePath),
          thumb_url: this.storage.publicUrl(item.thumbPath), width: item.width, height: item.height,
          ...(item.durationMs === null ? {} : { duration_ms: item.durationMs }), position: item.position,
        })),
      },
      score: Number(row.score),
      first_place_votes: Number(row.first_place_votes),
      total_votes: Number(row.total_votes),
      ...(includePositionCounts ? { by_position: row.by_position.map(Number) } : {}),
      ...(includeAuthors ? { author_name: row.author_label ?? (row.author_id ? authors.get(row.author_id) : undefined) ?? null } : {}),
    }));
    if (!userId && versionAtStart === this.cacheVersion) this.cache.set(cacheKey, { items, expiresAt: Date.now() + 3_000 });
    return items;
  }

  invalidate(category?: Category) {
    this.cacheVersion++;
    if (!category) this.cache.clear();
    else for (const key of this.cache.keys()) if (key.startsWith(`${category}:`)) this.cache.delete(key);
  }
}
