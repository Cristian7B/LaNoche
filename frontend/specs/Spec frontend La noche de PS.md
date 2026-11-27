# Spec frontend — La noche de PS

## Estado y fuente de verdad

Borrador funcional y visual para implementar el frontend Astro. La spec del backend en `../../backend/specs/Spec backend Votaciones Gala PS.md` y su API son fuente de verdad para reglas y datos. Esta spec complementa el backend y documenta el código observado; no redefine sus reglas.

## Producto y dirección visual

Web mobile-first para la gala **La noche de PS** y las categorías **Mejor foto de la historia de PS** y **Mejor sticker de la historia de PS**. Participantes ingresan con Google, postulan y emiten papeletas ordenadas. Admins moderan, cierran y proyectan resultados. Canales: Astro web y bot WhatsApp que recibe stickers.

La landing ocupa exactamente `100svh` (fallback `100vh`) y no tiene scroll vertical. Las pantallas de aplicación sí pueden desplazarse. Todo el producto usa dark mode, elegancia nocturna, trazos astrales simples y acentos lima sobre violeta oscuro. La diapositiva adjunta inspira atmósfera y tipografía editorial, no su composición. La imagen de Nueva York inspira vibe ilustrada, no diseño literal. Reutilizar tokens de `src/assets/styles/variables.css` y el logo correcto de `public`. Probar Instrument Serif en titulares y una sans legible para controles y cuerpo. Mobile-first, targets táctiles cómodos, safe areas, navegación inferior fija en móvil y navegación lateral/superior en desktop. WCAG 2.2 AA como objetivo.

## Roles y estados

- Visitante: landing y resultados una vez publicados.
- Participante: Supabase Auth Google, perfil, verificación humana, postulaciones, reclamo de intakes y votos.
- Admin: rol `admin`; proteger rutas en UI y confiar siempre en autorización backend.
- `open`: postular/votar habilitado, ranking reservado a admin.
- `closed`: se bloquean escrituras.
- `results_published`: público consulta resultados finales.

El estado efectivo del backend es autoridad. Manejar además sesión expirada, error API, carga, vacío y offline con recuperación clara.

## Configuración y seguridad

Variables cliente: `PUBLIC_API_BASE_URL`, `PUBLIC_SUPABASE_URL`, `PUBLIC_SUPABASE_ANON_KEY` y configuración pública necesaria de OAuth/Turnstile. Nunca incluir secretos Supabase, Meta o backend en el bundle. El backend requiere CORS `WEB_URL` igual al origen de producción. No enviar email, teléfono, token de intake ni contenido privado a analytics. No registrar el token de `/s/:token`.

## Contrato backend conocido

Prefijo `/api/v1`, JSON en snake_case, privados con `Authorization: Bearer <Supabase access token>`.

- `GET /event`.
- `GET /me`, `PATCH /me`, `POST /me/verify-human`.
- `GET /submissions?category=photo|sticker`, `GET /submissions/:id`, `POST /submissions` multipart (`files`, `category`, `title`, `description`), `PATCH /submissions/:id`, `DELETE /submissions/:id`, `GET /me/submissions`.
- `GET /votes/me`, `PUT /votes/:category` con `{submission_ids: [...]}`.
- `GET /results`: anónimo solo después de publicar; Bearer opcional, inválido puede responder 401.
- `GET /intakes/:token`, `POST /intakes/:token/claim` con `{title, description}`.
- Admin: `/admin/dashboard`, `/admin/event/close|reopen|publish-results|unpublish-results`, `/admin/settings`, `/admin/submissions`, `/admin/submissions/:id`, `/admin/submissions/:id/restore`, `/admin/ranking`, `/admin/results/onsite`, `/admin/users`, `/admin/users/:id`, `/admin/audit/signals`, `/admin/audit/votes`, `/admin/actions`.
- Webhook WhatsApp es solo servidor; no llamarlo desde navegador.

## Contratos verificados contra backend

Referencia: controladores y servicios en `backend/src/{event,auth,submissions,media,intakes,votes,results,admin}`. Son contratos del código observado, sujetos a verificación en despliegue. Todos requieren Bearer salvo `GET /event` y `GET /results` (Bearer opcional; inválido puede fallar). El preview de intake requiere sesión. Errores: `{error:{code,message,details?}}`.

### Evento y sesión (AC-F01–03, AC-F11)

