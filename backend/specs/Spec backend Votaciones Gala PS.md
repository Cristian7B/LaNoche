# Spec backend: Votaciones Gala PS

- [ ] Versión 1 · 26 de noviembre de 2026 · Spec-Driven Development: esta spec es la fuente de verdad. Código, migraciones y pruebas se derivan de ella y se validan contra ella.

## 1. Resumen

API REST en NestJS que soporta la web de votación (Astro) y el bot de WhatsApp. Gestiona postulaciones de fotos y stickers, votos por orden de selección, estados del evento, ranking, resultados y la ingesta de stickers que llegan por WhatsApp.

- **Auth**: Supabase Auth (Google). El backend valida el JWT.
- **Datos**: Postgres de Supabase, con Drizzle.
- **Archivos**: Supabase Storage (bucket público `Candidatos`), escrito solo por el backend.
- **Bot**: WhatsApp Cloud API de Meta (webhook de entrada, Graph API de salida).
- **Referencia**: documento Votaciones Gala PS: pantallas y flujos de usuario (v1).

## 2. Alcance

**Incluye**: perfiles, postulaciones (foto y sticker), medios, votos, estados del evento, ranking en vivo para el admin, resultados onsite y públicos, moderación por eliminación, auditoría antifraude y bot de ingesta de stickers.

**No incluye (v1)**: recepción de fotos o videos por el bot (solo stickers), correos de notificación, websockets (el front hace polling), borrado definitivo de archivos durante el evento y WebM con transparencia.

**Supuestos de carga** (ajustables): hasta 3.000 usuarios, 500 candidatos por categoría y 100 req/s en el pico previo al cierre. Lecturas con p95 menor a 300 ms.

## 3. Arquitectura

- Astro llama a la API Nest en `/api/v1` con `Authorization: Bearer <JWT de Supabase>`.
- Nest accede a Postgres con Drizzle y a Storage con la **secret key** de Supabase, que nunca sale del backend.
- Meta envía mensajes a `POST /webhooks/whatsapp`. Nest responde por la Graph API.
- Cloudflare Turnstile se valida desde el backend.
- Nest corre en un **servidor persistente** (Railway, Render o Fly) con ffmpeg instalado. No usar planes que duerman el servicio: el webhook debe responder siempre.

**Stack**: Node 24, NestJS, TypeScript, Drizzle ORM + drizzle-kit, postgres.js, Zod, jose, sharp, ffmpeg (más ImageMagick y libwebp si el spike lo requiere), multer, p-limit, @nestjs/throttler, nestjs-pino, @supabase/supabase-js (solo Storage), Vitest o Jest + Supertest.

**Base de datos**

- Conectar por el **session pooler** de Supabase (soporta IPv4). Si se usa el transaction pooler (puerto 6543), desactivar los prepared statements en postgres.js.
- Drizzle no gestiona el esquema `auth`: solo se referencia `auth.users`.
- **RLS habilitado y sin políticas** en todas las tablas (`.enableRLS()` en Drizzle). La anon key vive en el front y no debe poder leer ni escribir nada por la Data API de Supabase. El backend conecta con un rol que no está sujeto a RLS.

## 4. Autenticación y autorización

- **Token**: validar el JWT de Supabase con `jose`: firma por JWKS (`<SUPABASE_URL>/auth/v1/.well-known/jwks.json`), `iss = <SUPABASE_URL>/auth/v1`, `aud = authenticated` y `exp`. Si el proyecto aún usa la clave HS256 heredada, validar con el JWT secret (revisar en Settings → JWT Keys). Alternativa más lenta: `supabase.auth.getUser(token)`.
- **Perfil**: en el primer request autenticado se hace upsert en `profiles` con `sub`, `email`, `user_metadata.full_name` (o `name`) y `avatar_url` (o `picture`). Caché en memoria de 60 s.
- **Rol**: `profiles.role`. Bootstrap: si el correo está en `ADMIN_EMAILS`, el perfil se crea o se promueve a `admin`.
- **Bloqueo**: si `is_blocked`, responder 403 `ACCOUNT_BLOCKED` en todo salvo `GET /event` y `GET /me`.
- **Verificación humana**: `POST /me/verify-human` valida Turnstile y guarda `human_verified_at`. Los endpoints de escritura de participantes exigen que no sea nulo (`HUMAN_VERIFICATION_REQUIRED`). Ajuste al doc de pantallas: Turnstile se muestra justo después del login con Google, porque el login OAuth lo maneja Supabase.
- **Guards**: `JwtAuthGuard` global (con `@Public()` para las excepciones), `RolesGuard` (`@Roles('admin')`) y `HumanVerifiedGuard` en las escrituras.

## 5. Modelo de datos

Postgres (Supabase). Migraciones con drizzle-kit. El orden de creación respeta las referencias.

