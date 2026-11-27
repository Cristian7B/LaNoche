import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, rm, rmdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { setTimeout as wait } from 'node:timers/promises';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { PARAMS_PROVIDER_TOKEN } from 'nestjs-pino';
import postgres from 'postgres';
import sharp from 'sharp';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/configure-app.js';
import { parseEnvironment } from '../src/config/env.js';
import { StorageService } from '../src/media/storage.service.js';
import { RankingService } from '../src/votes/ranking.service.js';
import { WhatsappService } from '../src/whatsapp/whatsapp.service.js';

const adminEmail = 'admin@example.test';
const databaseName = `gala_e2e_${randomUUID().replaceAll('-', '')}`;
const connection = new URL(
  process.env.TEST_DATABASE_URL ??
    'postgresql://gala:gala_dev_only@127.0.0.1:55432/gala',
);

if (!['127.0.0.1', 'localhost', '[::1]'].includes(connection.hostname)) {
  throw new Error(
    'TEST_DATABASE_URL must point to a disposable local PostgreSQL server.',
  );
}

const adminDb = postgres(connection.toString(), { max: 1 });
connection.pathname = `/${databaseName}`;
const db = postgres(connection.toString(), { max: 10 });
const objects = new Map<string, Buffer>();
const storage = {
  upload: async (path: string, bytes: Buffer) => {
    objects.set(path, bytes);
  },
  remove: async (paths: string[]) => {
    for (const path of paths) objects.delete(path);
  },
  publicUrl: (path: string) => `https://media.example.test/${path}`,
};
let app: NestExpressApplication | undefined;
let jwks: ReturnType<typeof createServer> | undefined;
let privateKey: CryptoKey;
let issuer: string;
let png: Buffer;
let webp: Buffer;
let createdDatabase = false;
let adminIdentity: ReturnType<typeof participant> | undefined;
const graphReplies = new Map<string, string[]>();
const graphAddressFields = new Map<string, { to?: string; recipient?: string }>();
const graphTimeouts = new Map<string, number>();
const metaMediaUrl = 'https://lookaside.fbsbx.com/fixture-sticker';
const hasVideoTools = ['ffmpeg', 'ffprobe'].every(
  (tool) => spawnSync(tool, ['-version'], { stdio: 'ignore' }).status === 0,
);

beforeAll(async () => {
  await adminDb`create database ${adminDb(databaseName)}`;
  createdDatabase = true;
  await db`create schema auth`;
  await db`create table auth.users (id uuid primary key)`;
  await migrate(drizzle(db), { migrationsFolder: 'src/db/migrations' });

  const keys = await generateKeyPair('ES256');
  privateKey = keys.privateKey;
  const jwk = {
    ...(await exportJWK(keys.publicKey)),
    alg: 'ES256',
    kid: 'gala-test',
    use: 'sig',
  };
  jwks = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((resolve) => jwks!.listen(0, '127.0.0.1', resolve));
  const authOrigin = `http://127.0.0.1:${(jwks.address() as AddressInfo).port}`;
  issuer = `${authOrigin}/auth/v1`;
  const fixtures = {
    NODE_ENV: 'test',
    DATABASE_URL: connection.toString(),
    WEB_URL: 'https://gala.example.test',
    STORAGE_PUBLIC_BASE_URL: 'https://media.example.test',
    SUPABASE_URL: authOrigin,
    SUPABASE_SECRET_KEY: 'storage-test-key',
    ADMIN_EMAILS: adminEmail,
    TURNSTILE_SECRET: 'turnstile-test-key',
    WA_VERIFY_TOKEN: 'webhook-test-key',
    WA_APP_SECRET: 'app-test-key',
    WA_ACCESS_TOKEN: 'access-test-key',
    WA_PHONE_NUMBER_ID: '12345',
    WA_HASH_PEPPER: 'test-pepper',
    WA_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64url'),
  };
  for (const [name, value] of Object.entries(fixtures)) vi.stubEnv(name, value);
  const fetch = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    async (input: RequestInfo | URL, options?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url.startsWith('https://challenges.cloudflare.com/turnstile/')) {
        return Response.json({ success: true });
      }
      if (url.startsWith('https://graph.facebook.com/')) {
        if (!url.endsWith('/messages'))
          return Response.json({
            url: metaMediaUrl,
            mime_type: 'image/webp',
            file_size: webp.length,
          });
        if (typeof options?.body !== 'string')
          throw new Error('Expected a Graph JSON payload.');
        const body = JSON.parse(options.body) as {
          to?: string;
          recipient?: string;
          text: { body: string };
        };
        const target = body.to ?? body.recipient;
        if (!target) throw new Error('Expected a WhatsApp recipient.');
        graphAddressFields.set(target, { to: body.to, recipient: body.recipient });
        const replies = graphReplies.get(target) ?? [];
        replies.push(body.text.body);
        graphReplies.set(target, replies);
        const timeouts = graphTimeouts.get(target) ?? 0;
        if (timeouts > 0) {
          graphTimeouts.set(target, timeouts - 1);
          throw new DOMException(
            'Simulated lost acknowledgement',
            'TimeoutError',
          );
        }
        return Response.json({ messages: [{ id: 'mock-reply-id' }] });
      }
      if (url === metaMediaUrl) {
        return new Response(new Uint8Array(webp), {
          headers: {
            'Content-Type': 'image/webp',
            'Content-Length': String(webp.length),
          },
        });
      }
      return fetch(input, options);
    },
  );
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(StorageService)
    .useValue(storage)
    .overrideProvider(PARAMS_PROVIDER_TOKEN)
    .useValue({
      pinoHttp: [
        { redact: ['req', 'res'] },
        new Writable({ write: (_chunk, _encoding, done) => done() }),
      ],
    })
    .compile();
  app = module.createNestApplication<NestExpressApplication>({
    rawBody: true,
    logger: false,
  });
  configureApp(app, parseEnvironment());
  await app.init();
  png = await sharp({
    create: { width: 24, height: 24, channels: 4, background: '#aabbcc' },
  })
    .png()
    .toBuffer();
  webp = await sharp(png).webp().toBuffer();
}, 30000);