- `GET /event`: `{status,effective_status,closes_at,server_time,limits:{max_votes_per_category,max_photo_submissions,max_sticker_submissions,max_images_per_photo},bot_wa_link}`. Fechas ISO; cierre y enlace pueden ser null. `effective_status` gobierna acciones; `server_time` permite compensar reloj. Fecha vencida puede producir estado efectivo cerrado antes de actualizar `status`.
- `GET /me`: `{id,email,display_name,avatar_url,role,human_verified,usage:{submissions:{photo,sticker},votes:{photo,sticker}}}`. `PATCH /me` recibe `{display_name}` recortado 2–60 caracteres. `POST /me/verify-human` recibe `{turnstile_token}` y responde 204. Ante `HUMAN_VERIFICATION_REQUIRED`, verificar y reintentar conservando datos locales.
- OAuth Google usa Supabase cliente y `/auth/callback`; no existe callback backend. Registrar callback en Supabase y validar retorno como ruta interna. No registrar token de intake. Configuración real se verifica en despliegue.

### Postulaciones y medios (AC-F04–06)

- `GET /submissions?category=photo|sticker` devuelve array completo de publicados, sin paginación, en orden seudoaleatorio estable por usuario. Elemento `{id,category,title,description,is_mine,created_at,media}`; medio `{id,kind,url,thumb_url,width,height,position,duration_ms?}`, kind image o video. Detalle y `/me/submissions` incluyen `status`, `source`, `delete_reason?` para propietario; lista propia incluye eliminadas. Estados: `published`, `deleted`.
- `POST /submissions` multipart: `category`, `title` 3–120, `description` 10–1000, `files` repetidos en orden. Foto: 1 hasta `max_images_per_photo`, JPEG/PNG/WebP. Sticker directo: exactamente un JPEG/PNG/WebP/GIF/MP4/WebM, máximo 10 s animado. El servidor detecta contenido y procesa; bytes máximos configurables no se publican (10 MiB por defecto no garantiza despliegue). Tratar `MEDIA_INVALID`, `VALIDATION_ERROR`, `QUOTA_EXCEEDED`, `EVENT_NOT_OPEN` y verificación; no imponer límite fijo desconocido.
- `PATCH /submissions/:id` solo título y/o descripción; `DELETE` responde 204. Ambas requieren propietario, publicado, verificación y evento abierto. Confirmar eliminación y refrescar uso y listas. Mostrar URLs y kind devueltos.
- `GET /intakes/:token` requiere sesión y devuelve `{status:'ready',category,media,expires_at}`. `INTAKE_NOT_READY` 409 indica procesamiento (preview incluye `Retry-After: 2`); `INTAKE_EXPIRED` 410, `INTAKE_ALREADY_CLAIMED` 409 y `NOT_FOUND` 404 son distintos. `POST /intakes/:token/claim` recibe `{title,description}`, mismos límites, requiere verificación y evento abierto y responde postulación; también manejar cuota. Login precede preview y conserva retorno interno sin registrar token.

### Votos y resultados (AC-F07–08, AC-F10)

- `GET /votes/me` devuelve `{photo:{category,items:[{position,submission}]},sticker:{category,items:[...]}}`. `PUT /votes/:category` recibe `{submission_ids:[UUID...]}` ordenados, reemplaza toda la papeleta y devuelve `{category,items}`. Admite vacío; máximo dinámico y absoluto 10, sin duplicados. Modificable mientras abierto y verificado. Refrescar papeleta y uso; una postulación eliminada desaparece de lectura.
- Puede rechazarse autovoto con `SELF_VOTE_NOT_ALLOWED`. `allow_self_vote` no aparece en `/event`; no asumir configuración. Manejar error y permitir corregir.
- `GET /results` responde 403 `RESULTS_NOT_PUBLISHED` antes de publicar; luego `{photo:[rankingItem],sticker:[rankingItem]}` limitado al máximo dinámico. Item: `rank`, `submission`, `score`, `first_place_votes`, `total_votes` y `author_name` solo si se permite. Orden por puntos, primeros lugares, votos totales, fecha e ID; rangos secuenciales. Ranking admin añade `by_position`. Onsite devuelve ranking completo: revelar hasta cinco primeros disponibles en orden descendente.

### Administración (AC-F09–10)