```sql
CREATE TYPE category AS ENUM ('photo', 'sticker');
CREATE TYPE user_role AS ENUM ('participant', 'admin');
CREATE TYPE event_status AS ENUM ('open', 'closed', 'results_published');
CREATE TYPE submission_status AS ENUM ('published', 'deleted');
CREATE TYPE submission_source AS ENUM ('web', 'whatsapp', 'admin');
CREATE TYPE media_kind AS ENUM ('image', 'video');
CREATE TYPE intake_status AS ENUM ('processing', 'ready', 'claimed', 'expired', 'failed');

CREATE TABLE profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email text NOT NULL,
  display_name text NOT NULL,
  avatar_url text,
  role user_role NOT NULL DEFAULT 'participant',
  is_blocked boolean NOT NULL DEFAULT false,
  human_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz
);
CREATE UNIQUE INDEX profiles_email_uq ON profiles (lower(email));

-- Una sola fila de configuración y estado del evento
CREATE TABLE event_settings (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  status event_status NOT NULL DEFAULT 'open',
  closes_at timestamptz,
  results_published_at timestamptz,
  max_votes_per_category smallint NOT NULL DEFAULT 5 CHECK (max_votes_per_category BETWEEN 1 AND 10),
  max_photo_submissions smallint NOT NULL DEFAULT 2,
  max_sticker_submissions smallint NOT NULL DEFAULT 3,
  allow_self_vote boolean NOT NULL DEFAULT false,
  show_author_in_public_results boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES profiles(id)
);
INSERT INTO event_settings (id) VALUES (1);

CREATE TABLE whatsapp_intakes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wa_message_id text NOT NULL UNIQUE,      -- idempotencia del webhook
  wa_media_id text NOT NULL,
  wa_id text,                              -- se pone en NULL al enviar la respuesta
  wa_sender_hash text NOT NULL,            -- HMAC(WA_HASH_PEPPER, wa_id)
  category category NOT NULL DEFAULT 'sticker',
  status intake_status NOT NULL DEFAULT 'processing',
  token_hash text UNIQUE,                  -- sha256 del token; NULL mientras procesa
  token_ciphertext text,                   -- cifrado temporal para reintentos de respuesta
  source_mime text,
  is_animated boolean,
  kind media_kind,
  storage_path text,
  thumb_path text,
  mime_type text,
  width int, height int, duration_ms int, size_bytes int,
  attempts smallint NOT NULL DEFAULT 0,
  error text,
  reply_sent_at timestamptz,
  claimed_by uuid REFERENCES profiles(id),
  claimed_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX intakes_sender_idx ON whatsapp_intakes (wa_sender_hash, created_at);
CREATE INDEX intakes_status_idx ON whatsapp_intakes (status, updated_at);

-- Además, un inbox durable identifica cada wamid, también para mensajes que
-- no crean intake. Conserva estado, intentos, siguiente intento y actividad
-- para recuperación; el remitente y secretos temporales se eliminan al terminar.

CREATE TABLE submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category category NOT NULL,
  title varchar(120) NOT NULL,
  description text NOT NULL,
  author_id uuid REFERENCES profiles(id),
  author_label text,                       -- nombre a mostrar; carga manual o corrección del admin
  source submission_source NOT NULL,
  intake_id uuid UNIQUE REFERENCES whatsapp_intakes(id),
  status submission_status NOT NULL DEFAULT 'published',
  deleted_at timestamptz,
  deleted_by uuid REFERENCES profiles(id),
  delete_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, category),
  CHECK (author_id IS NOT NULL OR author_label IS NOT NULL)
);
CREATE INDEX submissions_list_idx ON submissions (category, status);
CREATE INDEX submissions_author_idx ON submissions (author_id, category) WHERE status = 'published';

CREATE TABLE submission_media (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id uuid NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  position smallint NOT NULL CHECK (position >= 1),
  kind media_kind NOT NULL,
  storage_path text NOT NULL,              -- la URL pública se deriva del path
  thumb_path text NOT NULL,
  mime_type text NOT NULL,
  width int NOT NULL, height int NOT NULL,
  duration_ms int,
  size_bytes int NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (submission_id, position)
);

CREATE TABLE votes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  voter_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  category category NOT NULL,
  submission_id uuid NOT NULL,
  position smallint NOT NULL CHECK (position >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (submission_id, category) REFERENCES submissions (id, category) ON DELETE CASCADE,
  UNIQUE (voter_id, category, position),
  UNIQUE (voter_id, submission_id)
);
CREATE INDEX votes_submission_idx ON votes (submission_id);

CREATE TABLE vote_audit (
  id bigserial PRIMARY KEY,
  voter_id uuid NOT NULL REFERENCES profiles(id),
  category category NOT NULL,
  ballot uuid[] NOT NULL,
  ip inet,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vote_audit_voter_idx ON vote_audit (voter_id, created_at);

CREATE TABLE admin_actions (
  id bigserial PRIMARY KEY,
  admin_id uuid NOT NULL REFERENCES profiles(id),
  action text NOT NULL,
  target_type text,
  target_id text,
  payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Repetir en todas las tablas:
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
```

Bucket de Storage `Candidatos` (público, solo lectura anónima): `submissions/{submission_id}/{position}.{ext}` y `{position}_thumb.webp`; `intakes/{intake_id}/media.{ext}` y `thumb.webp`. Los nombres usan uuid, nunca el nombre original del archivo.

## 6. Reglas de negocio