afterAll(async () => {
  await app?.close();
  if (jwks) await new Promise<void>((resolve) => jwks!.close(() => resolve()));
  await db.end({ timeout: 2 });
  if (createdDatabase) await adminDb`drop database ${adminDb(databaseName)}`;
  await adminDb.end({ timeout: 2 });
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const api = () => request(app!.getHttpServer());
const participant = async (email?: string, verified = true) => {
  const id = randomUUID();
  const address = email ?? `${id}@example.test`;
  await db`insert into auth.users (id) values (${id})`;
  if (verified) {
    await db`insert into profiles (id, email, display_name, human_verified_at) values (${id}, ${address}, 'Perfil de prueba', now())`;
  }
  const jwt = await new SignJWT({
    email: address,
    user_metadata: { name: 'Perfil de prueba' },
  })
    .setProtectedHeader({ alg: 'ES256', kid: 'gala-test' })
    .setSubject(id)
    .setIssuer(issuer)
    .setAudience('authenticated')
    .setExpirationTime('10m')
    .sign(privateKey);
  return { id, jwt, bearer: `Bearer ${jwt}` };
};
const administrator = () => (adminIdentity ??= participant(adminEmail, false));

const createSubmission = (bearer: string, bytes = png) =>
  api()
    .post('/api/v1/submissions')
    .set('Authorization', bearer)
    .field('category', 'photo')
    .field('title', 'Foto de prueba')
    .field('description', 'Descripción de prueba para una postulación')
    .attach('files', bytes, 'sample.png');
const listPhotos = (bearer: string) =>
  api().get('/api/v1/submissions?category=photo').set('Authorization', bearer);
const putVotes = (bearer: string, ids: string[]) =>
  api()
    .put('/api/v1/votes/photo')
    .set('Authorization', bearer)
    .send({ submission_ids: ids });
const candidate = async (category: 'photo' | 'sticker' = 'photo') => {
  const [row] = await db<
    { id: string }[]
  >`insert into submissions (category, title, description, author_label, source)
    values (${category}, 'Candidato', 'Descripción de prueba para el ranking', 'Autor de prueba', 'admin') returning id`;
  return row.id;
};

describe('Identidad y postulaciones', () => {
  test('AC-01 crea un perfil de participante sin verificación', async () => {
    const user = await participant(undefined, false);
    const response = await api()
      .get('/api/v1/me')
      .set('Authorization', user.bearer)
      .expect(200);
    expect(response.body).toMatchObject({
      id: user.id,
      role: 'participant',
      human_verified: false,
    });
    expect(await db`select role from profiles where id = ${user.id}`).toEqual([
      { role: 'participant' },
    ]);
  });

  test('AC-02 crea un perfil de administrador desde ADMIN_EMAILS', async () => {
    const admin = await administrator();
    const response = await api()
      .get('/api/v1/me')
      .set('Authorization', admin.bearer)
      .expect(200);
    expect(response.body.role).toBe('admin');
  });

  test('AC-03 exige verificación humana para postular y votar', async () => {
    const { bearer } = await participant(undefined, false);
    const errors = await Promise.all([
      createSubmission(bearer),
      putVotes(bearer, []),
    ]);
    for (const error of errors) {
      expect(error.status).toBe(403);
      expect(error.body.error.code).toBe('HUMAN_VERIFICATION_REQUIRED');
    }
    await api()
      .post('/api/v1/me/verify-human')
      .set('Authorization', bearer)
      .send({ turnstile_token: 'verified-test' })
      .expect(204);
    await createSubmission(bearer).expect(201);
  });

  test('AC-04 libera el cupo de una foto retirada', async () => {
    const { bearer } = await participant();
    const first = await createSubmission(bearer).expect(201);
    await createSubmission(bearer).expect(201);
    const quota = await createSubmission(bearer).expect(409);
    expect(quota.body.error.code).toBe('QUOTA_EXCEEDED');
    await api()
      .delete(`/api/v1/submissions/${first.body.id}`)
      .set('Authorization', bearer)
      .expect(204);
    await createSubmission(bearer).expect(201);
  });

  test('AC-05 rechaza contenido inválido con nombre de imagen', async () => {
    const { bearer } = await participant();
    const response = await createSubmission(
      bearer,
      Buffer.from('Fixture sin firma de imagen'),
    ).expect(422);
    expect(response.body.error.code).toBe('MEDIA_INVALID');
  });

  test.skipIf(!hasVideoTools)(
    'AC-06 convierte un WebP sintético animado a MP4 H.264 sin audio',
    async () => {
      const { bearer } = await participant();
      const frames = Buffer.concat([
        Buffer.alloc(16 * 16 * 4, 0xee),
        Buffer.alloc(16 * 16 * 4, 0x11),
      ]);
      const animated = await sharp(frames, {
        raw: { width: 16, height: 32, channels: 4, pageHeight: 16 },
      })
        .webp({ delay: [100, 200], loop: 0 })
        .toBuffer();
      expect((await sharp(animated).metadata()).pages).toBe(2);
      const result = await api()
        .post('/api/v1/submissions')
        .set('Authorization', bearer)
        .field('category', 'sticker')
        .field('title', 'Sticker animado')
        .field('description', 'Conversión de un sticker sintético')
        .attach('files', animated, 'animated.webp')
        .expect(201);
      const recorded = result.body.media[0] as { kind: string; url: string };
      expect(recorded.kind).toBe('video');
      const bytes = objects.get(new URL(recorded.url).pathname.slice(1));
      expect(bytes).toBeDefined();
      expect(bytes!.length).toBeLessThan(1_000_000);
      const folder = await mkdtemp(join(tmpdir(), 'gala-video-test-'));
      const video = join(folder, 'sticker.mp4');
      try {
        await writeFile(video, bytes!);
        const probe = JSON.parse(
          execFileSync(
            'ffprobe',
            [
              '-v',
              'error',
              '-show_streams',
              '-show_format',
              '-of',
              'json',
              video,
            ],
            { encoding: 'utf8' },
          ),
        ) as {
          streams: {
            codec_name: string;
            codec_type: string;
            width: number;
            height: number;
          }[];
          format: { format_name: string };
        };
        expect(probe.format.format_name.split(',')).toContain('mp4');
        expect(probe.streams).toHaveLength(1);
        expect(probe.streams[0]).toMatchObject({
          codec_name: 'h264',
          codec_type: 'video',
        });
        expect(
          Math.max(probe.streams[0].width, probe.streams[0].height),
        ).toBeLessThanOrEqual(512);
      } finally {
        await rm(video, { force: true });
        await rmdir(folder);
      }
    },
    40000,
  );

  test.skipIf(!hasVideoTools)(
    'normaliza un sticker MP4 de duración finita',
    async () => {
      const { bearer } = await participant();
      const folder = await mkdtemp(join(tmpdir(), 'gala-video-input-'));
      const input = join(folder, 'input.mp4');
      try {
        execFileSync('ffmpeg', [
          '-v',
          'error',
          '-f',
          'lavfi',
          '-i',
          'color=c=blue:s=32x32:d=0.2',
          '-an',
          '-c:v',
          'libx264',
          '-pix_fmt',
          'yuv420p',
          input,
        ]);
        const result = await api()
          .post('/api/v1/submissions')
          .set('Authorization', bearer)
          .field('category', 'sticker')
          .field('title', 'Sticker MP4')
          .field('description', 'Conversión de un clip sintético')
          .attach('files', input)
          .expect(201);
        expect(result.body.media[0]).toMatchObject({
          kind: 'video',
          width: 512,
          height: 512,
        });
        expect(result.body.media[0].duration_ms).toBeGreaterThan(0);
        expect(result.body.media[0].duration_ms).toBeLessThanOrEqual(1000);
      } finally {
        await rm(input, { force: true });
        await rmdir(folder);
      }
    },
    40000,
  );

  test('AC-07 lista sin datos de autor y marca solo los medios propios', async () => {
    const owner = await participant();
    const viewer = await participant();
    const own = await createSubmission(owner.bearer).expect(201);
    const a = await listPhotos(owner.bearer).expect(200);
    const b = await listPhotos(viewer.bearer).expect(200);
    expect(
      a.body
        .filter((row: { is_mine: boolean }) => row.is_mine)
        .map((row: { id: string }) => row.id),
    ).toEqual([own.body.id]);
    expect(b.body.some((row: { is_mine: boolean }) => row.is_mine)).toBe(false);
    for (const row of b.body)
      expect(Object.keys(row).sort()).toEqual([
        'category',
        'created_at',
        'description',
        'id',
        'is_mine',
        'media',
        'title',
      ]);
  });

  test('AC-08 la lista mantiene su orden por usuario', async () => {
    const candidates = await Promise.all(
      Array.from({ length: 8 }, () => candidate()),
    );
    const people = await Promise.all([participant(), participant()]);
    const ids = (res: { body: { id: string }[] }) =>
      res.body.map((item) => item.id).filter((id) => candidates.includes(id));
    const first = await listPhotos(people[0].bearer).expect(200);
    const same = await listPhotos(people[0].bearer).expect(200);
    const other = await listPhotos(people[1].bearer).expect(200);
    expect(ids(same)).toEqual(ids(first));
    expect(ids(other)).not.toEqual(ids(first));
  });

  test('persiste el nombre editado y devuelve el uso y las postulaciones propias', async () => {
    const { bearer } = await participant();
    const own = await createSubmission(bearer).expect(201);
    await api()
      .patch('/api/v1/me')
      .set('Authorization', bearer)
      .send({ display_name: 'Nombre editado' })
      .expect(200);
    const me = await api()
      .get('/api/v1/me')
      .set('Authorization', bearer)
      .expect(200);
    expect(me.body).toMatchObject({
      display_name: 'Nombre editado',
      usage: { submissions: { photo: 1, sticker: 0 } },
    });
    const mine = await api()
      .get('/api/v1/me/submissions')
      .set('Authorization', bearer)
      .expect(200);
    expect(mine.body).toEqual([
      expect.objectContaining({
        id: own.body.id,
        is_mine: true,
        source: 'web',
      }),
    ]);
  });
});

describe('Moderación, publicación y auditoría', () => {
  const adminPost = (bearer: string, path: string) =>
    api().post(`/api/v1/admin/${path}`).set('Authorization', bearer);
  const resetEvent = () => db`update event_settings
    set status = 'open', closes_at = null, results_published_at = null, show_author_in_public_results = false where id = 1`;

  test('AC-17 no confirma votos nuevos después de que el cierre responde', async () => {
    const people = await Promise.all(
      Array.from({ length: 50 }, () => participant()),
    );
    const target = await candidate();
    const admin = await administrator();
    await api()
      .get('/api/v1/me')
      .set('Authorization', admin.bearer)
      .expect(200);
    const ballotCount = async () =>
      (
        await db<
          { total: number }[]
        >`select count(*)::int as total from vote_audit where ballot @> array[${target}]::uuid[]`
      )[0].total;
    let notifyLocked!: () => void;
    let releaseLock!: () => void;
    const lockHeld = new Promise<void>((resolve) => {
      notifyLocked = resolve;
    });
    const unlock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const barrier = db.begin(async (tx) => {
      await tx`select id from event_settings where id = 1 for share`;
      notifyLocked();
      await unlock;
    });
    await lockHeld;
    try {
      const wantsClose = adminPost(admin.bearer, 'event/close').then(
        (response) => response,
      );
      await vi.waitFor(async () => {
        const [waiting] = await db<
          { total: number }[]
        >`select count(*)::int as total from pg_stat_activity
          where datname = ${databaseName} and wait_event_type = 'Lock' and query like '%event_settings%'`;
        expect(waiting.total).toBeGreaterThan(0);
      }, 4000);
      const pending = Promise.all(
        people.map(({ bearer }) => putVotes(bearer, [target])),
      );
      releaseLock();
      expect((await wantsClose).status).toBe(200);
      const committedAtClose = await ballotCount();
      const responses = await pending;
      expect(responses.every((r) => [200, 409].includes(r.status))).toBe(true);
      expect(
        responses.some((r) => r.body.error?.code === 'EVENT_NOT_OPEN'),
      ).toBe(true);
      expect(await ballotCount()).toBe(committedAtClose);
      const after = await putVotes(people[0].bearer, [target]).expect(409);
      expect(after.body.error.code).toBe('EVENT_NOT_OPEN');
    } finally {
      releaseLock();
      await barrier;
      await resetEvent();
    }
  }, 15000);

  test('AC-18 y AC-27 publican resultados anónimos con autenticación opcional', async () => {
    const admin = await administrator();
    const owner = await participant();
    const mine = await createSubmission(owner.bearer).expect(201);
    const voter = await participant();
    await putVotes(voter.bearer, [mine.body.id]).expect(200);
    const hidden = await api().get('/api/v1/results').expect(403);
    expect(hidden.body.error.code).toBe('RESULTS_NOT_PUBLISHED');
    const onsite = await api()
      .get('/api/v1/admin/results/onsite')
      .set('Authorization', admin.bearer)
      .expect(409);
    expect(onsite.body.error.code).toBe('EVENT_STILL_OPEN');
    await api()
      .get('/api/v1/admin/ranking?category=photo')
      .set('Authorization', admin.bearer)
      .expect(200);
    try {
      await adminPost(admin.bearer, 'event/close').expect(200);
      const closed = await api()
        .get('/api/v1/admin/results/onsite')
        .set('Authorization', admin.bearer)
        .expect(200);
      expect(
        closed.body.photo.every((item: object) =>
          Object.hasOwn(item, 'author_name'),
        ),
      ).toBe(true);
      await adminPost(admin.bearer, 'event/publish-results').expect(200);
      const anonymous = await api().get('/api/v1/results').expect(200);
      expect(
        anonymous.body.photo.every(
          (item: { submission: { is_mine: boolean } }) =>
            !item.submission.is_mine && !Object.hasOwn(item, 'author_name'),
        ),
      ).toBe(true);
      const authenticated = await api()
        .get('/api/v1/results')
        .set('Authorization', owner.bearer)
        .expect(200);
      const result = authenticated.body.photo.find(
        (item: { submission: { id: string } }) =>
          item.submission.id === mine.body.id,
      );
      expect(result?.submission.is_mine).toBe(true);
      await api()
        .get('/api/v1/results')
        .set('Authorization', 'Bearer token-invalido')
        .expect(401);
      await api()
        .patch('/api/v1/admin/settings')
        .set('Authorization', admin.bearer)
        .send({ show_author_in_public_results: true })
        .expect(200);
      const named = await api().get('/api/v1/results').expect(200);
      expect(
        named.body.photo.every((item: object) =>
          Object.hasOwn(item, 'author_name'),
        ),
      ).toBe(true);
    } finally {
      await resetEvent();
    }
  });

  test('AC-24 un bloqueo se aplica al instante y excluye los votos', async () => {
    const admin = await administrator();
    const voter = await participant();
    const target = await candidate();
    await putVotes(voter.bearer, [target]).expect(200);
    const score = async () =>
      (await app!.get(RankingService).ranking('photo')).find(
        (item) => item.submission.id === target,
      )?.score;
    expect(await score()).toBe(5);
    await api()
      .patch(`/api/v1/admin/users/${voter.id}`)
      .set('Authorization', admin.bearer)
      .send({ is_blocked: true })
      .expect(200);
    expect(await score()).toBe(0);
    const blocked = await api()
      .get('/api/v1/votes/me')
      .set('Authorization', voter.bearer)
      .expect(403);
    expect(blocked.body.error.code).toBe('ACCOUNT_BLOCKED');
    await api()
      .get('/api/v1/me')
      .set('Authorization', voter.bearer)
      .expect(200);
    await api()
      .get('/api/v1/event')
      .set('Authorization', voter.bearer)
      .expect(200);
    await api()
      .patch(`/api/v1/admin/users/${voter.id}`)
      .set('Authorization', admin.bearer)
      .send({ is_blocked: false })
      .expect(200);
    expect(await score()).toBe(5);
  });

  test('AC-25 cada mutación administrativa queda registrada', async () => {
    const admin = await administrator();
    const target = await candidate();
    const voter = await participant();
    const auditCount = async () =>
      (
        await db<
          { total: number }[]
        >`select count(*)::int as total from admin_actions where admin_id = ${admin.id}`
      )[0].total;
    let total = await auditCount();
    try {
      await adminPost(admin.bearer, 'event/close').expect(200);
      expect(await auditCount()).toBe(++total);
      await api()
        .delete(`/api/v1/admin/submissions/${target}`)
        .set('Authorization', admin.bearer)
        .send({ reason: 'Moderación de prueba' })
        .expect(204);
      expect(await auditCount()).toBe(++total);
      await api()
        .patch(`/api/v1/admin/users/${voter.id}`)
        .set('Authorization', admin.bearer)
        .send({ is_blocked: true })
        .expect(200);
      expect(await auditCount()).toBe(++total);
      await api()
        .patch('/api/v1/admin/settings')
        .set('Authorization', admin.bearer)
        .send({ show_author_in_public_results: true })
        .expect(200);
      expect(await auditCount()).toBe(++total);
    } finally {
      await resetEvent();
    }
  });

  test('AC-26 una papeleta no vacía histórica congela el máximo', async () => {
    const admin = await administrator();
    const { bearer } = await participant();
    await putVotes(bearer, [await candidate()]).expect(200);
    await putVotes(bearer, []).expect(200);
    const result = await api()
      .patch('/api/v1/admin/settings')
      .set('Authorization', admin.bearer)
      .send({ max_votes_per_category: 4 })
      .expect(422);
    expect(result.body.error).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { reason: 'votes_exist' },
    });
  });

  test('AC-29 comprueba cupos al restaurar postulaciones de participantes', async () => {
    const admin = await administrator();
    const owner = await participant();
    const a = await createSubmission(owner.bearer).expect(201);
    await createSubmission(owner.bearer).expect(201);
    await api()
      .delete(`/api/v1/admin/submissions/${a.body.id}`)
      .set('Authorization', admin.bearer)
      .expect(204);
    await createSubmission(owner.bearer).expect(201);
    const rejected = await adminPost(
      admin.bearer,
      `submissions/${a.body.id}/restore`,
    ).expect(409);
    expect(rejected.body.error.code).toBe('QUOTA_EXCEEDED');
    const manual = await adminPost(admin.bearer, 'submissions')
      .field('category', 'photo')
      .field('title', 'Carga manual')
      .field('description', 'Descripción de una carga manual')
      .field('author_label', 'Autor manual')
      .field('author_id', owner.id)
      .attach('files', png, 'manual.png')
      .expect(201);
    await api()
      .delete(`/api/v1/admin/submissions/${manual.body.id}`)
      .set('Authorization', admin.bearer)
      .expect(204);
    await adminPost(
      admin.bearer,
      `submissions/${manual.body.id}/restore`,
    ).expect(200);
  });

  test('AC-31 la señal cuenta también intentos rechazados por el límite', async () => {
    const admin = await administrator();
    const voter = await participant();
    for (let i = 0; i < 31; i++) {
      const response = await putVotes(voter.bearer, []).expect(
        i < 20 ? 200 : 429,
      );
      if (i >= 20) expect(response.body.error.code).toBe('RATE_LIMITED');
    }
    const [attempts] = await db<
      { total: number }[]
    >`select count(*)::int as total from vote_attempts where voter_id = ${voter.id}`;
    expect(attempts.total).toBe(31);
    const response = await api()
      .get('/api/v1/admin/audit/signals')
      .set('Authorization', admin.bearer)
      .expect(200);
    expect(JSON.stringify(response.body)).toContain(voter.id);
  }, 15000);
});

