import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  inet,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  pgSchema,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

export const categoryEnum = pgEnum('category', ['photo', 'sticker']);
export const userRoleEnum = pgEnum('user_role', ['participant', 'admin']);
export const eventStatusEnum = pgEnum('event_status', ['open', 'closed', 'results_published']);
export const submissionStatusEnum = pgEnum('submission_status', ['published', 'deleted']);
export const submissionSourceEnum = pgEnum('submission_source', ['web', 'whatsapp', 'admin']);
export const mediaKindEnum = pgEnum('media_kind', ['image', 'video']);
export const intakeStatusEnum = pgEnum('intake_status', [
  'processing', 'ready', 'claimed', 'expired', 'failed',
]);
const authUsers = pgSchema('auth').table('users', { id: uuid('id').primaryKey() });

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

export const profiles = pgTable('profiles', {
  id: uuid('id').primaryKey().references(() => authUsers.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  displayName: text('display_name').notNull(),
  avatarUrl: text('avatar_url'),
  role: userRoleEnum('role').notNull().default('participant'),
  isBlocked: boolean('is_blocked').notNull().default(false),
  humanVerifiedAt: timestamp('human_verified_at', { withTimezone: true }),
  createdAt: createdAt(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
}, (t) => [uniqueIndex('profiles_email_uq').on(sql`lower(${t.email})`)]).enableRLS();

export const eventSettings = pgTable('event_settings', {
  id: smallint('id').primaryKey().default(1),
  status: eventStatusEnum('status').notNull().default('open'),
  closesAt: timestamp('closes_at', { withTimezone: true }),
  resultsPublishedAt: timestamp('results_published_at', { withTimezone: true }),
  maxVotesPerCategory: smallint('max_votes_per_category').notNull().default(5),
  maxPhotoSubmissions: smallint('max_photo_submissions').notNull().default(2),
  maxStickerSubmissions: smallint('max_sticker_submissions').notNull().default(3),
  allowSelfVote: boolean('allow_self_vote').notNull().default(false),
  showAuthorInPublicResults: boolean('show_author_in_public_results').notNull().default(false),
  updatedAt: updatedAt(),
  updatedBy: uuid('updated_by').references(() => profiles.id),
}, (t) => [
  check('event_settings_id_check', sql`${t.id} = 1`),
  check('event_max_votes_check', sql`${t.maxVotesPerCategory} between 1 and 10`),
]).enableRLS();

export const whatsappIntakes = pgTable('whatsapp_intakes', {
  id: uuid('id').primaryKey().defaultRandom(),
  waMessageId: text('wa_message_id').notNull(),
  waMediaId: text('wa_media_id').notNull(),
  waId: text('wa_id'),
  waSenderHash: text('wa_sender_hash').notNull(),
  category: categoryEnum('category').notNull().default('sticker'),
  status: intakeStatusEnum('status').notNull().default('processing'),
  tokenHash: text('token_hash'),
  tokenCiphertext: text('token_ciphertext'),
  sourceMime: text('source_mime'),
  isAnimated: boolean('is_animated'),
  kind: mediaKindEnum('kind'),
  storagePath: text('storage_path'),
  thumbPath: text('thumb_path'),
  mimeType: text('mime_type'),
  width: integer('width'),
  height: integer('height'),
  durationMs: integer('duration_ms'),
  sizeBytes: integer('size_bytes'),
  attempts: smallint('attempts').notNull().default(0),
  error: text('error'),
  replySentAt: timestamp('reply_sent_at', { withTimezone: true }),
  claimedBy: uuid('claimed_by').references(() => profiles.id),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  unique('whatsapp_intakes_message_uq').on(t.waMessageId),
  unique('whatsapp_intakes_token_hash_uq').on(t.tokenHash),
  index('intakes_sender_idx').on(t.waSenderHash, t.createdAt),
  index('intakes_status_idx').on(t.status, t.updatedAt),
]).enableRLS();

export const submissions = pgTable('submissions', {
  id: uuid('id').primaryKey().defaultRandom(),
  category: categoryEnum('category').notNull(),
  title: varchar('title', { length: 120 }).notNull(),
  description: text('description').notNull(),
  authorId: uuid('author_id').references(() => profiles.id),
  authorLabel: text('author_label'),
  source: submissionSourceEnum('source').notNull(),
  intakeId: uuid('intake_id').unique().references(() => whatsappIntakes.id),
  status: submissionStatusEnum('status').notNull().default('published'),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  deletedBy: uuid('deleted_by').references(() => profiles.id),
  deleteReason: text('delete_reason'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  unique('submissions_id_category_uq').on(t.id, t.category),
  check('submissions_author_check', sql`${t.authorId} is not null or ${t.authorLabel} is not null`),
  index('submissions_list_idx').on(t.category, t.status),
  index('submissions_author_idx').on(t.authorId, t.category).where(sql`${t.status} = 'published'`),
]).enableRLS();

export const submissionMedia = pgTable('submission_media', {
  id: uuid('id').primaryKey().defaultRandom(),
  submissionId: uuid('submission_id').notNull().references(() => submissions.id, { onDelete: 'cascade' }),
  position: smallint('position').notNull(),
  kind: mediaKindEnum('kind').notNull(),
  storagePath: text('storage_path').notNull(),
  thumbPath: text('thumb_path').notNull(),
  mimeType: text('mime_type').notNull(),
  width: integer('width').notNull(),
  height: integer('height').notNull(),
  durationMs: integer('duration_ms'),
  sizeBytes: integer('size_bytes').notNull(),
  createdAt: createdAt(),
}, (t) => [
  unique('submission_media_position_uq').on(t.submissionId, t.position),
  check('submission_media_position_check', sql`${t.position} >= 1`),
]).enableRLS();

export const votes = pgTable('votes', {
  id: uuid('id').primaryKey().defaultRandom(),
  voterId: uuid('voter_id').notNull().references(() => profiles.id, { onDelete: 'cascade' }),
  category: categoryEnum('category').notNull(),
  submissionId: uuid('submission_id').notNull(),
  position: smallint('position').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  foreignKey({ columns: [t.submissionId, t.category], foreignColumns: [submissions.id, submissions.category] }).onDelete('cascade'),
  unique('votes_position_uq').on(t.voterId, t.category, t.position),
  unique('votes_candidate_uq').on(t.voterId, t.submissionId),
  check('votes_position_check', sql`${t.position} >= 1`),
  index('votes_submission_idx').on(t.submissionId),
]).enableRLS();

export const voteAudit = pgTable('vote_audit', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  voterId: uuid('voter_id').notNull().references(() => profiles.id),
  category: categoryEnum('category').notNull(),
  ballot: uuid('ballot').array().notNull(),
  ip: inet('ip'),
  userAgent: text('user_agent'),
  createdAt: createdAt(),
}, (t) => [index('vote_audit_voter_idx').on(t.voterId, t.createdAt)]).enableRLS();

export const voteAttempts = pgTable('vote_attempts', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  voterId: uuid('voter_id').notNull().references(() => profiles.id),
  ip: inet('ip'),
  createdAt: createdAt(),
}, (t) => [index('vote_attempts_user_idx').on(t.voterId, t.createdAt)]).enableRLS();

export const adminActions = pgTable('admin_actions', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  adminId: uuid('admin_id').notNull().references(() => profiles.id),
  action: text('action').notNull(),
  targetType: text('target_type'),
  targetId: text('target_id'),
  payload: jsonb('payload'),
  createdAt: createdAt(),
}, (t) => [index('admin_actions_created_idx').on(t.createdAt)]).enableRLS();

export const webhookInbox = pgTable('webhook_inbox', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  messageId: text('message_id').notNull(),
  mediaId: text('media_id'),
  mediaMimeType: text('media_mime_type'),
  mediaSha256: text('media_sha256'),
  mediaAnimated: boolean('media_animated'),
  senderHash: text('sender_hash'),
  senderCiphertext: text('sender_ciphertext'),
  messageType: text('message_type').notNull(),
  status: text('status').notNull().default('pending'),
  attempts: smallint('attempts').notNull().default(0),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
  leaseToken: text('lease_token'),
  leaseUntil: timestamp('lease_until', { withTimezone: true }),
  lastError: text('last_error'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  unique('webhook_inbox_message_uq').on(t.messageId),
  index('webhook_inbox_pending_idx').on(t.status, t.updatedAt),
]).enableRLS();