- **RN-01 Estado efectivo**: el evento está abierto solo si `status = open` y (`closes_at` es nulo o `now() < closes_at`). Un tick cada 15 s persiste `closed` cuando se cumple `closes_at`.
- **RN-02 Escrituras**: crear, editar o eliminar postulaciones propias, reclamar un intake y votar exigen evento abierto. Las lecturas siempre se permiten, salvo los resultados (RN-14).
- **RN-03 Transiciones**: `open ↔ closed` y `closed ↔ results_published`. Nunca `open → results_published`.
- **RN-04 Cupos**: postulaciones `published` por (autor, categoría) no pueden superar `max_photo_submissions` (2) ni `max_sticker_submissions` (3). Eliminar una libera el cupo. Las cargas manuales del admin no cuentan.
- **RN-05 Medios**: una foto tiene de 1 a 10 imágenes (carrusel del mismo momento). Un sticker tiene exactamente 1 medio, imagen o video en loop.
- **RN-06 Textos**: `title` de 3 a 120 caracteres y `description` de 10 a 1000, ambos con trim.
- **RN-07 Papeleta**: de 0 a `max_votes_per_category` candidatos por categoría, sin repetir, todos `published` y de esa categoría. `PUT` reemplaza la papeleta completa (idempotente).
- **RN-08 Puntos**: con posición efectiva `p`, el candidato suma `max_votes_per_category - p + 1` (5, 4, 3, 2, 1).
- **RN-09 Posición efectiva**: se calcula al leer, compactando las posiciones de los votos válidos (candidato `published` y votante no bloqueado). Los votos no se borran cuando se elimina un candidato, así restaurarlo recupera sus votos.
- **RN-10 Desempate**: puntos, luego votos en 1.er lugar, luego votos totales y por último `created_at` más antiguo.
- **RN-11 Voto propio**: bloqueado si `allow_self_vote = false` (valor por defecto): 422 `SELF_VOTE_NOT_ALLOWED`.
- **RN-12 Anonimato**: los DTOs públicos nunca incluyen autor. `is_mine` es true solo para el propio usuario. El autor se muestra en el admin, en onsite y en los resultados públicos solo si `show_author_in_public_results`.
- **RN-13 Nombre mostrado**: `coalesce(author_label, profiles.display_name)`.
- **RN-14 Visibilidad del ranking**: público solo con `results_published`; el admin siempre; la vista onsite solo con `closed` o `results_published`.
- **RN-15 Orden de la lista**: determinístico por usuario: `ORDER BY md5(id::text || user_id::text)`.
- **RN-16 Máximo de votos**: `max_votes_per_category` queda congelado desde la primera papeleta no vacía registrada, aunque después se vacíe o eliminen votos. La evidencia histórica debe persistir.
- **RN-17 Eliminación lógica**: `status = deleted`, `deleted_by` y `delete_reason`. Los archivos no se borran durante el evento. El admin puede restaurar; el autor no.
- **RN-18 Concurrencia**: usar el reloj de Postgres para estado efectivo y vencimientos. Adquirir locks en orden evento → perfil → candidato/intake. Las escrituras toman evento `FOR SHARE` y perfil `FOR UPDATE`; las transiciones toman evento `FOR UPDATE`. Cierre responde únicamente tras commit, de modo que ninguna escritura se confirma después de su respuesta. Restaurar una postulación de participante exige cupo bajo el mismo orden de locks; una carga manual está exenta.

**Consulta de ranking** (por categoría `$1`):

```sql
WITH valid_votes AS (
  SELECT v.voter_id, v.submission_id,
         ROW_NUMBER() OVER (PARTITION BY v.voter_id ORDER BY v.position) AS eff_pos
  FROM votes v
  JOIN submissions s ON s.id = v.submission_id AND s.status = 'published'
  JOIN profiles p ON p.id = v.voter_id AND p.is_blocked = false
  WHERE v.category = $1
)
SELECT s.id,
       COALESCE(SUM(es.max_votes_per_category - vv.eff_pos + 1), 0) AS score,
       COUNT(*) FILTER (WHERE vv.eff_pos = 1) AS first_place_votes,
       COUNT(vv.voter_id) AS total_votes
FROM submissions s
CROSS JOIN event_settings es
LEFT JOIN valid_votes vv ON vv.submission_id = s.id
WHERE s.category = $1 AND s.status = 'published'
GROUP BY s.id, s.created_at
ORDER BY score DESC, first_place_votes DESC, total_votes DESC, s.created_at ASC;
```

## 7. Contrato de la API

**Convenciones**

- Base `/api/v1`. JSON en snake\_case, fechas ISO 8601 UTC, ids uuid. Todos los endpoints exigen Bearer salvo los marcados como públicos.
- Error: `{ error: { code, message, details? } }`.
- Códigos: `UNAUTHENTICATED` 401, `FORBIDDEN` 403, `ACCOUNT_BLOCKED` 403, `HUMAN_VERIFICATION_REQUIRED` 403, `RESULTS_NOT_PUBLISHED` 403, `NOT_FOUND` 404, `EVENT_NOT_OPEN` 409, `EVENT_STILL_OPEN` 409, `QUOTA_EXCEEDED` 409, `INVALID_TRANSITION` 409, `INTAKE_NOT_READY` 409, `INTAKE_ALREADY_CLAIMED` 409, `INTAKE_EXPIRED` 410, `VALIDATION_ERROR` 422, `SELF_VOTE_NOT_ALLOWED` 422, `MEDIA_INVALID` 422, `RATE_LIMITED` 429.
- Paginación (solo admin): `limit` (50 por defecto, 200 máximo) y `cursor`. Respuesta `{ items, next_cursor }`.

**DTOs**

```
Media { id, kind: image | video, url, thumb_url, width, height, duration_ms?, position }
SubmissionPublic { id, category, title, description, media: Media[], is_mine: boolean, created_at }
SubmissionMine = SubmissionPublic + { status, source, delete_reason? }
Ballot { category, items: { position, submission: SubmissionPublic }[] }
RankingItem { rank, submission: SubmissionPublic, score, first_place_votes, total_votes, author_name? }
```

Las URLs de medios se construyen con `STORAGE_PUBLIC_BASE_URL` más el path.

**Sistema y perfil**

- `GET /health` (público): `{ status: ok }`.
- `GET /event` (público): `{ status, effective_status, closes_at, server_time, limits: { max_votes_per_category, max_photo_submissions, max_sticker_submissions, max_images_per_photo }, bot_wa_link }`.
- `GET /me`: `{ id, email, display_name, avatar_url, role, human_verified, usage: { submissions: { photo, sticker }, votes: { photo, sticker } } }`.
- `PATCH /me`: `{ display_name }` (2 a 60 caracteres).
- `POST /me/verify-human`: `{ turnstile_token }` → 204. Si falla: 422 `VALIDATION_ERROR` con `details.reason = turnstile_failed`.

**Postulaciones**

- `GET /submissions?category=photo|sticker`: candidatos publicados como `SubmissionPublic[]`, sin paginar en v1, orden RN-15.
- `GET /submissions/:id`: `SubmissionPublic`. 404 si está eliminada, salvo para su autor.
- `POST /submissions` (multipart, humano verificado, evento abierto): campos `category`, `title`, `description` y `files` (1 a 10 para foto, 1 para sticker). 201 `SubmissionMine`. Errores: `QUOTA_EXCEEDED`, `MEDIA_INVALID`, `VALIDATION_ERROR`, `EVENT_NOT_OPEN`.
- `GET /me/submissions`: `SubmissionMine[]`, incluye las eliminadas con su motivo.
- `PATCH /submissions/:id`: `{ title?, description? }`. Solo el autor, evento abierto. No cambia los medios.
- `DELETE /submissions/:id`: solo el autor, evento abierto. Eliminación lógica, 204.

