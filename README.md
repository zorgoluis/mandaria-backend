# Mandaria — V1.2 Proveedores de Reparto

Plataforma independiente de logística y entregas. Mandaria y Coita Eats no comparten código, entidades Prisma ni PostgreSQL; su comunicación será exclusivamente API/eventos.

## Estado y arquitectura

V1.2 agrega DeliveryProvider y ProviderMembership al Core V1.0 y a las integraciones B2B V1.1. No reconstruye Auth humano ni agrega entregas. Los resultados de verificación están en [VERIFICATION.md](VERIFICATION.md); el contexto entre agentes, en [BITACORA.md](BITACORA.md).

- Node.js 24, TypeScript estricto, NestJS 11, Prisma 6, PostgreSQL 17/18.
- `auth/`: User, contraseña Argon2id, access JWT y refresh revocable.
- `users/`: selección explícita de campos públicos.
- `integrations/`: clientes externos, administración, credenciales, JWT B2B, scopes.
- `providers/`: oferta logística, límites administrativos, memberships y acceso aislado por proveedor.
- `health/`, `common/`, `config/`, `prisma/`: infraestructura compartida.
- `prisma/migrations/`: SQL versionado; no se usa db push ni reset.
- `test/`: servicios, HTTP y E2E; `scripts/`: bootstrap, pruebas y herramientas locales.

UsersModule exporta el servicio; AuthModule registra el controller de usuarios para evitar dependencias circulares. IntegrationsModule reutiliza los guards humanos exclusivamente para administración.

## Instalación local

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
npm run db:migrate
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
npm run db:migrate
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
- `deliveries:create`
- `deliveries:read`
- `deliveries:cancel`

Asignarlos en creación de credencial; por defecto no hay permisos. El endpoint `scope-check` requiere deliveries:read y sólo verifica autorización: no implementa entregas.

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
- maxDrivers/maxVehicles son límites operativos del proveedor, enteros de 1 a 10000. Se validan en DTO y con CHECK en PostgreSQL.
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
- code se recorta y convierte a mayúsculas; patrón `^[A-Z][A-Z0-9_]{1,49}# Mandaria — V1.2 Proveedores de Reparto

Plataforma independiente de logística y entregas. Mandaria y Coita Eats no comparten código, entidades Prisma ni PostgreSQL; su comunicación será exclusivamente API/eventos.

## Estado y arquitectura

V1.2 agrega DeliveryProvider y ProviderMembership al Core V1.0 y a las integraciones B2B V1.1. No reconstruye Auth humano ni agrega entregas. Los resultados de verificación están en [VERIFICATION.md](VERIFICATION.md); el contexto entre agentes, en [BITACORA.md](BITACORA.md).

- Node.js 24, TypeScript estricto, NestJS 11, Prisma 6, PostgreSQL 17/18.
- `auth/`: User, contraseña Argon2id, access JWT y refresh revocable.
- `users/`: selección explícita de campos públicos.
- `integrations/`: clientes externos, administración, credenciales, JWT B2B, scopes.
- `health/`, `common/`, `config/`, `prisma/`: infraestructura compartida.
- `prisma/migrations/`: SQL versionado; no se usa db push ni reset.
- `test/`: servicios, HTTP y E2E; `scripts/`: bootstrap, pruebas y herramientas locales.

UsersModule exporta el servicio; AuthModule registra el controller de usuarios para evitar dependencias circulares. IntegrationsModule reutiliza los guards humanos exclusivamente para administración.

## Instalación local

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
npm run db:migrate
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
npm run db:migrate
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
- `deliveries:create`
- `deliveries:read`
- `deliveries:cancel`

Asignarlos en creación de credencial; por defecto no hay permisos. El endpoint `scope-check` requiere deliveries:read y sólo verifica autorización: no implementa entregas.

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

, único.

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

DeliveryProvider.id queda disponible para relaciones futuras con Drivers, Vehicles y Wallet del proveedor. No hay conversiones automáticas de tipo. V1.3 deberá aplicar límites reales al crear recursos, coordinar altas concurrentes y definir qué ocurre al reducir un límite por debajo del uso existente.

### Actualizar y verificar V1.2

Detener previamente el backend si Windows bloquea el cliente Prisma:

```powershell
npm run prisma:generate
npm run db:migrate
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



## Docker: preparado, sin ejecución en esta etapa

Por instrucción del propietario, continuar localmente. Dockerfile y Compose se conservan, con variables B2B añadidas, PostgreSQL persistente, healthchecks y migraciones con reintentos. No se verificó build/up de Docker en V1.1.

Para uso futuro: configurar .env y ejecutar `docker compose up -d --build`. Si PostgreSQL local ocupa 5432, cambiar POSTGRES_PORT a otro puerto y ajustar DATABASE_URL del host. Compose usa internamente postgres:5432. No ejecutar down -v salvo eliminación deliberada de datos.

## Riesgos y deuda técnica

- Limitador en memoria para una instancia; antes de escalar usar almacenamiento compartido y configurar proxies confiables.
- Auditoría actual en logs, sin almacén persistente empresarial.
- Listados anteriores de Users/Integrations acotados a 100; Providers y memberships ya tienen paginación.
- JWT HS256 requiere distribución segura de claves si se separan servicios; rotación de claves de firma no automatizada.
- Credenciales pueden no expirar si el administrador omite expiresAt; establecer política operativa de rotación.
- Health 503 se prueba con fallo de consulta simulado, sin detener PostgreSQL compartido.
- Overrides multer ^2.3.0 y deepmerge-ts ^8.0.0 corrigen avisos transitivos; mantenerlos bajo revisión. tsconfck está deprecado como dependencia de desarrollo.

## Fuera de V1.2 / V1.3+

No se implementaron Driver, DriverProfile, Vehicle, DeliveryRequest, Quote, distancias/mapas, despacho, Socket.IO, Wallet, créditos/recargas, CUSTOMER, apps, GPS, pagos, planes ni facturación.

Las futuras apps Cliente/Repartidor usarán User. Los sistemas externos usarán IntegrationClient. Los créditos futuros pertenecen al proveedor; los vehículos son recursos operativos. Email, recuperación de contraseña y auditoría persistente siguen pendientes para versiones posteriores.
