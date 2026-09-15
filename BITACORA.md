# Bitácora de Mandaria

Documento de continuidad para el propietario y los agentes que trabajen en este repositorio. Actualizar el estado actual y agregar una entrada al historial al finalizar cada tarea.

## Estado actual

- **Versión del paquete:** 1.2.0.
- **Rama activa de V1.2:** `V1_2-Proveedores_Reparto` (nombre encontrado al iniciar la tarea; se respetó).
- **Repositorio remoto:** https://github.com/zorgoluis/mandaria-backend.git. Entrega V1.2 en `V1_2-Proveedores_Reparto`.
- **Objetivo actual:** V1.2 Proveedores de Reparto sobre Core V1.0 e integraciones B2B V1.1.
- **Herramientas:** scripts npm ampliados con OpenAPI exportable, matriz de acceso, Oxlint y configuración Prisma de pruebas; entrega autorizada en la rama actual.
- **Estado funcional V1.2:** implementado y verificado localmente el 2026-09-15; 21 pruebas unitarias/HTTP y 36 E2E correctos.
- **Definition of Done:** requisitos críticos V1.2 verificados. Docker/Compose heredado sigue pospuesto por el propietario; no se declara ejecutado.
- **Modalidad vigente:** Node.js y PostgreSQL locales; no levantar contenedores.
- **Base local configurada:** `mandaria_db`; base separada para E2E: `mandaria_test`.
- **Configuración:** `.env` local, ignorado por Git. El propietario corrigió el acceso y las verificaciones posteriores pasaron. No copiar sus valores a esta bitácora.
- **Servidor:** detenido el 2026-09-15 tras la validación PROVIDER_ADMIN (se levantó temporalmente con `node dist/main.js`). Iniciar con npm run start:dev o start:prod cuando se necesite.
- **Validación PROVIDER_ADMIN/memberships:** cerrada el 2026-09-15 en rama `QA` con autenticación real. Escenario local reproducible `npm run db:seed:local-provider-admins` (LOCAL/TEST ONLY) y `npm run verify:provider-admins`. Tests: 23 unitarias/HTTP y 45 E2E.

## Arquitectura y decisiones vigentes