**Votos**

- `GET /votes/me`: `{ photo: Ballot, sticker: Ballot }` con posiciones efectivas (RN-09).
- `PUT /votes/:category`: body `{ submission_ids: uuid[] }`, ordenado (el primero es el 1.º). Reemplaza la papeleta; `[]` la borra. 200 `Ballot`. En una transacción: bloquea la fila del usuario (RN-18), valida RN-02, RN-07 y RN-11, borra los votos previos de esa categoría, inserta los nuevos y agrega una fila a `vote_audit` (IP y user agent).

**Resultados**

- `GET /results` (público): `{ photo: RankingItem[], sticker: RankingItem[] }` con el top `max_votes_per_category`. 403 `RESULTS_NOT_PUBLISHED` si el estado no es `results_published`. Sin JWT `is_mine = false`; si se presenta un JWT inválido se responde 401. `author_name` solo si `show_author_in_public_results`.

**Intakes (stickers del bot)**

- `GET /intakes/:token` (requiere Bearer): `{ status, category, media: Media, expires_at }`. Errores: 404 `NOT_FOUND`, 410 `INTAKE_EXPIRED`, 409 `INTAKE_ALREADY_CLAIMED`, 409 `INTAKE_NOT_READY` (con `Retry-After`).
- `POST /intakes/:token/claim` (requiere Bearer): `{ title, description }`. En una transacción: valida evento abierto y cupo, marca el intake como `claimed` con `UPDATE ... WHERE token_hash = $h AND status = 'ready' AND expires_at > now() RETURNING *` y crea el submission (`source = whatsapp`, `intake_id`, medio tomado del intake). 201 `SubmissionMine`.

**Webhook**

- `GET` y `POST /webhooks/whatsapp` (públicos, fuera del prefijo `/api/v1`): ver sección 8.

**Admin** (rol admin)

- `GET /admin/dashboard`: `{ event, users, submissions: { photo, sticker, deleted }, voters: { photo, sticker }, votes_total, intakes: { ready, claimed, failed } }`.
- `POST /admin/event/close`, `/reopen`, `/publish-results` y `/unpublish-results`: transiciones de RN-03. Devuelven el evento. 409 `INVALID_TRANSITION`.
- `PATCH /admin/settings`: `{ closes_at?, max_votes_per_category?, max_photo_submissions?, max_sticker_submissions?, allow_self_vote?, show_author_in_public_results? }` (RN-16).
- `GET /admin/submissions?category&status=published|deleted|all&q&limit&cursor`: incluye `author { id, name, email }`, `source` y `votes { total, by_position: number[] }`.
- `POST /admin/submissions` (multipart): carga manual. Igual que `POST /submissions` más `author_label` (obligatorio) y `author_id` (opcional). `source = admin`, no consume cupos.
- `PATCH /admin/submissions/:id`: `{ title?, description?, author_label? }`.
- `DELETE /admin/submissions/:id` con `{ reason? }` → 204. `POST /admin/submissions/:id/restore` → 200.
- `GET /admin/ranking?category`: todos los candidatos con `score`, `first_place_votes`, `total_votes` y `by_position`. Caché de 3 s.
- `GET /admin/results/onsite`: `{ photo: RankingItem[], sticker: RankingItem[] }` con `author_name` siempre. 409 `EVENT_STILL_OPEN` si el estado es `open`.
- `GET /admin/users?q&blocked&limit&cursor` y `PATCH /admin/users/:id` con `{ is_blocked }`.
- `GET /admin/audit/signals`: señales antifraude (sección 10).
- `GET /admin/audit/votes?voter_id&category&limit&cursor`: filas de `vote_audit`.
- `GET /admin/actions?limit&cursor`: bitácora de `admin_actions`. Toda acción del admin (cerrar, publicar, eliminar, restaurar, bloquear, cambiar ajustes) se registra ahí.

## 8. Bot de WhatsApp

**Verificación** (`GET /webhooks/whatsapp`, público): si `hub.mode = subscribe` y `hub.verify_token = WA_VERIFY_TOKEN`, responder 200 con el texto de `hub.challenge`; si no, 403.

**Recepción** (`POST /webhooks/whatsapp`, público pero protegido por firma)

1. Habilitar `rawBody` en Nest. Validar `X-Hub-Signature-256` = `sha256=` + HMAC-SHA256 del cuerpo crudo con `WA_APP_SECRET`, con comparación en tiempo constante. Si falla: 401 y no se procesa nada.
2. Recorrer `entry[].changes[].value.messages[]` e ignorar `statuses`.
3. Persistir durablemente cada mensaje admitido en un inbox antes de responder **200**; procesarlo en segundo plano. Si falla la persistencia, responder error para que Meta reintente.
4. Idempotencia por wamid para todos los tipos de mensaje: una única entrada durable por `wa_message_id`. Una entrega duplicada no crea otro trabajo ni respuesta lógica.

**Por tipo de mensaje** (`from` = wa\_id del remitente, `id` = wamid)

- `sticker`: crea un intake (flujo siguiente). Campos usados: `sticker.id`, `sticker.mime_type`, `sticker.sha256` y `sticker.animated` (confirmar con un payload real).
- `text`, `image`, `video`, `document` y otros: respuesta de ayuda (solo se reciben stickers; las fotos se suben en la web).
- Evento no abierto: respuesta de que las postulaciones cerraron. No se crea intake.
- Más de `WA_MAX_INTAKES_PER_DAY` (10) intakes del mismo remitente en 24 h: respuesta de límite.

**Flujo de un sticker**

