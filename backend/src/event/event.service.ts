import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { and, eq, lt, sql } from 'drizzle-orm';
import { Interval } from '@nestjs/schedule';
import { DB, type Database } from '../db/db.module.js';
import { eventSettings } from '../db/schema.js';

@Injectable()
export class EventService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async getEvent() {
    const [row] = await this.db.select().from(eventSettings).where(eq(eventSettings.id, 1)).limit(1);
    if (!row) throw new Error('event_settings singleton row is missing');
    const [{ serverTime }] = await this.db.select({ serverTime: sql<Date>`clock_timestamp()`.mapWith({ mapFromDriverValue: (value) => new Date(value as string | number) }) })
      .from(eventSettings).where(eq(eventSettings.id, 1));
    const effectiveOpen = row.status === 'open' && (!row.closesAt || row.closesAt > serverTime);
    return {
      status: row.status,
      effective_status: effectiveOpen ? 'open' : row.status === 'open' ? 'closed' : row.status,
      closes_at: row.closesAt?.toISOString() ?? null,
      server_time: serverTime.toISOString(),
      limits: {
        max_votes_per_category: row.maxVotesPerCategory,
        max_photo_submissions: row.maxPhotoSubmissions,
        max_sticker_submissions: row.maxStickerSubmissions,
        max_images_per_photo: Number(process.env.MAX_IMAGES_PER_PHOTO ?? 10),
      },
      bot_wa_link: process.env.WA_BOT_LINK ?? null,
    };
  }

  async assertOpen(tx: Pick<Database, 'select'> = this.db) {
    const [row] = await tx.select().from(eventSettings).where(eq(eventSettings.id, 1)).for('share');
    const [clock] = await tx.select({ serverTime: sql<Date>`clock_timestamp()`.mapWith({ mapFromDriverValue: (value) => new Date(value as string | number) }) })
      .from(eventSettings).where(eq(eventSettings.id, 1));
    if (!row || row.status !== 'open' || (row.closesAt !== null && row.closesAt <= clock.serverTime)) {
      throw new ConflictException({ code: 'EVENT_NOT_OPEN', message: 'Las postulaciones y votaciones están cerradas.' });
    }
    return row;
  }

  @Interval(15_000)
  async closeAfterDeadline() {
    await this.db.update(eventSettings).set({ status: 'closed', updatedAt: new Date() })
      .where(and(eq(eventSettings.status, 'open'), lt(eventSettings.closesAt, sql`now()`)));
  }
}