- Node.js 24, TypeScript estricto, NestJS 11, Prisma 6 y PostgreSQL 18 local.
- Módulos: `auth`, `users`, `integrations`, `health`, `common`, `config` y `prisma`.
- API bajo `/api/v1`; health en `/health`; Swagger en `/docs` y OpenAPI en `/docs-json`.
- Entidades: User, RefreshToken, IntegrationClient e IntegrationCredential, con UUID y timestamps.
- Roles: SUPER_ADMIN, PROVIDER_ADMIN y DRIVER. No existe CUSTOMER ni registro público.
- Contraseñas con Argon2id. Access y refresh JWT tienen secretos, audiencias y tipos separados.
- Refresh almacenado como hash SHA-256, rotación transaccional de un solo uso y revocación en logout.
- Logout revoca refresh; access conserva vigencia hasta expirar. Los guards consultan el rol y estado activo actuales en PostgreSQL.
- Integraciones externas usan clientId/clientSecret para obtener JWT B2B temporal; `x-api-key` ya no autentica peticiones. clientId público identifica la credencial, no la entidad IntegrationClient.
- Estados IntegrationClient: ACTIVE, SUSPENDED y REVOKED; revocación terminal. Credenciales: ACTIVE/REVOKED, scopes, expiresAt opcional y lastUsedAt.
- Rotación genera nueva credencial con mismos scopes/vencimiento y mantiene la anterior hasta revocarla explícitamente. El guard verifica estado de cliente/credencial en cada request y aplica revocación/suspensión también a tokens emitidos.
- INTEGRATION_JWT_SECRET separado de los dos secretos humanos; INTEGRATION_ACCESS_TOKEN_EXPIRES_IN en segundos (60–3600, default 3600).
- Administración bajo `/api/v1/admin/integrations`; rutas administrativas V1.0 conservadas como aliases. Se acepta INACTIVE como alias de entrada de SUSPENDED. No existe recuperación del secreto.
- NestJS 11 se eligió por compatibilidad con Throttler 6. El esqueleto original usaba NestJS 12.
- Overrides de seguridad: multer `^2.3.0` y deepmerge-ts `^8.0.0`; migraciones y E2E fueron comprobados tras instalarlos.
- Rate limiting en memoria para una instancia. Antes de escalar, evaluar almacenamiento compartido y proxies confiables.
- Mandaria no comparte código, entidades Prisma ni PostgreSQL con Coita Eats. La comunicación futura será mediante API/webhooks.
- DeliveryProvider representa oferta logística, separado de IntegrationClient. Tipos FLEET/INDEPENDENT; estados PENDING/ACTIVE/SUSPENDED. No hay relación a integración, Driver, Vehicle o Wallet.
- ProviderMembership relaciona User existente con uno o varios proveedores. Roles OWNER/ADMIN locales; se exige User activo con rol global PROVIDER_ADMIN al asignar. Par providerId/userId único. Retirar sólo borra la relación.
- Limits maxDrivers/maxVehicles: enteros 1–10000 con validación DTO y CHECK SQL. Defaults de entorno FLEET 10/10 e INDEPENDENT 1/2. V1.2 no cuenta recursos inexistentes.
- Admin Providers: sólo SUPER_ADMIN. Perfil: AccessGuard + RolesGuard + ProviderMembershipGuard. Sin membership se devuelve 403 aun si el JWT sigue vigente; tokens B2B devuelven 401.
- `/provider/profile?providerId=UUID` selecciona una asociación; omitir ID sólo funciona con una membership. `/provider/profiles` lista asociaciones propias. Perfiles de proveedores suspendidos siguen consultables; no hay operaciones logísticas.
- Paginación nueva reutilizable page/pageSize (default 1/20, máximo 100 por página), filtros type/status/search y orden estable. No se cambió el contrato de listados V1.1.

## Mapa de archivos

| Ruta | Propósito |
|---|---|
| `README.md` | Instalación, comandos, endpoints, seguridad y alcance |
| `VERIFICATION.md` | Evidencias y limitaciones de la verificación del Core |
| `src/` | Implementación modular NestJS |
| `prisma/schema.prisma` | Modelo de datos |
| `prisma/migrations/20260915000100_core/migration.sql` | Migración inicial versionada |
| `prisma/seed.ts` | Bootstrap idempotente de SUPER_ADMIN |
| `test/` y `src/config/environment.spec.ts` | Pruebas de servicios, HTTP, configuración y E2E |
| `scripts/init-local.mjs` | Crear `.env` aleatorio sólo si no existe |
| `scripts/create-test-db.mjs` | Crear `mandaria_test` si falta, sin borrar datos |
| `scripts/test-db.mjs` | Migrar base de pruebas y ejecutar E2E |
| `scripts/verify-local.mjs` | Verificar endpoints del servidor activo sin imprimir secretos |
| `scripts/local-provider-admins.ts`, `scripts/seed-local-provider-admins.ts` | LOCAL/TEST ONLY: escenario PROVIDER_ADMIN A/B/sin membership, protegido contra producción |
| `scripts/verify-provider-admins-local.ts` | Validación HTTP real de memberships, aislamiento y separación User/Integration JWT |
| `test/provider-admin-access.e2e-spec.ts` | E2E casos 1–6 de autorización PROVIDER_ADMIN |
| `Dockerfile`, `docker-compose.yml` | Preparación para uso futuro, ejecución pendiente |

## Verificaciones históricas del Core

Ejecutadas el 2026-09-15; no implican que se hayan repetido tras cada cambio documental:

