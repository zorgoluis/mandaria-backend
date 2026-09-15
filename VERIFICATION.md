# Verificación V1.4-A — Drivers, Vehicles & Assignments (2026-09-15)

Rama `V1_4-Repartidores_Vehiculos` (local, desde QA), paquete 1.4.0, Node.js 24.15.0, PostgreSQL 18 local. Docker no ejecutado.

| Verificación | Resultado |
|---|---|
| Prisma validate / generate | PASS |
| Migración `20260915000400_drivers_vehicles` en mandaria_db y mandaria_test (sin reset) | PASS |
| Instalación limpia + V1.0 → V1.1 → V1.2 → V1.4 con fixtures (`verify-migrations.mjs`) | PASS; datos V1.2 idénticos; índices parciales y constraints presentes |
| Drift schema ↔ migraciones (`migrate diff`) | Vacío |
| Build / TypeScript (`tsc --noEmit`) | PASS |
| Oxlint / ESLint | PASS |
| docs:openapi / docs:check | PASS |
| npm test | 31 PASS (23 previas + 8 reglas V1.4) |
| npm run test:e2e | 63 PASS (45 previas + 11 drivers-vehicles + 7 driver-self) |
| Admin A → Drivers/Vehicles A | PASS 200/201 |
| Admin A → Drivers/Vehicles B | PASS 403 por scope; IDs de B → 404 |
| Admin B ↔ A simétrico | PASS |
| PROVIDER_ADMIN sin membership (crear/listar) | PASS 403 |
| Membership sin rol PROVIDER_ADMIN | PASS 403 (defensa en profundidad) |
| SUPER_ADMIN A/B, capacity y usage en listado | PASS |
| maxDrivers / maxVehicles (Luis y MOTO-03 → 409; suspendido cuenta; reducir límite → 409) | PASS |
| Concurrencia: 6 altas con límite 3 | PASS: 3 × 201 + 3 × 409 en Drivers y Vehicles |
| INDEPENDENT con límites configurables | PASS |
| Asignar / desasignar / reasignar / historial de Driver y Vehicle | PASS |
| Driver ocupado, Vehicle ocupado, Driver SUSPENDED, Vehicle INACTIVE/MAINTENANCE/SUSPENDED | PASS 409 |
| Cross-provider (API proveedor, API admin y FK compuesta en DB) | PASS 404 / error de FK |
| Asignación concurrente del mismo vehículo | PASS 201 + 409 |
| DRIVER /driver/me, disponibilidad propia, driverId ajeno → 400 | PASS |
| Driver suspendido / proveedor suspendido → AVAILABLE | PASS 409; OFFLINE forzado |
| DRIVER → administración | PASS 403 |
| IntegrationClient → crear/modificar/asignar Drivers/Vehicles y /driver | PASS 401 |
| Mutaciones: sin RolesGuard / sin límite maxDrivers / sin scope de vehículo | Detectadas (1 / 3 / 2 pruebas fallan) |
| HTTP local `verify:drivers-vehicles` (punto 54) | 16/16 PASS, ejecutado 2 veces |
| Regresión HTTP local `verify:provider-admins` | 13/13 PASS |
| Logs del backend y salidas | Sin contraseñas, JWT ni clientSecret; 0 request_failed |

---

# Verificación PROVIDER_ADMIN y ProviderMembership (2026-09-15)

Rama `QA`, paquete 1.2.0, Node.js 24.15.0, PostgreSQL 18 local. Validación con autenticación real; sin JWT manuales, bypass ni cambios en guards. Sin migración.

