import { z } from 'zod';

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  WEB_URL: z.url(),
  STORAGE_PUBLIC_BASE_URL: z.url(),
  DATABASE_URL: z.url(),
  SUPABASE_URL: z.url(),
  SUPABASE_SECRET_KEY: z.string().min(1),
  SUPABASE_STORAGE_BUCKET: z.string().min(1).default('candidates'),
  ADMIN_EMAILS: z.string().default(''),
  TURNSTILE_SECRET: z.string().min(1),
  WA_VERIFY_TOKEN: z.string().min(1),
  WA_APP_SECRET: z.string().min(1),
  WA_ACCESS_TOKEN: z.string().min(1),
  WA_PHONE_NUMBER_ID: z.string().min(1),
  WA_GRAPH_VERSION: z.string().default('v25.0'),
  WA_HASH_PEPPER: z.string().min(1),
  WA_TOKEN_ENCRYPTION_KEY: z.string().refine(
    (value) => Buffer.from(value, 'base64url').length === 32,
    'must be a base64url-encoded 32-byte key',
  ),
  WA_BOT_LINK: z.url().optional(),
  WA_MAX_INTAKES_PER_DAY: z.coerce.number().int().positive().default(10),
  INTAKE_TTL_HOURS: z.coerce.number().int().positive().default(72),
  MAX_IMAGE_BYTES: z.coerce.number().int().positive().default(10_485_760),
  MAX_STICKER_BYTES: z.coerce.number().int().positive().default(10_485_760),
  MAX_IMAGES_PER_PHOTO: z.coerce.number().int().min(1).max(10).default(10),
  MEDIA_STICKER_BG: z.string().regex(/^#[\da-fA-F]{6}$/).default('#FFFFFF'),
  TRUST_PROXY: z.stringbool().default(false),
});

export type Environment = z.infer<typeof environmentSchema>;

export function parseEnvironment(source: NodeJS.ProcessEnv = process.env): Environment {
  return environmentSchema.parse(source);
}