- `npm run build`: correcto.
- `npm run lint`: correcto.
- `npm test`: 15 pruebas correctas (servicios, configuración y HTTP con dobles de DB).
- `node scripts/test-db.mjs`: 9 E2E correctos con PostgreSQL real.
- Migración aplicada a `mandaria_db` y a `mandaria_test` recién creada y vacía.
- Seed ejecutado dos veces: administrador creado y segunda ejecución sin cambios ni duplicados.
- Smoke HTTP local: health, Swagger, login del administrador, me, users, refresh, logout y rechazo del refresh revocado.
- Integraciones: autenticación, rotación, revocación y desactivación verificadas por E2E.
- `npm audit`: cero vulnerabilidades en aquella ejecución.
- Fallo de health 503 probado con fallo de consulta simulado; no se detuvo el servidor PostgreSQL compartido.

## Pendientes y límites del alcance

1. Verificar Docker build y Compose sólo cuando el propietario indique retomar Docker. Hasta entonces no declarar satisfecha toda la Definition of Done original.
2. Mantener la bitácora actualizada conforme lleguen nuevas solicitudes.
3. V1.3+: Driver/Vehicle y aplicación real de límites. Deliveries, tarifas, despacho, wallets/créditos, realtime, integración operativa con Coita Eats, mandados, paquetería y fletes siguen fuera del alcance. No comenzar sin solicitud.
4. Recuperación/restablecimiento de contraseña, verificación de correo y auditoría persistente: preparación arquitectónica, sin infraestructura implementada.
5. En modelos futuros, los créditos pertenecen al proveedor; los vehículos son recursos operativos y los repartidores realizan entregas.

## Cómo retomar

1. Leer este documento y las instrucciones de `AGENTS.md`.
2. Revisar el estado de Git y los archivos relevantes; no sobrescribir cambios del propietario.
3. Comprobar PostgreSQL y el proceso local antes de arrancarlos; no imprimir `.env`.
4. Para iniciar con configuración existente: `npm ci`, `npm run prisma:generate`, `npm run db:migrate`, `npm run db:seed`, `npm run start:dev`. El seed requiere las variables de bootstrap.
5. Ejecutar las verificaciones adecuadas al cambio y registrar resultados reales. Las instrucciones detalladas están en README.

## Historial

### 2026-09-15 — Implementación inicial del Core (1.0.0)

- **Solicitud:** implementar la especificación Mandaria V1.0 con independencia de Coita Eats.
- **Trabajo:** módulos NestJS, Prisma y migración, autenticación y roles, integraciones, health, seguridad, logging, Swagger, bootstrap, scripts, pruebas y documentación; archivos Docker preparados.
- **Correcciones:** compatibilidad NestJS/Throttler, dependencias vulnerables y acceso PostgreSQL corregido por el propietario.
- **Cambio de instrucción:** el propietario indicó no correr Docker y trabajar localmente. Se continuó con PostgreSQL instalado.
- **Resultados:** build, lint, 15 pruebas unitarias/HTTP, 9 E2E, migración desde base vacía, seed idempotente y smoke HTTP correctos.
- **Pendiente:** ejecución de Docker/Compose.

### 2026-09-15 — Continuidad entre agentes y versión (1.0.1)

- **Solicitud:** crear un archivo acumulativo para que otro agente conozca el trabajo y actualizar la versión de package.json.
- **Trabajo:** creada esta bitácora y `AGENTS.md` para que futuros agentes la lean y actualicen; versión incrementada de 1.0.0 a 1.0.1 en package.json y package-lock.json.
- **Verificación:** JSON de ambos manifiestos válido y versiones del paquete raíz sincronizadas; sin cambios en dependencias o lógica de ejecución.
- **Pruebas:** no se repitieron build/E2E por tratarse de documentación y metadatos de versión. Los resultados anteriores se conservan como históricos.
- **Pendiente:** Docker/Compose continúa pospuesto. La versión 1.0.1 no representa el cierre de esa verificación.

### 2026-09-15 — Publicación inicial en GitHub