1. Crear el intake `processing` con `expires_at = now() + INTAKE_TTL_HOURS` (72 h), `wa_id` y `wa_sender_hash`.
2. Pedir la URL: `GET https://graph.facebook.com/<WA_GRAPH_VERSION>/<media_id>` con `Authorization: Bearer <WA_ACCESS_TOKEN>`. La URL vence a los 5 minutos.
3. Descargar el archivo con el mismo token. Verificar `sha256` si viene y un tope de 2 MB.
4. Normalizar con el pipeline de medios (sección 9) y subir a `intakes/<intake_id>/`.
5. Generar una sola vez un token aleatorio de 32 bytes (base64url), guardar su `sha256` en `token_hash` para claim y una copia cifrada temporal para reintentar el envío; pasar el intake a `ready`.
6. Responder con `POST https://graph.facebook.com/<v>/<WA_PHONE_NUMBER_ID>/messages` y cuerpo `{ messaging_product: whatsapp, to: wa_id, type: text, text: { body, preview_url: true } }`. El texto incluye `<WEB_URL>/s/<token>`.
7. Guardar `reply_sent_at` y borrar el token cifrado temporal y el remitente (`wa_id = null`) al terminar el envío o agotar los intentos.

**Fallos**: máximo 3 intentos en total, con esperas de 2 s y 10 s entre intentos. Tras el tercero se registra el fallo y se termina el trabajo. Los reintentos de envío usan exactamente la misma URL, incluso tras un resultado ambiguo; Meta puede haber aceptado una respuesta aunque el cliente no recibiera confirmación, por lo que no se garantiza entrega física única. Un job periódico y al arrancar recupera trabajos sin actividad durante 60 s, respetando el límite de intentos.

**Textos del bot** (español, texto plano, en un archivo de constantes): link de postulación, ayuda, evento cerrado, límite diario y error.

**Procesamiento**: corre en el mismo servicio; el inbox durable es la fuente de trabajo y una cola en memoria limita ejecución (`p-limit(2)` para ffmpeg), con recuperación desde Postgres. Si la carga crece, migrar a pg-boss.

## 9. Pipeline de medios

Módulo `MediaModule`, usado por `POST /submissions`, `POST /admin/submissions` y el bot.

**Validación de entrada**

- Detectar el tipo real por magic bytes (`file-type`), no por extensión ni por `Content-Type`.
- Foto: JPEG, PNG o WebP; máximo `MAX_IMAGE_BYTES` (10 MB) por imagen y 10 imágenes. HEIC no se soporta en v1 (iOS suele convertirlo a JPEG al subir desde el navegador).
- Sticker subido por la web: WebP, PNG, JPEG, GIF, MP4 o WebM; máximo `MAX_STICKER_BYTES` (10 MB) y 10 s de duración.
- Sticker del bot: WebP (estático o animado), máximo 2 MB.
- multer con `limits` y almacenamiento temporal en disco (no en memoria) para videos. Limpiar los temporales en `finally`.

**Fotos**: `sharp` con `.rotate()` (aplica la orientación EXIF) y sin metadata (incluye GPS). Máximo 2000 px por lado, salida WebP calidad 82 en `{n}.webp`. Miniatura de 480 px, WebP calidad 75, en `{n}_thumb.webp`.

**Stickers**

- **Estático**: WebP con alfa, máximo 512 px por lado, en `1.webp`; miniatura de 256 px. `kind = image`.
- **Animado** (WebP animado, GIF, MP4 o WebM): salida **MP4 H.264**, sin audio, máximo 512 px y `+faststart`, para reproducirse en loop en el front. La miniatura es el primer frame en WebP. `kind = video`.
- Comando base:

```
ffmpeg -i in -an -c:v libx264 -pix_fmt yuv420p -crf 26 -preset veryfast -movflags +faststart -vf scale=w=512:h=512:force_original_aspect_ratio=decrease:force_divisible_by=2 out.mp4
```

- **Transparencia**: MP4 no soporta alfa, así que el fondo se aplana sobre un color neutro (`MEDIA_STICKER_BG`, blanco por defecto). WebM VP9 con alfa queda como mejora.
- **WebP animado**: el soporte de decodificación en ffmpeg depende de la versión, por eso hay un spike obligatorio (fase 0) con stickers reales. Pipeline A: ffmpeg directo. Pipeline B: extraer los frames con ImageMagick (`magick in.webp -coalesce f_%04d.png`), tomar las duraciones por frame y armar el video con ffmpeg (concat). Se adopta el primero que pase el spike.
- **Detección de animación**: `sharp.metadata().pages > 1` (WebP o GIF) o presencia de stream de video (MP4 o WebM).

**Almacenamiento**: subir con supabase-js (secret key), con `contentType` correcto y `cacheControl: 31536000` (los paths con uuid son inmutables). Orden: subir todos los archivos, luego insertar las filas en una transacción. Si algo falla, borrar lo subido.

**Concurrencia**: máximo 2 conversiones de video a la vez (`p-limit`) y timeout de 30 s por conversión.

**Limpieza**: un job cada hora pasa a `expired` los intakes `ready` con `expires_at < now()` y borra sus archivos. Los archivos de postulaciones eliminadas se conservan hasta terminar el evento.

## 10. Seguridad y antifraude

- **CORS**: solo el origen `WEB_URL`. `helmet` activo.
- **Rate limiting** (`@nestjs/throttler`, clave = usuario o IP): `PUT /votes/*` 20/min; `POST /submissions` y `/intakes/*/claim` 10/min; `POST /me/verify-human` 10/min; lecturas 120/min. El webhook está exento de límite, pero exige firma.
- Registrar durablemente cada intento autenticado de `PUT /votes` antes del rate limiter, incluidos los rechazados con 429, para detectar más de 30 intentos por usuario en un minuto. Este registro es distinto de `vote_audit`, que conserva las papeletas aceptadas.
- **IP real**: configurar `trust proxy` según el hosting. La IP se guarda en `vote_audit`.
- **Secretos**: la secret key de Supabase, el token de Meta y el app secret solo en variables de entorno del backend, y nunca en logs.
- **Subidas**: validar magic bytes, tamaños y duración (sección 9). Los nombres de archivo los genera el servidor.
- **Señales antifraude** (`GET /admin/audit/signals`, umbrales configurables):
  1. Cuentas que votaron menos de 1 hora después de crearse.
  2. Más de 5 votantes distintos desde la misma IP en 10 minutos (ojo: el WiFi del evento comparte IP).
  3. 10 o más papeletas idénticas (mismo orden) de usuarios distintos.
  4. Más de 30 `PUT /votes` del mismo usuario en 1 minuto.