- `GET /admin/dashboard`: `{event,users,submissions:{photo,sticker,deleted},voters:{photo,sticker},votes_total,intakes:{ready,claimed,failed}}`. POST `event/close`, `reopen`, `publish-results`, `unpublish-results` devuelven evento; transición inválida `INVALID_TRANSITION`. `open→closed→results_published`, reversos explícitos. Reabrir con fecha vencida no implica estado efectivo abierto.
- `PATCH /admin/settings` acepta `closes_at` ISO con zona o null, `max_votes_per_category` 1–10, `max_photo_submissions` y `max_sticker_submissions` 0–20, `allow_self_vote` y `show_author_in_public_results` booleanos. Al menos un campo. Cambiar máximo tras una papeleta no vacía falla `VALIDATION_ERROR`, `details.reason: votes_exist`. No existe GET settings y `/event` omite booleanos: no presentar valores supuestos; encargo backend exponer lectura autorizada o diseñar cambios explícitos sin estado inicial.
- `GET /admin/submissions` acepta category, status (`published` por defecto, `deleted`, `all`), q, limit 1–200 y cursor; devuelve `{items,next_cursor}`. Crear multipart con `author_label` y `author_id?`, editar título/descripción/autor, borrar con `reason?`, restaurar; restauración puede fallar por cupo. No hay aprobación/rechazo. Lista admin no incluye medios.
- `GET /admin/users` filtra q por email, blocked, limit 1–100 y cursor; PATCH `{is_blocked}`. `/admin/audit/votes` y `/admin/actions` usan `{items,next_cursor}`; `/admin/audit/signals` devuelve objeto de arrays sin paginación. `/admin/ranking?category=...` devuelve array. `/admin/results/onsite` devuelve `{photo,sticker}` completo y rechaza evento efectivo abierto con `EVENT_STILL_OPEN`.

### Encargos de integración

1. Backend: exponer lectura de booleanos de settings y límites reales de bytes; hasta entonces manejar errores sin inventar configuración. Confirmar OAuth, CORS, Turnstile y enlaces en despliegue.
2. Frontend: cliente tipado y errores centrales; callback con retorno interno seguro; estados de carga, vacío, offline y sesión expirada. Solo acciones existentes; no registrar token o datos sensibles.
3. QA: contrastar instancia desplegada y probar expiración de sesión, cambio de estado durante formularios, cuotas concurrentes, papeleta vacía/autovoto, intake procesándose y publicación. Pendiente hasta tener instancia configurada.
## Mapa de rutas

Público/participante: `/` landing/login, `/app` hub, `/app/submissions/new`, `/app/submissions/:id`, `/app/me/submissions`, `/s/:token`, `/app/vote/:category`, `/app/vote/:category/review`, `/app/ranking`, `/auth/callback`.

Admin: `/admin` dashboard, `/admin/moderation`, `/admin/live-ranking`, `/admin/users`, `/admin/results`, `/admin/settings`.

Todas admiten deep link/recarga y definen carga, error, vacío y offline.

## Requisitos por pantalla

### Landing y sesión

Landing explica gala y categorías en pocas líneas, refleja estado real y ofrece **Continuar con Google**. Debe caber en viewport pequeño sin scroll. OAuth maneja cancelación y retorna a la ruta original. Hub saluda al participante, enseña estado, cupos desde `/me`, accesos Subir/Votar/Ranking y navegación persistente móvil. Antes de una acción protegida, completar Turnstile vía `/me/verify-human` si falta verificación, preservando el formulario cuando sea posible.

### Postulaciones

Foto: seleccionar varias imágenes hasta el límite real, ordenar/quitar, título obligatorio, descripción obligatoria, preview fiel y validación local de formato/tamaño; el servidor manda. Sticker: CTA al enlace `bot_wa_link` cuando exista y opción de subida directa admitida por API. Confirmación permite volver a subir o votar. Mis postulaciones refleja exactamente estados/acciones reales de API; editar/eliminar solo mientras API lo autorice y evento abierto.

### Reclamar sticker

En `/s/:token`, login con retorno a la ruta antes del preview. Mostrar preview estático/animado, título, descripción y Postular. Cubrir cargando, expirado, usado, no encontrado, evento cerrado, no verificado, cupo agotado y éxito según errores reales del API.

### Votar

Dos categorías y papeleta actual desde API. Listado completo devuelto por API; renderizar progresivamente si conviene. Selección/desselección con posición de orden; revisión permite reordenar/quitar. Máximo dinámico. Detalle accesible con imagen/video, título y descripción. Aclarar que PUT reemplaza la papeleta completa; permitir modificarla mientras abierto si backend lo admite. Confirmar y refrescar estado tras guardar. Conservar el orden estable proporcionado por API.

### Ranking

Durante `open`, texto “El ranking se revela al final”; cuenta regresiva solo si hay fecha confiable. Público consulta `/results` una vez publicado, mostrando solo campos devueltos y nombre autor según visibilidad backend. Admin ranking refresca manualmente o con polling moderado.

### Admin

Dashboard usa métricas reales y confirma cierre/publicación/reapertura. Moderación solo ofrece acciones existentes. Ranking presenta posiciones, puntos y votos según respuesta. Usuarios, auditoría de votos y acciones consumen endpoints paginados; señales no pagina. Settings solo edita campos del contrato. Onsite fullscreen revela puestos de 5 a 1 con teclado/touch, adapta la cantidad real y protege salida accidental.

## Criterios de aceptación