- **Solicitud:** configurar origin, usar la rama main y subir el proyecto a `zorgoluis/mandaria-backend`.
- **Preparación:** el repositorio local no tenía commits ni remotos; el remoto consultado no tenía referencias publicadas. Se prepara el commit inicial del Core 1.0.1 y su push a main.
- **Verificación previa:** `.env` ignorado por Git; revisión de los 54 archivos publicables sin coincidencias con los secretos locales configurados. No se incluyen node_modules ni dist.
- **Pruebas:** no repetidas; esta tarea sólo publica el estado ya verificado y actualiza la bitácora.
- **Ajuste de publicación:** eliminadas líneas vacías sobrantes al final de archivos y agregado `.gitattributes` para conservar LF en scripts shell al clonar desde Windows.
- **Resultado:** commit inicial `b977b6e` publicado correctamente en `origin/main`; HEAD y origin/main coincidieron, el directorio de trabajo quedó limpio y `.env` no está versionado. Esta actualización documental registra el resultado después del push inicial.
- **Pendiente funcional:** Docker/Compose sigue pospuesto por indicación del propietario.

### 2026-09-15 — V1.1 Clientes B2B e Integraciones API

- **Solicitud:** extender V1.0 con Client Credentials, tokens temporales B2B separados de usuarios, scopes, administración SUPER_ADMIN, rotación, revocación, suspensión y auditoría mínima.
- **Diagnóstico previo:** existentes IntegrationClient/IntegrationCredential, guards, JWT, logging, configuración y tests reutilizables. No se reconstruyó Auth humano.
- **Implementación:** IntegrationAuthService, guard Bearer B2B, IntegrationScopes/IntegrationScopesGuard, controller administrativo, DTOs/respuestas Swagger y selects públicos. Logging de eventos sin secretos; token endpoint limitado a 10/min/IP.
- **Migración:** `20260915000200_b2b_credentials`; renombra INACTIVE a SUSPENDED y agrega estado/scopes/expiración/último uso de credenciales sin recrear tablas. Conserva revocaciones previas.
- **Configuración:** script upgrade-env-v11 agrega únicamente variables B2B faltantes al `.env` local. `.env.example` queda con campos sensibles vacíos. Los valores anteriores del ejemplo no coincidían con los secretos locales; no se divulgaron sus valores.
- **Instalación:** npm ci completado tras detener el proceso V1.0 que bloqueaba la DLL de Prisma. Prisma generate y build correctos; auditoría de instalación sin vulnerabilidades.
- **Validación final:** lint correcto; 18 pruebas unitarias/HTTP y 21 E2E (7 Core + 14 B2B) correctos. Migraciones aplicadas a mandaria_db y mandaria_test.
- **Preservación:** bases `mandaria_clean_4edab2c526_test` y `mandaria_upgrade_4edab2c526_test` verificadas y conservadas para inspección. Fixtures confirman conservación de usuarios, refresh, IDs, hashes y estados revocados al actualizar desde V1.0.
- **HTTP local:** verificado cliente temporal → credencial → token → me/scopes → suspensión/rechazo → reactivación → rotación con coexistencia → revocación/rechazo. El script elimina sólo su integración temporal.
- **Seguridad:** E2E comprueba que secretos generados no aparecen en logs ni metadata; respuestas sin secretHash. Inspección de logs del proceso local sin campos clientSecret/secretHash. Revisar `.env` únicamente mediante herramientas que no impriman valores.
- **Versión:** package.json y package-lock.json sincronizados a 1.1.0; Swagger 1.1.0.
- **Continuidad:** README documenta comandos completos, migración del contrato API key y registro de Coita Eats vía SUPER_ADMIN. No se registró una integración de producción ni se modificó Coita Eats.
- **Pendientes:** Docker sigue sin ejecutar; limitador distribuido, auditoría persistente, paginación y todos los módulos V1.2+ quedan fuera del alcance. No se realizó commit ni push de V1.1 en esta tarea.

### 2026-09-15 — Entrega de V1.1 a la rama actual

