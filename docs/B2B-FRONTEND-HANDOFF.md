# Entrega de contrato B2B a Mandaria Frontend

2026-10-01. Contrato y guías; no implementación de portal o administración web. No cambios en frontend, Nginx, credenciales, flags, base ni acceso al Swagger completo.

## Artefactos públicos

- `docs/openapi-b2b.json`: único OpenAPI destinado al portal; 15 operaciones revisadas por método+ruta y componentes transitivos necesarios. No publicar `docs/openapi.json` como sustituto.
- `docs/B2B-PUBLIC-GUIDE.md`: flujo vigente, permisos, vencimiento y recuperación.
- `docs/B2B-WEBHOOKS.md`: contrato saliente y responsabilidades del receptor.
- `docs/examples/verify-mandaria-webhook.mjs`: ejemplo Node ejecutable que verifica firma sobre Buffer; sin servidor ni persistencia implementados.
- `docs/examples/b2b-flow.json`: cuerpos ficticios de emisión/conversión/aceptación. Fechas, contactos, IDs y coordenadas sólo ilustrativos; no disparar peticiones automáticamente.

Esta entrega administrativa es interna: **no publicar este documento ni el inventario de administración dentro de la referencia API pública**.

## Generación y verificación reproducibles

Node 24 compatible con el repositorio, dependencias instaladas. Desde raíz del backend:

```sh
npm run docs:b2b
npm run docs:b2b:check
npm run test:public-b2b
npm run lint
npm run lint:eslint
npx tsc --noEmit -p tsconfig.json
npx tsc --noEmit -p tsconfig.build.json
```

`docs:b2b` ejecuta `docs:openapi` (incluye Nest build) y exporta el contrato público. `docs:b2b:check` regenera metadata en memoria desde código compilado mediante `docs:check`, comprueba OpenAPI completo/matriz y luego compara el público; no sobrescribe documentos. Así, un JSON público acorde a un JSON interno viejo tampoco pasa. `test:public-b2b` corre completos ambos archivos de pruebas Node con `--test-isolation=none`: evita crear procesos hijos en estas pruebas puras y no omite casos ni cambia el runner E2E. No necesita base ni `.env` real. El ejemplo de firma se prueba con claves ficticias en memoria.

Cambiar un endpoint público exige revisar lista explícita en `scripts/export-public-b2b.mjs`, esquemas permitidos y catálogo editorial `scripts/public-b2b-prose.json`, actualizar pruebas independientes y regenerar. Seguridad heredada se resuelve y materializa en cada operación; combinaciones OR/AND con otro esquema o acceso anónimo alternativo se rechazan. Referencias externas, callbacks/links nuevos y componentes no revisados fallan; nunca se copian silenciosamente. Campos/prosa nuevos necesitan revisión: el exportador no reemplaza una revisión de privacidad de cambios de DTO. Los ejemplos son datos de documentación, no lecturas de usuarios.

## Origen de la API y publicación

Propietario confirma web **https://mandaria.com.mx** y API **https://mandaria.com.mx/api/v1**. El artefacto usa `servers[0].url=https://mandaria.com.mx`, sin `/api/v1`, porque cada path ya incluye ese prefijo. URL resultante de ejemplo: `https://mandaria.com.mx/api/v1/integrations/token`. No usar una base API prefijada al concatenar paths OpenAPI.

**Frontend debe sincronizar nuevamente `docs/openapi-b2b.json` y estas guías**, retirando cualquier override del dominio ficticio anterior. El visor y la descarga deben conservar el origen absoluto confirmado incluso si el portal se publica en otro dominio; no usar `/` como servidor. Para un entorno distinto, adaptar explícitamente el origen y mantener trazabilidad, sin adivinar dominios. Confirmación del propietario, no verificación remota nueva.

Portal anónimo separado de Protected/AdminLayout y de restauración obligatoria de sesión. No enviar JWT humano, clientSecret o secreto HMAC desde el portal. Recomendación inicial: referencia y ejemplos copiables sin Try it out contra producción. Publicar JSON como `application/json`, no fallback de SPA, comprobar enlaces directos y descarga sin sesión. Versionar artefacto por revisión/build además del número de paquete, que no cambia aquí. La guía de webhooks acompaña al OpenAPI: el JSON 3.0 de rutas entrantes no representa por sí solo el callback saliente.

## Administración de webhooks existente

Base `/api/v1`, **User Bearer + SUPER_ADMIN**. No es self-service con token de IntegrationClient. Fuente: `src/b2b-webhooks/admin-b2b-webhooks.controller.ts`, DTOs en `b2b-webhooks.dto.ts`, lógica en `webhook-operations.service.ts` y `b2b-webhooks.service.ts`.

