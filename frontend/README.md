# La noche de PS · frontend

Astro mobile-first frontend for the gala and voting flows.

## Public environment configuration

Set these values in the local `.env` file and in the production build environment. They are public client configuration; never put Supabase service-role, Meta, Turnstile secret, or backend secrets here.

```dotenv
PUBLIC_API_BASE_URL=https://api.example.com
PUBLIC_SUPABASE_URL=https://project.supabase.co
PUBLIC_SUPABASE_ANON_KEY=public-anon-key
PUBLIC_TURNSTILE_SITE_KEY=public-turnstile-site-key
```

`PUBLIC_API_BASE_URL` is the backend origin without `/api/v1`. Leave it empty only when the site host proxies `/api/v1` to the backend. Google OAuth uses Supabase PKCE. Add the deployed site's `/auth/callback` to Supabase's allowed redirect URLs and register Supabase's own provider callback URI with Google.

## Deep links for WhatsApp stickers

The app is built as static Astro output. `/s/:token` is rewritten to `/s/index.html`, which reads the token from the browser path and keeps it out of analytics and logs.

- `vercel.json` provides the Vercel rewrite.
- `public/_redirects` provides the Netlify rewrite.
- The Astro middleware and Vite development middleware provide the local development rewrite.

For any other static host, add an equivalent rewrite from `/s/*` to `/s/index.html` while preserving the browser URL. This rewrite must preserve the original path in the browser so Google sign-in can return to the same intake.

## Run

```sh
pnpm install
pnpm dev
pnpm build
```