- **Solicitud:** crear commit y subir V1.1 a `v1-cliente_b2b_integracion_api` en origin.
- **Contenido de entrega:** implementación B2B 1.1.0, migración, pruebas, scripts y documentación descritos en la entrada anterior.
- **Verificación previa:** diff sin errores de formato; `.env` ignorado y archivos publicables sin coincidencias con los secretos locales configurados. No se repitieron las pruebas por tratarse de publicación del código ya verificado (18 unitarias/HTTP y 21 E2E).
- **Aclaración sobre OpenAPI:** documentación funcional existente; queda pendiente ampliar descripciones por endpoint, ejemplos completos y errores 400/401/403/404/409/429 aplicables. El README contiene actualmente una explicación más completa del flujo. Esta ampliación no está incluida en el commit solicitado.
- **Destino:** rama actual; sin merge a main. Comprobar sincronización con origin al finalizar el push.

### 2026-09-15 — V1.2 Proveedores de Reparto

- **Solicitud:** DeliveryProvider, límites configurables, estados, administración SUPER_ADMIN, memberships de usuarios y aislamiento cross-provider. Sin lógica V1.3+.
- **Diagnóstico previo:** V1.0/V1.1 reutilizables; no existía paginación formal. Se respetó la rama `V1_2-Proveedores_Reparto` y se mantuvo PostgreSQL local.
- **Modelos:** DeliveryProvider y ProviderMembership; enums ProviderType, ProviderStatus y ProviderMemberRole. IDs UUID, timestamps, restricciones de unicidad, FKs RESTRICT y CHECK para límites.
- **Migración:** `20260915000300_delivery_providers`, incremental. Verificada limpia y en secuencia V1.0 → V1.1 → V1.2. Los registros de User/RefreshToken/IntegrationClient/IntegrationCredential quedaron idénticos al snapshot V1.1.
- **Bases de evidencia:** `mandaria_clean_e0cd1120c3_test` y `mandaria_upgrade_e0cd1120c3_test`, conservadas. Migración aplicada también a mandaria_db y mandaria_test, sin reset.
- **Implementación:** módulo providers con servicios separados de CRUD, memberships y acceso; guards humanos reutilizados y ProviderMembershipGuard/CurrentProvider nuevos. No se cambian roles globales al asociar miembros.
- **Estados:** nace PENDING; activar PENDING/SUSPENDED, suspender ACTIVE; repetir estado actual es idempotente. PATCH no permite cambiar type/status. No existe borrado de proveedores por API.
- **Configuración:** cuatro DEFAULT_* de límites, opcionales con defaults en configuración y ejemplos. No se agregaron secretos ni dependencias. package.json/package-lock.json/Swagger a 1.2.0.
- **Swagger:** nuevas operaciones con descripciones extensas en español, permisos, parámetros, ejemplos, paginación y schemas de errores. La ampliación general de OpenAPI B2B mencionada antes sigue siendo un pendiente separado.
- **Validación:** Prisma generate, build y lint correctos. 21 pruebas unitarias/HTTP y 36 E2E (7 Core, 14 B2B, 15 Providers). Casos de duplicado concurrente, filtros, límites inválidos, roles, suspensión, multi-provider y remoción sin eliminar User correctos.
- **HTTP local:** SUPER_ADMIN login, FLEET/INDEPENDENT con defaults, límites personalizados, activación/suspensión, creación de User PROVIDER_ADMIN temporal, asociación, login y perfil; acceso A→B 403; B2B→Provider 401; remoción invalida acceso y conserva User. El script limpia sólo sus fixtures.
- **Proceso local:** se detuvo el backend anterior para liberar la DLL de Prisma y se levantó la compilación V1.2 en puerto 3000. Comprobar que sigue activo al retomar.
- **Continuidad:** README incluye Delivery Providers y comandos reproducibles. `verify-migrations.mjs` centraliza pruebas de evolución; el script v11 queda como alias compatible.
- **Pendientes/deuda:** provisión general de usuarios no ampliada; OWNER/ADMIN tienen sólo lectura, auditoría sigue en logs, rate limiting en memoria. V1.3 deberá aplicar límites reales y definir políticas de recursos al suspender/reducir capacidad. No se hizo commit/push de V1.2.