- **Respuesta**: el admin bloquea cuentas (`is_blocked`). Sus votos dejan de contar automáticamente (RN-09) y se pueden recuperar al desbloquear.
- **Privacidad**: del bot solo se conserva un hash del número; `wa_id` se anula tras responder. La metadata EXIF se elimina de las fotos.

## 11. Configuración (variables de entorno)

```
NODE_ENV, PORT, WEB_URL, STORAGE_PUBLIC_BASE_URL
DATABASE_URL                  # session pooler de Supabase
SUPABASE_URL, SUPABASE_SECRET_KEY, SUPABASE_STORAGE_BUCKET=Candidatos
ADMIN_EMAILS                  # lista separada por comas
TURNSTILE_SECRET
WA_VERIFY_TOKEN, WA_APP_SECRET, WA_ACCESS_TOKEN, WA_PHONE_NUMBER_ID
WA_GRAPH_VERSION=v25.0, WA_HASH_PEPPER, WA_MAX_INTAKES_PER_DAY=10
WA_TOKEN_ENCRYPTION_KEY        # clave para cifrar temporalmente el token de claim
INTAKE_TTL_HOURS=72
MAX_IMAGE_BYTES=10485760, MAX_STICKER_BYTES=10485760, MAX_IMAGES_PER_PHOTO=10
MEDIA_STICKER_BG=#FFFFFF
```

Se validan con Zod al arrancar: si falta una variable, el servidor no inicia. No hay valores por defecto para secretos.

## 12. Estructura del proyecto

```
src/
  main.ts          # rawBody, helmet, CORS, trust proxy, prefijo /api/v1
  config/          # validación de env (Zod)
  db/              # schema/*.ts (Drizzle), migrations/, db.module.ts
  common/          # filtro de errores, guards, decoradores, paginación
  auth/            # JwtAuthGuard, RolesGuard, HumanVerifiedGuard, ProfilesService, Turnstile
  event/           # EventService (estado efectivo, transiciones, tick de cierre)
  media/           # MediaService (sharp, ffmpeg), StorageService (Supabase)
  submissions/     # controller, service, DTOs
  votes/           # controller, service, RankingService
  results/         # controller público
  intakes/         # controller, service (claim)
  whatsapp/        # WebhookController, GraphClient, BotService, mensajes
  admin/           # controllers de admin, AuditService, ActionsService
  health/
test/              # e2e (Supertest) contra un Postgres de prueba
```

Las pruebas corren contra un Postgres local en Docker, nunca contra el proyecto de producción.

## 13. Criterios de aceptación

Formato Dado / Cuando / Entonces. Cada criterio debe tener al menos una prueba automatizada.

- **AC-01** Dado un JWT válido de un usuario nuevo, cuando llama `GET /me`, entonces se crea su perfil con rol `participant` y `human_verified = false`.
- **AC-02** Dado un correo incluido en `ADMIN_EMAILS`, cuando entra por primera vez, entonces su rol es `admin`.
- **AC-03** Dado un usuario sin verificación humana, cuando llama `POST /submissions` o `PUT /votes/*`, entonces recibe 403 `HUMAN_VERIFICATION_REQUIRED`.
- **AC-04** Dado un usuario con 2 fotos publicadas, cuando sube una tercera, entonces recibe 409 `QUOTA_EXCEEDED`; si elimina una, puede subirla.
- **AC-05** Dado un archivo con extensión `.png` pero contenido ejecutable, cuando se sube, entonces recibe 422 `MEDIA_INVALID`.
- **AC-06** Dado un sticker WebP animado real, cuando se procesa, entonces se obtiene un MP4 reproducible en iOS y Android, de 512 px o menos y menor a 1 MB.
- **AC-07** Dado un usuario autenticado, cuando consulta `GET /submissions`, entonces ningún elemento contiene datos del autor y solo los propios tienen `is_mine = true`.
- **AC-08** Dado el mismo usuario, cuando consulta la lista dos veces, entonces recibe el mismo orden; con otro usuario, el orden es distinto.
- **AC-09** Dado un `PUT /votes/photo` con 6 ids, ids repetidos o el id de un sticker, entonces 422 `VALIDATION_ERROR`.
- **AC-10** Dada la papeleta \[A, B, C\], cuando se calcula el ranking, entonces A suma 5, B suma 4 y C suma 3.
- **AC-11** Dada una papeleta existente, cuando el usuario envía otra, entonces la anterior se reemplaza por completo y `vote_audit` registra ambos envíos.
- **AC-12** Dado un voto a un candidato propio con `allow_self_vote = false`, entonces 422 `SELF_VOTE_NOT_ALLOWED`.
- **AC-13** Dada la papeleta \[A, B, C\] y A eliminado por el admin, entonces B suma 5 y C suma 4; al restaurar A, vuelven a sumar 5, 4 y 3.
- **AC-14** Dados dos candidatos con el mismo puntaje, entonces gana el que tiene más votos en 1.er lugar.
- **AC-15** Dado un evento en `closed`, cuando se intenta subir, editar, eliminar o votar, entonces 409 `EVENT_NOT_OPEN`.
- **AC-16** Dado `closes_at` en el pasado, cuando se intenta votar, entonces 409 `EVENT_NOT_OPEN` aunque el estado guardado sea `open`.
- **AC-17** Dado un `close` concurrente con 50 votos en vuelo, entonces ningún voto se confirma después de que `close` responde.
- **AC-18** Dado el evento `open`, cuando se pide `GET /results` o `GET /admin/results/onsite`, entonces 403 `RESULTS_NOT_PUBLISHED` y 409 `EVENT_STILL_OPEN` respectivamente; `GET /admin/ranking` sí responde.
- **AC-19** Dado un webhook con firma inválida, entonces 401 y no se crea ningún intake.
- **AC-20** Dado el mismo mensaje de WhatsApp entregado dos veces y una respuesta aceptada confirmada, entonces existe un solo trabajo lógico, un solo intake y se envía una sola respuesta. En el caso independiente de envío ambiguo pueden producirse entregas físicas duplicadas; sus reintentos usan la misma URL.
- **AC-21** Dado un sticker recibido, cuando termina el procesamiento, entonces el usuario recibe un link con el token y `GET /intakes/:token` devuelve `ready`.
- **AC-22** Dado un intake ya reclamado, cuando otro usuario llama `claim`, entonces 409 `INTAKE_ALREADY_CLAIMED`; con el intake vencido, 410 `INTAKE_EXPIRED`.
- **AC-23** Dado un usuario que ya tiene 3 stickers, cuando reclama un intake, entonces 409 `QUOTA_EXCEEDED` y el intake sigue en `ready`.
- **AC-24** Dado un usuario bloqueado, entonces sus votos dejan de contar en el ranking y recibe 403 `ACCOUNT_BLOCKED` en todo salvo `GET /event` y `GET /me`.
- **AC-25** Dada cualquier acción del admin (cerrar, eliminar, bloquear, cambiar ajustes), entonces queda una fila en `admin_actions`.
- **AC-26** Dada una papeleta no vacía registrada alguna vez, aunque luego se vacíe, cuando el admin cambia `max_votes_per_category`, entonces 422 `VALIDATION_ERROR` con `details.reason = votes_exist`.