describe('Papeletas y estado efectivo', () => {
  test('AC-16 comprueba la hora después de esperar el bloqueo del evento', async () => {
    const { bearer } = await participant();
    const target = await candidate();
    let notifyLocked!: () => void;
    let releaseLock!: () => void;
    const lockHeld = new Promise<void>((resolve) => { notifyLocked = resolve; });
    const unlock = new Promise<void>((resolve) => { releaseLock = resolve; });
    await db`update event_settings set closes_at = clock_timestamp() + interval '3 seconds' where id = 1`;
    const barrier = db.begin(async (tx) => {
      await tx`select id from event_settings where id = 1 for update`;
      notifyLocked();
      await unlock;
    });
    await lockHeld;
    const pending = putVotes(bearer, [target]).then((response) => response);
    try {
      await vi.waitFor(async () => {
        const [waiting] = await db<{ total: number }[]>`select count(*)::int as total from pg_stat_activity
          where datname = ${databaseName} and wait_event_type = 'Lock' and query ilike '%for share%'`;
        expect(waiting.total).toBeGreaterThan(0);
      }, 4000);
      await db`select pg_sleep(greatest(0, extract(epoch from closes_at - clock_timestamp()) + 0.05)::float)
        from event_settings where id = 1`;
      releaseLock();
      const response = await pending;
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('EVENT_NOT_OPEN');
    } finally {
      releaseLock();
      await barrier;
      await pending.catch(() => undefined);
      await db`update event_settings set status = 'open', closes_at = null where id = 1`;
    }
  }, 12000);

  test('AC-09 rechaza papeletas largas, duplicadas o de otra categoría', async () => {
    const { bearer } = await participant();
    const a = await candidate();
    const sticker = await candidate('sticker');
    for (const ballot of [
      Array.from({ length: 6 }, () => randomUUID()),
      [a, a],
      [sticker],
    ]) {
      const response = await putVotes(bearer, ballot).expect(422);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    }
  });

  test('AC-10 y AC-13 puntúa por orden y recompone el ranking al retirar/restaurar', async () => {
    const { bearer } = await participant();
    const admin = await administrator();
    const ids = await Promise.all([candidate(), candidate(), candidate()]);
    await putVotes(bearer, ids).expect(200);
    const score = async () => {
      const ranking = await app!.get(RankingService).ranking('photo');
      return ids.map(
        (id) => ranking.find((item) => item.submission.id === id)?.score,
      );
    };
    expect(await score()).toEqual([5, 4, 3]);
    await api()
      .delete(`/api/v1/admin/submissions/${ids[0]}`)
      .set('Authorization', admin.bearer)
      .expect(204);
    expect(await score()).toEqual([undefined, 5, 4]);
    await api()
      .post(`/api/v1/admin/submissions/${ids[0]}/restore`)
      .set('Authorization', admin.bearer)
      .expect(200);
    expect(await score()).toEqual([5, 4, 3]);
  });

  test('AC-11 reemplaza la papeleta y registra el historial incluido el vaciado', async () => {
    const { id, bearer } = await participant();
    const [a, b] = await Promise.all([candidate(), candidate()]);
    await putVotes(bearer, [a, b]).expect(200);
    const replaced = await putVotes(bearer, [b]).expect(200);
    expect(replaced.body.items).toHaveLength(1);
    expect(replaced.body.items[0].submission.id).toBe(b);
    const cleared = await putVotes(bearer, []).expect(200);
    expect(cleared.body.items).toEqual([]);
    expect(
      await db`select ballot from vote_audit where voter_id = ${id} order by id`,
    ).toEqual([{ ballot: [a, b] }, { ballot: [b] }, { ballot: [] }]);
  });

  test('AC-12 rechaza el voto propio', async () => {
    const { bearer } = await participant();
    const own = await createSubmission(bearer).expect(201);
    const response = await putVotes(bearer, [own.body.id]).expect(422);
    expect(response.body.error.code).toBe('SELF_VOTE_NOT_ALLOWED');
  });

  test('AC-14 desempata por primeros puestos antes de votos totales', async () => {
    const ids = await Promise.all(Array.from({ length: 6 }, () => candidate()));
    const [a, b, c, d, e, f] = ids;
    const people = await Promise.all([
      participant(),
      participant(),
      participant(),
    ]);
    await putVotes(people[0].bearer, [a, c]).expect(200);
    await putVotes(people[1].bearer, [d, e, b]).expect(200);
    await putVotes(people[2].bearer, [f, e, d, b]).expect(200);
    const ordered = (await app!.get(RankingService).ranking('photo')).filter(
      (row) => [a, b].includes(row.submission.id),
    );
    expect(
      ordered.map((row) => [
        row.submission.id,
        row.score,
        row.first_place_votes,
      ]),
    ).toEqual([
      [a, 5, 1],
      [b, 5, 0],
    ]);
  });

  test('AC-15 y AC-16 rechazan escrituras con cierre manual o efectivo', async () => {
    const { bearer } = await participant();
    const own = await createSubmission(bearer).expect(201);
    const a = await candidate();
    await db`update event_settings set status = 'closed' where id = 1`;
    try {
      for (const r of await Promise.all([
        createSubmission(bearer),
        putVotes(bearer, [a]),
        api()
          .patch(`/api/v1/submissions/${own.body.id}`)
          .set('Authorization', bearer)
          .send({ title: 'Otro título' }),
        api()
          .delete(`/api/v1/submissions/${own.body.id}`)
          .set('Authorization', bearer),
      ])) {
        expect(r.status).toBe(409);
        expect(r.body.error.code).toBe('EVENT_NOT_OPEN');
      }
      await db`update event_settings set status = 'open', closes_at = clock_timestamp() - interval '1 second' where id = 1`;
      const event = await api().get('/api/v1/event').expect(200);
      expect(event.body.effective_status).toBe('closed');
      const vote = await putVotes(bearer, [a]).expect(409);
      expect(vote.body.error.code).toBe('EVENT_NOT_OPEN');
    } finally {
      await db`update event_settings set status = 'open', closes_at = null where id = 1`;
    }
  });
});