### 2026-09-15 — Entrega de V1.2 a la rama actual

- **Solicitud:** crear commit y subir V1.2 a `V1_2-Proveedores_Reparto` en origin.
- **Contenido:** implementación 1.2.0, migración incremental, pruebas, Swagger y documentación descritos arriba.
- **Verificación de publicación:** revisión de archivos publicables y diff; `.env` permanece excluido. Se comprobará la coincidencia de HEAD con la rama remota después del push.
- **Pruebas:** no repetidas para esta publicación; resultados de implementación conservados: build/lint correctos, 21 pruebas unitarias/HTTP y 36 E2E aprobadas.
- **Pendientes:** Docker continúa pospuesto; deuda funcional indicada en la entrada anterior. Sin merge a main.

### 2026-09-15 — Comandos npm y documentación exportable

- **Solicitud:** habilitar scripts de build/formato, Oxlint, documentación OpenAPI, Prisma, Docker, arranque y Vitest indicados por el propietario.
- **Cambios:** scripts solicitados disponibles; alias prisma:generate y lint:eslint conservados. Hooks pretest* mantienen compilación previa para imports de dist. db:migrate ahora usa migrate dev; documentación y verificador antiguo usan deploy para aplicar migraciones existentes.
- **Documentación:** openapi.cli genera docs/openapi.json sin conectar a PostgreSQL ni abrir HTTP; generate-api-access genera docs/API_ACCESS.md con roles/scopes de decorators compartidos. docs:check compila y compara ambos artefactos con código actual, sin sobrescribirlos.
- **Prisma:** config principal registra seed; config de pruebas comparte selección validada de TEST_DATABASE_URL con E2E, deriva mandaria_test si falta y rechaza nombre no terminado en _test o la misma base principal. No se modificó schema ni datos del seed existente.
- **Verificaciones:** npm install de Oxlint (0 vulnerabilidades); build, lint sin advertencias, docs:openapi y docs:check correctos. Comprobación negativa de documento alterado rechazada y archivo restaurado. db:generate/postinstall correctos tras detener backend que bloqueaba DLL; deploy principal/test sin migraciones pendientes; seed idempotente sin cambios.
- **Tests:** npm test 21 aprobadas, npm run test:e2e 36 aprobadas, npm run test:cov 21 aprobadas; cobertura de líneas 63.27% del conjunto medido por Vitest (sin E2E).
- **Proceso:** backend reiniciado con npm run start:prod (node dist/main); health HTTP 200. Revisión de archivos publicables sin secretos locales configurados.
- **No ejecutado:** Docker, resets, migrate dev interactivo, Studio y modos watch/debug. Siguen disponibles para uso explícito; resets destruyen datos. No se repitió instalación limpia completa. Sin commit/push de estos cambios.

### 2026-09-15 — Publicación de comandos npm y OpenAPI

- **Solicitud:** crear commit y subir los cambios de herramientas a la rama actual `V1_2-Proveedores_Reparto`.
- **Contenido:** comandos npm, Oxlint, exportación OpenAPI/matriz de acceso, configuración Prisma y documentación de la entrada anterior.
- **Verificación:** diff sin errores de formato y archivos revisados; no se repiten las pruebas de implementación ya registradas. Comprobar sincronización con origin tras el push.
- **Destino:** origin/V1_2-Proveedores_Reparto, sin merge a main. Docker y resets permanecen sin ejecutar.

### 2026-09-15 — Resolución de EPERM en Prisma generate

- **Solicitud:** resolver error EPERM al reemplazar query_engine-windows.dll.node.
- **Diagnóstico:** backend iniciado por el agente (PID 26400, node dist/main, puerto 3000) mantenía la DLL cargada.
- **Acción:** detenido únicamente ese backend; npm run db:generate completó correctamente con Prisma Client 6.19.3.
- **Resultado:** cliente regenerado; servidor queda apagado para evitar otro bloqueo mientras el propietario ejecuta comandos. PostgreSQL no se detuvo y no se hicieron migraciones ni resets.
- **Continuidad:** cambio preexistente en package-lock.json conservado. No se repiten tests por esta operación local, sin cambios funcionales; sin commit/push.

