# Mandaria — V1.10-B Credit Policy Engine

Plataforma independiente de logística y entregas. Mandaria y Coita Eats no comparten código, entidades Prisma ni PostgreSQL; su comunicación será exclusivamente API/eventos.

## Estado y arquitectura

V1.2 agregó DeliveryProvider y ProviderMembership al Core V1.0 y a las integraciones B2B V1.1. V1.4-A agregó Drivers, Vehicles y asignaciones con historial, límites efectivos y autoservicio de disponibilidad del Driver. V1.5-A agregó DeliveryRequest B2B (qué transportar). V1.6-A agrega ServiceType, zonas de servicio con GeoJSON, routing reemplazable (Google Routes), tarifas versionadas por bandas de distancia y DeliveryQuotes con vigencia y aceptación. V1.6.1-A agrega el aprovisionamiento real de cuentas PROVIDER_ADMIN y DRIVER por invitación con activación de cuenta (ver [Production User Provisioning](#production-user-provisioning-v161-a)). V1.7-A agregó el motor de despacho: al aceptar la Quote se abre un Dispatch para los proveedores elegibles y exactamente uno lo reclama (ver [Dispatch Engine](#dispatch-engine-v17-a)). V1.8-A agregó la asignación interna del proveedor: qué Driver y qué Vehicle de su flotilla ejecutan el servicio reclamado, con historial de reasignaciones (ver [Provider Driver & Vehicle Assignment](#provider-driver--vehicle-assignment-v18-a)). V1.9-A agrega el **segundo modelo de ejecución**: un repartidor habilitado por Mandaria toma un servicio por su cuenta, con sus propios vehículos y sin proveedor de por medio; ambos modelos compiten por el mismo Dispatch y exactamente uno gana (ver [Independent Drivers](#independent-drivers-v19-a)). V1.10-A agrega la base contable de los créditos Mandaria: una cuenta por proveedor y por repartidor independiente, con un ledger inmutable, recargas y ajustes manuales de SUPER_ADMIN; **todavía no se cobra ningún crédito al adjudicar servicios** (ver [Credit Accounts & Immutable Ledger](#credit-accounts--immutable-ledger-v110-a)). V1.10-B agrega el motor de políticas de créditos: cuánto cuesta adjudicarse un servicio según serviceType, quién paga y la distancia canónica, con versiones inmutables; **sólo calcula, no cobra** (ver [Credit Policy Engine](#credit-policy-engine-v110-b)). No hay Driver App, GPS ni tracking. Los resultados de verificación están en [VERIFICATION.md](VERIFICATION.md); el contexto entre agentes, en [BITACORA.md](BITACORA.md).

- Node.js 24, TypeScript estricto, NestJS 11, Prisma 6, PostgreSQL 17/18.
- `auth/`: User, contraseña Argon2id, access JWT y refresh revocable.
- `users/`: selección explícita de campos públicos.
- `integrations/`: clientes externos, administración, credenciales, JWT B2B, scopes.
- `providers/`: oferta logística, límites administrativos, memberships y acceso aislado por proveedor.
- `drivers/`, `vehicles/`, `assignments/`: capacidad logística V1.4 (perfiles Driver, vehículos, asignaciones y `/driver`).
- `delivery-requests/`: demanda B2B V1.5 y administración; `idempotency/`: registro reutilizable de Idempotency-Key.
- `geo/`, `service-zones/`, `routing/`, `rate-plans/`, `delivery-quotes/`: cotización V1.6 (geometría interna, zonas, RoutingProvider, tarifas y Quotes).
- `invitations/`, `mail/`: aprovisionamiento V1.6.1 (invitaciones, activación de cuenta y MailProvider).
- `dispatch/`: V1.7 Dispatch, candidatos, coberturas de proveedor, claim y liberación.
- `delivery-assignments/`: V1.8 asignación de Driver y Vehicle al Dispatch reclamado, con historial, reasignación y plazo.
- `independent-drivers/`: V1.9 perfil independiente, vehículos propios y las operaciones `take`/`release` del repartidor.
- `credits/`: V1.10-A cuentas de créditos, ledger inmutable, recargas y ajustes; sin cobro por servicio todavía.
- `credit-policies/`: V1.10-B políticas de créditos versionadas y cálculo puro del costo de un servicio; no debita cuentas.
- `health/`, `common/`, `config/`, `prisma/`: infraestructura compartida.
- `prisma/migrations/`: SQL versionado; no se usa db push ni reset.
- `test/`: servicios, HTTP y E2E; `scripts/`: bootstrap, pruebas y herramientas locales.

UsersModule exporta el servicio; AuthModule registra el controller de usuarios para evitar dependencias circulares. IntegrationsModule reutiliza los guards humanos exclusivamente para administración.

## Instalación local

### Comandos npm

Los comandos de desarrollo solicitados están disponibles en `package.json`:

| Comandos | Uso |
|---|---|
| `build`, `format`, `lint` | Compilar, formatear src/test/prisma y revisar src/test/scripts con Oxlint |
| `lint:eslint` | Conservar la revisión ESLint anterior como comprobación adicional |
| `docs:openapi` | Compilar y generar `docs/openapi.json` y `docs/API_ACCESS.md` |
| `docs:check` | Compilar y detectar documentación ausente o desactualizada, sin sobrescribirla |
| `start`, `start:dev`, `start:debug`, `start:prod` | Arranque normal, watch, debug y compilado |
| `db:generate`, `prisma:generate`, `postinstall` | Generar Prisma Client; postinstall se ejecuta automáticamente tras instalar |
| `db:migrate` | Crear/aplicar migraciones de desarrollo; puede requerir una shadow database |
| `db:deploy` | Aplicar únicamente migraciones existentes; usar en instalación y despliegue |
| `db:seed`, `db:studio` | Bootstrap idempotente de SUPER_ADMIN y explorador de datos |
| `db:seed:local` | **LOCAL/TEST ONLY**: ejecuta en orden los tres seeds locales (provider admins → driver users → pricing) |
| `db:seed:local-provider-admins`, `verify:provider-admins` | **LOCAL/TEST ONLY**: escenario PROVIDER_ADMIN A/B/sin membership y su validación HTTP real |
| `db:seed:local-driver-users`, `verify:drivers-vehicles` | **LOCAL/TEST ONLY**: Users DRIVER locales y validación HTTP real del escenario V1.4 |
| `verify:delivery-requests` | **LOCAL/TEST ONLY**: validación HTTP real del escenario V1.5 con IntegrationClients locales A/B |
| `db:seed:local-pricing`, `verify:delivery-quotes` | **LOCAL/TEST ONLY**: zonas/tarifa placeholder y validación HTTP real de cotización V1.6 |
| `db:seed:local-credit-policies` | **LOCAL/TEST ONLY**: políticas de créditos v1 `LOCAL_DELIVERY` PER_KM (1 crédito/km, mínimo 3) para PROVIDER e INDEPENDENT_DRIVER; idempotente, nunca edita una existente |
| `verify:user-invitations` | **LOCAL/TEST ONLY**: invitación → correo en outbox local → activación → login real de PROVIDER_ADMIN y DRIVER (V1.6.1) |
| `routing:check-google` | Comprobación manual explícita de Google Routes (1 llamada facturable; requiere GOOGLE_ROUTES_API_KEY) |
| `db:test:deploy` | Aplicar migraciones a la base de pruebas |
| `test`, `test:watch`, `test:cov`, `test:e2e` | Vitest normal, watch, cobertura y E2E |
| `db:up`, `db:down` | Docker Compose; disponibles, pero su ejecución local sigue pospuesta |
| `db:reset`, `db:test:reset` | Borrar datos y recrear la base seleccionada; el segundo no pide confirmación |

Los hooks `pretest*` compilan antes de ejecutar Vitest porque las pruebas actuales importan `dist` para conservar metadata de decorators de NestJS. En watch, recompilar los cambios de backend con `npm run build` o mantener `npm run start:dev` en otra terminal.

`prisma.test.config.ts` y E2E usan `TEST_DATABASE_URL` si está definido; en caso contrario derivan `mandaria_test` desde la conexión local. Exigen un nombre terminado en `_test` y diferente de la base principal. Crear la base antes de ejecutar `db:test:deploy`. No usar los comandos de reset sobre datos que se quieran conservar.

La exportación OpenAPI no abre un servidor ni conecta a PostgreSQL. Roles y scopes se exportan desde los mismos decorators que usa la autorización. La matriz resume autenticación Bearer; validaciones adicionales, como refresh tokens en el cuerpo o memberships vigentes, siguen descritas en los endpoints. `docs:check` compara también el OpenAPI contra el código actual, no sólo la matriz contra un JSON anterior.

En Windows, detener el backend antes de `db:generate` o una instalación con `postinstall` si mantiene bloqueada la DLL de Prisma; después volver a iniciarlo. `start:prod` requiere una compilación previa.

```powershell
npm run db:deploy
npm run docs:openapi
npm run docs:check
npm run lint
npm test
npm run db:test:deploy
npm run test:e2e
```

Requisitos: Node.js 24, npm 11, PostgreSQL activo y psql. En Windows, psql suele estar en `C:\Program Files\PostgreSQL\18\bin\psql.exe`.

```powershell
npm ci
node scripts/init-local.mjs
npm run prisma:generate
```

El inicializador crea `.env` con valores aleatorios sólo si no existe. Ajustar `DATABASE_URL` a la cuenta y base locales; nunca versionar secretos. También se puede completar `.env.example` manualmente.

Para crear rol/bases por primera vez, conectarse como administrador:

```powershell
& 'C:\Program Files\PostgreSQL\18\bin\psql.exe' -h localhost -p 5432 -U postgres -d postgres
```

En psql (no repetir CREATE si ya existen):

```sql
CREATE ROLE mandaria LOGIN;
\password mandaria
CREATE DATABASE mandaria OWNER mandaria;
CREATE DATABASE mandaria_test OWNER mandaria;
\q
```

Usar la contraseña elegida en DATABASE_URL, codificando caracteres especiales como URL. La base de desarrollo existente en este equipo se llama `mandaria_db`; respetar su configuración y no recrearla.

```powershell
npm run db:deploy
npm run db:seed
npm run start:dev
```

El seed usa `BOOTSTRAP_ADMIN_EMAIL` y `BOOTSTRAP_ADMIN_PASSWORD` (16–128 caracteres). Es idempotente, no cambia contraseñas existentes ni eleva usuarios que no sean SUPER_ADMIN. Retirar las variables de bootstrap del despliegue tras aprovisionar.

Para ejecutar la compilación: `npm run build`, después `npm run start:prod`. Detener primero cualquier instancia que ya ocupe el puerto.

- [Health](http://localhost:3000/health)
- [Swagger](http://localhost:3000/docs)
- [OpenAPI JSON](http://localhost:3000/docs-json)

## Actualización desde V1.0

Detener el backend local antes de npm ci/Prisma generate en Windows: el proceso puede bloquear la DLL de Prisma.

```powershell
npm ci
node scripts/upgrade-env-v11.mjs
npm run prisma:generate
npm run db:deploy
npm run build
npm run start:prod
```

`upgrade-env-v11.mjs` agrega únicamente la configuración B2B faltante y no imprime secretos ni modifica credenciales humanas.

La migración `20260915000200_b2b_credentials`:
- Renombra INACTIVE a SUSPENDED, conservando los registros.
- Agrega REVOKED al estado de integración.
- Agrega CredentialStatus ACTIVE/REVOKED, scopes, expiresAt y lastUsedAt.
- Marca como REVOKED las credenciales que ya tenían revokedAt.
- Conserva UUID, hashes, usuarios, refresh tokens y timestamps existentes.
- Da scopes vacíos a credenciales anteriores: no amplía permisos automáticamente.

**Cambios de contrato intencionales:**
- `/integrations/me` ahora requiere Bearer B2B y no acepta x-api-key.
- Crear/rotar credenciales entrega `clientId/clientSecret/integrationId`; ya no entrega apiKey.
- Una API key V1.0 `UUID.secreto` puede adaptarse al intercambio de token usando su UUID como clientId y su segunda parte como clientSecret. El hash previo sigue siendo válido; sus scopes iniciales son vacíos.
- Las rutas administrativas antiguas `/integrations` siguen como alias de `/admin/integrations`, incluido DELETE de revocación. PATCH acepta INACTIVE como alias de SUSPENDED. Las respuestas usan el estado nuevo.
- Auth humano mantiene su contrato y sus secretos.

## Variables de entorno

| Variable | Uso |
|---|---|
| NODE_ENV, PORT | Entorno y puerto |
| DATABASE_URL | PostgreSQL propio de Mandaria |
| JWT_ACCESS_SECRET | Firma de access humano, mínimo 32 caracteres |
| JWT_REFRESH_SECRET | Firma de refresh humano, mínimo 32 caracteres |
| JWT_ACCESS_EXPIRES_IN | Segundos, 60–3600; default 900 |
| JWT_REFRESH_EXPIRES_IN | Segundos, 3600–2592000; default 604800 |
| INTEGRATION_JWT_SECRET | **Nueva**, firma B2B, mínimo 32 caracteres |
| INTEGRATION_ACCESS_TOKEN_EXPIRES_IN | **Nueva**, segundos, 60–3600; default 3600 |
| CORS_ORIGINS | Orígenes HTTP/HTTPS exactos separados por comas |
| BOOTSTRAP_ADMIN_EMAIL/PASSWORD | Sólo para seed y verificaciones con administrador |
| LOCAL_PROVIDER_ADMIN_PASSWORD | **LOCAL/TEST ONLY**; cuentas PROVIDER_ADMIN del seed local. Nunca en producción |
| ROUTING_PROVIDER | `google` (por defecto) o `local_fake` (LOCAL/TEST ONLY; rechazado en producción) |
| GOOGLE_ROUTES_API_KEY | Clave de Google Routes sólo en backend; obligatoria en producción con `google`; nunca versionar |
| GOOGLE_ROUTES_TIMEOUT_MS, GOOGLE_ROUTES_MAX_RETRIES, GOOGLE_ROUTES_TRAVEL_MODE | Timeout por intento (1000–15000, 5000), reintentos transitorios (0–2, 1), DRIVE/TWO_WHEELER |
| MANDARIA_WEB_URL | Base de Mandaria Web para `{url}/activate-account?token=…`; sin query, fragmento ni credenciales; https obligatorio en producción |
| USER_INVITATION_TTL_HOURS, USER_INVITATION_RESEND_COOLDOWN_SECONDS | Vigencia de invitaciones (1–168, 24) y espera mínima entre reenvíos (0–3600, 60) |
| MAIL_PROVIDER | `smtp` (obligatorio en producción) o `local_outbox` (LOCAL/TEST ONLY; default fuera de producción; rechazado en producción) |
| MAIL_FROM, SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASSWORD | Remitente y relay SMTP; host y remitente obligatorios con smtp; usuario y contraseña juntos; nunca versionar |
| DISPATCH_TTL_MINUTES | Minutos que un servicio aceptado es reclamable (1–1440, default 10); independiente de la vigencia de la Quote |
| LOCAL_DELIVERY_ASSIGNMENT_TTL_MINUTES | Minutos que el proveedor tiene para asignar Driver y Vehicle tras reclamar un LOCAL_DELIVERY (1–1440, default 5); sólo señal `assignmentOverdue`, sin liberación automática |
| INDEPENDENT_DRIVER_MAX_VEHICLES | Vehículos propios que SUPER_ADMIN puede dar de alta a un repartidor independiente (1–100, default 3); cuentan todos, sea cual sea su estado |
| LOCAL_MAIL_OUTBOX_DIR | **LOCAL/TEST ONLY**; carpeta del outbox local (default `<temp>/mandaria-mail-outbox`) |

Los tres secretos JWT deben ser distintos. La aplicación falla al iniciar ante valores inválidos, sin imprimirlos. CORS vacío deshabilita acceso cross-origin del navegador; no se acepta `*`. CORS no sustituye autenticación server-to-server.

# B2B Integrations

## User frente a IntegrationClient

| Principal | Autenticación | Destino |
|---|---|---|
| Usuario humano | email/password → access + refresh | Administración; futuras apps Cliente/Repartidor |
| Sistema externo | clientId/clientSecret → access temporal | Integración B2B, por ejemplo Coita Eats Backend |

No hay usuarios ficticios de Coita Eats, refresh B2B, CUSTOMER ni apps móviles en esta versión.

Un IntegrationClient representa a la empresa/sistema. Cada IntegrationCredential pertenece a ese cliente y tiene un UUID independiente.

**Identificadores:**
- `IntegrationClient.id` identifica al sistema y aparece en las rutas administrativas.
- `clientId` enviado a `/integrations/token` es **el UUID de la credencial**.
- La respuesta de creación distingue `integrationId` (sistema) y `clientId` (credencial).
- La metadata Prisma mantiene `IntegrationCredential.clientId` como FK al sistema por compatibilidad; su campo `id` es el identificador público de credencial. Swagger documenta esta diferencia.

## Flujo completo: Coita Eats

Con un access JWT humano de SUPER_ADMIN obtenido por `POST /api/v1/auth/login`, ejecutar en PowerShell (reemplazar sólo el placeholder):

```powershell
$base = 'http://localhost:3000/api/v1'
$userToken = '<USER_ACCESS_TOKEN>'
$adminHeaders = @{ Authorization = "Bearer $userToken" }

$client = Invoke-RestMethod -Method Post -Uri "$base/admin/integrations" -Headers $adminHeaders -ContentType 'application/json' -Body (@{name='Coita Eats'; code='COITA_EATS'} | ConvertTo-Json)

$credential = Invoke-RestMethod -Method Post -Uri "$base/admin/integrations/$($client.id)/credentials" -Headers $adminHeaders -ContentType 'application/json' -Body (@{scopes=@('quotes:create','deliveries:create','deliveries:read','deliveries:cancel')} | ConvertTo-Json)

# Guardar $credential.clientId y $credential.clientSecret en el gestor
# de secretos de Coita Eats Backend. No incluirlos en apps ni logs.
$token = Invoke-RestMethod -Method Post -Uri "$base/integrations/token" -ContentType 'application/json' -Body (@{clientId=$credential.clientId; clientSecret=$credential.clientSecret} | ConvertTo-Json)
$b2bHeaders = @{ Authorization = "Bearer $($token.accessToken)" }
Invoke-RestMethod -Uri "$base/integrations/me" -Headers $b2bHeaders
Invoke-RestMethod -Uri "$base/integrations/scope-check" -Headers $b2bHeaders
```

El code es único. Si COITA_EATS ya existe, consultarlo y reutilizar su ID en lugar de crearlo de nuevo. No se crea automáticamente una integración de producción ni se hardcodea su secreto.

Token responde `accessToken`, `tokenType=Bearer` y `expiresIn`. El consumidor solicita otro token cuando sea necesario. No obtiene refresh token.

## Scopes

Catálogo preparado:
- `quotes:create`
- `quotes:read`
- `quotes:accept`
- `deliveries:create`
- `deliveries:read`
- `deliveries:cancel`

Asignarlos en creación de credencial; por defecto no hay permisos. Desde V1.5, `deliveries:create`, `deliveries:read` y `deliveries:cancel` protegen `/delivery-requests`; desde V1.6, `quotes:create`, `quotes:read` y `quotes:accept` protegen la cotización (ver secciones Delivery Requests y Delivery Quotes). El endpoint `scope-check` requiere deliveries:read y sólo verifica autorización.

Los futuros controllers pueden importar IntegrationsModule y usar:

```typescript
@UseGuards(IntegrationGuard, IntegrationScopesGuard)
@IntegrationScopes('deliveries:create')
```

El guard exige todos los scopes indicados y no contiene condiciones específicas de Coita Eats. El permiso efectivo es la intersección entre los scopes del token y los actuales de la credencial; un token nunca gana permisos adicionales después de emitirse.

## Rotación, revocación y suspensión

```powershell
# Crear B conservando A durante la transición
$replacement = Invoke-RestMethod -Method Post -Uri "$base/admin/integrations/$($client.id)/credentials/$($credential.clientId)/rotate" -Headers $adminHeaders
# Guardar y desplegar las nuevas credenciales en Coita Eats.
# Comprobar token + /me con B y después revocar A:
Invoke-RestMethod -Method Post -Uri "$base/admin/integrations/$($client.id)/credentials/$($credential.clientId)/revoke" -Headers $adminHeaders

# Suspender todos los accesos del sistema
Invoke-RestMethod -Method Patch -Uri "$base/admin/integrations/$($client.id)" -Headers $adminHeaders -ContentType 'application/json' -Body '{"status":"SUSPENDED"}'
# Reactivar
Invoke-RestMethod -Method Patch -Uri "$base/admin/integrations/$($client.id)" -Headers $adminHeaders -ContentType 'application/json' -Body '{"status":"ACTIVE"}'
```

- Rotar crea un nuevo UUID/secreto y hereda scopes y expiresAt. A continúa activa hasta revocarse explícitamente.
- Si la credencial venció, generar otra en lugar de rotarla. Puede indicarse expiresAt futuro al crearla; omitirlo permite una credencial sin vencimiento, siempre revocable.
- El secreto aleatorio de 256 bits aparece sólo en creación/rotación. SHA-256 almacena su hash; no existe recuperación del secreto.
- Cada petición B2B verifica JWT, emisor, audiencia, tipo, expiración, dueño y estado actual de cliente/credencial en PostgreSQL.
- Suspender impide nuevos tokens y el uso de los ya emitidos. Reactivar permite reutilizar tokens todavía vigentes cuya credencial siga activa.
- Revocar la credencial invalida inmediatamente sus tokens en la siguiente autorización. No se necesita blacklist individual.
- REVOKED en IntegrationClient es terminal; no admite reactivación ni nuevas credenciales. Usar SUSPENDED para pausas reversibles.
- Los controles se aplican al autorizar cada petición; no cancelan operaciones que ya hayan pasado la autorización.

## Endpoints

Prefijo `/api/v1` salvo health/docs:

| Método | Ruta | Autenticación |
|---|---|---|
| POST | /auth/login | Pública |
| POST | /auth/refresh | Refresh humano en body |
| POST | /auth/logout | Refresh humano en body |
| GET | /auth/me | Bearer humano |
| GET | /users | SUPER_ADMIN; `status` INVITED/ACTIVE/DISABLED |
| POST | /auth/activate-account | Pública; token de invitación |
| POST, GET | /admin/providers/:providerId/invitations, /admin/user-invitations[/:id[/resend\|/revoke]] | SUPER_ADMIN (ver V1.6.1) |
| POST, GET | /provider/driver-invitations[/:id[/resend\|/revoke]] | PROVIDER_ADMIN + membership |
| GET | /provider/dispatches, /provider/dispatches/:id, /provider/service-coverages | PROVIDER_ADMIN + membership |
| POST | /provider/dispatches/:id/claim, /provider/dispatches/:id/release | PROVIDER_ADMIN + membership (ver V1.7) |
| POST, GET | /provider/dispatches/:id/assignment[/reassign\|/cancel], /provider/dispatches/:id/assignments, /provider/dispatches/:id/available-drivers\|available-vehicles | PROVIDER_ADMIN + membership (ver V1.8) |
| GET | /admin/dispatches/:id/assignments | SUPER_ADMIN |
| GET, POST, PATCH | /admin/dispatches[/:id], /admin/providers/:providerId/service-coverages[/:id] | SUPER_ADMIN |
| POST | /integrations/token | Client Credentials en body |
| GET | /integrations/me | Bearer B2B |
| GET | /integrations/scope-check | Bearer B2B + deliveries:read |
| POST | /delivery-requests | Bearer B2B + deliveries:create + Idempotency-Key |
| GET | /delivery-requests, /delivery-requests/:publicId | Bearer B2B + deliveries:read |
| POST | /delivery-requests/:publicId/cancel | Bearer B2B + deliveries:cancel |
| GET | /admin/delivery-requests, /admin/delivery-requests/:publicId | SUPER_ADMIN |
| POST | /admin/delivery-requests/:publicId/cancel | SUPER_ADMIN |
| POST, GET | /delivery-requests/:publicId/quotes | Bearer B2B + quotes:create / quotes:read |
| GET | /delivery-quotes/:publicId | Bearer B2B + quotes:read |
| POST | /delivery-quotes/:publicId/accept | Bearer B2B + quotes:accept |
| * | /admin/service-zones, /admin/rate-plans, /admin/delivery-quotes | SUPER_ADMIN (ver sección V1.6) |
| POST, GET | /admin/integrations | SUPER_ADMIN |
| GET, PATCH | /admin/integrations/:id | SUPER_ADMIN |
| POST, GET | /admin/integrations/:id/credentials | SUPER_ADMIN |
| POST | /admin/integrations/:id/credentials/:credentialId/rotate | SUPER_ADMIN |
| POST | /admin/integrations/:id/credentials/:credentialId/revoke | SUPER_ADMIN |
| DELETE | /admin/integrations/:id/credentials/:credentialId | Alias de revocación |
| GET | /health | Pública; backend y DB |
| GET | /docs, /docs-json | Swagger / OpenAPI |

Aliases administrativos disponibles en `/integrations`. Listas limitadas a 100 elementos; listado de clientes conserva metadata de hasta 100 credenciales por cliente.

Swagger distingue **User Bearer Authentication** (`bearer`) de **Integration Bearer Authentication** (`integration-bearer`).

## Seguridad y auditoría mínima

Helmet, DTOs con whitelist/forbidNonWhitelisted/transform, body 16 KiB, respuestas no-store y errores HTTP uniformes. Contraseñas humanas con Argon2id; secretos aleatorios/tokens con SHA-256.

Límites por IP: global 100/min, login 5/min, refresh 20/min, token B2B 10/min, activación de cuenta 10/min, creación de invitaciones 20/min, reenvío 10/min, claim de Dispatch 60/min y liberación 20/min. Health está exento. Los fallos B2B por ID desconocido, secreto incorrecto, revocación o suspensión usan el mismo 401 genérico. Un DTO mal formado recibe 400; el límite recibe 429.

Logging JSON, sin bodies, query strings, headers de autorización, secretos ni tokens. Eventos:
INTEGRATION_CREATED, INTEGRATION_SUSPENDED, INTEGRATION_ACTIVATED, INTEGRATION_REVOKED, CREDENTIAL_CREATED, CREDENTIAL_ROTATED, CREDENTIAL_REVOKED, INTEGRATION_AUTH_SUCCESS, INTEGRATION_AUTH_FAILED. Los eventos administrativos incluyen actorId y los IDs afectados.

Usar HTTPS en despliegue público. No poner credenciales B2B en frontend/mobile. El access humano conserva vigencia tras logout hasta expirar; estado y rol humanos se vuelven a consultar por petición.

## Pruebas y verificación

```powershell
npm run build
npm run lint
npm test
node scripts/create-test-db.mjs
node scripts/test-db.mjs
```

create-test-db crea mandaria_test sólo si falta; requiere psql (o PSQL_PATH) y permiso CREATEDB. test-db cambia el nombre de DATABASE_URL a mandaria_test, migra y ejecuta E2E. Las suites eliminan sólo sus propios registros. Para otra base, usar TEST_DATABASE_URL con nombre terminado en _test, migrarla y ejecutar `npm run test:e2e`.

Comprobar instalación desde cero y actualización con fixtures V1.0:

```powershell
node scripts/verify-migrations-v11.mjs
```

Crea dos bases con nombres aleatorios terminados en _test y las conserva para inspección. No elimina ni reinicia bases existentes. Verifica conservación de usuarios, refresh tokens, UUID, hashes y estados previos.

Con el backend activo y bootstrap configurado:

```powershell
node scripts/verify-local.mjs
node scripts/verify-b2b-local.mjs
```

El segundo ejecuta el flujo B2B completo y elimina únicamente su integración temporal. No imprime secretos. Las pruebas E2E capturan logging y comprueban que no aparecen secretos generados.

## Delivery Providers

`IntegrationClient = sistema que consume Mandaria.`

`DeliveryProvider = persona/empresa que proporciona capacidad logística.`

```text
DeliveryProvider
├── FLEET
└── INDEPENDENT
```

No existe relación directa entre IntegrationClient y DeliveryProvider. Un INDEPENDENT usa el mismo modelo que una FLEET y no depende del tipo de vehículo. User representa al humano que administra; ProviderMembership conecta a ese User con uno o varios proveedores.

### Estados y límites

Los proveedores nacen PENDING:

```text
PENDING → ACTIVE → SUSPENDED
             ↑         │
             └─────────┘
```

- Sólo SUPER_ADMIN puede activar/suspender. Repetir el estado actual devuelve 200 sin otro cambio.
- PENDING → SUSPENDED se rechaza con 409; primero debe activarse.
- PATCH sólo edita name, code y límites. No acepta status ni type, ni cuerpos vacíos.
- No hay DELETE del proveedor. Suspender conserva proveedor, usuarios y memberships.
- Un PROVIDER_ADMIN asociado puede consultar perfiles PENDING/SUSPENDED para conocer su estado; esto no habilita ninguna operación logística.
- maxDrivers/maxVehicles son límites operativos del proveedor, enteros de 1 a 10000. Se validan en DTO y con CHECK en PostgreSQL. Desde V1.4 se aplican al crear Drivers/Vehicles y no pueden fijarse por debajo del uso actual (ver sección V1.4).
- Todavía no se cuentan Driver/Vehicle, no se cobran ampliaciones y no hay planes, créditos ni Wallet.

Defaults de entorno opcionales (el backend aplica estos valores aunque no existan en .env):

```env
DEFAULT_FLEET_MAX_DRIVERS=10
DEFAULT_FLEET_MAX_VEHICLES=10
DEFAULT_INDEPENDENT_MAX_DRIVERS=1
DEFAULT_INDEPENDENT_MAX_VEHICLES=2
```

Cada campo omitido toma el default correspondiente al type al crear el proveedor. Cambiar el entorno afecta nuevas creaciones; no modifica límites guardados. SUPER_ADMIN puede fijar valores personalizados, iguales o distintos de los defaults.

### Endpoints V1.2

Todas estas rutas usan el prefijo `/api/v1` y **JWT humano**:

| Método | Ruta | Permisos y función |
|---|---|---|
| POST | /admin/providers | SUPER_ADMIN; crea proveedor PENDING |
| GET | /admin/providers | SUPER_ADMIN; filtros y paginación |
| GET | /admin/providers/:id | SUPER_ADMIN; consulta cualquiera |
| PATCH | /admin/providers/:id | SUPER_ADMIN; nombre, código y límites |
| POST | /admin/providers/:id/activate | SUPER_ADMIN; activa/reactiva |
| POST | /admin/providers/:id/suspend | SUPER_ADMIN; suspende activo |
| POST | /admin/providers/:providerId/members | SUPER_ADMIN; asocia User existente |
| GET | /admin/providers/:providerId/members | SUPER_ADMIN; lista memberships |
| DELETE | /admin/providers/:providerId/members/:membershipId | SUPER_ADMIN; retira relación, no User |
| GET | /provider/profiles | PROVIDER_ADMIN; sólo proveedores asociados |
| GET | /provider/profile?providerId=UUID | PROVIDER_ADMIN con membership en ese proveedor |

Swagger incluye descripciones, ejemplos de campos, esquemas de respuesta, parámetros, permisos y errores 400/401/403/404/409/429 aplicables. Secciones: **Admin Providers** y **Provider**.

### Paginación y filtros

V1.1 no tenía paginación formal. V1.2 introduce `PaginationQueryDto` reutilizable, sin cambiar contratos anteriores.

```http
GET /api/v1/admin/providers?type=FLEET&status=ACTIVE&search=rapidos&page=1&pageSize=20
```

Respuesta:

```json
{
  "items": [],
  "total": 0,
  "page": 1,
  "pageSize": 20,
  "totalPages": 0
}
```

- page comienza en 1 (máximo 100000); pageSize de 1 a 100, default 20.
- Filtros combinables: type, status y search por nombre/código, sin distinguir mayúsculas.
- Orden estable createdAt DESC, id DESC. Lista y conteo se leen en un snapshot RepeatableRead.
- Los listados de memberships y perfiles propios usan la misma estructura.
- Una página sin resultados devuelve 200, no 404.
- code se recorta y convierte a mayúsculas; patrón `^[A-Z][A-Z0-9_]{1,49}$`, único.

### Ejemplo administrativo completo

Obtener primero el access humano con POST /auth/login. PowerShell, reemplazando el placeholder de token:

```powershell
$base = 'http://localhost:3000/api/v1'
$adminHeaders = @{ Authorization = 'Bearer <SUPER_ADMIN_ACCESS_TOKEN>' }

$fleet = Invoke-RestMethod -Method Post -Uri "$base/admin/providers" -Headers $adminHeaders -ContentType 'application/json' -Body '{"name":"Rápidos de Coita","code":"RAPIDOS_COITA","type":"FLEET"}'
$independent = Invoke-RestMethod -Method Post -Uri "$base/admin/providers" -Headers $adminHeaders -ContentType 'application/json' -Body '{"name":"Juan Pérez","code":"JUAN_PEREZ","type":"INDEPENDENT"}'

Invoke-RestMethod -Method Patch -Uri "$base/admin/providers/$($fleet.id)" -Headers $adminHeaders -ContentType 'application/json' -Body '{"maxDrivers":15,"maxVehicles":20}'
Invoke-RestMethod -Method Post -Uri "$base/admin/providers/$($fleet.id)/activate" -Headers $adminHeaders
Invoke-RestMethod -Method Post -Uri "$base/admin/providers/$($fleet.id)/suspend" -Headers $adminHeaders
```

Los códigos son únicos: si el proveedor ya existe, buscarlo y reutilizar su ID.

### Memberships y perfiles

La asignación recibe un **User existente, activo y con rol global PROVIDER_ADMIN**. No crea usuarios, no cambia sus roles y no acepta DRIVER como rol administrativo local.

```text
User.role = PROVIDER_ADMIN
       ↓
ProviderMembership.role = OWNER o ADMIN
       ↓
DeliveryProvider
```

- Un proveedor puede tener varios administradores, incluidos varios OWNER.
- Un usuario puede tener memberships en varios proveedores.
- La combinación providerId/userId es única en PostgreSQL. Duplicados devuelven 409, también ante solicitudes concurrentes.
- OWNER y ADMIN permiten la misma consulta en V1.2. No conceden edición; toda modificación es exclusiva de SUPER_ADMIN.
- Se puede retirar la última membership: SUPER_ADMIN sigue administrando el proveedor.
- Las FKs RESTRICT evitan borrados accidentales en cascada. El endpoint de retirada elimina sólo ProviderMembership.
- La gestión general/provisión de usuarios no se amplía en V1.2. El script de verificación crea usuarios temporales únicamente como fixtures; no es una API de registro.

```powershell
$member = Invoke-RestMethod -Method Post -Uri "$base/admin/providers/$($fleet.id)/members" -Headers $adminHeaders -ContentType 'application/json' -Body '{"userId":"<EXISTING_PROVIDER_ADMIN_UUID>","role":"OWNER"}'
Invoke-RestMethod -Uri "$base/admin/providers/$($fleet.id)/members?page=1&pageSize=20" -Headers $adminHeaders

$providerHeaders = @{ Authorization = 'Bearer <PROVIDER_ADMIN_ACCESS_TOKEN>' }
Invoke-RestMethod -Uri "$base/provider/profiles" -Headers $providerHeaders
Invoke-RestMethod -Uri "$base/provider/profile?providerId=$($fleet.id)" -Headers $providerHeaders

Invoke-RestMethod -Method Delete -Uri "$base/admin/providers/$($fleet.id)/members/$($member.id)" -Headers $adminHeaders
```

`/provider/profile` sin providerId selecciona sólo cuando hay exactamente una membership. Con cero devuelve 403; con varias devuelve 409 para exigir selección explícita. `/provider/profiles` permite descubrir los IDs asociados.

El guard comprueba la membership actual: retirar la relación bloquea el siguiente acceso con el JWT anterior. Provider A Admin → Provider B devuelve **403**, igual que un ID válido inexistente. Un IntegrationToken recibe **401** en ambas superficies; un PROVIDER_ADMIN recibe **403** en /admin/providers y administración B2B. No se toma userId del cliente para decidir qué perfiles listar.

### Auditoría y preparación V1.3

Se registran PROVIDER_CREATED, PROVIDER_UPDATED, PROVIDER_ACTIVATED, PROVIDER_SUSPENDED, PROVIDER_MEMBER_ADDED, PROVIDER_MEMBER_REMOVED y PROVIDER_LIMITS_CHANGED. Incluyen IDs y actorId; no passwords/tokens ni datos personales innecesarios.

No hay conversiones automáticas de tipo. Los límites reales, la concurrencia de altas y la reducción de límites se resolvieron en V1.4 (sección Drivers, Vehicles y Assignments). Wallet sigue pendiente.

### Actualizar y verificar V1.2

Detener previamente el backend si Windows bloquea el cliente Prisma:

```powershell
npm run prisma:generate
npm run db:deploy
npm run build
npm run lint
npm test
node scripts/test-db.mjs
npm run start:prod
```

Desde otra terminal, con el backend activo y bootstrap configurado:

```powershell
node scripts/verify-providers-local.mjs
```

El script autentica SUPER_ADMIN y un PROVIDER_ADMIN temporal, crea FLEET/INDEPENDENT, verifica defaults/límites/estados/memberships, aislamiento cross-provider y rechazo B2B. Limpia únicamente sus fixtures.

Para verificar instalación limpia y la secuencia V1.0 → V1.1 → V1.2:

```powershell
node scripts/verify-migrations.mjs
```

Se conservan las bases de verificación aleatorias para inspección. `verify-migrations-v11.mjs` permanece como alias compatible.

### Escenario local PROVIDER_ADMIN (LOCAL/TEST ONLY)

Propósito: disponer de cuentas reales de PROVIDER_ADMIN para validar `User → ProviderMembership → DeliveryProvider` con el mismo login que usará Mandaria Web. No hay bypass, JWT manual ni cambios en guards: el seed sólo escribe las mismas tablas que usa la API.

| Cuenta / recurso | Valor | Acceso esperado |
|---|---|---|
| Provider A | `LOCAL_RAPIDOS_COITA`, "Rápidos de Coita", FLEET, ACTIVE | — |
| Provider B | `LOCAL_MANDADOS_CENTRO`, "Mandados del Centro", FLEET, ACTIVE | — |
| `provider-admin-a@mandaria.local` | PROVIDER_ADMIN, membership OWNER en A | A ✅ · B ❌ |
| `provider-admin-b@mandaria.local` | PROVIDER_ADMIN, membership OWNER en B | B ✅ · A ❌ |
| `provider-admin-sin-membership@mandaria.local` | PROVIDER_ADMIN, sin memberships | ninguno ❌ |

Variables: `DATABASE_URL` (local), `NODE_ENV` (development/test), `LOCAL_PROVIDER_ADMIN_PASSWORD` (16–128 caracteres, compartida por las tres cuentas y distinta de `BOOTSTRAP_ADMIN_PASSWORD`). La verificación HTTP además usa `BOOTSTRAP_ADMIN_EMAIL/PASSWORD`.

```powershell
node scripts/upgrade-env-local-provider-admins.mjs   # agrega una contraseña aleatoria a .env sólo si falta; no la imprime
npm run db:seed:local-provider-admins                # idempotente; imprime IDs y emails, nunca contraseñas
npm run build
npm run start:prod                                   # en otra terminal
npm run verify:provider-admins                       # matriz real: login, refresh, /auth/me, aislamiento, 403/401
```

Iniciar sesión como Admin A (leer la contraseña localmente en `.env`, sin copiarla a logs ni documentación):

```powershell
$base = 'http://localhost:3000/api/v1'
$login = Invoke-RestMethod -Method Post -Uri "$base/auth/login" -ContentType 'application/json' -Body (@{ email = 'provider-admin-a@mandaria.local'; password = '<LOCAL_PROVIDER_ADMIN_PASSWORD>' } | ConvertTo-Json)
$h = @{ Authorization = "Bearer $($login.accessToken)" }
Invoke-RestMethod -Uri "$base/auth/me" -Headers $h
Invoke-RestMethod -Uri "$base/provider/profiles" -Headers $h   # identifica Provider A (id, code LOCAL_RAPIDOS_COITA)
Invoke-RestMethod -Uri "$base/provider/profile" -Headers $h
```

Reglas del seed:
- Rechaza `NODE_ENV` distinto de development/test, hosts de base de datos no locales y contraseñas débiles o iguales a la del bootstrap.
- **No es un mecanismo de aprovisionamiento de producción.** Las cuentas reales se crean por invitación (V1.6.1).
- No forma parte de `prisma db seed`; `scripts/` no se copia a la imagen Docker (sólo el entrypoint, que únicamente migra) y `tsx` es dependencia de desarrollo.
- Nunca cambia el rol de un email existente con otro rol. Reactiva las cuentas sembradas, reestablece A/B en ACTIVE y deja exactamente las memberships indicadas (retira otras memberships de esas tres cuentas). Si la contraseña cambió, actualiza el hash y revoca sus refresh tokens.
- `verify:provider-admins` crea y elimina sólo un IntegrationClient temporal; hace 4 logins, por lo que repetirlo antes de 60 s puede devolver 429.

Comportamiento documentado:
- Provider ajeno o inexistente → **403** (mismo código, no revela existencia). Sin membership → 403 en `/provider/profile` y lista vacía en `/provider/profiles`.
- `userId` u otros parámetros enviados por el cliente → 400; `providerId` repetido → 400. El acceso siempre se filtra por el User del JWT.
- PROVIDER_ADMIN → `/admin/providers`, `/users`, `/admin/integrations` y alias `/integrations` (crear, modificar, suspender, credenciales, rotar, revocar) → **403** sin cambios en datos.
- JWT de IntegrationClient → superficies humanas → **401**; JWT humano → `/integrations/me` → 401.
- SUPER_ADMIN administra A y B mediante `/admin/providers`; `/provider/profile` es exclusivo de PROVIDER_ADMIN (403 para SUPER_ADMIN por diseño).
- ProviderMembership no tiene estado propio (activo/suspendido): retirar la relación bloquea el siguiente request; un User inactivo recibe 401 y un proveedor SUSPENDED sigue consultable en sólo lectura.

Pruebas automatizadas: `test/provider-admin-access.e2e-spec.ts` (casos 1–6 usando el mismo código del seed) y `test/local-provider-admins.spec.ts` (protecciones de entorno).


## Drivers, Vehicles y Assignments (V1.4-A)

V1.4 representa **quién puede realizar una entrega y con qué vehículo**. No decide qué entrega realizar: DeliveryRequest, cotización, mapas, despacho, tracking y wallet empiezan en V1.5 o después.

```text
DeliveryProvider
├── Drivers   (perfil logístico de un User con rol DRIVER)
├── Vehicles  (recursos del proveedor, no del Driver)
└── DriverVehicleAssignments (historial; unassignedAt = null es la asignación vigente)
```

### Modelo

| Modelo | Campos principales | Restricciones |
|---|---|---|
| Driver | providerId, userId, name, status, availability | `userId` único (un perfil por User), FK RESTRICT a User y proveedor, CHECK de nombre 1–100 |
| Vehicle | providerId, identifier, type, status, brand?, model?, year?, color?, plate? | `(providerId, identifier)` único, identifier `^[A-Z0-9][A-Z0-9_-]{0,29}$`, year 1900–2100, plate opcional sin unicidad |
| DriverVehicleAssignment | providerId, driverId, vehicleId, assignedAt, unassignedAt | FKs compuestas `(driverId, providerId)` y `(vehicleId, providerId)`; índices únicos parciales: una asignación vigente por Driver y por Vehicle; CHECK `unassignedAt >= assignedAt` |

- **User vs Driver:** User conserva email, contraseña, JWT y rol global. Driver no tiene credenciales. Crear un Driver exige un User existente, activo y con `role = DRIVER`; no se cambia ningún rol (PROVIDER_ADMIN o SUPER_ADMIN → 409). La provisión/invitación de usuarios DRIVER sigue fuera de alcance.
- **Mismo proveedor garantizado en PostgreSQL:** las FKs compuestas comparten `providerId`, así que una asignación Driver A + Vehicle B es imposible incluso fuera de la API.
- **INDEPENDENT** usa el mismo modelo: un proveedor con sus propios Drivers y Vehicles, gobernado sólo por maxDrivers/maxVehicles (no hay código que fije "un solo Driver").
- Migración incremental `20260915000400_drivers_vehicles`; sin reset. Prisma no detecta drift por los índices parciales/CHECK.

### Estados y disponibilidad

| DriverStatus | Transiciones | Efecto |
|---|---|---|
| PENDING | → ACTIVE, → SUSPENDED | Estado inicial. Puede recibir vehículo (onboarding) pero no ofrecer disponibilidad |
| ACTIVE | → SUSPENDED | Único estado que permite AVAILABLE/BUSY |
| SUSPENDED | → ACTIVE | No recibe nuevos vehículos; queda OFFLINE al suspender |

Volver a PENDING devuelve 409. Salir de ACTIVE fuerza `availability = OFFLINE`.

- **DriverAvailability** `OFFLINE / AVAILABLE / BUSY` sólo se persiste; no hay dispatch. El Driver la cambia para sí mismo; OFFLINE siempre está permitido y AVAILABLE/BUSY requieren Driver ACTIVE **y** proveedor ACTIVE.
- **Proveedor suspendido:** en la misma transacción de `/suspend`, sus Drivers AVAILABLE/BUSY pasan a OFFLINE; mientras siga suspendido no puede volver a AVAILABLE/BUSY ni asignar vehículos.
- **VehicleStatus** `ACTIVE / INACTIVE / MAINTENANCE / SUSPENDED`, transiciones libres. Sólo ACTIVE admite nuevas asignaciones. Cambiar el estado **no** cierra la asignación vigente (se decide en V1.5 junto con entregas en curso); se desasigna explícitamente.

### Límites y concurrencia

- **Qué cuenta:** todos los Drivers/Vehicles existentes del proveedor, en cualquier estado. No hay eliminación en V1.4, así que suspender nunca libera cupo (no se puede suspender → crear → suspender para evadir el límite).
- `POST drivers|vehicles` al alcanzar el límite → 409. `PATCH /admin/providers/:id` con maxDrivers/maxVehicles por debajo del uso actual → 409.
- **Estrategia:** cada alta abre una transacción que bloquea la fila del proveedor con `SELECT … FOR UPDATE`, cuenta e inserta. Las altas concurrentes del mismo proveedor quedan serializadas; la edición de límites y la suspensión toman el mismo bloqueo. Proveedores distintos no se bloquean entre sí. Se eligió bloqueo de fila frente a SERIALIZABLE para no introducir reintentos por conflictos de serialización.
- **Asignaciones:** bloqueo proveedor (FOR SHARE) → Driver → Vehicle (FOR UPDATE), siempre en ese orden para evitar deadlocks; los índices únicos parciales son la última defensa (P2002 → 409). Probado: 6 altas concurrentes con límite 3 → exactamente 3 × 201; dos asignaciones simultáneas del mismo vehículo → 201 + 409.
- Uso visible sin N+1: `GET /admin/providers` incluye `usage` por fila (subconsultas `_count` en la misma consulta), `GET /admin/providers/:id/capacity` y `GET /provider/capacity` devuelven `{ drivers: { count, max }, vehicles: { count, max } }`.

### Endpoints V1.4

Prefijo `/api/v1`, JWT humano. Rutas de proveedor: `AccessGuard → RolesGuard(PROVIDER_ADMIN) → ProviderMembershipGuard`; membership y rol son comprobaciones independientes (quitar el rol a un usuario con membership devuelve 403). `providerId` va en query y sólo selecciona entre memberships propias; nunca concede acceso.

| Método | SUPER_ADMIN (`/admin/providers/:providerId/…`) | PROVIDER_ADMIN (`/provider/…?providerId=`) | Función |
|---|---|---|---|
| POST | `drivers` | `drivers` | Crear Driver (userId DRIVER existente, name) |
| GET | `drivers` | `drivers` | Listar: page/pageSize, status, availability, search (nombre/email) |
| GET | `drivers/:driverId` | `drivers/:driverId` | Detalle con asignación vigente |
| PATCH | `drivers/:driverId` | `drivers/:driverId` | name y/o status |
| POST | `drivers/:driverId/vehicle` | `drivers/:driverId/vehicle` | Asignar `{ vehicleId }` → 201 |
| DELETE | `drivers/:driverId/vehicle` | `drivers/:driverId/vehicle` | Cerrar asignación vigente → 200 con el registro cerrado |
| GET | `drivers/:driverId/assignments` | `drivers/:driverId/assignments` | Historial del Driver, assignedAt DESC |
| POST | `vehicles` | `vehicles` | Crear vehículo |
| GET | `vehicles` | `vehicles` | Listar: page/pageSize, type, status, search (identifier/placa/marca/modelo) |
| GET | `vehicles/:vehicleId` | `vehicles/:vehicleId` | Detalle con Driver vigente |
| PATCH | `vehicles/:vehicleId` | `vehicles/:vehicleId` | Datos (null limpia opcionales) y status |
| GET | `vehicles/:vehicleId/assignments` | `vehicles/:vehicleId/assignments` | Historial del vehículo |
| GET | `/admin/providers/:id/capacity` | `/provider/capacity` | count/max |

| Método | Ruta DRIVER | Función |
|---|---|---|
| GET | `/driver/me` | User → Driver → Provider → vehículo vigente (sin userId, email ni límites). Sin perfil → 404 |
| PATCH | `/driver/availability` | `{ "availability": "AVAILABLE" }`; cualquier otro campo (driverId, userId) → 400 |

**Códigos:** 400 validación/campos desconocidos; 401 sin JWT humano (incluye tokens de IntegrationClient); 403 rol global incorrecto o proveedor sin membership; 404 proveedor/Driver/Vehicle/asignación inexistente **o perteneciente a otro proveedor** (no revela existencia); 409 límite alcanzado, User no elegible o con perfil, transición inválida, identifier duplicado en el proveedor, Driver/proveedor suspendido, vehículo no ACTIVE, Driver o vehículo ya asignado; 429 rate limit.

Eventos de log: DRIVER_CREATED, DRIVER_UPDATED, DRIVER_STATUS_CHANGED, DRIVER_AVAILABILITY_CHANGED (con reason DRIVER_NOT_ACTIVE o PROVIDER_SUSPENDED en cambios automáticos), VEHICLE_CREATED, VEHICLE_UPDATED, VEHICLE_STATUS_CHANGED, VEHICLE_ASSIGNED, VEHICLE_UNASSIGNED. Incluyen IDs y actorId; nunca contraseñas ni tokens.

### Ejemplo local (PowerShell)

```powershell
$base = 'http://localhost:3000/api/v1'
$h = @{ Authorization = 'Bearer <PROVIDER_ADMIN_A_ACCESS_TOKEN>' }
$carlos = Invoke-RestMethod -Method Post -Uri "$base/provider/drivers" -Headers $h -ContentType 'application/json' -Body '{"userId":"<DRIVER_USER_UUID>","name":"Carlos"}'
Invoke-RestMethod -Method Patch -Uri "$base/provider/drivers/$($carlos.id)" -Headers $h -ContentType 'application/json' -Body '{"status":"ACTIVE"}'
$moto = Invoke-RestMethod -Method Post -Uri "$base/provider/vehicles" -Headers $h -ContentType 'application/json' -Body '{"identifier":"MOTO-01","type":"MOTORCYCLE","plate":"ABC-123"}'
Invoke-RestMethod -Method Post -Uri "$base/provider/drivers/$($carlos.id)/vehicle" -Headers $h -ContentType 'application/json' -Body (@{ vehicleId = $moto.id } | ConvertTo-Json)
Invoke-RestMethod -Uri "$base/provider/drivers/$($carlos.id)/assignments" -Headers $h
Invoke-RestMethod -Method Delete -Uri "$base/provider/drivers/$($carlos.id)/vehicle" -Headers $h
Invoke-RestMethod -Uri "$base/provider/capacity" -Headers $h
```

### Escenario y verificación local (LOCAL/TEST ONLY)

```powershell
npm run db:deploy
npm run db:seed:local                   # provider admins + driver users + pricing (o cada seed por separado)
npm run build
npm run start:prod                      # otra terminal
npm run verify:drivers-vehicles         # escenario completo sobre "Rápidos de Coita"
```

- `db:seed:local-driver-users` usa la misma protección (development/test, DB local) y la misma `LOCAL_PROVIDER_ADMIN_PASSWORD` compartida del escenario local. No crea Driver, Vehicle ni asignaciones: eso se hace por API.
- `verify:drivers-vehicles` es idempotente: fija Provider A en 3/3, crea o reutiliza Carlos/Pedro/José y MOTO-01/MOTO-02/BICI-01, comprueba Luis y MOTO-03 → 409, asigna, reasigna con historial, MAINTENANCE → 409, Driver suspendido y proveedor suspendido → AVAILABLE 409 (restaura ambos), Provider B (Mario/VAN-01), aislamiento A/B, Admin sin membership, SUPER_ADMIN, DRIVER e IntegrationClient (401). Deja el escenario asignado para Mandaria Web; hace 5 logins, esperar 60 s entre ejecuciones.

Pruebas automatizadas V1.4: `test/drivers-vehicles.e2e-spec.ts` (acceso A/B, sin membership, defensa en profundidad de rol, SUPER_ADMIN, límites, INDEPENDENT, concurrencia, asignaciones), `test/driver-self.e2e-spec.ts` (DRIVER, disponibilidad, suspensiones, IntegrationClient, Swagger y logs) y `test/logistics.spec.ts` (reglas de servicio). `node scripts/verify-migrations.mjs` cubre instalación limpia y V1.0 → V1.1 → V1.2 → V1.4 con datos.

## Delivery Requests (V1.5-A)

V1.5 representa **qué necesita ser transportado**. No calcula costo (V1.6), no elige proveedor, Driver ni vehículo (Dispatch) y no gestiona el ciclo de entrega.

```text
DEMANDA                                OFERTA (V1.2–V1.4)
IntegrationClient                      DeliveryProvider
      ↓  B2B JWT                       ├── Drivers
DeliveryRequest (MDR-000123)           └── Vehicles
├── DeliveryStop[]  (1 PICKUP + 1 DROPOFF, snapshot)
├── DeliveryPackage[] (≥ 1, genéricos)
└── DeliveryFinancialContext (valor de mercancía, no envío)
```

DeliveryRequest no tiene `providerId`, `driverId` ni `vehicleId`: la unión demanda-oferta pertenece a Dispatch.

### Modelo y reglas

| Modelo | Contenido | Reglas / constraints |
|---|---|---|
| DeliveryRequest | id (UUID interno), publicId, integrationClientId, externalReference?, status, requestedAt, cancelledAt?, cancellationReason? | publicId único `^MDR-\d{6,}$`; CHECK de consistencia CREATED/CANCELLED; FK RESTRICT al IntegrationClient |
| DeliveryStop | type, sequence, address, latitude, longitude, contactName, contactPhone, instructions? | `(deliveryRequestId, sequence)` único; lat −90..90, lng −180..180 (NUMERIC(9,6)); textos no vacíos |
| DeliveryPackage | category, description, quantity, weightKg?, lengthCm?, widthCm?, heightCm?, isFragile, handlingInstructions? | quantity ≥ 1; peso y dimensiones > 0 si se informan (NUMERIC) |
| DeliveryFinancialContext | goodsValue?, goodsPaymentMode, currency | 1:1; NUMERIC(14,2); `goodsValue > 0` si existe; COURIER_ADVANCE exige valor; currency ISO 4217 |
| ApiIdempotencyRecord | integrationClientId, key, operation, requestHash, resourceType, resourceId | `(integrationClientId, key)` único; sólo hash SHA-256, nunca el payload |

- **Status:** `CREATED` y `CANCELLED` únicamente. `requestedAt` = momento en que Mandaria acepta la solicitud (sin programación).
- **Stops como snapshot:** dirección, coordenadas y contacto se copian; no hay relación con restaurantes, direcciones de clientes ni Coita Eats. Exactamente `sequence 1 = PICKUP` y `sequence 2 = DROPOFF` (el orden del array no importa). El modelo 1:N queda preparado para varios stops, pero la API no los habilita. Coordenadas provistas por el cliente; sin Google Maps.
- **Packages genéricos:** categorías `FOOD, GROCERIES, MEDICINE, DOCUMENT, PARCEL, MERCHANDISE, OTHER`; 1–50 por solicitud. No se replica carrito, productos ni precios (p. ej. `FOOD`, "Pedido preparado", 2). El tipo de vehículo no interviene.
- **Inmutable:** no hay PATCH ni DELETE de solicitudes, stops, packages o contexto financiero. Para corregir: cancelar y crear otra. Las canceladas permanecen como historial.
- **externalReference** no es única ni sustituye a Idempotency-Key: `ORDER-1842` puede tener una solicitud CANCELLED y otra CREATED.

### Contexto financiero

| goodsPaymentMode | Significado | goodsValue |
|---|---|---|
| `PREPAID` | El origen ya cobró la mercancía. El Driver paga **0** en pickup; Mandaria no procesa ese dinero | Opcional (null permitido); si se envía, > 0 |
| `COURIER_ADVANCE` | El Driver **adelanta** goodsValue al comercio en pickup y lo **recupera** del destinatario en dropoff | Obligatorio y > 0 |

`goodsValue` se acepta como string decimal (recomendado) o número con hasta 2 decimales, se guarda como NUMERIC(14,2) y se devuelve como string `"450.00"`; nunca se usa float. `currency` es un código ISO 4217 válido (se normaliza a mayúsculas; Mandaria opera principalmente en MXN, sin fijarlo). No existe deliveryFee, wallet ni créditos.

### publicId e idempotencia

- **publicId:** dentro de la transacción de creación se ejecuta `nextval('"DeliveryRequest_publicId_seq"')` y se formatea `MDR-` + 6 dígitos mínimo (`MDR-1000000` tras `MDR-999999`, sin truncar). Las secuencias de PostgreSQL nunca entregan el mismo valor a transacciones concurrentes; un rollback deja huecos, nunca duplicados. El índice único es la última defensa. No se usa `COUNT(*) + 1`.
- **Idempotency-Key** (header obligatorio, 8–255 caracteres ASCII visibles) con unicidad `IntegrationClient + key`:
  - Misma key + mismo payload → **200** con la solicitud original y `Idempotent-Replayed: true` (la primera respuesta es 201 con `false`).
  - Misma key + payload distinto → **409**; la original no cambia.
  - La misma key en otro IntegrationClient es independiente.
- **Hash:** SHA-256 de JSON canónico (claves ordenadas) del payload **normalizado**: textos recortados, stops ordenados por sequence, defaults aplicados (`isFragile=false`, opcionales null), dinero en 2 decimales y moneda en mayúsculas. `450`, `"450"` y `"450.00"` son el mismo request.
- **Concurrencia y atomicidad:** el registro de idempotencia se inserta primero, en la misma transacción que DeliveryRequest, stops, packages y contexto financiero. Una petición simultánea con la misma key queda bloqueada en el índice único hasta que la primera confirma y entonces responde 200 o 409. Si algo falla, todo hace rollback y la key no queda consumida. Probado: 10 peticiones simultáneas → 1 solicitud; fallo forzado al insertar un package → cero filas.
- Los registros de idempotencia no expiran en V1.5 (retención pendiente).

### Endpoints V1.5

Se usa `/delivery-requests` (no `/integrations/...`, donde `/integrations/:id` es alias administrativo con UUID).

| Método | Ruta | Autorización | Función |
|---|---|---|---|
| POST | /delivery-requests | Bearer B2B + `deliveries:create` + `Idempotency-Key` | Crear (201 / 200 replay / 409) |
| GET | /delivery-requests | Bearer B2B + `deliveries:read` | Listar propias: page, pageSize, publicId, externalReference, status, requestedFrom, requestedTo |
| GET | /delivery-requests/:publicId | Bearer B2B + `deliveries:read` | Detalle propio; ajena o inexistente → 404 |
| POST | /delivery-requests/:publicId/cancel | Bearer B2B + `deliveries:cancel` | `{ "reason": "..." }`; CREATED → CANCELLED |
| GET | /admin/delivery-requests | SUPER_ADMIN | Listar todas; filtros anteriores + integrationClientId |
| GET | /admin/delivery-requests/:publicId | SUPER_ADMIN | Detalle con IntegrationClient |
| POST | /admin/delivery-requests/:publicId/cancel | SUPER_ADMIN | Cancelar cualquiera |

- **Ownership B2B:** `integrationClientId` sale del token (IntegrationGuard); enviarlo en body o query responde 400. Las respuestas B2B no exponen UUID internos ni metadata del cliente; los listados son resúmenes sin datos de contacto.
- **Scopes independientes:** create no concede read ni cancel, y viceversa. Un cliente o credencial suspendido/revocado recibe 401 incluso con un token ya emitido.
- **Cancelación repetida:** sobre una CANCELLED responde 200 con el estado actual; no reescribe razón ni fecha ni emite otro evento.
- **Roles:** SUPER_ADMIN lista, consulta y cancela, pero no crea, edita ni elimina. PROVIDER_ADMIN y DRIVER reciben 403 en `/admin/delivery-requests` y 401 en las rutas B2B (un JWT humano no es un token B2B). Tampoco hay rutas `/provider` ni `/driver` para solicitudes.
- **Rate limit:** creación limitada a 60/min por IP con el ThrottlerGuard existente (las demás rutas conservan sus límites actuales). Sin planes ni cuotas.
- **Códigos:** 400 validación/key/filtros; 401 token B2B inválido, humano o cliente suspendido; 403 scope o rol; 404 inexistente/ajena; 409 conflicto de idempotencia; 429 límite; 500 sanitizado.
- **Auditoría:** `DELIVERY_REQUEST_CREATED` (actorType INTEGRATION) y `DELIVERY_REQUEST_CANCELLED` (actorType INTEGRATION o USER con actorId), además de `IDEMPOTENCY_REPLAY` e `IDEMPOTENCY_CONFLICT`. Sólo IDs y publicId: nunca direcciones, contactos, teléfonos, payloads, tokens ni secretos.

### Ejemplo B2B (PowerShell)

```powershell
$base = 'http://localhost:3000/api/v1'
# 1. Token (credencial creada por SUPER_ADMIN con deliveries:create/read/cancel; secreto desde el gestor de secretos)
$token = Invoke-RestMethod -Method Post -Uri "$base/integrations/token" -ContentType 'application/json' -Body (@{ clientId = '<CREDENTIAL_ID>'; clientSecret = '<CLIENT_SECRET>' } | ConvertTo-Json)
$h = @{ Authorization = "Bearer $($token.accessToken)"; 'Idempotency-Key' = [guid]::NewGuid().ToString() }

# 2. Crear
$body = @{
  externalReference = 'ORDER-1842'
  stops = @(
    @{ type = 'PICKUP'; sequence = 1; address = 'Restaurante, Av. Central 123'; latitude = 16.753554; longitude = -93.115983; contactName = 'Restaurante'; contactPhone = '9611234567' },
    @{ type = 'DROPOFF'; sequence = 2; address = 'Cliente, Calle 5 Pte 42'; latitude = 16.759812; longitude = -93.109231; contactName = 'Cliente'; contactPhone = '9617654321'; instructions = 'Tocar timbre' }
  )
  packages = @(@{ category = 'FOOD'; description = 'Pedido preparado'; quantity = 2 })
  financialContext = @{ goodsValue = '450.00'; goodsPaymentMode = 'PREPAID'; currency = 'MXN' }
} | ConvertTo-Json -Depth 5
$request = Invoke-RestMethod -Method Post -Uri "$base/delivery-requests" -Headers $h -ContentType 'application/json' -Body $body
# Reintentar con el mismo $h y $body devuelve el mismo publicId (200).

# 3. Consultar
$read = @{ Authorization = "Bearer $($token.accessToken)" }
Invoke-RestMethod -Uri "$base/delivery-requests/$($request.publicId)" -Headers $read
Invoke-RestMethod -Uri "$base/delivery-requests?externalReference=ORDER-1842&status=CREATED" -Headers $read

# 4. Cancelar
Invoke-RestMethod -Method Post -Uri "$base/delivery-requests/$($request.publicId)/cancel" -Headers $read -ContentType 'application/json' -Body '{"reason":"El cliente canceló el pedido"}'
```

### Verificación V1.5

```powershell
npm run db:deploy
npm run build
npm test
npm run test:e2e
node scripts/verify-migrations.mjs     # limpia + V1.0 → … → V1.4 → V1.5 con datos
npm run start:prod                     # otra terminal
npm run verify:delivery-requests       # escenario local (LOCAL/TEST ONLY)
```

`verify:delivery-requests` crea o reutiliza IntegrationClients `LOCAL_DELIVERY_CLIENT_A/B`. Emite una credencial temporal con los tres scopes y la revoca al final. Valida ORDER-1842 PREPAID 450 MXN → MDR CREATED, repetición idempotente, 409 con otro Dropoff, COURIER_ADVANCE 450, aislamiento A/B, cancelación, SUPER_ADMIN, PROVIDER_ADMIN/DRIVER bloqueados y suspensión. Las solicitudes quedan como historial. No imprime secretos, tokens ni datos de contacto.

Pruebas: `test/delivery-requests-validation.e2e-spec.ts` (contrato, stops, packages, financiero, atomicidad, logs sin datos personales), `test/delivery-requests-b2b.e2e-spec.ts` (publicId concurrente, idempotencia, aislamiento, scopes, suspensión, cancelación, filtros, SUPER_ADMIN, roles, rate limit, Swagger y auditoría) y `test/delivery-requests.spec.ts` (hash canónico, reglas e IdempotencyService).

## Routing, Service Zones, Rate Plans y Delivery Quotes (V1.6-A)

V1.6 responde **¿Mandaria puede realizar este LOCAL_DELIVERY y cuánto cuesta?** No elige proveedor, Driver ni vehículo: eso es Dispatch (V1.7).

```text
DeliveryRequest (CREATED) → ServiceType LOCAL_DELIVERY
  → ServiceZone ACTIVE de PICKUP = ServiceZone ACTIVE de DROPOFF
  → RatePlan ACTIVE (zona + servicio) → RoutingProvider (distancia/duración reales)
  → RateBand [min, max) → DeliveryQuote OFFERED (MQ-000001) → ACCEPTED
```

Ejemplo real de la validación local: `MDR-000037 → ruta 4509 m → banda 4000–6000 m → MQ-000001 → $50.00 MXN → ACCEPTED`.

### ServiceType y scheduling

- `DeliveryRequest.serviceType` (enum `ServiceType`) sólo admite `LOCAL_DELIVERY`. La migración asigna ese valor a todas las solicitudes V1.5 existentes (`DEFAULT`, sin reset). En la API es opcional al crear. Se omite del hash de idempotencia mientras sea el valor por defecto, así que los reintentos V1.5 siguen reconociéndose.
- Sólo servicio **inmediato**; no hay `scheduledFor`. Tres conceptos independientes: `requestedAt` (cuándo se pidió), `expiresAt` de la Quote (cuánto dura el precio) y `scheduledFor` (futuro: cuándo se realizará). **La vigencia de una Quote no indica cuándo se presta el servicio.**
- Futuro documentado, no implementado: `ERRAND`, `INTERCITY` (política de vigencia propia), `FREIGHT` (vigencias de 24 h o más) y servicios programados. Se añadirán como valores de `ServiceType` sin rediseñar RatePlan ni DeliveryQuote.

### Service Zones

- `ServiceZone`: `code` único, `name`, `status` ACTIVE/INACTIVE (nace INACTIVE), `currency` ISO 4217 inmutable y `boundary` GeoJSON `Polygon`/`MultiPolygon` en orden `[longitude, latitude]`. Las columnas de bounding box se usan como prefiltro SQL.
- **Estrategia geográfica sin PostGIS:** `src/geo/geometry.ts` concentra la validación (anillos cerrados, ≥ 4 posiciones, rangos, sin autointersecciones, área > 0, máximo 10000 posiciones), el punto en polígono (los bordes cuentan como dentro; los huecos excluyen) y la intersección entre zonas. Ningún controller ni servicio hace geometría por su cuenta. Migrar a PostGIS significa sustituir este módulo por `ST_Covers`/`ST_Intersects`.
- **Activación:** rechaza con `409 SERVICE_ZONE_OVERLAP` una zona que interseque o toque otra ACTIVE, así cada punto pertenece a lo sumo a una zona. Las activaciones se serializan con advisory lock más bloqueo de fila. Las zonas vecinas no deben compartir borde en V1.6.
- El boundary sólo se reemplaza con la zona INACTIVE (`409 SERVICE_ZONE_NOT_EDITABLE`). Desactivar una zona hace que las nuevas cotizaciones fallen con `OUT_OF_SERVICE_AREA`; las Quotes existentes conservan su snapshot.
- Ocozocoautla es una instancia de configuración, sin reglas propias en código. Local: `npm run db:seed:local-pricing` crea `LOCAL_OCOZOCOAUTLA` y `LOCAL_TUXTLA` con **rectángulos aproximados LOCAL/TEST**, no límites oficiales.

### Rate Plans y Rate Bands

- `RatePlan`: `serviceZoneId`, `serviceType`, `version` (1, 2, 3… por zona + servicio), `status` DRAFT → ACTIVE → INACTIVE, `calculationType` (`DISTANCE_BANDS`; `BASE_PLUS_DISTANCE` sólo documentado), `quoteValidityMinutes`, `currency` heredada de la zona, `activatedAt` y `deactivatedAt`.
- **Vigencia (TTL):** la base admite 1–10080 minutos; la política de `LOCAL_DELIVERY` es 1–120, con 15 recomendado. Configurable por SUPER_ADMIN.
- **Versionado:** crear un DRAFT (siguiente versión bajo bloqueo de la zona) o clonar una versión, editar el TTL, reemplazar las bandas, validar y activar. Al activar, la versión ACTIVE anterior pasa a INACTIVE **en la misma transacción**. El índice único parcial `RatePlan_active_zone_service_key` garantiza como máximo un ACTIVE aunque haya concurrencia.
- **Inmutabilidad histórica:** la API sólo edita DRAFT (`409 RATE_PLAN_NOT_EDITABLE`). Los triggers de PostgreSQL rechazan cambios estructurales en planes ACTIVE/INACTIVE, bandas insertadas o modificadas fuera de DRAFT y transiciones distintas de DRAFT→ACTIVE→INACTIVE. No hay DELETE por API; las FKs RESTRICT impiden borrar planes y bandas usados por Quotes.
- **`RateBand`:** `[minDistanceMeters, maxDistanceMeters)` en metros enteros (**min inclusivo, max exclusivo**), `amount` NUMERIC(14,2) > 0 y `currency` igual a la del plan. Un plan activable empieza en 0 y sus bandas son contiguas, así que 1999 m → primera banda, 2000 m → segunda, 3999 m → segunda y 4000 m → tercera. La distancia máxima soportada es el último `max`, exclusivo: con última banda 8000–10000, 10000 m y 11400 m dan `DISTANCE_NOT_SUPPORTED`.
- **Validación previa a activar:** huecos, solapes, inicio distinto de 0, rangos inválidos, montos ≤ 0 y monedas distintas → `422 RATE_PLAN_INVALID`. `POST .../validate` informa sin activar.

### Routing

- **Contrato:** `RoutingProvider.calculateRoute(origin, destination)` devuelve `{ distanceMeters, durationSeconds, routingProvider, calculatedAt }`. `DeliveryQuotesService` depende sólo del token `ROUTING_PROVIDER`; los tests lo sustituyen por un fake.
- **`GoogleRoutingProvider`** (Routes API `computeRoutes`):
  - La API key va sólo en la cabecera `X-Goog-Api-Key`; nunca en URL, logs, respuestas ni Swagger.
  - `X-Goog-FieldMask: routes.distanceMeters,routes.duration` limita respuesta y facturación, con `TRAFFIC_UNAWARE` y modo `DRIVE`/`TWO_WHEELER`.
  - No se guarda la respuesta de Google ni polyline.
- **Timeout y reintentos:** `GOOGLE_ROUTES_TIMEOUT_MS` por intento (1000–15000, por defecto 5000). `GOOGLE_ROUTES_MAX_RETRIES` (0–2, por defecto 1) reintentos extra sólo ante timeout, error de red, 429 o 5xx, con espera de 200 ms × intento. 4xx y respuestas inválidas no se reintentan.
- **Errores:** respuesta sin rutas → `ROUTE_NOT_FOUND` (422). Timeout, 5xx, 429, red, 4xx, clave ausente o respuesta inválida → `ROUTING_UNAVAILABLE` (503). **Nunca hay fallback a Haversine** ni precio aproximado.
- **Configuración:** `ROUTING_PROVIDER=google` (por defecto) exige `GOOGLE_ROUTES_API_KEY` cuando `NODE_ENV=production`. `ROUTING_PROVIDER=local_fake` (línea recta × 1.3) es **LOCAL/TEST ONLY** y se rechaza en producción.
- **Comprobación real explícita:** `npm run routing:check-google` hace una única llamada facturable con la key de `.env` e imprime sólo distancia, duración y latencia. No forma parte de `npm test` ni de las E2E.

### Delivery Quotes

- **`DeliveryQuote`** es un snapshot inmutable: `publicId` `MQ-000001` (secuencia PostgreSQL, igual que MDR), `deliveryRequestId`, `serviceType`, `serviceZoneId`, `ratePlanId`, `rateBandId`, `distanceMeters`, `durationSeconds`, `amount`, `currency`, `routingProvider`, `routeCalculatedAt`, `expiresAt` y `createdAt`.
  - Sólo cambian `status` y sus timestamps (`acceptedAt`, `expiredAt`, `cancelledAt`, `cancellationReason`); lo garantiza un trigger.
  - FKs compuestas aseguran que la banda pertenece al plan y el plan a la zona.
- **Estados:** OFFERED → ACCEPTED | EXPIRED | CANCELLED; no hay transiciones desde ACCEPTED.
  - Índices únicos parciales: como máximo una OFFERED y una ACCEPTED por DeliveryRequest.
  - Una OFFERED con `now >= expiresAt` se informa como EXPIRED en lecturas y filtros, y se persiste EXPIRED al intentar aceptarla o al cotizar de nuevo (sin cron).
- **Cotizar** (`POST /delivery-requests/:publicId/quotes`) con bloqueo `FOR UPDATE` de la DeliveryRequest:
  1. La solicitud debe estar CREATED (`409 DELIVERY_REQUEST_NOT_QUOTABLE`).
  2. Si existe ACCEPTED u OFFERED vigente, se devuelve (200, `Quote-Reused: true`) sin recalcular ni llamar a routing.
  3. Se marca EXPIRED la vencida.
  4. Se resuelven las zonas: `OUT_OF_SERVICE_AREA`, `CROSS_ZONE_NOT_SUPPORTED` o `SERVICE_ZONE_AMBIGUOUS` si hay anomalía.
  5. Se busca el RatePlan ACTIVE: `RATE_CONFIGURATION_UNAVAILABLE` o `RATE_CONFIGURATION_INVALID`. Se comprueba **antes** de llamar a routing para no pagar rutas que no se pueden tarificar.
  6. Routing, banda (`DISTANCE_NOT_SUPPORTED`) y Quote OFFERED con `expiresAt = createdAt + quoteValidityMinutes` (201).
- **Idempotencia natural:** 20 cotizaciones simultáneas producen una Quote y una llamada de routing (las demás esperan el bloqueo y reutilizan). No se añadió un segundo sistema de idempotencia: la unicidad es por DeliveryRequest y `Idempotency-Key` sigue siendo la infraestructura V1.5 para crear solicitudes. La transacción tiene un presupuesto igual al peor caso de routing más margen.
- **Un fallo nunca crea Quote ni cancela la solicitud:** sigue CREATED y puede reintentarse. Nunca se usa `amount = 0` como error.
- **Aceptar** (`POST /delivery-quotes/:publicId/accept`): OFFERED vigente → ACCEPTED, serializado sobre la solicitud. Repetir es idempotente (200). Si venció: `409 QUOTE_EXPIRED` (queda EXPIRED); cancelada o solicitud cancelada: `409 QUOTE_NOT_ACCEPTABLE`. El precio aceptado queda congelado; los nuevos planes sólo afectan Quotes nuevas. SUPER_ADMIN no acepta en V1.6.
- **Cancelar la DeliveryRequest** (B2B o admin, misma transacción y bloqueo): las OFFERED vigentes pasan a CANCELLED (`DELIVERY_REQUEST_CANCELLED`) y las vencidas a EXPIRED. Una ACCEPTED **se conserva como historial** y la solicitud queda CANCELLED; desde V1.8 la cancelación cierra además la asignación de Driver y Vehicle ACTIVE con `DELIVERY_CANCELLED`.
- **Precio de entrega vs mercancía:** el costo logístico es `acceptedQuote.amount`; no se duplica `deliveryFee` en DeliveryRequest. `goodsValue`/`goodsPaymentMode` (V1.5) siguen independientes: con 450 COURIER_ADVANCE y Quote de 50, la Quote es 50, nunca 500. No hay créditos, wallet ni costo de plataforma al proveedor.

### Endpoints V1.6

| Método | Ruta | Autorización |
|---|---|---|
| POST | /delivery-requests/:publicId/quotes | B2B `quotes:create` (30/min por IP) |
| GET | /delivery-requests/:publicId/quotes | B2B `quotes:read` |
| GET | /delivery-quotes/:publicId | B2B `quotes:read` |
| POST | /delivery-quotes/:publicId/accept | B2B `quotes:accept` |
| GET | /admin/delivery-quotes, /admin/delivery-quotes/:publicId, /admin/delivery-requests/:publicId/quotes | SUPER_ADMIN (lectura) |
| POST, GET | /admin/service-zones | SUPER_ADMIN |
| GET, PATCH | /admin/service-zones/:id | SUPER_ADMIN (PATCH sólo name) |
| PUT | /admin/service-zones/:id/boundary | SUPER_ADMIN (zona INACTIVE) |
| POST | /admin/service-zones/:id/activate, /deactivate | SUPER_ADMIN |
| POST, GET | /admin/rate-plans | SUPER_ADMIN |
| GET, PATCH | /admin/rate-plans/:id | SUPER_ADMIN (PATCH sólo DRAFT) |
| PUT | /admin/rate-plans/:id/bands | SUPER_ADMIN (DRAFT) |
| POST | /admin/rate-plans/:id/clone, /validate, /activate, /deactivate | SUPER_ADMIN |

- **Scopes nuevos:** `quotes:read` y `quotes:accept` se suman a `quotes:create` en el catálogo V1.1. Ningún scope implica otro.
- **Aislamiento:** solicitudes y Quotes de otro IntegrationClient → 404.
- **Roles humanos:** PROVIDER_ADMIN y DRIVER reciben 403 en toda la administración de zonas, planes y Quotes, y 401 en las rutas B2B.
- **Formato de error:** los errores de dominio usan `code` estable en la respuesta (p. ej. `{ "statusCode": 422, "code": "OUT_OF_SERVICE_AREA", ... }`); los 5xx mantienen mensaje sanitizado.
- **Respuesta B2B de Quote:** `publicId`, `deliveryRequestPublicId`, `serviceType`, zona (code/name), distancia, duración, `amount` string, `currency`, `status`, `createdAt`, `expiresAt`, `acceptedAt`, `cancelledAt` y `cancellationReason`. Sin UUID internos, plan, banda ni proveedor de routing; SUPER_ADMIN los ve.
- **Auditoría (logs JSON):** `DELIVERY_QUOTE_CREATED` (plan, versión, distancia, monto), `DELIVERY_QUOTE_ACCEPTED`, `DELIVERY_QUOTE_EXPIRED`, `DELIVERY_QUOTE_CANCELLED`, `DELIVERY_QUOTE_FAILED` (`reasonCode`), `ROUTING_CALCULATED`/`ROUTING_FAILED` (proveedor, latencia, motivo), `SERVICE_ZONE_*` y `RATE_PLAN_*`, con `actorType`/`actorId`. Nunca incluyen coordenadas, direcciones, contactos, API keys, tokens ni secretos.

### Ejemplo B2B (PowerShell)

```powershell
$base = 'http://localhost:3000/api/v1'
$token = (Invoke-RestMethod -Method Post -Uri "$base/integrations/token" -ContentType 'application/json' -Body (@{ clientId = '<CREDENTIAL_ID>'; clientSecret = '<CLIENT_SECRET>' } | ConvertTo-Json)).accessToken
$h = @{ Authorization = "Bearer $token" }
# DeliveryRequest creada según V1.5 (MDR-000037) con pickup/dropoff dentro de la zona
$quote = Invoke-RestMethod -Method Post -Uri "$base/delivery-requests/MDR-000037/quotes" -Headers $h
$quote | Select-Object publicId, distanceMeters, amount, currency, status, expiresAt
Invoke-RestMethod -Uri "$base/delivery-quotes/$($quote.publicId)" -Headers $h        # snapshot, sin recalcular
Invoke-RestMethod -Method Post -Uri "$base/delivery-quotes/$($quote.publicId)/accept" -Headers $h
```

### Configuración y verificación local (LOCAL/TEST ONLY)

```powershell
npm run db:deploy
npm run db:seed:local-pricing          # zonas LOCAL_OCOZOCOAUTLA y LOCAL_TUXTLA + plan v1 (35/40/50/60/70 MXN, 0–10 km, TTL 15)
npm run build
$env:ROUTING_PROVIDER='local_fake'; npm run start:prod   # o google con GOOGLE_ROUTES_API_KEY
npm run verify:delivery-quotes         # otra terminal: 9 comprobaciones HTTP reales
npm run routing:check-google           # opcional: una llamada real a Google Routes
```

- Los precios del seed son **placeholders**, no valores comerciales; la configuración de producción la crea un SUPER_ADMIN por API. El seed se niega fuera de development/test o con base no local y no está conectado al flujo de producción.
- Pruebas: `test/pricing.spec.ts` (geometría, bandas, adaptador Google con HTTP simulado, configuración), `test/pricing-admin.e2e-spec.ts` (zonas, planes, versionado, concurrencia, triggers, roles) y `test/delivery-quotes.e2e-spec.ts` (bandas 0/1999/2000/3999/4000/9999/10000/11400, ciclo de vida, snapshot, expiración con reloj simulado, errores de zona, tarifa y routing, cancelación, 20 cotizaciones y 10 aceptaciones concurrentes, aislamiento, scopes, roles, auditoría y Swagger). `node scripts/verify-migrations.mjs` cubre V1.5 → V1.6 con datos.

## Production User Provisioning (V1.6.1-A)

Única vía soportada para que una persona real entre a Mandaria como PROVIDER_ADMIN o DRIVER. Ningún administrador define ni conoce la contraseña de otra persona; no existe `POST /users` con contraseña.

```text
SUPER_ADMIN
  → Provider A → invitar PROVIDER_ADMIN (email + membershipRole)
  → invitar DRIVER (email + driverName)            [también posible]

PROVIDER_ADMIN (con membership en Provider A)
  → invitar DRIVER sólo en Provider A

Persona invitada
  → correo: {MANDARIA_WEB_URL}/activate-account?token=…
  → POST /auth/activate-account { token, password }
  → cuenta ACTIVE (+ ProviderMembership o Driver)
  → POST /auth/login normal
```

SUPER_ADMIN sigue creándose sólo con el bootstrap (`npm run db:seed`, `BOOTSTRAP_ADMIN_EMAIL/PASSWORD`), que no usa invitaciones. No se pueden invitar SUPER_ADMIN. Los seeds locales siguen existiendo para desarrollo, pero **no son un mecanismo de aprovisionamiento de producción**.

### Matriz de roles

| Actor | Puede invitar | Alcance |
|---|---|---|
| SUPER_ADMIN | PROVIDER_ADMIN, DRIVER | Cualquier proveedor (`/admin/providers/:providerId/invitations`) |
| PROVIDER_ADMIN | DRIVER | Sólo proveedores con membership vigente (`/provider/driver-invitations`); el payload no acepta `role` ni `providerId` |
| DRIVER | — | 403 |
| IntegrationClient | — | 401 en todas las rutas de usuarios e invitaciones |

La política vive en `src/invitations/invitation-policy.ts` y el servicio la vuelve a comprobar aunque el controller ya limite el rol.

### Estado de la cuenta (INVITED / ACTIVE / DISABLED)

Decisión menos disruptiva: no se agregó columna de estado. `User.active` se conserva (guards, servicios, seeds y pruebas lo usan) y `passwordHash` pasó a ser opcional:

| Estado | Representación | Login |
|---|---|---|
| INVITED | `active = false` y `passwordHash IS NULL` (nunca activada) | 401 idéntico a contraseña incorrecta |
| ACTIVE | `active = true` (CHECK: siempre con `passwordHash`) | Normal |
| DISABLED | `active = false` con `passwordHash` | 401, como antes |

`GET /users` devuelve `status` derivado y acepta `?status=INVITED|ACTIVE|DISABLED`; la migración conserva todas las cuentas previas (activas → ACTIVE, inactivas → DISABLED). No existe API de desactivación; el comportamiento previo de `active = false` en login, refresh y guards no cambió.

### Ciclo de vida de la invitación

| Estado | Persistido | Significado |
|---|---|---|
| PENDING | Sí | Token vigente (`now < expiresAt`) |
| EXPIRED | **No** | PENDING con `now >= expiresAt`; se calcula en lectura y filtros, sin cron |
| ACCEPTED | Sí | Cuenta activada; token inservible |
| REVOKED | Sí | Revocada por un administrador; token inservible |

- **Token:** 256 bits aleatorios (`base64url`, 43 caracteres). Sólo se guarda su SHA-256 (`tokenHash`); el valor en claro existe únicamente en el correo. Nunca se devuelve en respuestas, Swagger ni logs.
- **Vigencia:** `USER_INVITATION_TTL_HOURS` (default 24, 1–168).
- **Una sola invitación válida:** índice único parcial `UserInvitation(userId) WHERE status = 'PENDING'`, más bloqueo de fila del User. 20 invitaciones simultáneas al mismo email producen 1 User y 1 invitación (probado).
- **Reenvío:** rota el token en la misma fila (el enlace anterior deja de funcionar), reinicia `expiresAt`, incrementa `resendCount` y envía un correo nuevo. Sirve para PENDING vigentes o vencidas. Enfriamiento `USER_INVITATION_RESEND_COOLDOWN_SECONDS` (default 60) comprobado bajo bloqueo: reenvíos simultáneos rotan el token una sola vez.
- **Revocación:** PENDING → REVOKED; repetir es idempotente; ACCEPTED → 409. El User queda INVITED (sin contraseña ni acceso) y el email puede invitarse de nuevo reutilizando el mismo User. No se borra historial.
- **Activación (transacción única):** token válido y vigente → contraseña Argon2id → User ACTIVE con el rol invitado y `emailVerifiedAt` → ProviderMembership o Driver → invitación ACCEPTED. Cualquier error revierte todo. Estados, token y User se vuelven a comprobar bajo bloqueo: activaciones simultáneas producen un éxito y el resto `INVITATION_ALREADY_ACCEPTED`.
- **Inmutabilidad (trigger `UserInvitation_immutable`):** usuario, email, rol, proveedor, membershipRole, driverName y creador nunca cambian; una invitación ACCEPTED o REVOKED ya no puede modificarse.

### Membership y Driver: se materializan al activar

Decisión: opción **B** para ambos roles. La invitación guarda `providerId` y `membershipRole` (PROVIDER_ADMIN) o `driverName` (DRIVER); la membership o el Driver se crean en la transacción de activación. Así se preservan las invariantes existentes de V1.2/V1.4 (una membership o un Driver siempre pertenecen a un User activo con el rol correcto), no hace falta limpiar nada al revocar y un proveedor nunca ve en `/provider/drivers` a alguien que aún no aceptó. `POST /admin/providers/:providerId/members` y `POST …/drivers` siguen disponibles para Users que ya estén activos.

Capacidad: una invitación DRIVER PENDING vigente **reserva un lugar**: Drivers + invitaciones DRIVER pendientes vigentes no pueden superar `maxDrivers` (409 `PROVIDER_DRIVER_LIMIT_REACHED`). Al activar se vuelve a comprobar con bloqueo del proveedor.

### Endpoints

| Método | Ruta | Autorización | Resultado |
|---|---|---|---|
| POST | /admin/providers/:providerId/invitations | SUPER_ADMIN | 201 invitación + `emailDelivery` |
| GET | /admin/user-invitations | SUPER_ADMIN | Paginado; filtros `status`, `role`, `providerId`, `search` |
| GET | /admin/user-invitations/:invitationId | SUPER_ADMIN | Detalle |
| POST | /admin/user-invitations/:invitationId/resend | SUPER_ADMIN | 200 token rotado + correo |
| POST | /admin/user-invitations/:invitationId/revoke | SUPER_ADMIN | 200 REVOKED |
| POST | /provider/driver-invitations[?providerId] | PROVIDER_ADMIN + membership | 201 invitación DRIVER |
| GET | /provider/driver-invitations[?providerId] | PROVIDER_ADMIN + membership | Sólo invitaciones DRIVER de su proveedor |
| GET | /provider/driver-invitations/:invitationId | PROVIDER_ADMIN + membership | 404 fuera de su proveedor |
| POST | /provider/driver-invitations/:invitationId/resend | PROVIDER_ADMIN + membership | Igual que admin |
| POST | /provider/driver-invitations/:invitationId/revoke | PROVIDER_ADMIN + membership | Igual que admin |
| POST | /auth/activate-account | Pública (token) | 200 `{status:"ACTIVE", email, role}`; no emite sesión |
| GET | /users[?status] | SUPER_ADMIN | Incluye `status` derivado |

DTOs: SUPER_ADMIN `{ email, role: PROVIDER_ADMIN|DRIVER, membershipRole? (OWNER|ADMIN, obligatorio con PROVIDER_ADMIN), driverName? (1–100, obligatorio con DRIVER) }`; PROVIDER_ADMIN `{ email, driverName }`; activación `{ token, password }`. Email normalizado (trim + minúsculas) igual que login. La contraseña reutiliza la política real del bootstrap: **16–128 caracteres** (`src/common/password-policy.ts`, compartida por bootstrap, activación y límite de login).

### Errores de dominio (`code`)

| Código | HTTP | Cuándo |
|---|---|---|
| USER_ALREADY_ACTIVE | 409 | El email pertenece a una cuenta ACTIVE (no se crea otro User) |
| USER_INVITATION_PENDING | 409 | Ya hay invitación PENDING (vigente o vencida): usar resend |
| USER_DISABLED | 409 | Cuenta DISABLED: no se reactiva por invitación; requiere política administrativa explícita |
| PROVIDER_DRIVER_LIMIT_REACHED | 409 | Sin lugar para otro Driver (al invitar, reenviar o activar) |
| INVITATION_NOT_PENDING | 409 | Reenviar una invitación aceptada/revocada o revocar una aceptada |
| INVITATION_RESEND_COOLDOWN | 429 | Reenvío antes del enfriamiento |
| INVITATION_TOKEN_INVALID | 400 | Token desconocido o reemplazado por un reenvío |
| INVITATION_EXPIRED | 410 | `now >= expiresAt` |
| INVITATION_REVOKED | 410 | Invitación revocada |
| INVITATION_ALREADY_ACCEPTED | 409 | Token ya usado |
| ACCOUNT_NOT_ACTIVATABLE | 409 | La cuenta ya no está INVITED |
| MAIL_NOT_CONFIGURED | 503 | Falta `MANDARIA_WEB_URL`; no se crea ni rota nada |

El endpoint público trabaja sólo con el token: no acepta email ni revela si una cuenta existe. Los administradores autenticados sí reciben los conflictos útiles de su alcance.

### Correo (MailProvider)

El dominio depende sólo de la interfaz `MailProvider.sendUserInvitation(...)` (`src/mail/`). Adaptadores:

| MAIL_PROVIDER | Uso |
|---|---|
| `smtp` | Producción (obligatorio). Cualquier relay SMTP (Resend, SES, Postmark, Mailgun, propio) vía nodemailer; STARTTLS obligatorio en producción salvo `SMTP_SECURE=true`; timeouts; errores reducidos a un código (`EAUTH`, `ECONNECTION`…) |
| `local_outbox` | **LOCAL/TEST ONLY** y default fuera de producción: escribe cada correo como JSON privado en `LOCAL_MAIL_OUTBOX_DIR` o `<temp del SO>/mandaria-mail-outbox`, fuera del repositorio. Contiene el enlace con token: nunca usar en producción (la configuración lo rechaza) |
| FakeMailProvider | Sólo pruebas automatizadas (`test/support/fake-mail.provider.ts`); nunca envían correo real |

El correo se envía **después** del commit: si falla, la invitación queda PENDING, la respuesta indica `emailDelivery: "FAILED"` y puede reenviarse. Plantilla en español con proveedor, rol (Administrador de proveedor / Repartidor), botón «Activar cuenta» y fecha de expiración en hora del centro de México; nunca incluye contraseña. Recomendación para Mandaria Web: leer `token` de la URL, eliminarlo del historial (`history.replaceState`) y servir la página con `Referrer-Policy: no-referrer`.

Configuración (ver `.env.example`): `MANDARIA_WEB_URL` (https obligatorio en producción), `USER_INVITATION_TTL_HOURS`, `USER_INVITATION_RESEND_COOLDOWN_SECONDS`, `MAIL_PROVIDER`, `MAIL_FROM`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`/`SMTP_PASSWORD` (juntos), `LOCAL_MAIL_OUTBOX_DIR`. **Actualización de despliegues:** con `NODE_ENV=production` el backend no arranca sin `MAIL_PROVIDER=smtp`, `SMTP_HOST`, `MAIL_FROM` y `MANDARIA_WEB_URL` https.

### Seguridad, límites y auditoría

- Límites por IP: creación 20/min (por ruta), reenvío 10/min, activación 10/min; además el enfriamiento por invitación evita abuso de correo.
- Bloqueos: proveedor (DRIVER) → User → invitación, en ese orden en invitar, reenviar y activar.
- Eventos (logs JSON): `USER_INVITED`, `USER_INVITATION_RESENT`, `USER_INVITATION_REVOKED`, `USER_INVITATION_ACCEPTED`, `USER_ACTIVATED`, `PROVIDER_MEMBER_ADDED`/`DRIVER_CREATED` con `source: "invitation"`, `USER_INVITATION_EMAIL_SENT`/`USER_INVITATION_EMAIL_FAILED` (con `reason`) y `USER_ACTIVATION_REJECTED` (con `reason`). Incluyen `invitationId`, `targetUserId`, `role`, `providerId`, `actorId` y marca de tiempo; nunca token, hash, contraseña, email ni JWT (verificado en E2E).

### Verificación local

```powershell
npm run db:seed
npm run db:seed:local-provider-admins
# backend con salida de correo local y URL de Mandaria Web (sin editar .env versionados):
$env:MAIL_PROVIDER='local_outbox'; $env:MANDARIA_WEB_URL='http://localhost:5173'; node dist/main.js
npm run verify:user-invitations
```

El script usa login real (5 logins), lee el token del outbox local como lo haría la persona invitada, comprueba `Admin A → Provider A ✅ / Provider B ❌`, activación, reutilización rechazada y `/driver/me`, y elimina sólo las cuentas que creó. No imprime contraseñas ni tokens.

Pruebas: `test/invitations.spec.ts` (token/hash, expiración, errores, matriz de roles, política de contraseña, validaciones previas a la base, plantilla, SMTP con transporte simulado, outbox local y configuración) y `test/user-invitations.e2e-spec.ts` (flujos PROVIDER_ADMIN y DRIVER completos con login/refresh/logout, aislamiento A/B en ambos sentidos, matriz de roles, IntegrationClient, expirado, reutilizado, revocado, duplicados, ACTIVE/DISABLED, validaciones, fallo de correo, reserva de lugares, concurrencia de invitación/reenvío/activación, rate limits, invariantes SQL y auditoría sin secretos). `node scripts/verify-migrations.mjs` cubre V1.6 → V1.6.1 con datos.

## Dispatch Engine (V1.7-A)

Responde: una vez aceptada la cotización, ¿qué proveedores pueden realizar el servicio y cuál lo toma?

```text
IntegrationClient → POST /delivery-quotes/:publicId/accept
      ↓  (misma transacción)
DeliveryQuote ACCEPTED + Dispatch OPEN + candidatos (snapshot)
      ↓
PROVIDER_ADMIN → GET /provider/dispatches?view=AVAILABLE
      ↓
POST /provider/dispatches/:dispatchId/claim  → exactamente 1 gana
      ↓
Dispatch CLAIMED (claimedByProviderId)
```

El IntegrationClient no llama ningún endpoint de dispatch: aceptar la Quote basta. V1.7 no asigna Driver ni Vehicle, no usa disponibilidad/GPS de repartidores ni envía notificaciones.

### Elegibilidad

Un proveedor es candidato cuando, al abrirse el Dispatch:

1. `DeliveryProvider.status = ACTIVE`;
2. tiene una `ProviderServiceCoverage` **ACTIVE** para la **ServiceZone** de la Quote aceptada (calculada geográficamente en V1.6, nunca por texto de dirección);
3. y para su **ServiceType** (`LOCAL_DELIVERY` hoy; el motor no está atado a ese valor).

`ProviderServiceCoverage` es el modelo mínimo nuevo (antes no existía relación proveedor–zona–servicio) y representa la habilitación operacional. La administra SUPER_ADMIN:

| Método | Ruta | Uso |
|---|---|---|
| POST | /admin/providers/:providerId/service-coverages | `{serviceZoneId, serviceType}` → ACTIVE; 409 `SERVICE_COVERAGE_EXISTS` |
| GET | /admin/providers/:providerId/service-coverages | Lista |
| PATCH | /admin/providers/:providerId/service-coverages/:coverageId | `{status: ACTIVE\|INACTIVE}` |
| GET | /provider/service-coverages | PROVIDER_ADMIN: coberturas propias (lectura) |

Los candidatos se guardan como **snapshot** (`DispatchCandidate`) y no se recalculan: el historial responde a quién se ofreció. La elegibilidad se vuelve a comprobar al reclamar (proveedor suspendido o cobertura desactivada → 409 `PROVIDER_NOT_ELIGIBLE`).

**Sin candidatos:** la aceptación nunca falla por falta de proveedores. El Dispatch se crea OPEN sin candidatos y queda así hasta vencer. No se añadió un estado `NO_PROVIDER_FOUND`: la vista de administración expone la señal derivada `noProviderAvailable` (OPEN sin candidaturas OFFERED; también tras liberaciones que agotan candidatos) y el evento `DISPATCH_OPENED` registra `candidateCount`.

### Estados y transiciones

| Dispatch | Significado |
|---|---|
| OPEN | Reclamable hasta `expiresAt` |
| CLAIMED | Tomado por `claimedByProviderId`; el claim no caduca con `expiresAt` |
| EXPIRED | Ventana cerrada sin claim (persistencia perezosa: un OPEN vencido se informa EXPIRED y se guarda al intentar reclamar) |
| CANCELLED | La DeliveryRequest fue cancelada |

| DispatchCandidate | Significado |
|---|---|
| OFFERED | Puede reclamar mientras el Dispatch esté OPEN |
| CLAIMED | Tiene (o tenía al cancelarse) el claim |
| RELEASED | Liberó el claim; no puede reclamar de nuevo ese Dispatch |

No se añadió `EXCLUDED`: cuando otro proveedor gana, los demás siguen OFFERED como historial y vuelven a poder reclamar si el ganador libera. Transiciones permitidas (trigger SQL): OPEN → CLAIMED/EXPIRED/CANCELLED; CLAIMED → OPEN (liberación en ventana)/EXPIRED (liberación tras la ventana)/CANCELLED. EXPIRED y CANCELLED son terminales.

### Configuración y expiración

`DISPATCH_TTL_MINUTES` (1–1440, default **10**): `openedAt = acceptedAt`, `expiresAt = openedAt + TTL`, independiente de `DeliveryQuote.expiresAt`. No hay cron ni cola: la expiración es perezosa y `now >= expiresAt` impide reclamar.

### Claim, liberación y cancelación

- **Claim** (`POST /provider/dispatches/:dispatchId/claim`, sin body): el proveedor sale de la membership (`?providerId=` sólo elige entre las propias; con varias memberships es obligatorio). Requiere Dispatch OPEN y vigente, candidatura OFFERED y proveedor elegible. Repetir el claim del ganador devuelve 200 sin cambios.
- **Concurrencia:** la transacción bloquea la fila del Dispatch (`SELECT … FOR UPDATE`); los claims simultáneos se serializan y todos salvo el primero ven CLAIMED → 409 `DISPATCH_ALREADY_CLAIMED` sin escribir. Respaldo en PostgreSQL: índice único parcial de un candidato CLAIMED por Dispatch y trigger que exige que el dueño sea un candidato CLAIMED.
- **Liberación** (`POST /provider/dispatches/:dispatchId/release`, `{reason}` 3–500): sólo el dueño actual. Su candidatura pasa a RELEASED; en ventana el Dispatch vuelve a OPEN para los demás; tras `expiresAt` pasa a EXPIRED. Liberaciones simultáneas: una aplica, el resto 409.
- **Cancelación:** integrada en la cancelación oficial de V1.5 (`POST /delivery-requests/:publicId/cancel` y `/admin/delivery-requests/:publicId/cancel`), en la misma transacción. OPEN/CLAIMED → CANCELLED (`DELIVERY_REQUEST_CANCELLED`); un CLAIMED cancelado **conserva `claimedByProviderId`** como historial. Un OPEN ya vencido se cierra como EXPIRED. Nunca quedan DeliveryRequest CANCELLED y Dispatch operativo.
- **Quién no reclama:** SUPER_ADMIN (403: administra, no actúa como flotilla), DRIVER (403; V1.9) e IntegrationClient (401).

### Consultas de proveedor y exposición de datos

`GET /provider/dispatches` (`view=AVAILABLE|CLAIMED|ALL`, `status` efectivo, paginación) y `GET /provider/dispatches/:dispatchId` sólo muestran Dispatches donde el proveedor fue candidato; uno ajeno responde 404. El detalle depende de `access`:

| access | Cuándo | Incluye |
|---|---|---|
| OFFER | OPEN, vigente, candidatura OFFERED | Zona, servicio, tarifa (`deliveryFee`), ruta, direcciones y coordenadas, paquetes sin texto libre, mercancía (`goodsValue`, `goodsPaymentMode`, `driverAdvancesGoods` para COURIER_ADVANCE) |
| OWNER | Mi proveedor tiene (o tenía al cancelarse) el claim | Lo anterior + contactos, instrucciones, descripción de paquetes, `deliveryRequestPublicId`, `externalReference` |
| SUMMARY | Cualquier otro caso | Estado y fechas; `service = null` |

Nunca se exponen a proveedores el IntegrationClient, otros candidatos ni secretos. SUPER_ADMIN consulta `GET /admin/dispatches` (filtros status, providerId, deliveryRequestPublicId) y `GET /admin/dispatches/:dispatchId` con candidatos y motivos.

### Errores de dominio

| Código | HTTP | Cuándo |
|---|---|---|
| DISPATCH_ALREADY_CLAIMED | 409 | Otro proveedor tiene el claim (incluye el perdedor de una carrera) |
| DISPATCH_EXPIRED | 409 | `now >= expiresAt` sin claim |
| DISPATCH_CANCELLED | 409 | Servicio cancelado |
| DISPATCH_RECLAIM_NOT_ALLOWED | 409 | Mi proveedor liberó ese Dispatch |
| DISPATCH_NOT_CLAIMED_BY_PROVIDER | 409 | Liberar sin tener el claim |
| PROVIDER_NOT_ELIGIBLE | 409 | Proveedor no ACTIVE o cobertura INACTIVE al reclamar |
| SERVICE_COVERAGE_EXISTS | 409 | Cobertura duplicada |

### Base de datos y auditoría

- Migración `20260917000800_dispatch_engine`: tablas `ProviderServiceCoverage`, `Dispatch`, `DispatchCandidate`; únicos `Dispatch.deliveryQuoteId`, `DispatchCandidate(dispatchId, providerId)`, `ProviderServiceCoverage(providerId, serviceZoneId, serviceType)`; índice parcial de un candidato CLAIMED por Dispatch; CHECK de coherencia de estados; triggers `Dispatch_guard` (sólo nace OPEN para una Quote ACCEPTED de su solicitud, identidad y ventana inmutables, transiciones válidas) y `DispatchCandidate_guard`.
- Índices: `Dispatch(status, expiresAt)`, `Dispatch(claimedByProviderId, status)`, `Dispatch(deliveryRequestId)`, `Dispatch(createdAt, id)`, `DispatchCandidate(providerId, status, dispatchId)` y `ProviderServiceCoverage(serviceZoneId, serviceType, status)`; el único `(dispatchId, providerId)` cubre las búsquedas por Dispatch.
- **Backfill:** las Quotes ACCEPTED anteriores a V1.7 reciben un Dispatch EXPIRED sin candidatos (o CANCELLED si su solicitud ya estaba cancelada), de modo que «ACCEPTED ⇒ Dispatch» se cumple para todos los datos. Nunca se ofrecen.
- **Invariante ACCEPTED ⇒ Dispatch:** la Quote pasa a ACCEPTED y el Dispatch se inserta en la misma transacción (probado con un fallo forzado: la Quote sigue OFFERED). El único por `deliveryQuoteId` impide un segundo Dispatch en aceptaciones repetidas o simultáneas.
- Eventos: `DISPATCH_OPENED` (candidateCount, noProviderAvailable), `DISPATCH_CLAIMED`, `DISPATCH_RELEASED` (reason), `DISPATCH_EXPIRED` (reason), `DISPATCH_CANCELLED`, `PROVIDER_COVERAGE_CREATED/UPDATED`, con `dispatchId`, `providerId`, `actorUserId`/`actorId` y marca de tiempo; sin tokens, contactos ni direcciones.

Pruebas: `test/dispatch.spec.ts` (TTL, expiración, reglas de claim, apertura con y sin candidatos, cancelación, exposición por access, autorización del servicio) y `test/dispatch.e2e-spec.ts` (creación automática, candidatos A/B vs C otra zona, D suspendido y F cobertura inactiva, sin candidatos, aceptación repetida y concurrente, atomicidad, claim con login real, aislamiento y roles, múltiples memberships, liberación y no reclamo, liberaciones concurrentes, 3 rondas de 15 claims simultáneos de 5 proveedores, expiración, cancelación OPEN/CLAIMED, invariantes SQL y auditoría).

## Provider Driver & Vehicle Assignment (V1.8-A)

Responde: el proveedor ya reclamó el servicio, ¿**qué Driver y qué Vehicle** de su flotilla lo ejecutan?

```text
Dispatch CLAIMED (V1.7)
      ↓
PROVIDER_ADMIN → GET /provider/dispatches/:id/available-drivers | available-vehicles
      ↓
POST /provider/dispatches/:id/assignment  {driverId, vehicleId}
      ↓
DeliveryAssignment ACTIVE  (1 por Dispatch, 1 por Driver, 1 por Vehicle)
      ↓  reassign (motivo)                ↓  cancel (motivo)
nueva ACTIVE + anterior REASSIGNED    anterior CANCELLED, sin reemplazo
```

La asignación **no cambia el estado del Dispatch** (sigue CLAIMED) ni crea estados de ejecución. El Driver no acepta ni rechaza: el proveedor decide (V1.8 no tiene Driver App). Nada de GPS, tracking, sockets, push, wallet ni saldos de repartidor.

### Historial, nunca sobrescritura

`DeliveryAssignment` es una tabla de historial: reasignar **no** edita la fila, cierra la anterior e inserta una nueva. `Dispatch` no guarda `driverId`/`vehicleId`.

| status | Significado |
|---|---|
| ACTIVE | Ejecuta el servicio ahora (máximo 1 por Dispatch) |
| REASSIGNED | Reemplazada por otra asignación (`endedAt`, `endReason`, quién) |
| CANCELLED | Liberada sin reemplazo, o cerrada por la cancelación del servicio |

Las filas cerradas son inmutables y la identidad (`dispatchId`, `providerId`, `driverId`, `vehicleId`, `assignedAt`, `assignedByUserId`) nunca cambia: lo garantizan CHECKs y el trigger `DeliveryAssignment_guard`, no sólo el servicio.

### Elegibilidad del Driver y del Vehicle

Asignables sólo los recursos **del proveedor dueño del claim**: `Driver.status = ACTIVE` con `User.active = true`, `Vehicle.status = ACTIVE`, proveedor ACTIVE, ninguno con otra asignación ACTIVE y respetando el emparejamiento V1.4 (`DriverVehicleAssignment` vigente). Un recurso de otro proveedor responde **404** (no existe para quien pregunta), nunca 403 con detalles. Orden de comprobación: existencia → elegibilidad → ocupación → emparejamiento.

`GET /provider/dispatches/:dispatchId/available-drivers` y `available-vehicles` (paginados) devuelven exactamente esos candidatos, con el vehículo/driver emparejado cuando existe.

### Endpoints

| Método | Ruta | Uso |
|---|---|---|
| POST | /provider/dispatches/:dispatchId/assignment | `{driverId, vehicleId}` → 201 ACTIVE |
| POST | /provider/dispatches/:dispatchId/assignment/reassign | `{driverId, vehicleId, reason, reasonDetail?}` → 200 nueva ACTIVE |
| POST | /provider/dispatches/:dispatchId/assignment/cancel | `{reason, reasonDetail?}` → 200 CANCELLED |
| GET | /provider/dispatches/:dispatchId/assignments | Historial del Dispatch (sólo el dueño del claim) |
| GET | /provider/dispatches/:dispatchId/available-drivers | Drivers asignables |
| GET | /provider/dispatches/:dispatchId/available-vehicles | Vehicles asignables |
| GET | /admin/dispatches/:dispatchId/assignments | SUPER_ADMIN: historial completo (auditoría) |

Sólo **PROVIDER_ADMIN con membership** asigna; el proveedor sale de la membership (`?providerId=` sólo elige entre las propias). SUPER_ADMIN y DRIVER reciben 403 (el admin no opera flotillas ajenas; el Driver es V1.9) y el IntegrationClient 401: el cliente B2B no elige repartidor. `reason` ∈ `DRIVER_UNAVAILABLE | VEHICLE_ISSUE | OPERATIONAL_CHANGE | OTHER` (`OTHER` exige `reasonDetail` de 3–500); `DELIVERY_CANCELLED` está reservado a la cancelación oficial y es 400 si lo envía un proveedor.

### Plazo de asignación

`LOCAL_DELIVERY_ASSIGNMENT_TTL_MINUTES` (1–1440, default **5**), por ServiceType (cada tipo nuevo añade su variable). `assignmentDeadline = claimedAt + TTL` y la señal derivada `assignmentOverdue` (CLAIMED sin asignación ACTIVE y `now > deadline`) aparecen en el detalle del Dispatch. **No** libera ni reasigna automáticamente: es visibilidad operativa, sin cron.

### Contexto de pago del servicio

La asignación devuelve `paymentContext` con datos V1.5/V1.6, sin mezclar dinero logístico y mercancía: `deliveryFee` (lo que cobra el proveedor), `goodsValue`, `goodsPaymentMode`, `driverAdvancesGoods` y `driverAdvanceAmount`. Con `COURIER_ADVANCE` el repartidor adelanta la mercancía al comercio y la recupera al entregar; **Mandaria no mueve ese dinero ni valida si el repartidor tiene efectivo** — es responsabilidad del proveedor. V1.8 no crea wallet, saldo ni crédito.

### Protección del servicio en curso

- **Liberar el Dispatch** (`/release`) con asignación ACTIVE → 409 `DISPATCH_HAS_ACTIVE_ASSIGNMENT`; hay que cancelar la asignación primero (queda auditado quién y por qué). Respaldo en `dispatch_guard`: la fila no puede salir de CLAIMED con una asignación ACTIVE.
- **Cancelar la DeliveryRequest** (B2B o admin) cierra en la misma transacción la asignación ACTIVE con `endReason = DELIVERY_CANCELLED`, conservando el historial.
- **Emparejamiento V1.4:** asignar o desasignar el vehículo de un Driver que está ejecutando una entrega → 409; primero se cierra la asignación de entrega.

### Errores de dominio

| Código | HTTP | Cuándo |
|---|---|---|
| DISPATCH_NOT_CLAIMED_BY_PROVIDER | 409 | El Dispatch no está CLAIMED por mi proveedor |
| DISPATCH_ALREADY_ASSIGNED | 409 | Ya hay una asignación ACTIVE (usar reassign) |
| NO_ACTIVE_ASSIGNMENT | 409 | Reasignar o cancelar sin asignación ACTIVE |
| ASSIGNMENT_UNCHANGED | 409 | Reasignar al mismo Driver y Vehicle |
| PROVIDER_NOT_ACTIVE | 409 | Proveedor suspendido |
| DRIVER_NOT_ELIGIBLE / VEHICLE_NOT_ELIGIBLE | 409 | Recurso no ACTIVE (o cuenta del Driver inactiva) |
| DRIVER_BUSY / VEHICLE_BUSY | 409 | Ya ejecuta otra entrega |
| DRIVER_VEHICLE_MISMATCH | 409 | Contradice el emparejamiento V1.4 |
| DISPATCH_HAS_ACTIVE_ASSIGNMENT | 409 | Liberar el claim con asignación ACTIVE |
| ASSIGNMENT_CONFLICT | 409 | Carrera resuelta por PostgreSQL (perdedor de un empate) |

### Base de datos y auditoría

- Migración `20260917000900_delivery_assignments`: tabla `DeliveryAssignment` (crea 0 filas para datos existentes), FKs compuestas `(driverId, providerId)` y `(vehicleId, providerId)` que hacen imposible mezclar flotillas, **tres índices únicos parciales** `WHERE status = 'ACTIVE'` (por Dispatch, por Driver y por Vehicle), CHECKs de coherencia (`ACTIVE` sin datos de cierre; cerradas con `endedAt >= assignedAt` y motivo; `OTHER` con detalle), trigger `DeliveryAssignment_guard` (nace ACTIVE para un Dispatch CLAIMED del mismo proveedor; identidad inmutable; filas cerradas congeladas) y `dispatch_guard` ampliado con `DISPATCH_HAS_ACTIVE_ASSIGNMENT`.
- Concurrencia: la transacción bloquea el Dispatch, el proveedor (SHARE), el Driver y el Vehicle en orden fijo; 10 asignaciones simultáneas sobre un Dispatch dejan exactamente 1 ACTIVE y 9 → 409, y el mismo Driver o Vehicle no puede quedar en dos Dispatches. Dos **reasignaciones** simultáneas no compiten: se serializan y la segunda parte de la nueva ACTIVE, de modo que el historial encadena los cambios (ambas responden 200) y sigue existiendo exactamente 1 ACTIVE.
- Eventos: `DELIVERY_ASSIGNMENT_CREATED`, `DELIVERY_ASSIGNMENT_REASSIGNED` (recursos anteriores y nuevos, motivo) y `DELIVERY_ASSIGNMENT_CANCELLED`, con `assignmentId`, `dispatchId`, `providerId`, `driverId`, `vehicleId` y `actorUserId`; sin tokens, contraseñas, contactos del cliente ni montos de mercancía.

Pruebas: `test/delivery-assignments.spec.ts` (plazo, TTL por ServiceType, contexto de pago, emparejamiento, guardas del servicio, cierre por cancelación) y `test/delivery-assignments.e2e-spec.ts` (recursos asignables y asignación con contexto de pago, aislamiento por proveedor y por dueño del claim, roles, emparejamiento V1.4 en ambos sentidos, recursos ocupados, reasignación con historial, protección de `/release`, cancelación del servicio, `assignmentOverdue`, 10 asignaciones simultáneas, carreras por Driver y por Vehicle, invariantes e inmutabilidad en PostgreSQL y auditoría sin secretos).

## Independent Drivers (V1.9-A)

Hasta V1.8 todo servicio se ejecutaba a través de un proveedor: el Dispatch se abre, un proveedor lo **reclama** y su administrador asigna Driver y Vehicle de su flotilla. V1.9 agrega un segundo modelo que **convive** con el anterior sin modificarlo: un repartidor habilitado por Mandaria **toma** el servicio por su cuenta, con un vehículo propio. Los dos caminos terminan en la misma `DeliveryAssignment`, no en motores paralelos.

```text
                    Dispatch OPEN
                          │
          ┌───────────────┴───────────────┐
      Provider                      Independent Driver
       CLAIM                              TAKE
          │                                 │
  (después) asignar Driver+Vehicle   claim + assignment atómicos
          └───────────────┬───────────────┘
                   EXACTAMENTE UNO
                          ↓
                 DeliveryAssignment ACTIVE
```

### El independiente no es un proveedor ficticio

No se crea un `DeliveryProvider` de una persona, ni un ProviderMembership de sí mismo. La capacidad es explícita: `IndependentDriverProfile`, una extensión 1:1 del `Driver` existente que **no duplica** nada que ya viva en él (nombre, estado, disponibilidad, proveedor). Estados: `PENDING`, `APPROVED`, `SUSPENDED`, `REJECTED`. V1.9 no tiene alta pública, así que SUPER_ADMIN crea el perfil directamente en `APPROVED`; `PENDING` queda reservado para el onboarding futuro, que podrá usarse sin migrar datos.

`ProviderType.INDEPENDENT` (V1.2) es otra cosa y no cambia: describe a un proveedor pequeño de una sola persona, con su flotilla y sus administradores. El repartidor independiente de V1.9 no tiene proveedor en su contexto de ejecución.

### Los dos contextos de una misma persona

Un `Driver` pertenece siempre a un proveedor (V1.4) y el aprovisionamiento de cuentas sigue siendo V1.6.1: V1.9 **no crea** Users ni Drivers, sólo habilita a uno existente. Por eso la misma persona puede operar en dos contextos, y **el contexto lo decide la ruta, nunca el payload**:

| Contexto | Quién actúa | Ruta | Recursos que puede usar |
|---|---|---|---|
| Flotilla | PROVIDER_ADMIN del proveedor con el claim | `POST /provider/dispatches/:id/assignment` | Driver y Vehicle **de ese proveedor** |
| Independiente | el propio repartidor (rol DRIVER) | `POST /driver/dispatches/:id/take` | sólo **sus** vehículos |

No hay ambigüedad posible ni fuga entre contextos: un vehículo pertenece a un proveedor **XOR** a un perfil independiente (`Vehicle_owner_check`), la pertenencia se relee en la base de datos en cada operación y el trigger `delivery_assignment_guard` la comprueba por modo. Usar un vehículo de la flotilla en un `take` responde 404, y asignar un vehículo independiente desde una ruta de proveedor también. Un repartidor suspendido como independiente conserva intacto su perfil de flotilla, y al revés.

### Vehículos propios

SUPER_ADMIN da de alta los vehículos del repartidor siguiendo el patrón de los vehículos de proveedor. Quedan con `providerId` nulo e `independentDriverProfileId` del repartidor; el identificador es único dentro del repartidor (índice único parcial), el límite lo fija `INDEPENDENT_DRIVER_MAX_VEHICLES` y cuentan todos los vehículos, sea cual sea su estado. Así:

```text
Carlos — Independent Driver
  MOTO-CARLOS-01  MOTORCYCLE  ACTIVE
  AUTO-CARLOS-01  CAR         ACTIVE
```

V1.9 no implementa verificación documental del vehículo ni del repartidor.

### Qué servicios admiten independientes

No se asume que todo servicio pueda tomarlo un independiente. `SERVICE_EXECUTION_MODES` (en `independent-driver-policy.ts`) declara el modo por `ServiceType` y es **exhaustivo por construcción**: agregar un ServiceType no compila hasta decidir su modo, de forma que ningún servicio futuro queda disponible para independientes por omisión.

| ServiceType | Modo | Motivo |
|---|---|---|
| `LOCAL_DELIVERY` | `BOTH` | Un paquete dentro de una zona es exactamente lo que hace un repartidor por cuenta propia, y V1.6 lo tarifa igual sin importar quién lo lleve. |

Un servicio declarado `FLEET` no aparecería en el listado del repartidor y su `take` respondería 409 `DISPATCH_NOT_OPEN_TO_INDEPENDENT`. Freight y los demás tipos siguen fuera de alcance.

### Elegibilidad para tomar un servicio

Perfil independiente `APPROVED` + User activo + Driver `ACTIVE` + **ninguna** asignación ACTIVE (de cualquier modelo) + vehículo propio `ACTIVE` y libre + Dispatch `OPEN` dentro de su ventana + ServiceType que admita independientes + no haberlo liberado antes. V1.9 **no** introduce presencia en tiempo real: no existen ONLINE/OFFLINE ni heartbeat, porque no hay Driver App.

### Endpoints

| Método | Ruta | Rol | Qué hace |
|---|---|---|---|
| GET | `/admin/independent-drivers` | SUPER_ADMIN | Lista perfiles con su Driver y número de vehículos |
| GET/POST | `/admin/drivers/:driverId/independent` | SUPER_ADMIN | Consulta / habilita (idempotente; reaprobar rehabilita) |
| POST | `/admin/drivers/:driverId/independent/suspend` y `/reject` | SUPER_ADMIN | Retira la habilitación con motivo obligatorio |
| GET/POST | `/admin/drivers/:driverId/independent/vehicles` | SUPER_ADMIN | Lista / da de alta vehículos propios |
| PATCH | `/admin/drivers/:driverId/independent/vehicles/:vehicleId` | SUPER_ADMIN | Edita detalles o estado |
| GET | `/driver/me` | DRIVER | Agrega `independent` y `activeDeliveryAssignment` |
| GET | `/driver/vehicles` | DRIVER | Mis vehículos propios |
| GET | `/driver/dispatches/available` | DRIVER | Servicios que puedo tomar (paginado) |
| GET | `/driver/dispatches/:dispatchId` | DRIVER | Detalle de uno ofrecido o tomado por mí |
| POST | `/driver/dispatches/:dispatchId/take` | DRIVER | Tomar el servicio (`vehicleId`) |
| POST | `/driver/dispatches/:dispatchId/release` | DRIVER | Liberarlo con motivo obligatorio |

Sólo SUPER_ADMIN habilita o suspende: PROVIDER_ADMIN no puede, un DRIVER no puede autoaprobarse y un token B2B no sirve en ninguna de estas rutas (401). SUPER_ADMIN tiene visibilidad y auditoría, pero **no** puede tomar ni liberar un servicio haciéndose pasar por el repartidor (403).

### Privacidad del repartidor

Dos niveles, equivalentes a los del proveedor en V1.7:

- **OFFER** (puedo tomarlo): ruta, direcciones con coordenadas, paquetes sin texto libre y contexto de pago. Sin contactos, sin instrucciones, sin referencia del comercio.
- **OWNER** (lo tomé): se agregan contactos, instrucciones, descripciones de paquete y el `publicId` del pedido.

Las consultas del repartidor usan un `select` propio que ni siquiera lee `DispatchCandidate`, `claimedByProviderId` ni el IntegrationClient, de modo que la relación comercial de un proveedor no puede filtrarse por descuido.

### Serialización con la suspensión

`take` bloquea la fila del perfil independiente junto con la del `Driver` (`FOR UPDATE OF d, p`), que es la misma fila que bloquea la suspensión. Orden de bloqueo: Dispatch → perfil + Driver → Vehicle; la suspensión sólo toma el bloqueo del perfil, así que no hay ciclo posible. Con eso las dos operaciones son mutuamente excluyentes: si la suspensión llega primero, el `take` lee `SUSPENDED` bajo bloqueo y responde 409 sin escribir nada; si el `take` llega primero, la suspensión espera y encuentra la asignación ACTIVE (409 `INDEPENDENT_DRIVER_HAS_ACTIVE_ASSIGNMENT`). El CHECK V1.9-A demostró que sin ese bloqueo quedaba un repartidor suspendido ejecutando un servicio (ver [VERIFICATION.md](VERIFICATION.md)).

Por la misma razón, `take` y `release` construyen su respuesta sin repetir la comprobación de habilitación: su trabajo ya está confirmado, y una suspensión posterior no debe convertir una operación exitosa en un error. Y cualquier `RAISE EXCEPTION` de los triggers se traduce a 409 `TAKE_CONFLICT`: perder una carrera es un conflicto, nunca un 5xx.

### Take = claim + assignment, atómico

`take` es **una sola transacción**. Bloquea `FOR UPDATE` la misma fila de Dispatch que bloquea el claim de proveedor, valida repartidor, vehículo, Dispatch y elegibilidad, pone el Dispatch en `CLAIMED` a nombre del repartidor y crea la `DeliveryAssignment` ACTIVE en modo `INDEPENDENT`. Si algo falla, no queda nada:

- nunca un **claim independiente sin asignación ACTIVE** (misma transacción);
- nunca una **asignación independiente sin claim**: `delivery_assignment_guard` reexamina en SQL que el Dispatch esté CLAIMED por ese mismo repartidor.

`release` es igual de atómico en sentido inverso: la asignación ACTIVE pasa a `CANCELLED` con motivo y **después** el Dispatch vuelve a `OPEN` (o `EXPIRED` si la ventana ya cerró) con el claim limpio. El orden importa y `dispatch_guard` rechaza el contrario con `DISPATCH_HAS_ACTIVE_ASSIGNMENT`.

### Dueño del claim: exactamente uno

`Dispatch` no sobrecarga `claimedByProviderId` con un id de Driver. V1.9 agrega `claimedByIndependentDriverId` con su propia FK, y `Dispatch_values_check` exige que un Dispatch CLAIMED tenga **exactamente un** dueño (`num_nonnulls(...) = 1`), nunca los dos. Lo mismo en la asignación: `mode` decide qué columna de dueño se llena (`DeliveryAssignment_mode_check`), así que un ejecutor independiente **no** arrastra un `providerId` falso.

### Sin reasignación para el repartidor

Un repartidor no puede pasarle el servicio a otro: no existe endpoint de reasignación para el rol DRIVER y las rutas de proveedor de V1.8 le responden 403. Debe liberar; después podrá tomarlo otro actor. Quien libera no puede volver a tomar ese mismo Dispatch (paridad con `DISPATCH_RECLAIM_NOT_ALLOWED` de V1.7). Un PROVIDER_ADMIN tampoco puede apropiarse ni reasignar un servicio tomado por un independiente: recibe 409 `DISPATCH_NOT_CLAIMED_BY_PROVIDER`.

### Una entrega a la vez, en los dos modelos

Los tres índices únicos parciales de V1.8 (`WHERE status = 'ACTIVE'`, por Dispatch, por Driver y por Vehicle) son **globales**: no distinguen modo. Por eso, sin añadir reglas nuevas, un repartidor ocupado en un servicio de proveedor no puede tomar uno propio y al revés, y un vehículo ejecuta una entrega a la vez. `GET /driver/me` lo resume en `independent.canTakeServices`.

### Contexto de pago

`take` y el listado devuelven el mismo `paymentContext` de V1.8: `deliveryFee`, `goodsValue`, `goodsPaymentMode`, `driverAdvancesGoods` y `driverAdvanceAmount`. Con `COURIER_ADVANCE` el repartidor sabe **antes** de tomar el servicio cuánto tendrá que adelantar al comercio:

```text
Mercancía: $800.00   ->  driverAdvanceAmount 800.00
Envío:     $60.00    ->  deliveryFee          60.00
```

Mandaria no mueve ese dinero ni comprueba si el repartidor dispone de él: **no hay wallet, saldo ni crédito** en V1.9.

### Plazo de asignación

`assignmentDeadline` / `assignmentOverdue` es un concepto de flotilla: mide el hueco entre reclamar y asignar. Un `take` cierra ese hueco dentro de la misma transacción, así que un claim independiente informa siempre `null` / `false` en vez de inventar una obligación que no puede incumplirse.

### Servicio en curso: no se rompe en silencio

Suspender o rechazar a un repartidor con una asignación ACTIVE responde **409 `INDEPENDENT_DRIVER_HAS_ACTIVE_ASSIGNMENT`** y no cambia nada; desactivar su vehículo, **409 `VEHICLE_HAS_ACTIVE_ASSIGNMENT`**. V1.9 prefiere rechazar la operación administrativa antes que cancelar por detrás una entrega en curso: primero se termina el servicio (lo libera el repartidor, o se cancela la DeliveryRequest) y después se suspende. Ambas reglas están además forzadas en PostgreSQL por `independent_driver_profile_guard`.

### Errores de dominio (`code`)

`INDEPENDENT_NOT_APPROVED`, `DRIVER_NOT_ELIGIBLE`, `INDEPENDENT_DRIVER_HAS_ACTIVE_ASSIGNMENT`, `DISPATCH_ALREADY_CLAIMED`, `DISPATCH_EXPIRED`, `DISPATCH_CANCELLED`, `DISPATCH_NOT_OPEN_TO_INDEPENDENT`, `DISPATCH_RETAKE_NOT_ALLOWED`, `DISPATCH_NOT_CLAIMED_BY_DRIVER`, `DRIVER_BUSY`, `VEHICLE_BUSY`, `VEHICLE_NOT_ELIGIBLE`, `VEHICLE_HAS_ACTIVE_ASSIGNMENT`, `VEHICLE_LIMIT_REACHED` y `TAKE_CONFLICT`. Todos 409; los recursos ajenos o inexistentes son 404 y nunca revelan que existen.

### Base de datos y auditoría

- Migración `20260918001000_independent_drivers`, incremental desde V1.8 y **sin reset**: no reescribe ninguna fila. Toda `DeliveryAssignment` existente queda `mode = 'FLEET'` con su `providerId` por el DEFAULT, y todo `Vehicle` conserva su proveedor.
- Objetos nuevos: tabla `IndependentDriverProfile` con sus CHECKs de coherencia; `Vehicle_owner_check` (dueño excluyente) e índice único parcial `Vehicle_independent_identifier_key`; `DeliveryAssignment_mode_check`; `Dispatch_values_check` ampliado con el XOR del dueño del claim; triggers `Driver_owner_guard`, `Vehicle_owner_guard` e `IndependentDriverProfile_guard`; `delivery_assignment_guard` y `dispatch_guard` ampliados a los dos modelos.
- **Cambio sobre V1.8:** las FKs compuestas `DeliveryAssignment_(driverId|vehicleId)_providerId_fkey` se retiran, porque con `providerId` nulo PostgreSQL las omitiría en silencio (MATCH SIMPLE) y dejarían de garantizar nada. Las sustituyen FKs simples a `Driver` y `Vehicle`, la comprobación de pertenencia por modo dentro de `delivery_assignment_guard` y la **inmutabilidad del dueño** de Drivers y Vehicles. El conjunto es más estricto que antes: la pertenencia se prueba en cada escritura y, además, un Driver ya no puede cambiar de proveedor ni un Vehicle de dueño.
- Concurrencia: `take` y `claim` compiten por el mismo bloqueo de fila, de modo que un CLAIM de proveedor y un TAKE independiente simultáneos dejan exactamente un dueño; varios independientes sobre un Dispatch dejan uno; el mismo repartidor o el mismo vehículo sobre dos Dispatches quedan ACTIVE en uno solo.
- Eventos: `INDEPENDENT_DRIVER_ENABLED`, `INDEPENDENT_DRIVER_SUSPENDED`, `INDEPENDENT_DRIVER_REJECTED`, `INDEPENDENT_DISPATCH_TAKEN`, `INDEPENDENT_DISPATCH_RELEASED`, `INDEPENDENT_VEHICLE_CREATED`, `INDEPENDENT_VEHICLE_UPDATED` e `INDEPENDENT_VEHICLE_STATUS_CHANGED`, con `profileId`, `driverId`, `dispatchId`, `vehicleId`, `assignmentId` y `actorUserId` según corresponda; sin tokens, contraseñas ni contactos del cliente.

Pruebas: `test/independent-drivers.spec.ts` (política de ejecución por ServiceType, orden de rechazo del `take`, motivos de liberación, plazo que no aplica, habilitación idempotente, suspensión con servicio activo, límite de vehículos, identidad tomada del JWT) y `test/independent-drivers.e2e-spec.ts` (habilitación y permisos negativos, vehículos propios, privacidad del listado, take con contexto de pago, vehículo ajeno en ambos sentidos, repartidor suspendido, release y retake, ausencia de reasignación, carrera flotilla vs independiente, varios independientes, mismo repartidor y mismo vehículo en paralelo, ocupado en un modelo frente al otro, suspensión y desactivación con servicio en curso, invariantes en PostgreSQL y auditoría sin secretos).

## Credit Accounts & Immutable Ledger (V1.10-A)

V1.10-A crea la base contable de los créditos Mandaria: cuentas y un historial inmutable de movimientos. **Todavía no cobra nada:** CLAIM de proveedor y TAKE independiente siguen funcionando exactamente igual, con o sin créditos, y no escriben en el ledger. El consumo por servicio llega en V1.10-D; la política de costo (V1.10-B) tampoco existe aún.

### Créditos no son dinero

Un crédito es el **derecho comercial a adjudicarse servicios** dentro de Mandaria. No es la tarifa del envío (`deliveryFee`), ni el valor de la mercancía (`goodsValue`), ni efectivo del repartidor, ni un wallet. Por eso son **enteros**, no llevan moneda y ningún campo de créditos usa decimales o `MXN`:

```text
ORDER / DELIVERY MONEY   ≠   MANDARIA CREDITS
deliveryFee 60.00 MXN        balance 500
goodsValue 800.00 MXN        amount -7
```

### Quién tiene cuenta

| Dueño | Cuándo se crea | Notas |
|---|---|---|
| **Proveedor** | Al crearse el proveedor, por cualquier vía (API, seed, SQL) | Una por proveedor. La usan todos sus Drivers de flotilla, que **no** tienen cuenta propia. |
| **Repartidor independiente** | La primera vez que su perfil llega a `APPROVED` | Pertenece a la capacidad independiente, no al User. Se conserva si después queda `SUSPENDED` o `REJECTED`. |

La creación la hacen triggers de PostgreSQL (`DeliveryProvider_credit_account`, `IndependentDriverProfile_credit_account`) con `ON CONFLICT DO NOTHING`, así que es atómica con el dueño e idempotente: reaprobar a un repartidor nunca crea una segunda cuenta. Una cuenta **nace con saldo 0** (un trigger rechaza cualquier otro valor).

**Datos existentes:** la migración creó una cuenta con saldo 0 para cada proveedor existente y para cada perfil independiente que **haya sido aprobado alguna vez** (`approvedAt` no nulo; la misma regla que aplica el trigger en adelante). **No** escribió ningún movimiento: una cuenta vacía no tiene historia económica, e inventar una `RECHARGE` registraría un pago que nadie hizo.

### Sin estado propio de la cuenta (decisión)

No se añadió `ACTIVE`/`SUSPENDED` a la cuenta. En V1.10-A sería redundante: el dueño ya tiene estado operativo (`DeliveryProvider.status`, `IndependentDriverProfile.status`), no existe todavía ningún débito automático que bloquear, y las recargas y ajustes son decisiones explícitas de SUPER_ADMIN. Un estado de cuenta sin nadie que lo consulte sería superficie sin uso. Si V1.10-D necesita congelar créditos de forma distinta a la suspensión operativa, se añadirá entonces con un consumidor concreto.

Consecuencia documentada: **suspender a un proveedor o a un repartidor no borra ni congela su saldo ni su historial**, y SUPER_ADMIN puede seguir recargando o ajustando esa cuenta.

### Límites

| Límite | Valor | Dónde |
|---|---|---|
| Créditos por movimiento | 1 – 1 000 000 | DTO + CHECK `CreditLedgerEntry_amount_check` |
| Saldo máximo | 1 000 000 000 | servicio + CHECK `CreditAccount_balance_check` |
| Saldo mínimo | 0 | servicio + CHECK (nunca negativo) |

Con ambos límites, `balanceBefore + amount` siempre cabe en un `INTEGER` de 32 bits: ninguna operación puede desbordarse. Los límites son constantes (`src/credits/credit-policy.ts`), no variables de entorno; V1.10-A no añade ninguna variable a `.env.example`.

### Ledger

Cada movimiento es una fila `CreditLedgerEntry` con `amount`, `balanceBefore`, `balanceAfter`, tipo, actor y motivo. Convención de signo única, forzada por CHECK:

| Tipo | Signo | Uso en V1.10-A |
|---|---|---|
| `RECHARGE` | siempre `+` | Sí: recarga manual |
| `ADMIN_ADJUSTMENT` | `+` o `−`, nunca 0 | Sí: corrección con motivo |
| `SERVICE_AWARD` | siempre `−` | Reservado (cobro al adjudicar) |
| `SERVICE_REFUND` | siempre `+` | Reservado (devolución) |

`RECHARGE -500` o cualquier movimiento de 0 los rechaza la base. No hay columna `metadata` libre: lo que habría ido ahí son columnas tipadas (`rechargeMethod`, `externalReference`, `reason`, `referenceType`/`referenceId`), para no guardar datos arbitrarios y que OpenAPI publique cada campo con su tipo.

**Inmutable en PostgreSQL, no sólo en la API.** `UPDATE` sobre el ledger se rechaza siempre; `DELETE` y `TRUNCATE` también. La única excepción es para bases de prueba desechables: en una base cuyo nombre termina en `_test`, una transacción que ejecuta `SET LOCAL mandaria.ledger_purge = 'test-fixtures'` puede **borrar** (nunca editar) entradas, para que las suites automáticas limpien lo que crearon. En cualquier otra base (desarrollo, producción) el interruptor no tiene efecto y el `DELETE` se rechaza siempre (migración `20260921001200_credit_ledger_purge_test_only`, corrección del CHECK V1.10-A). La aplicación nunca lo usa ni puede usarlo. Una cuenta con historia no se puede borrar (FK `RESTRICT`); una cuenta sin movimientos sigue a su dueño.

**El saldo sólo se mueve a través del ledger.** `CreditAccount.balance` está materializado para lecturas rápidas y para el cobro futuro, pero insertar una entrada **es** el movimiento: el trigger `CreditLedgerEntry_apply` actualiza el saldo en la misma sentencia, sólo si la cuenta todavía tiene exactamente `balanceBefore`. Un `UPDATE "CreditAccount" SET balance = ...` directo desde cualquier cliente lo rechaza `CreditAccount_guard` (`CREDIT_BALANCE_WITHOUT_LEDGER`). Así, el ledger ordenado por `sequence` es una cadena sin huecos: `balanceBefore + amount = balanceAfter` en cada fila, cada `balanceAfter` es el `balanceBefore` de la siguiente, y la última coincide con el saldo.

### Movimiento atómico y concurrencia

```text
BEGIN
  SELECT balance FROM "CreditAccount" WHERE id = … FOR UPDATE   -- bloquea la cuenta
  ¿Idempotency-Key ya usada?  → devolver el original
  balanceAfter = balanceBefore + amount   -- < 0 → 409 INSUFFICIENT_CREDITS
  INSERT CreditLedgerEntry                -- el trigger mueve el saldo
COMMIT                                    -- cualquier fallo: ROLLBACK completo
```

El bloqueo de fila serializa todos los movimientos de una cuenta: con saldo 10, dos débitos simultáneos de 8 terminan en **uno aplicado, uno rechazado y saldo 2**, nunca −6. Aunque otro escritor se saltara el bloqueo, el trigger rechaza una entrada construida sobre un saldo ya obsoleto (`CREDIT_LEDGER_STALE`), y los CHECK impiden un saldo negativo.

### Idempotencia

Recargas y ajustes exigen la cabecera `Idempotency-Key` (8–255 caracteres ASCII visibles), con el mismo contrato que la creación B2B de DeliveryRequest:

| Situación | Respuesta |
|---|---|
| Key nueva | `201`, `Idempotent-Replayed: false`, movimiento aplicado |
| Misma key + mismo cuerpo | `200`, `Idempotent-Replayed: true`, **el movimiento original**, nada se aplica otra vez |
| Misma key + cuerpo distinto (o recarga vs. ajuste) | `409 CREDIT_IDEMPOTENCY_CONFLICT` |
| Sin key o mal formada | `400` |

La key es **única por cuenta** y vive en el propio ledger (índice único `CreditLedgerEntry_creditAccountId_idempotencyKey_key`), no en `ApiIdempotencyRecord`, porque el actor es un SUPER_ADMIN humano y no un IntegrationClient. Se guarda sólo una huella SHA-256 del cuerpo. Un doble clic, un reintento del navegador o de red nunca recarga dos veces: la key se revisa antes, se revisa otra vez bajo el bloqueo, y el índice único resuelve el caso de dos copias que corren en paralelo. Mandaria Web debe generar una key nueva por cada operación intencional. CORS expone `Idempotent-Replayed` para que el navegador pueda leerla.

### Endpoints

| Método | Ruta | Rol |
|---|---|---|
| GET | `/admin/providers/:providerId/credits` | SUPER_ADMIN |
| GET | `/admin/providers/:providerId/credits/ledger` | SUPER_ADMIN |
| POST | `/admin/providers/:providerId/credits/recharge` | SUPER_ADMIN |
| POST | `/admin/providers/:providerId/credits/adjustment` | SUPER_ADMIN |
| GET | `/admin/drivers/:driverId/independent/credits` | SUPER_ADMIN |
| GET | `/admin/drivers/:driverId/independent/credits/ledger` | SUPER_ADMIN |
| POST | `/admin/drivers/:driverId/independent/credits/recharge` | SUPER_ADMIN |
| POST | `/admin/drivers/:driverId/independent/credits/adjustment` | SUPER_ADMIN |
| GET | `/provider/credits`, `/provider/credits/ledger` | PROVIDER_ADMIN (sólo su proveedor) |
| GET | `/driver/credits`, `/driver/credits/ledger` | DRIVER independiente (sólo su cuenta) |

- **Recarga:** `{ credits, method: TRANSFER|CASH|OTHER, externalReference?, reason? }`. `credits` entero de 1 a 1 000 000. `method` registra cómo se pagó **fuera** de Mandaria: no es una pasarela y Mandaria no verifica el pago; SUPER_ADMIN declara que se confirmó. `OTHER` exige `reason`.
- **Ajuste:** `{ amount, reason }`. Entero con signo, nunca 0, motivo obligatorio. Es una operación separada de la recarga. Si dejaría el saldo negativo responde `409 INSUFFICIENT_CREDITS` y no aplica nada.
- **Historial:** paginado (máx. 100 por página), del más reciente al más antiguo por `sequence`. SUPER_ADMIN ve además quién registró cada movimiento y con qué Idempotency-Key; el dueño de la cuenta ve importes, saldos y motivos, pero no esos datos internos. La huella del cuerpo no se expone a nadie.

La cuenta siempre se resuelve desde el dueño que nombra la ruta (y que los guards autorizan) o desde el JWT: el cuerpo **no** acepta `ownerType`, `providerId`, `balance` ni ids de cuenta (400 por campo desconocido). PROVIDER_ADMIN y DRIVER no tienen rutas de mutación. Un proveedor nunca ve la cuenta de otro (403). Un Driver de flotilla no tiene cuenta propia (`404 CREDIT_ACCOUNT_NOT_FOUND`). Un token B2B no sirve en ninguna ruta de créditos (401): los IntegrationClients no conocen los créditos en esta versión. SUPER_ADMIN administra, pero no usa las rutas propias de proveedor o repartidor (403).

Un repartidor independiente puede **consultar** su cuenta aunque su perfil esté `SUSPENDED` o `REJECTED` (el prompt pedía `APPROVED`): su saldo y su historia se conservan, y ocultárselos contradiría esa conservación. Si podrá **operar** con esos créditos se decide cuando exista el cobro (V1.10-D).

### Errores (`code`)

`INSUFFICIENT_CREDITS`, `CREDIT_BALANCE_LIMIT`, `CREDIT_IDEMPOTENCY_CONFLICT` y `CREDIT_MOVEMENT_CONFLICT` (una guarda de PostgreSQL se disparó; reintentar con la misma key) son 409 y nunca aplican nada. `CREDIT_ACCOUNT_NOT_FOUND` es 404. Motivos y referencias rechazan caracteres de control (Unicode `Cc`), para que nunca puedan falsificar una línea de log.

### Auditoría

`CREDIT_RECHARGED` y `CREDIT_ADJUSTED` registran `actorUserId`, `creditAccountId`, `ownerType`, `ownerId`, `entryId`, `sequence`, `amount`, `balanceBefore`, `balanceAfter`, `rechargeMethod` y `externalReference`. También `CREDIT_MOVEMENT_REPLAYED`, `CREDIT_IDEMPOTENCY_CONFLICT` y `CREDIT_MOVEMENT_REJECTED`. Nunca tokens, contraseñas, secretos B2B ni credenciales SMTP.

### Base de datos

Migración `20260921001100_credit_accounts_ledger`, incremental desde V1.9 y **sin reset**: sólo añade tablas; ninguna fila existente cambia. Objetos: CHECK `CreditAccount_owner_check` (dueño coherente con `ownerType`, exactamente uno), `CreditAccount_balance_check`, `CreditLedgerEntry_amount_check` (aritmética, límites, nunca 0), `CreditLedgerEntry_type_check` (signo y campos obligatorios por tipo), `CreditLedgerEntry_text_check`; índices únicos por proveedor, por perfil independiente y por (cuenta, Idempotency-Key); triggers `CreditAccount_guard`, `CreditLedgerEntry_apply`, `CreditLedgerEntry_guard`, `CreditLedgerEntry_no_truncate` y los dos de creación de cuenta.

Pruebas: `test/credits.spec.ts` (convención de signo, límites y desbordamiento, validación estricta de enteros, motivo con OTHER, caracteres de control, campos de dueño forjados, Idempotency-Key, vistas sin huella ni datos internos, saldo insuficiente bajo bloqueo, replay y conflicto de key, guarda de PostgreSQL traducida a 409) y `test/credits.e2e-spec.ts` (creación de cuentas por cualquier vía, cuenta independiente al aprobar y conservada, Driver de flotilla sin cuenta, recarga, replay y conflicto, ajustes, rechazo de cero/decimales/texto/cantidades absurdas/campos forjados, aislamiento por rol y por proveedor, paginación, inmutabilidad por SQL, 16 ataques directos a la base, concurrencia de recargas, doble débito, movimientos mixtos y una misma key en paralelo, CLAIM y TAKE con saldo 0 sin tocar el ledger, suspensión que conserva el saldo, y auditoría sin secretos).

## Credit Policy Engine (V1.10-B)

Responde: **¿cuántos créditos cuesta adjudicarse un servicio?** V1.10-B define políticas versionadas y **sólo calcula**: CLAIM y TAKE todavía **no** consumen créditos, no se escribe ningún SERVICE_AWARD y ninguna cuenta cambia de saldo (el cobro empieza en V1.10-D; el snapshot del costo en el Dispatch es V1.10-C).

```text
serviceType + actorType ──► política ACTIVE (única) ──┐
distancia canónica (metros enteros, ya calculada) ────┴──► calculateCreditCost ──► credits (entero)
```

### Actor y tipos de cálculo

`actorType` es **quién paga**, con el mismo enum de las cuentas V1.10-A: `PROVIDER` (el proveedor, también cuando ejecuta un Driver de su flotilla) o `INDEPENDENT_DRIVER`. Nunca un `DRIVER` genérico. `serviceType` usa el enum real (hoy sólo `LOCAL_DELIVERY`); el motor no asume ningún tipo de cálculo por servicio.

| calculationType | Campos (sólo éstos; cualquier otro → 400) | Costo |
|---|---|---|
| `PER_KM` | `creditsPerKm` 1–1 000 000, `minimumCredits` 0–1 000 000 | `max(ceil(distanceMeters / 1000) × creditsPerKm, minimumCredits)` |
| `FLAT` | `flatCredits` 1–1 000 000 | `flatCredits`, cualquiera sea la distancia |
| `DISTANCE_RANGE` | `ranges` (1–50) | `credits` del único rango que contiene la distancia |

Ejemplo `PER_KM` 1 crédito/km, mínimo 3: 0 m → 3; 800 m → ceil(0,8) = 1 → max(1, 3) = **3**; 1001 m → 2 km → **3**; 6240 m → 6,24 km → 7 km facturables → **7**.

**Rangos `[min, max)`** (mínimo inclusivo, máximo exclusivo, metros enteros; igual que las bandas de tarifa V1.6): el primero empieza en 0, cada uno empieza donde termina el anterior y **sólo el último es abierto** (`maxDistanceMeters: null`, «en adelante»). Así cualquier distancia ≥ 0 cae en exactamente un rango. Ejemplo `[0,3000)→3`, `[3000,5000)→5`, `[5000,10000)→8`, `[10000,∞)→15`: 2999 m → 3, **3000 m → 5**, 4999 m → 5, **5000 m → 8**, 10000 m → 15. Huecos, solapes, un primer rango que no empieza en 0 o un último cerrado se rechazan (400 en la API y trigger en PostgreSQL).

**Enteros y límites.** Todo es aritmética entera (`ceil` se calcula con resto entero, sin coma flotante). La distancia debe ser un entero de 0 a 2 147 483 647 m (`CREDIT_DISTANCE_INVALID` si no: negativa, decimal, NaN, Infinity, texto, cadena vacía o parámetro repetido → 400 en la API). Un costo mayor que 1 000 000 créditos —el límite de un movimiento del ledger V1.10-A— es 422 `CREDIT_COST_OUT_OF_RANGE`, nunca se trunca. Con `minimumCredits: 0` y 0 m el costo es 0: V1.10-D deberá decidir cómo registrar un servicio de costo 0 (el ledger no admite movimientos de 0).

**Distancia canónica.** El cálculo recibe los metros que Mandaria ya obtuvo para el servicio; nunca vuelve a llamar a Google Routes, `local_fake` ni otro proveedor de routing. Es **determinista**: misma versión + misma distancia → mismo resultado; no depende del reloj, del saldo, del proveedor ni del repartidor.

**Sin política no hay servicio gratis.** Si no hay política ACTIVE para la combinación, `CREDIT_POLICY_UNAVAILABLE` (409). Nunca se asume 0 créditos.

### Versionado, vigencia e inmutabilidad

- **Una política ACTIVE como máximo** por `serviceType + actorType`, garantizado por un índice único parcial en PostgreSQL.
- **Versiones monótonas** (1, 2, 3…) por combinación, siempre `máximo + 1` calculado por el servidor y comprobado por trigger: el cliente nunca envía `version`, `status`, fechas ni autor (400).
- **Nunca se edita una versión.** Cambiar la economía crea una versión nueva: en una transacción, bajo un bloqueo por combinación, la ACTIVE pasa a INACTIVE con `effectiveUntil = ahora` y la nueva nace ACTIVE con `effectiveFrom = ahora`. Nunca coexisten dos ACTIVE ni queda un estado a medias. Las INACTIVE son historial permanente: no se reactivan (para volver a condiciones anteriores se crea otra versión con ellas).
- **Vigencia sin programación.** `effectiveFrom`/`effectiveUntil` los fija el servidor al activar y al reemplazar, así que responden de forma exacta qué versión regía en cada instante. No hay activación futura ni scheduler (fuera de alcance, por simplicidad y determinismo).
- **Concurrencia.** Una versión nueva se basa en la ACTIVE (`/:id/versions` con su id). Si otra solicitud la reemplazó antes, `CREDIT_POLICY_VERSION_CONFLICT` (409) y no se escribe nada: 10 solicitudes simultáneas → 1 versión nueva y 9 conflictos. Dos creaciones iniciales simultáneas → una v1 y `CREDIT_POLICY_EXISTS`. Sin DELETE, PATCH ni PUT.

### Endpoints (sólo SUPER_ADMIN)

| Método | Ruta | Uso |
|---|---|---|
| GET | `/admin/credit-policies` | Historial completo (ACTIVE e INACTIVE); filtros `serviceType`, `actorType`, `status`; paginado |
| GET | `/admin/credit-policies/:id` | Configuración completa, rangos incluidos |
| POST | `/admin/credit-policies` | Versión 1 de una combinación sin políticas (409 `CREDIT_POLICY_EXISTS` si ya tiene) |
| POST | `/admin/credit-policies/:id/versions` | Nueva versión desde la ACTIVE `:id` (conserva `serviceType` y `actorType`) |
| GET | `/admin/credit-policies/calculation?serviceType=&actorType=&distanceMeters=` | Resuelve la ACTIVE y calcula; sólo lectura |

PROVIDER_ADMIN y DRIVER reciben 403 y el IntegrationClient 401: no leen las reglas comerciales; en versiones posteriores recibirán sólo el `creditCost` del servicio. Internamente, `CreditPoliciesService.resolveActivePolicy()` y la función pura `calculateCreditCost({ policy, distanceMeters })` son la interfaz que usarán V1.10-C/D.

### Base de datos, seed y auditoría

- Migración `20260922001300_credit_policies`: tablas `CreditPolicy` y `CreditPolicyRange`; únicos `(serviceType, actorType, version)`, `(creditPolicyId, position)` y `(creditPolicyId, minDistanceMeters)`; índice parcial `CreditPolicy_active_key`; CHECKs de versión > 0, coherencia estado/vigencia y **exactamente los campos del tipo de cálculo** (con `IS NOT NULL` explícitos: un CHECK que evalúa a NULL pasaría); triggers de versión `máximo + 1`, nacimiento ACTIVE, inmutabilidad (sólo ACTIVE → INACTIVE con `effectiveUntil`), prohibición de DELETE/TRUNCATE y un trigger **diferido** que al COMMIT exige rangos completos y contiguos (y sin rangos en PER_KM/FLAT), lo que también impide añadir rangos a una política existente. La migración **no crea políticas** ni toca cuentas o ledger.
- Borrado sólo en bases `*_test` con el mismo interruptor que el ledger (`mandaria.ledger_purge = 'test-fixtures'`), para que las suites limpien sus fixtures.
- **Política inicial:** configuración, no migración. En local, `npm run db:seed:local-credit-policies` (LOCAL/TEST ONLY, idempotente, nunca edita una política existente) crea v1 `LOCAL_DELIVERY` `PER_KM` 1 crédito/km, mínimo 3, para `PROVIDER` y para `INDEPENDENT_DRIVER`, atribuidas al SUPER_ADMIN de bootstrap. En producción las crea explícitamente un SUPER_ADMIN con `POST /admin/credit-policies`; hasta entonces el cálculo responde `CREDIT_POLICY_UNAVAILABLE`.
- Eventos `CREDIT_POLICY_CREATED` y `CREDIT_POLICY_VERSIONED` (versión anterior y nueva) con la configuración completa, `effectiveFrom` y `actorUserId`; cada fila guarda `createdByUserId`. Con eso se reconstruye quién, cuándo, qué versión y qué configuración.

Pruebas: `test/credit-policies.spec.ts` (PER_KM 0/1/999/1000/1001/6240 m con mínimo, casos donde el mínimo ya no domina, FLAT, fronteras de rangos, validación de campos por tipo, huecos/solapes, distancia inválida, desbordamiento, determinismo con reloj falso, fallo cerrado y pureza respecto a cuentas) y `test/credit-policies.e2e-spec.ts` (autorización, fallo cerrado, creación y campos falsificados, cálculo por HTTP, versionado v1→v4 con historial intacto, conflicto al versionar desde una INACTIVE, fronteras por HTTP, 10 versiones simultáneas, cadenas concurrentes, creaciones iniciales simultáneas, 28 ataques SQL rechazados y ledger/saldos intactos tras los cálculos).

## Docker: preparado, sin ejecución en esta etapa

Por instrucción del propietario, continuar localmente. Dockerfile y Compose se conservan, con variables B2B añadidas, PostgreSQL persistente, healthchecks y migraciones con reintentos. No se verificó build/up de Docker en V1.1.

Para uso futuro: configurar .env y ejecutar `docker compose up -d --build`. Si PostgreSQL local ocupa 5432, cambiar POSTGRES_PORT a otro puerto y ajustar DATABASE_URL del host. Compose usa internamente postgres:5432. No ejecutar down -v salvo eliminación deliberada de datos.

## Riesgos y deuda técnica

- Limitador en memoria para una instancia; antes de escalar usar almacenamiento compartido y configurar proxies confiables.
- Auditoría actual en logs, sin almacén persistente empresarial.
- Listados anteriores de Users/Integrations acotados a 100; Providers, memberships, Drivers, Vehicles e historiales ya tienen paginación.
- V1.4: `POST …/drivers` sigue aceptando el UUID de un User DRIVER activo sin perfil; desde V1.6.1 la vía de alta soportada es la invitación, que crea el Driver al activar.
- Cambiar un vehículo a INACTIVE/MAINTENANCE/SUSPENDED o suspender un Driver no cierra su asignación de entrega ACTIVE (V1.8): impide asignarlos de nuevo, pero el servicio en curso sigue con ellos hasta que el proveedor reasigne o cancele.
- No existe eliminación ni transferencia de Drivers/Vehicles entre proveedores; por eso todos los registros cuentan para los límites.
- ApiIdempotencyRecord no expira todavía; definir retención antes de volumen alto. El rate limit de creación B2B es por IP (clientes detrás de la misma IP comparten cupo).
- `goodsValue` admite 2 decimales (NUMERIC(14,2)); monedas ISO con 0 o 3 decimales requerirán ajustar precisión/validación.
- Los stops contienen datos personales operativos sin cifrado a nivel de columna ni política de retención; los logs no los incluyen.
- El orden de packages en la respuesta es determinista pero no refleja el orden de envío.
- V1.6: la cotización mantiene abierta una transacción (bloqueo de la DeliveryRequest) durante la llamada de routing, hasta unos 15 s en el peor caso con la configuración por defecto; con alto volumen conviene un mecanismo de single-flight sin conexión retenida.
- Corregido el 2026-09-21: dentro de esa transacción, las búsquedas de zona y de tarifa usaban el cliente global de Prisma, que pide una segunda conexión del pool mientras la transacción retiene la suya y el bloqueo. Con tantas cotizaciones simultáneas como conexiones, todas esperaban el bloqueo y quien lo tenía esperaba al pool: interbloqueo hasta el timeout de 10 s y `500` en todas (P2024). Ahora toda consulta de la transacción usa `tx` (`resolveActive` y `findActive` aceptan el cliente de la transacción). Regla general: dentro de un `$transaction` interactivo nunca se consulta con `this.prisma` ni con servicios que lo usen.
- V1.6: geometría planar en grados (adecuada a escala ciudad) sin PostGIS; zonas vecinas no pueden compartir borde; límites de Ocozocoautla/Tuxtla del seed son aproximados y los precios son placeholders.
- V1.6: Google Routes verificado una vez contra la API real (`routing:check-google` y cotización HTTP con `ROUTING_PROVIDER=google`); las pruebas automatizadas siguen usando respuestas HTTP simuladas y no consumen cuota.
- V1.6: sin DELETE de bandas por API; a nivel SQL una banda no usada de un plan ACTIVE podría borrarse manualmente (las usadas están protegidas por FK). La cotización detecta la anomalía como RATE_CONFIGURATION_INVALID.
- V1.6: rate limit de cotización por IP; ROUTING_CALCULATED/FAILED en logs, sin métricas agregadas.
- V1.6.1: no hay recuperación de contraseña ni API para deshabilitar/reactivar cuentas; USER_DISABLED exige una política administrativa futura.
- V1.6.1: el token viaja en la query de `/activate-account` (contrato pedido); Mandaria Web debe retirarlo del historial y usar `Referrer-Policy: no-referrer`.
- V1.6.1: el correo se envía tras el commit sin cola ni reintentos automáticos; un fallo se reporta como `emailDelivery: FAILED` y se resuelve con resend.
- V1.6.1: los límites de invitación son por IP en memoria; administradores autenticados pueden saber si un email ya tiene cuenta (errores útiles de su alcance).
- V1.6.1: el outbox local guarda enlaces con token en claro en la carpeta temporal; es sólo para desarrollo y se rechaza en producción.
- V1.7: expiración de Dispatch perezosa (sin cron); un OPEN vencido figura EXPIRED en lecturas y se persiste al intentar reclamar o cancelar. Sin notificaciones: los proveedores consultan `view=AVAILABLE` (sockets pendientes, V1.9+).
- V1.7: el claim bloquea la fila del Dispatch; con muy alto volumen conviene medir la contención. La elegibilidad no considera capacidad real (Drivers disponibles) ni cercanía.
- V1.7: coberturas sólo por SUPER_ADMIN; desactivar una cobertura no retira candidaturas ya ofrecidas, pero sus claims fallan con PROVIDER_NOT_ELIGIBLE.
- V1.8: `assignmentOverdue` es sólo una señal; no hay cron que libere, reasigne ni notifique el vencimiento del plazo, y no existe métrica agregada de incumplimiento.
- V1.8: el Driver no acepta ni rechaza la asignación (no hay Driver App hasta V1.9) y no se comprueba su disponibilidad real, su cercanía ni su efectivo para `COURIER_ADVANCE`; el proveedor asume esa responsabilidad.
- V1.8: la asignación no crea estados de ejecución (recogido/en camino/entregado); el Dispatch permanece CLAIMED hasta que el ciclo de vida de la entrega exista.
- V1.8: un Driver o Vehicle sólo ejecuta una entrega a la vez (índices únicos parciales); entregas agrupadas o multi-stop operativo requerirán relajar esa regla deliberadamente.
- V1.9: un repartidor independiente sigue teniendo un `Driver` ligado a un proveedor, porque V1.9 no crea cuentas (el alta es V1.6.1). Los contextos están separados y no hay fuga de recursos, pero el alta de un independiente **puro** (sin proveedor) exigirá una invitación sin `providerId` en una versión futura.
- V1.9: la elegibilidad del independiente no considera zona de servicio. Un repartidor APPROVED ve todos los Dispatches OPEN cuyo ServiceType lo admita, sin equivalente a `ProviderServiceCoverage`; operar en varias ciudades exigirá una cobertura por repartidor.
- V1.9: tampoco se considera cercanía, capacidad real ni efectivo disponible para `COURIER_ADVANCE`; no hay wallet, saldo ni crédito, y Mandaria no verifica que el repartidor pueda adelantar la mercancía.
- V1.9: no hay verificación documental del repartidor ni del vehículo, ni alta pública. `PENDING` y `REJECTED` existen en el modelo para ese onboarding futuro, pero hoy sólo SUPER_ADMIN crea perfiles, ya en `APPROVED`.
- V1.9: que un Dispatch aparezca en `/driver/dispatches/available` no garantiza poder tomarlo; la disponibilidad del repartidor y del vehículo se resuelve bajo bloqueos en el `take`, que puede responder 409.
- V1.9: sin notificaciones. Un repartidor descubre trabajo consultando el listado, igual que un proveedor con `view=AVAILABLE`.
- V1.9: `take` serializa con la suspensión y con la desactivación de vehículos mediante el bloqueo del perfil; si en el futuro se añaden más operaciones administrativas sobre el repartidor, deben tomar ese mismo bloqueo o volverá a abrirse la carrera que corrigió el CHECK V1.9-A.
- V1.10-A: los créditos existen pero no se consumen. Hasta V1.10-D cualquier proveedor o repartidor sigue reclamando y tomando servicios aunque su saldo sea 0; un saldo alto hoy no confiere ninguna ventaja operativa.
- V1.10-A: las recargas son una declaración de SUPER_ADMIN sobre un pago externo; Mandaria no lo verifica ni lo concilia. `externalReference` es texto libre sin validación contra un banco.
- V1.10-A: el ledger sólo admite `DELETE` en bases cuyo nombre termina en `_test` y con `mandaria.ledger_purge = 'test-fixtures'`. Hasta el CHECK V1.10-A el interruptor funcionaba en cualquier base y para **cualquier rol con permiso DELETE** (fijar un GUC propio no requiere privilegios), así que usar un rol sin privilegios de dueño no lo cerraba. Sigue siendo cierto que el dueño de las tablas puede desactivar triggers: en producción la aplicación debe usar un rol que no sea dueño y el nombre de la base no debe terminar en `_test`.
- V1.10-A: la Idempotency-Key es única por cuenta, no global; reutilizar la misma key en dos cuentas distintas registra dos movimientos independientes.
- V1.10-A: los límites (1 000 000 por movimiento, 1 000 000 000 de saldo) son constantes de código y de CHECK; cambiarlos requiere migración.
- OpenAPI: 130 campos anulables de versiones anteriores (V1.1–V1.9, incluidos varios de V1.9) se publican como `type: object` sin estructura, porque TypeScript refleja `X | null` como Object. Los esquemas de V1.10-A declaran su tipo explícitamente; el resto queda pendiente como tarea aparte.
- V1.10-B: las políticas sólo se calculan; ninguna ruta de proveedor o repartidor muestra aún el costo de un servicio, y ningún servicio lo congela (V1.10-C) ni lo cobra (V1.10-D).
- V1.10-B: sin activación futura ni scheduler; una versión rige desde que se crea. Deshabilitar el cobro de una combinación no tiene endpoint (y, cuando V1.10-D cobre, la falta de política bloqueará adjudicaciones: fallo cerrado).
- V1.10-B: con `minimumCredits: 0` un servicio de 0 m cuesta 0 créditos; V1.10-D debe decidir cómo tratarlo porque el ledger no admite movimientos de 0.
- JWT HS256 requiere distribución segura de claves si se separan servicios; rotación de claves de firma no automatizada.
- Credenciales pueden no expirar si el administrador omite expiresAt; establecer política operativa de rotación.
- Health 503 se prueba con fallo de consulta simulado, sin detener PostgreSQL compartido.
- Overrides multer ^2.3.0 y deepmerge-ts ^8.0.0 corrigen avisos transitivos; mantenerlos bajo revisión. tsconfck está deprecado como dependencia de desarrollo.

## Fuera de V1.10-B / V1.10-C+

No se implementaron snapshot del costo en créditos en el Dispatch (V1.10-C), débito al CLAIM o al TAKE, SERVICE_AWARD y SERVICE_REFUND operativos, devolución automática, caducidad de créditos, pasarela de pago, Driver App, autorregistro del repartidor, verificación documental, aceptación/rechazo de una asignación de flotilla por el repartidor, estados de ejecución de la entrega, sockets/notificaciones push, penalizaciones de proveedor, algoritmo de repartidor más cercano, hunting, elegibilidad o tarifa por vehículo, BASE_PLUS_DISTANCE, INTERCITY/FREIGHT/ERRAND, servicios programados (scheduledFor), PostGIS, polylines, Socket.IO, GPS/tracking, ciclo de vida completo de entrega, múltiples stops operativos, fletes, Wallet, créditos/recargas, pagos/payout, CUSTOMER, apps Repartidor/Cliente, KYC/documentos, planes comerciales ni facturación.

Las futuras apps Cliente/Repartidor usarán User. Los sistemas externos usarán IntegrationClient. Los créditos futuros pertenecen al proveedor; los vehículos son recursos operativos. El correo transaccional existe desde V1.6.1 sólo para invitaciones; recuperación de contraseña, cambio de email, desactivación por API y auditoría persistente siguen pendientes.