| Método/ruta | Entrada → respuesta | HTTP/códigos relevantes |
|---|---|---|
| GET `/admin/integrations/:id/webhook` | UUID → `WebhookEndpointResponse` | 200; 404 HTTP_404 si no hay endpoint |
| PUT `/admin/integrations/:id/webhook` | `UpsertWebhookEndpointDto` → `WebhookEndpointResponse` | 200 tanto crear como actualizar; 400 VALIDATION_ERROR; 404 HTTP_404 cliente inexistente |
| POST `/admin/integrations/:id/webhook/secret` | UUID, sin body → `WebhookSecretResponse` | 200; 404 HTTP_404 endpoint inexistente; 400 VALIDATION_ERROR si clave de firma no usable/configurada |
| GET `/admin/integrations/:id/webhook/summary` | UUID → `WebhookClientSummaryResponse` | 200; cliente sin filas produce conteos cero, no comprobación de existencia |
| GET `/admin/integrations/:id/webhook/deliveries` | UUID → `WebhookDeliveryResponse[]` | 200; hasta 100 recientes, sin paginación; sin filas devuelve [] |
| GET `/admin/b2b-events` | `AdminEventListQueryDto` → `AdminEventPageResponse` | 200; 400 VALIDATION_ERROR para filtros/fechas inválidos |
| GET `/admin/b2b-events/:eventId` | UUID → `AdminEventDetailResponse` | 200; 404 HTTP_404 si evento inexistente |
| GET `/admin/webhooks/health` | sin body → `WebhookHealthResponse` | 200 |
| POST `/admin/b2b-events/:eventId/rescue` | UUID → `WebhookRescueResponse` | 200 RESCHEDULED o ALREADY_PENDING; 409 WEBHOOK_DELIVERY_NOT_TRACKED / WEBHOOK_ALREADY_DELIVERED |
| POST `/admin/b2b-events/:eventId/deliver` | UUID → `WebhookAttemptResponse` | 200 attempted/skipped; 409 WEBHOOK_DELIVERY_IN_PROGRESS; 404 HTTP_404 |

Las últimas dos rutas ya existen: inventario únicamente, **fuera de nueva implementación de rescate/envío manual**. Un 200 de ellas no equivale necesariamente a envío correcto. Todas pueden fallar con 401/403 por autenticación/rol, 400 por UUID/validación y 5xx de infraestructura. El código exacto de errores genéricos viene del filtro, p. ej. HTTP_401/HTTP_403/HTTP_400; no inferirlo sólo del HTTP. Respuesta común: `statusCode`, `code`, `requestId`, `message`, `errors`, `timestamp`, `path`. Conservar code/requestId; no mostrar SQL ni cuerpos completos en notificaciones.

### DTOs y semántica que debe respetar la UI

- **UpsertWebhookEndpointDto:** `url` string requerido, máximo 2048; `enabled` boolean opcional, default backend **true**. Enviar siempre el boolean explícito. URL pública HTTPS sin usuario/password ni fragmento; controles SSRF también al entregar.
- **WebhookEndpointResponse:** id, integrationClientId, url, enabled, deliverFrom, secretConfigured, secretSetAt nullable, createdAt, updatedAt. No secret ni ciphertext. Algunas fechas nullable del Swagger administrativo tienen metadata genérica; en runtime son ISO string/null, no objetos arbitrarios.
- **WebhookSecretResponse:** secret, secretSetAt, algorithm=HMAC-SHA256, signatureHeader=X-Mandaria-Signature, signedMessage y note. Mostrar una sola vez en estado local; no Query cache, storage ni logs. Cerrar al navegar/logout/pagehide. No retry automático ante respuesta perdida ni doble submit. Rotación inmediata sin convivencia; advertir posible petición en vuelo firmada antes del cambio.
- **AdminEventListQueryDto:** page default 1 (máximo 100000), pageSize default 20 (máximo 100); integrationClientId UUID; type=DELIVERY_COMPLETED (filtro interno), transportState; deliveryRequestPublicId; externalReference exacta; occurredFrom/occurredTo ISO. Fechas invertidas se rechazan.
- **AdminEventPageResponse:** items, page, pageSize, total, totalPages. Evento incluye eventId, type público delivery.completed, cliente, MDR/referencia, fechas, transportState, noDeliveryReason, attemptCount e inFlight.
- Estados: PENDING, DELIVERED, EXHAUSTED, NO_DELIVERY (derivado). Razones reales: **NO_ENDPOINT, BEFORE_BOUNDARY, NOT_YET_PICKED_UP**. NO_ENDPOINT también puede corresponder a falta de secreto: consultar endpoint. NO_DELIVERY no significa evento perdido.
- **AdminEventDetailResponse:** resumen anterior + payload congelado, endpoint actual e intentos. Cada intento incluye id, attemptNumber nullable, attemptedAt, durationMs, result SUCCEEDED/FAILED, httpStatus, failureKind, failureDetail y **endpointUrl histórico**. Mostrar destino del intento, no sustituirlo por el actual. No hay cuerpo de respuesta remota.
- **WebhookClientSummaryResponse:** events, pending, delivered, exhausted. El total de eventos puede superar la suma de estados por eventos fuera de transporte.
- **WebhookHealthResponse:** pending, exhausted, delivered, leased, oldestPendingDueAt y thisInstance {workerEnabled, pollSeconds, leaseSeconds, lastPollAt}. Los conteos son compartidos; thisInstance no acredita salud de todas las réplicas.

