import { Test, TestingModule } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from './../src/app.module.js';
import { parseEnvironment } from './../src/config/env.js';
import { configureApp } from './../src/configure-app.js';
import { WhatsappService } from './../src/whatsapp/whatsapp.service.js';

const env = parseEnvironment({
  NODE_ENV: 'test',
  WEB_URL: 'https://gala.example',
  STORAGE_PUBLIC_BASE_URL: 'https://storage.example/Candidatos',
  DATABASE_URL: 'postgres://user:password@localhost:5432/gala',
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_SECRET_KEY: 'secret',
  TURNSTILE_SECRET: 'turnstile-secret',
  WA_VERIFY_TOKEN: 'verify-token',
  WA_APP_SECRET: 'app-secret',
  WA_ACCESS_TOKEN: 'access-token',
  WA_PHONE_NUMBER_ID: 'phone-id',
  WA_HASH_PEPPER: 'hash-pepper',
  WA_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64url'),
});

describe('AppController (e2e)', () => {
  let app: NestExpressApplication;

  beforeEach(async () => {
    vi.stubEnv(
      'DATABASE_URL',
      'postgresql://gala:gala_dev_only@127.0.0.1:55432/gala',
    );
    vi.stubEnv('NODE_ENV', 'test');
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(WhatsappService)
      .useValue({})
      .compile();

    app = moduleFixture.createNestApplication<NestExpressApplication>({
      rawBody: true,
    });
    configureApp(app, env);
    await app.init();
  });

  it('/ (GET)', () => {
    return request(app.getHttpServer())
      .get('/api/v1')
      .expect(200)
      .expect('Hello World!');
  });

  it('serves the health check under the API prefix', () => {
    return request(app.getHttpServer())
      .get('/api/v1/health')
      .expect(200)
      .expect({ status: 'ok' });
  });

  afterEach(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });
});