- **AC-27** Resultados publicados admiten acceso anónimo con `is_mine = false`; un JWT inválido produce 401 y `author_name` sigue el ajuste público.
- **AC-28** Preview y claim de intake requieren Bearer; el webhook opera fuera del prefijo API y no confirma recepción antes del commit durable del inbox.
- **AC-29** Restaurar una postulación de participante sin cupo produce 409; restaurar una carga manual está exento.
- **AC-30** Envío ambiguo y recuperación tras 60 s reutilizan la URL original, máximo tres intentos totales con 2 y 10 s de espera; se eliminan secreto temporal y remitente al terminar.
- **AC-31** Más de 30 intentos de voto en un minuto generan señal, incluyendo los 429 registrados antes del límite de 20/min.

## 14. Plan de implementación

Cada fase termina cuando pasan sus criterios de aceptación.

- **Fase 0: spikes externos (pendientes; no bloquean la base local)**
  1. Convertir 5 stickers animados reales de WhatsApp a MP4 (pipeline A o B) y verificarlos en iOS y Android.
  2. Recibir un sticker en el webhook con el número de prueba de Meta y descargarlo con las dos llamadas. Confirmar el payload real (`animated`).
  3. Validar un JWT de Supabase con `jose` (JWKS).
- **Fase 1: base**: scaffold de Nest, validación de env, Drizzle y migraciones del modelo completo, RLS, filtro de errores, `/health` y logging.
- **Fase 2: auth y evento**: guards, `profiles`, `/me`, Turnstile, `EventService` con estado efectivo y `/event`. (AC-01 a 03, 15, 16)
- **Fase 3: medios y postulaciones**: `MediaService`, `StorageService`, CRUD de postulaciones y cupos. (AC-04 a 08)
- **Fase 4: votos y ranking**: `PUT /votes`, `RankingService`, desempate y posiciones efectivas. (AC-09 a 14, 17)
- **Fase 5: bot e intakes**: webhook, cola, respuestas y `claim`. (AC-19 a 23)
- **Fase 6: admin y resultados**: endpoints de admin, onsite, resultados públicos y auditoría. (AC-18, 24 a 26)
- **Fase 7: endurecimiento y despliegue**: rate limiting, Dockerfile con ffmpeg, servicio siempre activo, prueba de carga (100 req/s de votos) y ensayo general con el bot real.

## 15. Pendientes por confirmar

1. **Voto propio**: la spec asume bloqueado (`allow_self_vote = false`).
2. **Nombre en resultados públicos**: la spec asume que solo se muestra en onsite (`show_author_in_public_results = false`).
3. **Cierre automático**: la spec soporta `closes_at` y el cierre manual. ¿Se usarán ambos?
4. **Límites de archivos**: 10 MB, 10 imágenes y 10 s de sticker son valores provisionales.
5. **Transparencia en stickers animados**: v1 aplana sobre un fondo neutro. ¿Basta, o se quiere WebM con alfa?
6. **Retención**: qué se hace con archivos y datos después de la gala (medios eliminados, hashes del bot).
7. **Nombre del bot y textos** de los mensajes de WhatsApp.
8. **Fotos por el bot**: fuera de v1, pero el modelo ya lo soporta (`whatsapp_intakes.category`).

## 16. Backlog y matriz de trazabilidad

La implementación y sus pruebas deben cubrir las reglas indicadas; «pendiente» no implica verificación exitosa. Los spikes externos no bloquean el trabajo local, pero sí la validación integral de las integraciones correspondientes. No se autoriza despliegue por este plan.