### 2026-09-15 — Validación real de PROVIDER_ADMIN y ProviderMembership

- **Solicitud:** cerrar la observación "falta validar PROVIDER_ADMIN y memberships contra una cuenta real". Sin V1.4 ni cambios de dominio.
- **Inspección:** User/Role, AuthService (login/refresh/me), AccessGuard/RolesGuard, ProviderMembershipGuard/ProviderAccessService, controllers `/admin/providers`, `/provider`, `/users`, `/admin/integrations` (+ alias `/integrations`), schema, seed y E2E existentes. La autorización ya dependía de la membership (consulta `userId` del JWT + `providerId`); no se encontró bug de autorización, por lo que no se modificaron guards, servicios, contratos ni schema. Sin migración.
- **Escenario local (LOCAL/TEST ONLY):** `scripts/local-provider-admins.ts` + CLI `npm run db:seed:local-provider-admins`. Crea Provider A `LOCAL_RAPIDOS_COITA` y B `LOCAL_MANDADOS_CENTRO` (FLEET, ACTIVE), Admin A→A OWNER, Admin B→B OWNER y un PROVIDER_ADMIN sin membership. Idempotente; no cambia roles de emails existentes. Contraseña en `LOCAL_PROVIDER_ADMIN_PASSWORD` (agregada al `.env` local con `scripts/upgrade-env-local-provider-admins.mjs`, sin imprimirla).
- **Protección producción:** rechaza NODE_ENV distinto de development/test, DB no local y contraseña igual a la del bootstrap. No está en `prisma db seed`; Docker no copia `scripts/` salvo el entrypoint (sólo migra) y `tsx` es devDependency. Rechazo con NODE_ENV=production comprobado.
- **Validación HTTP real:** `npm run verify:provider-admins` contra `node dist/main.js` y `mandaria_db`: 13/13 PASS (login, refresh con rechazo de reutilización, /auth/me, A→A 200, A→B 403, B→B 200, B→A 403, sin membership 403, PROVIDER_ADMIN→admin/users/integraciones 403 sin cambios, B2B JWT→superficies humanas 401, SUPER_ADMIN gestiona A/B). Primer intento falló por un bug del script (enviaba campos extra a `/integrations/token` → 400); corregido. Logs del backend y salida sin contraseñas, JWT ni clientSecret.
- **Pruebas nuevas:** `test/provider-admin-access.e2e-spec.ts` (9 casos: seed idempotente, rechazo de elevación, login/refresh/me, casos 1–6) y `test/local-provider-admins.spec.ts` (2). Prueba de mutación: quitar el filtro `userId` en ProviderAccessService hace fallar casos 2, 3 y 5; código restaurado.
- **Documentación:** README con sección "Escenario local PROVIDER_ADMIN", variable y comandos. Corregido bloque duplicado de ~264 líneas en README (causado por un reemplazo con `$` en el patrón de code); sin pérdida de contenido.
- **Verificaciones:** prisma validate, build, Oxlint, ESLint, `tsc --noEmit`, docs:check, db:test:deploy (sin pendientes), npm test 23 PASS, test:e2e 45 PASS.
- **Observaciones/pendientes:** ProviderMembership no tiene estado propio (activo/suspendido); si se requiere, será cambio de dominio futuro. ProviderMembershipGuard no verifica el rol por sí mismo (depende de RolesGuard en el controller): al reutilizarlo en V1.4 combinarlo siempre con `@Roles('PROVIDER_ADMIN')`. SUPER_ADMIN recibe 403 en `/provider/profile` por diseño. Avisos de Prettier preexistentes en `scripts/generate-api-access.ts` y `scripts/test-database-url.ts` sin tocar. Docker sigue sin ejecutar. Sin commit/push.
