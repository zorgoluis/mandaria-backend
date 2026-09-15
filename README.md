# Mandaria — V1.1 Clientes B2B e Integraciones API

Plataforma independiente de logística y entregas. Mandaria y Coita Eats no comparten código, entidades Prisma ni PostgreSQL; su comunicación será exclusivamente API/eventos.

## Estado y arquitectura

V1.1 extiende el Core V1.0 con Client Credentials, JWT B2B y scopes. No reconstruye Auth humano ni agrega entregas. Los resultados de verificación están en [VERIFICATION.md](VERIFICATION.md); el contexto entre agentes, en [BITACORA.md](BITACORA.md).

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

## Docker: preparado, sin ejecución en esta etapa

Por instrucción del propietario, continuar localmente. Dockerfile y Compose se conservan, con variables B2B añadidas, PostgreSQL persistente, healthchecks y migraciones con reintentos. No se verificó build/up de Docker en V1.1.

Para uso futuro: configurar .env y ejecutar `docker compose up -d --build`. Si PostgreSQL local ocupa 5432, cambiar POSTGRES_PORT a otro puerto y ajustar DATABASE_URL del host. Compose usa internamente postgres:5432. No ejecutar down -v salvo eliminación deliberada de datos.

## Riesgos y deuda técnica

- Limitador en memoria para una instancia; antes de escalar usar almacenamiento compartido y configurar proxies confiables.
- Auditoría actual en logs, sin almacén persistente empresarial.
- Listados acotados a 100; paginación completa pendiente.
- JWT HS256 requiere distribución segura de claves si se separan servicios; rotación de claves de firma no automatizada.
- Credenciales pueden no expirar si el administrador omite expiresAt; establecer política operativa de rotación.
- Health 503 se prueba con fallo de consulta simulado, sin detener PostgreSQL compartido.
- Overrides multer ^2.3.0 y deepmerge-ts ^8.0.0 corrigen avisos transitivos; mantenerlos bajo revisión. tsconfck está deprecado como dependencia de desarrollo.

## Fuera de V1.1 / V1.2+

No se implementaron DeliveryProvider, Fleet, independientes, DriverProfile, Vehicle, DeliveryRequest, Quotes, distancias, despacho, Socket.IO, Wallet, créditos, CUSTOMER, apps, pagos, planes ni facturación.

Las futuras apps Cliente/Repartidor usarán User. Los sistemas externos usarán IntegrationClient. Los créditos futuros pertenecen al proveedor; los vehículos son recursos operativos. Email, recuperación de contraseña y auditoría persistente siguen pendientes para versiones posteriores.