describe('Recepción de WhatsApp y reclamo de stickers', () => {
  const stickerMessage = () => ({
    id: `wamid.${randomUUID()}`,
    from: `573${randomUUID().replaceAll(/\D/g, '').slice(0, 9)}`,
    type: 'sticker',
    sticker: {
      id: `media-${randomUUID()}`,
      animated: false,
      mime_type: 'image/webp',
      sha256: createHash('sha256').update(webp).digest('base64'),
    },
  });
  const receive = (
    message: Omit<ReturnType<typeof stickerMessage>, 'from'> & { from?: string; from_user_id?: string },
    valid = true,
    path = '/webhooks/whatsapp',
    contacts?: { wa_id: string; user_id: string }[],
  ) => {
    const payload = JSON.stringify({
      entry: [{ changes: [{ value: { messages: [message], contacts } }] }],
    });
    const signature = createHmac(
      'sha256',
      valid ? process.env.WA_APP_SECRET! : 'incorrect-test-key',
    )
      .update(payload)
      .digest('hex');
    return api()
      .post(path)
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', `sha256=${signature}`)
      .send(payload);
  };
  const preview = (token: string, bearer?: string) => {
    const req = api().get(`/api/v1/intakes/${token}`);
    return bearer ? req.set('Authorization', bearer) : req;
  };
  const claim = (token: string, bearer: string) =>
    api()
      .post(`/api/v1/intakes/${token}/claim`)
      .set('Authorization', bearer)
      .send({
        title: 'Sticker de prueba',
        description: 'Descripción válida para el sticker',
      });
  const waitReply = async (message: ReturnType<typeof stickerMessage>) => {
    await vi.waitFor(async () => {
      expect(graphReplies.get(message.from)?.length).toBeGreaterThan(0);
      const [row] =
        await db`select status from webhook_inbox where message_id = ${message.id}`;
      expect(row.status).toBe('done');
    }, 7000);
    const last = graphReplies.get(message.from)!.at(-1)!;
    const token = /\/s\/([\w-]{43})/.exec(last)?.[1];
    expect(token).toBeDefined();
    return token!;
  };
  const createIntake = async () => {
    const message = stickerMessage();
    await receive(message).expect(200);
    return { message, token: await waitReply(message) };
  };

  test.each(['teléfono', 'teléfono y BSUID', 'solo BSUID'])('responde a un sticker identificado por %s', async (identity) => {
    const fixture = stickerMessage();
    const bsuid = `CO.${randomUUID().replaceAll('-', '')}`;
    const from = identity === 'solo BSUID' ? undefined : fixture.from;
    const fromUserId = identity === 'teléfono' ? undefined : bsuid;
    const target = from ?? bsuid;
    const otherContact = { wa_id: '573000001234', user_id: 'CO.otraPersona' };
    await receive({ ...fixture, from, from_user_id: fromUserId }, true, '/webhooks/whatsapp', [otherContact]).expect(200);
    await vi.waitFor(async () => {
      const [row] = await db`select status, reply_sent_at from whatsapp_intakes where wa_message_id = ${fixture.id}`;
      expect(row?.status).toBe('ready');
      expect(row.reply_sent_at).toBeTruthy();
    }, 7000);
    expect(graphAddressFields.get(target)).toStrictEqual({ to: from, recipient: from ? undefined : bsuid });
    expect(graphReplies.get(target)?.at(-1)).toMatch(/\/s\/[\w-]{43}/);
    expect(graphReplies.get(otherContact.wa_id)).toBeUndefined();
    expect(graphReplies.get(otherContact.user_id)).toBeUndefined();
  });

  test('AC-19 rechaza una firma inválida sin persistir recepción ni intake', async () => {
    const message = stickerMessage();
    await receive(message, false).expect(401);
    expect(
      await db`select id from webhook_inbox where message_id = ${message.id}`,
    ).toHaveLength(0);
    expect(
      await db`select id from whatsapp_intakes where wa_message_id = ${message.id}`,
    ).toHaveLength(0);
  });

  test('AC-20 y AC-21 deduplica reentregas y permite abrir un intake listo', async () => {
    const message = stickerMessage();
    await Promise.all([
      receive(message).expect(200),
      receive(message).expect(200),
    ]);
    const token = await waitReply(message);
    expect(
      await db`select id from whatsapp_intakes where wa_message_id = ${message.id}`,
    ).toHaveLength(1);
    expect(graphReplies.get(message.from)).toHaveLength(1);
    const viewer = await participant();
    const response = await preview(token, viewer.bearer).expect(200);
    expect(response.body).toMatchObject({
      status: 'ready',
      category: 'sticker',
      media: { kind: 'image' },
    });
  });

  test('AC-22 reclamo concurrente produce un ganador y expirar impide reclamar', async () => {
    const { token } = await createIntake();
    const people = await Promise.all([participant(), participant()]);
    const responses = await Promise.all(
      people.map(({ bearer }) => claim(token, bearer)),
    );
    expect(responses.map((r) => r.status).sort((a, b) => a - b)).toEqual([
      201, 409,
    ]);
    expect(responses.find((r) => r.status === 409)?.body.error.code).toBe(
      'INTAKE_ALREADY_CLAIMED',
    );
    const expired = await createIntake();
    await db`update whatsapp_intakes set expires_at = clock_timestamp() - interval '1 minute' where wa_message_id = ${expired.message.id}`;
    const rejected = await claim(expired.token, people[0].bearer).expect(410);
    expect(rejected.body.error.code).toBe('INTAKE_EXPIRED');
  });

  test('AC-23 no consume el enlace si la persona ya alcanzó el cupo', async () => {
    const { token } = await createIntake();
    const { id, bearer } = await participant();
    await db`insert into submissions (category, title, description, author_id, source)
      select 'sticker', 'Sticker', 'Sticker de prueba ya postulado', ${id}, 'web' from generate_series(1, 3)`;
    const rejected = await claim(token, bearer).expect(409);
    expect(rejected.body.error.code).toBe('QUOTA_EXCEEDED');
    const ready = await preview(token, bearer).expect(200);
    expect(ready.body.status).toBe('ready');
  });

  test('AC-28 el webhook confirma el inbox durable y el enlace exige Bearer', async () => {
    await api()
      .get('/webhooks/whatsapp')
      .query({
        'hub.mode': 'subscribe',
        'hub.verify_token': process.env.WA_VERIFY_TOKEN,
        'hub.challenge': 'challenge',
      })
      .expect(200, 'challenge');
    const message = stickerMessage();
    await receive(message, true, '/api/v1/webhooks/whatsapp').expect(404);
    await receive(message).expect(200);
    expect(
      await db`select id from webhook_inbox where message_id = ${message.id}`,
    ).toHaveLength(1);
    const token = await waitReply(message);
    await preview(token).expect(401);
    await api().post(`/api/v1/intakes/${token}/claim`).send({}).expect(401);
  });

  test('AC-30 un envío ambiguo recuperado conserva su enlace y limpia secretos temporales', async () => {
    const message = stickerMessage();
    graphTimeouts.set(message.from, 1);
    await receive(message).expect(200);
    await vi.waitFor(async () => {
      const [inbox] =
        await db`select status, attempts, extract(epoch from next_attempt_at - updated_at)::float as delay_seconds
        from webhook_inbox where message_id = ${message.id}`;
      expect(inbox).toMatchObject({ status: 'pending', attempts: 1 });
      expect(inbox.delay_seconds).toBeCloseTo(2, 0);
      expect(graphReplies.get(message.from)).toHaveLength(1);
    }, 5000);
    await db`update webhook_inbox set status = 'processing', updated_at = clock_timestamp() - interval '61 seconds',
      lease_until = clock_timestamp() - interval '1 second', lease_token = 'stale-test-lease',
      next_attempt_at = clock_timestamp() - interval '1 second' where message_id = ${message.id}`;
    await app!.get(WhatsappService).recover();
    await waitReply(message);
    const replies = graphReplies.get(message.from)!;
    expect(replies).toHaveLength(2);
    expect(replies[0]).toBe(replies[1]);
    const [intake] =
      await db`select token_hash, token_ciphertext, wa_id, reply_sent_at from whatsapp_intakes where wa_message_id = ${message.id}`;
    expect(intake).toMatchObject({ token_ciphertext: null, wa_id: null });
    expect(intake.token_hash).toBeTruthy();
    expect(intake.reply_sent_at).toBeTruthy();
    const [inbox] =
      await db`select attempts, sender_ciphertext from webhook_inbox where message_id = ${message.id}`;
    expect(inbox).toMatchObject({ attempts: 2, sender_ciphertext: null });
  }, 15000);

  test('AC-30 agota tres intentos y elimina el token cifrado y el remitente', async () => {
    const message = stickerMessage();
    graphTimeouts.set(message.from, 3);
    await receive(message).expect(200);
    for (const [attempt, expectedDelay] of [
      [1, 2],
      [2, 10],
    ]) {
      await vi.waitFor(async () => {
        const [row] =
          await db`select status, attempts, extract(epoch from next_attempt_at - updated_at)::float as delay_seconds
          from webhook_inbox where message_id = ${message.id}`;
        expect(row).toMatchObject({ status: 'pending', attempts: attempt });
        expect(row.delay_seconds).toBeCloseTo(expectedDelay, 0);
      }, 7000);
      await db`update webhook_inbox set next_attempt_at = clock_timestamp() - interval '1 second' where message_id = ${message.id}`;
      await app!.get(WhatsappService).recover();
    }
    await vi.waitFor(async () => {
      const [row] =
        await db`select status, attempts, sender_ciphertext from webhook_inbox where message_id = ${message.id}`;
      expect(row).toMatchObject({
        status: 'failed',
        attempts: 3,
        sender_ciphertext: null,
      });
      const [intake] =
        await db`select status, token_ciphertext, wa_id from whatsapp_intakes where wa_message_id = ${message.id}`;
      expect(intake).toMatchObject({
        status: 'failed',
        token_ciphertext: null,
        wa_id: null,
      });
    }, 7000);
    const replies = graphReplies.get(message.from)!;
    expect(replies).toHaveLength(3);
    expect(new Set(replies).size).toBe(1);
  }, 25000);
});