| Bloque | Entregable | Trazabilidad principal | Estado |
| --- | --- | --- | --- |
| 0 | Spikes de stickers reales, Meta y JWT Supabase | AC-06, 19–21; secciones 4, 8 y 9 | Pendiente de muestras, credenciales y herramientas externas |
| 1 | Configuración, Postgres, esquema, migraciones, RLS y salud | Secciones 3, 5, 11 y 12 | En progreso: migración y RLS verificadas; falta filtro de errores y verificación final integrada |
| 2 | Auth, perfiles y evento | RN-01–03, 18; AC-01–03, 15–17 | En progreso: smoke parcial de auth; contratos y pruebas pendientes |
| 3 | Medios y postulaciones | RN-02, 04–06, 12–13, 15, 17–18; AC-04–08, 29 | En progreso: pipeline inicial bajo revisión; faltan integración y pruebas |
| 4 | Papeletas, ranking y concurrencia | RN-07–11, 16, 18; AC-09–14, 17, 26, 31 | En progreso: smoke parcial de votos; faltan concurrencia, contratos y pruebas guardadas |
| 5 | Meta, inbox e intakes | RN-02, 04, 18; AC-19–23, 28, 30 | En progreso: inbox inicial y pruebas parciales; recuperación y servicios externos pendientes |
| 6 | Admin, resultados y auditoría | RN-03, 09–14, 16–18; AC-18, 24–27, 29, 31 | Pendiente de implementación y verificación |
| 7 | Docker, carga y ensayo de staging | AC-06, 17, 20–21, 30; supuestos de sección 2 | Pendiente de herramientas y acceso; sin despliegue |

Cada AC requiere una prueba automatizada; registrar evidencias y limitaciones por bloque conforme se ejecuten. Las comprobaciones con servicios simulados no sustituyen los spikes reales de Meta, Supabase y reproducción móvil.

Evidencia parcial del bloque 1: build y 3 pruebas unitarias aprobados; lint y 2 E2E aprobados con acceso escalado a loopback tras corregir la ruta de salud. La migración Drizzle pasó en una base aislada vacía con fixture `auth.users`: 10 de 10 tablas tienen RLS, existe el singleton `(1, open)` y un rol sin bypass con permisos SELECT/UPDATE no vio ni actualizó filas. La revisión estática confirmó la FK externa sin crear `auth.users`. Repetir los checks integrados al terminar el bloque; esta evidencia local no sustituye una comprobación de políticas y privilegios en Supabase.

Evidencia parcial del bloque 2: smoke local con Postgres y JWKS ES256 comprobó creación de perfiles participant y admin, `human_verified = false` y 401 sin Bearer. Un segundo smoke comprobó `/event` 200 y estado efectivo abierto tras corregir un error 500. Falta guardar pruebas automatizadas equivalentes y verificar el contrato completo.

Evidencia parcial del bloque 3: smoke con Postgres, JWKS local, Sharp real y Storage en memoria comprobó rechazo de escritura sin verificación humana, cupo de fotos y liberación tras borrado lógico, archivo falso con 422 `MEDIA_INVALID` y anonimato con `is_mine`. No sustituye pruebas automatizadas guardadas ni integración real con Storage.

Evidencia parcial del bloque 4: smoke local HTTP y Postgres comprobó rechazo de voto sin verificación, puntos, reemplazo y auditoría, voto propio, compactación/restauración y rechazo de voto con cierre manual o vencimiento. La moderación del smoke fue por SQL, no por API. IDs duplicados devolvieron 400 en vez del 422 especificado. Faltan pruebas guardadas, cierre concurrente y señales de intentos.

Actualización de pruebas: `test/gala.e2e-spec.ts` guarda 13 pruebas aprobadas con Postgres real y JWKS, Turnstile y Storage simulados; cubren AC-01–05 y AC-07–16, con moderación de AC-13 vía SQL. La suite confirma 422 para AC-09 tras la corrección. Quedan pendientes cierre concurrente y cobertura mediante API de moderación. El typecheck general aún detectó un problema de tipos en `test/app.e2e-spec.ts`.

Actualización posterior: la suite define 27 pruebas para AC-01–31; AC-06 sintético se omite sin FFmpeg. AC-19 y AC-30 pasaron tras migración 0001; los demás casos nuevos esperan los módulos correspondientes y aún no constituyen evidencia de aprobación. El typecheck general pasó antes de añadir AC-06; debe repetirse sobre el árbol final. Continúan pendientes los spikes reales y la revisión de recuperación de WhatsApp.

Evidencia posterior del bloque 5: 6 E2E pasaron con Postgres real y Graph simulado, cubriendo AC-19–23, 28 y 30; el typecheck general también pasó. Siguen pendientes los casos terminales y de recuperación identificados en revisión, staging y la integración real con Meta. No se considera cerrado el bloque.

Carga local preliminar del bloque 7: 1000/1000 votos respondieron 200 a una oferta de 100/s, pero p95 de 100 lecturas `/submissions` fue 2456,5 ms, superior al objetivo de 300 ms. El escenario usó los mismos cinco candidatos; requiere diagnóstico y repetición representativa. El bloque no está aprobado.

Verificación posterior: E2E completo reportó 25 pruebas aprobadas, incluidas concurrencia real de 50 votos (AC-17), AC-18, 24–27 y AC-30 con tres intentos y limpieza. Fallaron AC-29 por ausencia de carga manual admin (404; la parte de cupo de participante pasó) y AC-31 por ausencia de limitador; video sintético y benchmark son opt-in y quedaron omitidos. Una carga distribuida con logs descartados mantuvo 1000/1000 votos 200 y p95 de lecturas 2039,4 ms: sigue sin cumplir el objetivo. Ningún bloque queda aprobado solo por estos resultados parciales.

Actualización: tres E2E nuevos o revisados pasaron: AC-13 modera y restaura por API admin, AC-29 incluye carga manual, y se comprueban PATCH `/me`, `/me/submissions` y uso. El fallo anterior de AC-29 queda corregido; siguen pendientes AC-31, Docker y una carga que cumpla el objetivo.

Última verificación funcional local: 30 E2E aprobados, 2 omitidos (video y carga opt-in), 3 unitarias aprobadas y typecheck general sin errores; AC-31 ya pasó. La cobertura funcional local queda cumplida con las reservas de AC-06 real, integraciones externas, carga y staging. Docker y los spikes siguen en curso; no implica autorización ni preparación para desplegar.
