import { parseEnvironment } from './env.js';

const requiredEnvironment = {
  WEB_URL: 'https://gala.example',
  STORAGE_PUBLIC_BASE_URL: 'https://storage.example/candidates',
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
};

describe('parseEnvironment', () => {
  it('applies documented defaults and parses the port', () => {
    const env = parseEnvironment({ ...requiredEnvironment, PORT: '8080' });
    expect(env.PORT).toBe(8080);
    expect(env.SUPABASE_STORAGE_BUCKET).toBe('candidates');
    expect(env.WA_MAX_INTAKES_PER_DAY).toBe(10);
    expect(env.TRUST_PROXY).toBe(false);
  });

  it('fails fast when required secrets are missing or malformed', () => {
    expect(() => parseEnvironment({ ...requiredEnvironment, WA_APP_SECRET: '' })).toThrow();
    expect(() => parseEnvironment({ ...requiredEnvironment, WEB_URL: 'not a url' })).toThrow();
  });
});