Deuda preexistente: la validación DNS del transporte no fija la IP del socket; el README documenta una ventana de DNS rebinding. Esta entrega no la corrige ni acredita seguridad adicional del transporte.

Configuración no prueba conectividad. Habilitar no garantiza worker activo ni secreto correcto. Deshabilitar conserva pendientes, pero no cancela peticiones ya tomadas/en vuelo. La UI puede guiar “guardar deshabilitado → generar secreto → configurar receptor → habilitar”; no genera eventos de prueba ni envía solicitudes automáticamente.

## Swagger completo: situación y propuesta separada

`src/setup.ts` registra Swagger completo en `/docs` sin guard explícito. La dependencia instalada sirve además `/docs-json` y `/docs-yaml` por defecto. Lectura actual de `../mandaria-frontend/nginx.conf`: `location /docs` hace proxy al backend y también abarca esas dos rutas, sin restricción de acceso en ese bloque. No se verificó exposición remota en esta tarea. El contrato filtrado no protege esa ruta ni sus recursos JSON por sí solo.

### Propuesta concreta para producción (no aplicada)

1. **Cerrar Swagger completo en el ingreso público:** sustituir en una tarea autorizada el proxy público por denegación (404) de `/docs`, `/docs/` y todos sus recursos, `/docs-json` y `/docs-yaml`. Reservar el prefijo `/docs` para uso interno y bloquear cualquier variante/alias que lo publique. No modificar `/api/v1` ni sus guards.
2. **Conservar acceso de soporte por túnel SSH:** permitir Swagger completo sólo por la interfaz privada/loopback del backend, accesible mediante túnel de un operador autorizado. El puerto backend no debe admitir conexiones públicas que eludan nginx: comprobar binding y firewall antes de considerar aplicada la restricción. Conservar autenticación SSH individual y revocación de acceso; no introducir claves compartidas en el portal. Estas condiciones son requisitos propuestos, no garantías de la VM actual.
3. **Portal anónimo separado:** proponer `/developers` y `/developers/openapi-b2b.json` como rutas de publicación, todavía no implementadas. Servir allí sólo el artefacto filtrado y las dos guías públicas, sin login, sin proxy a Swagger completo y sin publicar este handoff administrativo ni `docs/openapi.json`. Descarga JSON real, no fallback HTML. Visor sin ejecución automática ni secretos; inicialmente sin Try it out contra producción.
4. **Verificación antes de habilitar el cambio:** desde fuera, UI completa, JSON/YAML y assets no disponibles (404); puerto directo inaccesible. Desde túnel, soporte autorizado puede consultar Swagger. Portal y descarga públicos funcionan sin sesión, contienen sólo las 15 operaciones aprobadas y apuntan al origen confirmado. Comprobar HTTPS, rutas directas y que no quede copia del contrato completo en archivos estáticos, CDN o caché pública; invalidar copias administradas si existieran.

La decisión pendiente es aprobar ese modelo de soporte por SSH y designar sus operadores. En esta tarea **no se cambia setup, exposición, nginx, firewall ni frontend**, ni se prueban esos controles remotamente. Ocultar un enlace o el candado Bearer del visor no restringe la descarga del documento.

## Pruebas pendientes de frontend

Build/tipos, guards y accesos directos por rol; formulario y errores reales; secreto único con logout/respuesta tardía/perdida; tabla y filtros; distinción evento/transporte/intento; destino histórico; lector público sin sesión y API fuera del dominio del portal; JSON descargable; teclado y revisión visual móvil/escritorio. El borrador `.tmp/web-platform/webhooks.tsx` sigue sin integrar ni verificar visualmente. No acredita estas capacidades.
