# Mandaria — V1.6 Routing, Service Zones, Rate Plans y Delivery Quotes

Plataforma independiente de logística y entregas. Mandaria y Coita Eats no comparten código, entidades Prisma ni PostgreSQL; su comunicación será exclusivamente API/eventos.

## Estado y arquitectura

V1.2 agregó DeliveryProvider y ProviderMembership al Core V1.0 y a las integraciones B2B V1.1. V1.4-A agregó Drivers, Vehicles y asignaciones con historial, límites efectivos y autoservicio de disponibilidad del Driver. V1.5-A agregó DeliveryRequest B2B (qué transportar). V1.6-A agrega ServiceType, zonas de servicio con GeoJSON, routing reemplazable (Google Routes), tarifas versionadas por bandas de distancia y DeliveryQuotes con vigencia y aceptación. No reconstruye Auth humano ni despacha entregas. Los resultados de verificación están en [VERIFICATION.md](VERIFICATION.md); el contexto entre agentes, en [BITACORA.md](BITACORA.md).

- Node.js 24, TypeScript estricto, NestJS 11, Prisma 6, PostgreSQL 17/18.
- `auth/`: User, contraseña Argon2id, access JWT y refresh revocable.
- `users/`: selección explícita de campos públicos.
- `integrations/`: clientes externos, administración, credenciales, JWT B2B, scopes.
- `providers/`: oferta logística, límites administrativos, memberships y acceso aislado por proveedor.
- `drivers/`, `vehicles/`, `assignments/`: capacidad logística V1.4 (perfiles Driver, vehículos, asignaciones y `/driver`).
- `delivery-requests/`: demanda B2B V1.5 y administración; `idempotency/`: registro reutilizable de Idempotency-Key.
- `geo/`, `service-zones/`, `routing/`, `rate-plans/`, `delivery-quotes/`: cotización V1.6 (geometría interna, zonas, RoutingProvider, tarifas y Quotes).
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
| `db:seed:local-provider-admins`, `verify:provider-admins` | **LOCAL/TEST ONLY**: escenario PROVIDER_ADMIN A/B/sin membership y su validación HTTP real |
| `db:seed:local-driver-users`, `verify:drivers-vehicles` | **LOCAL/TEST ONLY**: Users DRIVER locales y validación HTTP real del escenario V1.4 |
| `verify:delivery-requests` | **LOCAL/TEST ONLY**: validación HTTP real del escenario V1.5 con IntegrationClients locales A/B |
| `db:seed:local-pricing`, `verify:delivery-quotes` | **LOCAL/TEST ONLY**: zonas/tarifa placeholder y validación HTTP real de cotización V1.6 |
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
| GET | /users | SUPER_ADMIN |
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

Límites por IP: global 100/min, login 5/min, refresh 20/min y token B2B 10/min. Health está exento. Los fallos B2B por ID desconocido, secreto incorrecto, revocación o suspensión usan el mismo 401 genérico. Un DTO mal formado recibe 400; el límite recibe 429.

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
npm run db:seed:local-provider-admins
npm run db:seed:local-driver-users      # driver-carlos|pedro|jose|luis|mario@mandaria.local, sólo Users DRIVER
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
- **Cancelar la DeliveryRequest** (B2B o admin, misma transacción y bloqueo): las OFFERED vigentes pasan a CANCELLED (`DELIVERY_REQUEST_CANCELLED`) y las vencidas a EXPIRED. Una ACCEPTED **se conserva como historial** y la solicitud queda CANCELLED; en V1.7 Dispatch definirá la política con servicio en curso.
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

## Docker: preparado, sin ejecución en esta etapa

Por instrucción del propietario, continuar localmente. Dockerfile y Compose se conservan, con variables B2B añadidas, PostgreSQL persistente, healthchecks y migraciones con reintentos. No se verificó build/up de Docker en V1.1.

Para uso futuro: configurar .env y ejecutar `docker compose up -d --build`. Si PostgreSQL local ocupa 5432, cambiar POSTGRES_PORT a otro puerto y ajustar DATABASE_URL del host. Compose usa internamente postgres:5432. No ejecutar down -v salvo eliminación deliberada de datos.