- **AC-F01** Landing sin scroll vertical en móvil y desktop, con identidad, estado y OAuth.
- **AC-F02** OAuth llega al hub y retorna a deep link protegido.
- **AC-F03** Estado efectivo gobierna todas las acciones y mensajes.
- **AC-F04** Flujo de foto valida/ordena archivos y refleja errores/confirmación API.
- **AC-F05** WhatsApp → login si falta sesión → preview intake → claim cubre estados y éxito.
- **AC-F06** Mis postulaciones refleja exactamente estado y acciones API.
- **AC-F07** Votación de ambas categorías ordena y reemplaza papeleta según API.
- **AC-F08** Ranking público se oculta antes de publicación y luego muestra datos reales.
- **AC-F09** Admin ofrece acciones autorizadas y protege rutas.
- **AC-F10** Onsite revela puestos devueltos y funciona fullscreen.
- **AC-F11** Loading/vacío/error/offline/sesión expirada son recuperables.
- **AC-F12** Flujos clave operan por teclado y móvil sin overflow horizontal.
- **AC-F13** No se filtran secretos, tokens ni datos personales no autorizados.

## Entrega por etapas

1. Confirmar contratos abiertos y cliente API/tipos/sesión.
2. Tokens, layout responsive, landing y estados globales.
3. Hub, perfil y postulaciones.
4. OAuth, Turnstile, intakes y retorno del bot.
5. Votación y papeletas.
6. Ranking y administración.
7. Onsite, accesibilidad, seguridad y ensayo end-to-end.

Mantener trazabilidad `requisito → ruta/componente → endpoint → AC-F → prueba/evidencia`. Cada historia dependiente espera contrato resuelto.

## Trazabilidad de implementación y evidencia

| Requisito | Ruta/componente | Endpoint | Aceptación | Evidencia requerida |
|---|---|---|---|---|
| Landing, estado, sesión | `/`, `/auth/callback`, cliente sesión | `/event`, `/me` | AC-F01–03 | viewport pequeño, callback/deep link y estado efectivo |
| Postulaciones | `/app/submissions/*`, `/app/me/submissions` | `/submissions`, `/me/submissions`, `/me/verify-human` | AC-F04, AC-F06 | medios, límites, edición, eliminación y errores |
| Reclamo WhatsApp | `/s/:token` | `/intakes/:token`, `/intakes/:token/claim` | AC-F05, AC-F13 | login, espera, expiración, reclamo y privacidad |
| Papeletas | `/app/vote/:category`, `/app/vote/:category/review` | `/submissions`, `/votes/me`, `/votes/:category` | AC-F07 | orden, reemplazo, vacío, límite y autovoto |
| Resultados | `/app/ranking` | `/event`, `/results` | AC-F08 | oculto antes y datos publicados |
| Administración y onsite | `/admin/*` | `/admin/*` | AC-F09–10 | autorización, transiciones, paginación y revelación |
| Estados y accesibilidad | layouts y controles compartidos | todos | AC-F11–13 | teclado, móvil, recuperación y privacidad |

La evidencia queda pendiente hasta ejecutar cada flujo contra una instancia configurada.
## Evidencia de revisión — 27 nov 2026

- Contratos contrastados estáticamente con controladores y servicios backend; no sustituye prueba contra instancia configurada.
- Revisión estática de landing, sesión, postulaciones, papeletas, administración y onsite comunicada al equipo de implementación; defectos y correcciones requieren reevaluación antes de dar por cumplidos los AC.
- `npm run build` generó 14 rutas estáticas, incluidas `/s/index.html` y `/admin/onsite/index.html`. El middleware de Astro, `public/_redirects` y `vercel.json` declaran rewrites de intake para desarrollo, Netlify y Vercel respectivamente; la existencia de configuración no demuestra comportamiento en hosting.
- El primer intento de `astro dev --background` falló con `EACCES` en conexión local `127.0.0.1:59995`; posteriormente el coordinador verificó HTTP 200 para `/s/synthetic-smoke-token` en desarrollo tras activar el plugin. Pendientes pruebas de deep link y recarga en Netlify y Vercel, además de OAuth, Turnstile, API, teclado y viewport reales.

### Cierre local y ensayo externo

- El coordinador verificó el build final de 16 rutas y respuestas HTTP 200 locales para todas ellas, incluida `/s/synthetic-smoke-token`. Esto acredita entrega de páginas, no comportamiento funcional ni configuración del hosting.
- Revisión estática confirmó el tipo de límites del dashboard y llamadas de reset de Turnstile tras error y desmontaje al cancelar edición. Pendiente verificar cambio de contenedor de verificación entre tarjetas y el comportamiento real del widget.
- Ensayo externo pendiente con servicios configurados: Google OAuth y retorno, Turnstile, API y base de datos, WhatsApp y reclamo, medios, papeletas, transiciones, resultados y onsite; verificar teclado, móvil y deep links/recargas en Netlify y Vercel.