| Verificación | Resultado |
|---|---|
| Login real PROVIDER_ADMIN (A, B, sin membership) | PASS |
| Refresh (rotación y rechazo de reutilización) | PASS |
| /auth/me (rol PROVIDER_ADMIN, activo) | PASS |
| Admin A → Provider A (/provider/profile, /provider/profiles) | PASS, 200 |
| Admin A → Provider B / ID inexistente | PASS, 403 |
| Admin B → B 200; → A 403 | PASS |
| PROVIDER_ADMIN sin membership | PASS, 403 y lista vacía |
| userId/providerId duplicado enviados por cliente | PASS, 400 |
| PROVIDER_ADMIN → /admin/providers, /users | PASS, 403 |
| PROVIDER_ADMIN → IntegrationClient/credenciales (crear, modificar, suspender, rotar, revocar; alias incluidos) | PASS, 403 sin cambios |
| IntegrationClient JWT → /provider/*, /admin/providers, /auth/me | PASS, 401 |
| SUPER_ADMIN administra Provider A y B | PASS |
| Seed local idempotente y rechazo en producción/DB remota | PASS |
| Prueba de mutación (sin filtro userId) detectada por E2E | PASS, 3 casos fallan |
| Prisma validate, build, Oxlint, ESLint, tsc, docs:check | PASS |
| npm test | 23 PASS |
| npm run test:e2e | 45 PASS (7 Core, 14 B2B, 15 Providers, 9 PROVIDER_ADMIN) |
| HTTP local `npm run verify:provider-admins` | 13/13 PASS |

Logs del backend y salidas revisados sin contraseñas, JWT ni clientSecret. Detalle y comandos en README, sección "Escenario local PROVIDER_ADMIN".

---

# Verificación de Mandaria V1.2

Fecha: 2026-09-15. Node.js 24.15.0, PostgreSQL 18 local, rama `V1_2-Proveedores_Reparto`, paquete 1.2.0.

## Resultado V1.2

Definition of Done crítica V1.2 comprobada localmente. No se ejecutó Docker, conforme a la instrucción vigente del propietario.

| Verificación | Resultado |
|---|---|
| Prisma Generate | PASS, tras detener backend anterior que bloqueaba la DLL |
| Migración en mandaria_db y mandaria_test | PASS |
| Instalación desde base vacía | PASS |
| V1.0 → V1.1 → V1.2 con snapshots de datos | PASS, datos anteriores conservados |
| Build | PASS |
| ESLint | PASS |
| Tests unitarios/HTTP | 21 PASS |
| E2E PostgreSQL | 36 PASS: 7 Core + 14 B2B + 15 Providers |
| SUPER_ADMIN crea FLEET/INDEPENDENT y defaults | PASS |
| Defaults personalizados por configuración y límites explícitos | PASS |
| Códigos únicos normalizados, campos/IDs/límites inválidos | PASS |
| Paginación, filtros combinados y orden estable | PASS |
| Edición de límites, transiciones e idempotencia | PASS |
| Membresías múltiples y rechazo de duplicado concurrente | PASS |
| Retirar membership sin eliminar User | PASS |
| PROVIDER_ADMIN consulta su perfil | PASS |
| Provider A Admin → Provider B | 403 comprobado en E2E y HTTP local |
| IntegrationToken → Admin Providers y Provider | 401 comprobado |
| PROVIDER_ADMIN → administración B2B | 403 comprobado |
| Rol global/active actual y pérdida de membership | PASS con JWT emitido antes del cambio |
| Multi-provider: selección explícita y perfiles propios | PASS |
| Swagger versión/esquemas/descripciones/permisos/errores | PASS |
| Logging de eventos sin secretos de fixtures | PASS |
| Flujo local con login humano real | PASS, verify-providers-local.mjs |

Bases aisladas conservadas: `mandaria_clean_e0cd1120c3_test` y `mandaria_upgrade_e0cd1120c3_test`. El snapshot tras V1.1 de User, RefreshToken, IntegrationClient e IntegrationCredential se comparó exactamente después de V1.2. No se borraron ni resetearon bases existentes.

## Archivos V1.2

### Creados

- `src/providers/providers.module.ts`
- `src/providers/providers.service.ts`
- `src/providers/providers.dto.ts`
- `src/providers/providers.responses.ts`
- `src/providers/provider.select.ts`
- `src/providers/admin-providers.controller.ts`
- `src/providers/provider.controller.ts`
- `src/providers/provider-members.service.ts`
- `src/providers/provider-access.service.ts`
- `src/providers/provider-membership.guard.ts`
- `src/common/pagination.dto.ts`
- `src/common/api-errors.decorator.ts`
- `prisma/migrations/20260915000300_delivery_providers/migration.sql`
- `scripts/verify-migrations.mjs` (evolución del verificador anterior)
- `scripts/verify-providers-local.mjs`
- `test/providers.spec.ts`
- `test/providers.e2e-spec.ts`

### Modificados

- `prisma/schema.prisma`: DeliveryProvider, ProviderMembership, enums y relación reversa en User.
- `src/app.module.ts`, `src/config/environment.ts`, `src/setup.ts`: módulo, defaults y versión OpenAPI.
- `.env.example`, `docker-compose.yml`, `scripts/init-local.mjs`: defaults opcionales de límites.
- `scripts/verify-migrations-v11.mjs`: alias compatible del verificador común.
- `package.json`, `package-lock.json`: versión 1.2.0; sin dependencias nuevas.
- `README.md`, `BITACORA.md`, `VERIFICATION.md`: operación, decisiones y evidencia.

## Decisiones y límites V1.2

- ProviderMembership es muchos-a-muchos; global PROVIDER_ADMIN y rol local OWNER/ADMIN son independientes. No se crean ni elevan usuarios al asignar.
- `/provider/profile` omite ID sólo con una membership; varias devuelven 409 y requieren elegir providerId. Un proveedor ajeno/inexistente devuelve 403. `/provider/profiles` sólo consulta las memberships del User autenticado.
- Suspender conserva consulta del perfil y datos. No hay endpoints operativos; V1.3 deberá incorporar controles de estado para sus operaciones.
- Límites de 1 a 10000 en API y CHECK SQL. No se cuentan recursos inexistentes. No se implementó conversión automática de tipo.
- No se agregó Driver, Vehicle, Wallet, IntegrationClient↔Provider ni ninguna función V1.3+.
- Rate limiting en memoria y auditoría en logs siguen como deuda heredada. La gestión general de usuarios no se amplía.
- Swagger de Providers se amplió con detalles y errores. La mejora general pendiente del OpenAPI B2B anterior no se incluyó.
- Docker sólo recibió defaults de configuración; no fue ejecutado. No se provocó una caída física de PostgreSQL.

---

# Histórico: verificación de Mandaria V1.1

Fecha: 2026-09-15. Node.js 24.15.0, PostgreSQL 18 local, rama `v1-cliente_b2b_integracion_api`, paquete 1.1.0.

## Resultado V1.1

Requisitos críticos de la Definition of Done V1.1 comprobados localmente. No se ejecutó Docker, conforme a la instrucción vigente del propietario.

| Verificación | Resultado |
|---|---|
| Instalación limpia npm ci | PASS; se detuvo el backend V1.0 para liberar la DLL de Prisma |
| Prisma generate | PASS |
| Build | PASS |
| ESLint | PASS |
| Tests unitarios/HTTP | 18 PASS |
| Tests E2E con PostgreSQL | 21 PASS: 7 Core + 14 B2B |
| Migraciones desde base vacía | PASS |
| Actualización desde esquema y fixtures V1.0 | PASS; usuarios, refresh, UUID, hashes y revocaciones preservados |
| Migraciones en mandaria_db y mandaria_test | PASS |
| Credenciales válidas e inválidas, expiración de token/credencial | PASS |
| Separación User/Integration y SUPER_ADMIN | PASS |
| Emisión única de secretos y metadata sin hashes/secretos | PASS |
| Scopes permitidos/denegados y validación del catálogo | PASS |
| Suspensión y reactivación con token ya emitido | PASS |
| Rotación con coexistencia y revocación de tokens anteriores | PASS |
| REVOKED terminal en IntegrationClient | PASS |
| Rate limiting real del endpoint token | PASS: décima petición permitida, siguiente 429 |
| Swagger y esquemas Bearer distintos | PASS |
| Aliases administrativos V1.0, INACTIVE y creación sin body | PASS |
| Logs sin secretos generados | PASS, captura E2E; logs locales sin campos clientSecret/secretHash |
| Flujo HTTP en backend local | PASS, script verify-b2b-local.mjs |
| npm audit durante instalación limpia | 0 vulnerabilidades |

Herramientas reproducibles: README, scripts/verify-migrations-v11.mjs, scripts/test-db.mjs y scripts/verify-b2b-local.mjs.

## Inventario de archivos V1.1

### Creados

- `src/integrations/admin-integrations.controller.ts`
- `src/integrations/integration-auth.service.ts`
- `src/integrations/integration-scopes.ts`
- `src/integrations/integration.select.ts`
- `prisma/migrations/20260915000200_b2b_credentials/migration.sql`
- `scripts/upgrade-env-v11.mjs`
- `scripts/verify-migrations-v11.mjs`
- `scripts/verify-b2b-local.mjs`
- `test/b2b.e2e-spec.ts`
- `test/integration-auth.spec.ts`

### Modificados

- `prisma/schema.prisma`: evolución de las dos entidades existentes y nuevo enum CredentialStatus; ningún modelo nuevo.
- `src/integrations/integration.guard.ts`, `integrations.controller.ts`, `integrations.dto.ts`, `integrations.module.ts`, `integrations.service.ts`: autenticación, administración, respuestas y scopes B2B.
- `src/config/environment.ts`, `src/config/environment.spec.ts`, `src/setup.ts`: configuración y Swagger.
- `test/core.e2e-spec.ts`, `test/http.spec.ts`, `test/services.spec.ts`: conservación de pruebas humanas y sustitución de casos API key por pruebas B2B ampliadas.
- `.env.example`, `scripts/init-local.mjs`, `docker-compose.yml`: variables B2B.
- `package.json`, `package-lock.json`: versión 1.1.0, sin dependencias nuevas.
- `README.md`, `BITACORA.md`, `VERIFICATION.md`: instrucciones, continuidad y resultados.
- `.env` local no versionado: nuevas variables B2B agregadas sin imprimir ni reemplazar valores existentes.

Bases de verificación conservadas: `mandaria_clean_4edab2c526_test` y `mandaria_upgrade_4edab2c526_test`. No se borró ni reseteó ninguna base existente. Las suites limpian sus propios registros.

## Decisiones y límites V1.1

- El clientId público del intercambio identifica IntegrationCredential.id; la FK histórica clientId sigue apuntando al IntegrationClient. La respuesta de creación añade integrationId para desambiguar.
- El guard consulta PostgreSQL en cada autorización. Suspensión y revocación afectan tokens emitidos; no cancelan requests que ya pasaron autorización. Reactivar restaura acceso a tokens aún vigentes.
- Rotación conserva scopes y expiresAt; una credencial vencida requiere generación nueva. El secreto anterior sigue activo hasta revocación explícita.
- Rutas administrativas previas conservadas; el contrato de autenticación x-api-key y la respuesta apiKey fueron reemplazados de forma intencional y documentada.
- Rate limiting en memoria, logs sin auditoría persistente, listados acotados a 100 y rotación de claves JWT no automatizada son deuda documentada.
- No se implementaron módulos de logística, usuarios CUSTOMER, apps, pagos ni facturación.
- Docker/Compose se actualizó sólo en configuración; su ejecución continúa pendiente por instrucción del propietario. El fallo físico de PostgreSQL no se provocó; health 503 sigue probado mediante fallo de consulta.

---

# Histórico: verificación de Mandaria Core V1.0

Fecha: 2026-09-15. Entorno: Windows, Node.js 24.15.0 y PostgreSQL 18 local.

## Resultado

Core implementado y verificado localmente. **V1.0 no se declara completamente terminada según la Definition of Done original:** la ejecución de Docker/Compose fue pospuesta expresamente por el propietario.

| Verificación | Resultado |
|---|---|
| Build TypeScript/Nest | PASS |
| ESLint | PASS |
| Tests unitarios y HTTP con dobles de DB | 15 PASS |
| E2E con PostgreSQL real | 9 PASS |
| Migración inicial en mandaria_db | PASS |
| Migración desde base mandaria_test vacía | PASS |
| Repetir migrate deploy sin pendientes | PASS |
| Seed SUPER_ADMIN | PASS |
| Seed repetido sin duplicados | PASS |
| Login, me, users, refresh y logout por HTTP local | PASS |
| Refresh concurrente y rechazo de reutilización | PASS, E2E |
| Roles y rechazo de usuarios inactivos | PASS, E2E |
| Integraciones: autenticación, rotación, revocación y desactivación | PASS, E2E |
| Health consulta PostgreSQL | PASS |
| Health 503 ante fallo de consulta | PASS, fallo simulado; no se detuvo el PostgreSQL compartido |
| Swagger y OpenAPI | PASS |
| CORS, Helmet, body y validación | PASS |
| npm audit | 0 vulnerabilidades tras overrides |
| Docker build y docker compose up | PENDIENTE por instrucción del propietario |

## Problemas encontrados y resueltos

- El esqueleto NestJS 12 no satisfacía los peer dependencies de Throttler 6. Se alineó el runtime con NestJS 11 y Swagger 11.
- Prisma y Vitest/tsx requerían descargas/subprocesos que el aislamiento de Windows bloqueaba. Se ejecutaron con autorización y completaron correctamente.
- PostgreSQL rechazaba las credenciales iniciales (P1000). El propietario corrigió `.env`; las migraciones y pruebas posteriores pasaron.
- Avisos transitivos en multer y deepmerge-ts: overrides a `^2.3.0` y `^8.0.0`, respectivamente. Migraciones y E2E se repitieron después de actualizar.
- Docker Desktop no respondía inicialmente. No se prosiguió con contenedores tras la instrucción de trabajar localmente.

## Límites conocidos

- La prueba 503 inyecta un fallo de consulta; no simula caída física del servidor.
- Logout revoca refresh; access conserva vigencia hasta expirar. Desactivar un usuario impide el acceso inmediatamente al volver a consultar su estado.
- Rate limiting en memoria para una instancia. Al escalar habrá que compartir almacenamiento.
- Los secretos locales permanecen sólo en `.env`, ignorado por Git. Las verificaciones no imprimieron contraseñas, JWT ni API keys.
- Las pruebas E2E limpian sus propios registros; la base `mandaria_test` permanece disponible.

Los comandos reproducibles, endpoints y alcance futuro están en README.md.

## Verificación posterior — Scripts npm (2026-09-15)

- Build, Oxlint (sin advertencias), docs:openapi y docs:check: PASS.
- docs:check con archivo deliberadamente alterado: rechaza con código 1; original restaurado.
- Prisma generate y postinstall: PASS después de liberar DLL del backend local.
- db:deploy y db:test:deploy: PASS, sin migraciones pendientes.
- db:seed: PASS, SUPER_ADMIN existente conservado.
- npm test: 21 PASS; npm run test:e2e directo: 36 PASS.
- npm run test:cov: 21 PASS; líneas 63.27%, statements 64.01%, ramas 50.21%, funciones 39.39% del conjunto medido; no incluye E2E.
- start:prod con node dist/main: PASS, health HTTP 200.
- npm install de Oxlint: 0 vulnerabilidades reportadas; revisión de secretos locales en archivos publicables sin coincidencias.
- No ejecutados: Docker, resets, migrate dev interactivo, Studio, watch/debug ni instalación limpia completa. Format configurado con globs src/test/prisma; se formatearon sólo archivos modificados para evitar cambios ajenos a la solicitud.