## Riesgos y deuda técnica

- Limitador en memoria para una instancia; antes de escalar usar almacenamiento compartido y configurar proxies confiables.
- Auditoría actual en logs, sin almacén persistente empresarial.
- Listados anteriores de Users/Integrations acotados a 100; Providers, memberships, Drivers, Vehicles e historiales ya tienen paginación.
- V1.4 no provee alta/invitación de Users DRIVER por API: se asocian Users existentes (local: seed). Un PROVIDER_ADMIN que conozca el UUID de un User DRIVER sin perfil puede asociarlo; la provisión controlada queda pendiente.
- Cambiar un vehículo a INACTIVE/MAINTENANCE/SUSPENDED o suspender un Driver no cierra su asignación vigente; la política con entregas en curso se define en V1.5.
- No existe eliminación ni transferencia de Drivers/Vehicles entre proveedores; por eso todos los registros cuentan para los límites.
- ApiIdempotencyRecord no expira todavía; definir retención antes de volumen alto. El rate limit de creación B2B es por IP (clientes detrás de la misma IP comparten cupo).
- `goodsValue` admite 2 decimales (NUMERIC(14,2)); monedas ISO con 0 o 3 decimales requerirán ajustar precisión/validación.
- Los stops contienen datos personales operativos sin cifrado a nivel de columna ni política de retención; los logs no los incluyen.
- El orden de packages en la respuesta es determinista pero no refleja el orden de envío.
- V1.6: la cotización mantiene abierta una transacción (bloqueo de la DeliveryRequest) durante la llamada de routing, hasta unos 15 s en el peor caso con la configuración por defecto; con alto volumen conviene un mecanismo de single-flight sin conexión retenida.
- V1.6: geometría planar en grados (adecuada a escala ciudad) sin PostGIS; zonas vecinas no pueden compartir borde; límites de Ocozocoautla/Tuxtla del seed son aproximados y los precios son placeholders.
- V1.6: Google Routes verificado una vez contra la API real (`routing:check-google` y cotización HTTP con `ROUTING_PROVIDER=google`); las pruebas automatizadas siguen usando respuestas HTTP simuladas y no consumen cuota.
- V1.6: sin DELETE de bandas por API; a nivel SQL una banda no usada de un plan ACTIVE podría borrarse manualmente (las usadas están protegidas por FK). La cotización detecta la anomalía como RATE_CONFIGURATION_INVALID.
- V1.6: rate limit de cotización por IP; ROUTING_CALCULATED/FAILED en logs, sin métricas agregadas.
- JWT HS256 requiere distribución segura de claves si se separan servicios; rotación de claves de firma no automatizada.
- Credenciales pueden no expirar si el administrador omite expiresAt; establecer política operativa de rotación.
- Health 503 se prueba con fallo de consulta simulado, sin detener PostgreSQL compartido.
- Overrides multer ^2.3.0 y deepmerge-ts ^8.0.0 corrigen avisos transitivos; mantenerlos bajo revisión. tsconfck está deprecado como dependencia de desarrollo.

## Fuera de V1.6 / V1.7+

No se implementaron Dispatch (asignación de proveedor, Driver o vehículo), hunting, elegibilidad o tarifa por vehículo, BASE_PLUS_DISTANCE, INTERCITY/FREIGHT/ERRAND, servicios programados (scheduledFor), PostGIS, polylines, Socket.IO, GPS/tracking, ciclo de vida completo de entrega, múltiples stops operativos, fletes, Wallet, créditos/recargas, pagos/payout, CUSTOMER, apps Repartidor/Cliente, KYC/documentos, planes comerciales ni facturación.

Las futuras apps Cliente/Repartidor usarán User. Los sistemas externos usarán IntegrationClient. Los créditos futuros pertenecen al proveedor; los vehículos son recursos operativos. Email, recuperación de contraseña y auditoría persistente siguen pendientes para versiones posteriores.