test.skipIf(process.env.GALA_LOAD_TEST !== '1')(
  'Carga local: 100 papeletas por segundo y p95 de lecturas menor a 300 ms',
  async () => {
    await db`with new_users as (
    insert into auth.users (id) select gen_random_uuid() from generate_series(1, 3000) returning id
  ) insert into profiles (id, email, display_name, human_verified_at)
    select id, id::text || '@example.test', 'Carga de prueba', now() from new_users`;
    await db`insert into submissions (category, title, description, author_label, source)
    select kind, 'Carga de prueba', 'Descripción para las pruebas de carga', 'Autor de prueba', 'admin'
    from unnest(array['photo'::category, 'sticker'::category]) as kind cross join generate_series(1, 500)`;

    const people = await Promise.all(
      Array.from({ length: 200 }, () => participant()),
    );
    const ids = await db<
      { id: string }[]
    >`select id from submissions where category = 'photo' and status = 'published' order by id limit 500`;
    const instance = app!;
    await instance.listen(0, '127.0.0.1');
    const origin = await instance.getUrl();
    const times: number[] = [];
    const total = 1000;
    const start = performance.now();
    const responses = await Promise.all(
      Array.from({ length: total }, async (_, index) => {
        await wait(Math.max(0, 10 * index - (performance.now() - start)));
        const voter = index % people.length;
        const { bearer } = people[voter];
        const ballot = JSON.stringify({
          submission_ids: Array.from(
            { length: 5 },
            (_, position) => ids[(voter * 7 + position * 13) % ids.length].id,
          ),
        });
        const vote = fetch(`${origin}/api/v1/votes/photo`, {
          method: 'PUT',
          headers: {
            authorization: bearer,
            'content-type': 'application/json',
          },
          body: ballot,
        });
        const read =
          index % 10 === 0
            ? (async () => {
                const before = performance.now();
                const response = await fetch(
                  `${origin}/api/v1/submissions?category=photo`,
                  { headers: { authorization: bearer } },
                );
                await response.arrayBuffer();
                times.push(performance.now() - before);
                return response.status;
              })()
            : Promise.resolve(200);
        const [response, readStatus] = await Promise.all([vote, read]);
        await response.arrayBuffer();
        return response.status === 200 && readStatus === 200;
      }),
    );
    times.sort((a, b) => a - b);
    const p95 = times[Math.ceil(times.length * 0.95) - 1];
    console.log(
      `Carga local: ${responses.filter(Boolean).length}/${total} papeletas y p95 ${p95.toFixed(1)} ms en ${times.length} lecturas.`,
    );
    expect(responses.every(Boolean)).toBe(true);
    expect(p95).toBeLessThan(300);
  },
  35000,
);
