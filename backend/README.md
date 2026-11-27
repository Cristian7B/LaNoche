# Votaciones Gala PS API

REST API para la web de votaciones y el bot de WhatsApp. Requiere Node.js 24, pnpm y PostgreSQL. Las migraciones se ejecutan como paso de release; la API no modifica el esquema al arrancar.

## Configuración local

1. Copia `.env.example` a `.env` y configura credenciales de Supabase, Turnstile y WhatsApp, incluido el enlace público `WA_BOT_LINK`. Genera `WA_TOKEN_ENCRYPTION_KEY` como 32 bytes codificados en base64url; no reutilices la clave de ejemplo.
2. Inicia PostgreSQL de desarrollo y la API:

```bash
docker compose up --build
```

Compose incluye una base local con un stub de `auth.users` para desarrollo. No la conectes a datos de producción. La API queda en `http://localhost:3000`; health check en `/api/v1/health`.

Para instalar y ejecutar la API directamente:

```bash
pnpm install --frozen-lockfile
pnpm run db:migrate
pnpm run start:dev
```

`DATABASE_URL` debe apuntar a una base de prueba o al session pooler de Supabase. En production, usa secretos administrados para las llaves; `.env` no se versiona.

## Comandos

```bash
pnpm run build
pnpm test
pnpm run test:e2e
pnpm run lint
pnpm run db:generate -- --name=change_name
pnpm run db:migrate
```

Los E2E usan PostgreSQL desechable y dobles para JWKS, Storage, Turnstile y Graph. El test de carga se activa solo con `GALA_LOAD_TEST=1`. La conversión de stickers animados necesita ffmpeg y ffprobe; la imagen Docker instala ambas herramientas y ImageMagick para inspección/fallback.

## Docker

`Dockerfile` ofrece las etapas `build`, `test` y `runtime`. `build`/`test` conservan fuentes, dependencias de desarrollo, ffmpeg y ImageMagick para las verificaciones de medios. `runtime` contiene el build compilado, dependencias de producción, ffmpeg y corre como usuario no privilegiado.

Para construir y ejecutar:

```bash
docker compose up --build
```

El servicio `migrate` aplica migraciones antes de iniciar `api`. En despliegues persistentes usa PostgreSQL administrado y configura el servicio para no dormir. Ejecuta la prueba de carga y valida el flujo real de Meta en un entorno de staging antes de una gala.

## API

Los endpoints de la aplicación viven bajo `/api/v1`, salvo `GET` y `POST /webhooks/whatsapp`. JSON usa `snake_case`. Todas las rutas privadas requieren JWT de Supabase; los resultados públicos aceptan Bearer opcional y rechazan tokens inválidos.

La especificación funcional completa está en [`specs/Spec backend Votaciones Gala PS.md`](specs/Spec%20backend%20Votaciones%20Gala%20PS.md).
