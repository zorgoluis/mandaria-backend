# Bitácora de Mandaria

Documento de continuidad para el propietario y los agentes que trabajen en este repositorio. Actualizar el estado actual y agregar una entrada al historial al finalizar cada tarea.

## Estado actual

- **Versión del paquete:** 1.10.0 (V1.10-A Credit Accounts & Immutable Ledger).
- **Rama activa:** `v1.10-credit-monetization`, creada por el propietario tras el merge de V1.9 (PR #14). V1.10-A sin commit ni push (instrucción del propietario).
- **Repositorio remoto:** https://github.com/zorgoluis/mandaria-backend.git. Entrega V1.2 en `V1_2-Proveedores_Reparto`.
- **Objetivo actual:** V1.10-A: cuentas de créditos por proveedor y por repartidor independiente con ledger inmutable, recargas y ajustes manuales de SUPER_ADMIN e idempotencia. Los créditos son enteros y no son dinero. **CLAIM y TAKE todavía no consumen créditos** (eso empieza en V1.10-D). No iniciados: V1.10-B (CreditPolicy) en adelante, pagos online, Driver App. La «V1.9-C Service Coverage» que mencionó el propietario no existe en el repositorio; pendiente aclararlo.
- **Herramientas:** scripts npm ampliados con OpenAPI exportable, matriz de acceso, Oxlint y configuración Prisma de pruebas; entrega autorizada en la rama actual.
- **Estado funcional V1.10-A:** implementado y verificado el 2026-09-21 (commit `533bf10`). El mismo día se corrigió el defecto de cotizaciones concurrentes de V1.6 que causaba el único fallo arrastrado de la suite: 131 unitarias y **197 E2E con 15/15 archivos en verde, sin fallos**, `verify-migrations` en tres bases, tormenta de créditos 7/7 y 0 violaciones del ledger.
- **Estado funcional V1.9-A:** implementado, verificado y **validado adversarialmente (CHECK) el 2026-09-18**: 34/34 comprobaciones por HTTP real contra `dist/main.js` y 0 violaciones en el escaneo de ambas bases. 113 pruebas unitarias y 162 E2E por archivo. `verify-migrations` V1.0 → V1.9 PASS sin reset. El CHECK **encontró y se corrigieron 3 defectos reales de una sola causa raíz** (carrera entre `take` y la suspensión; ver historial y VERIFICATION.md). Queda **1 fallo preexistente** en `delivery-quotes` (20 cotizaciones concurrentes) que ya fallaba en la línea base antes de tocar código: agotamiento del pool de conexiones de Prisma (500 a los 10 063 ms), camino V1.6 que V1.9 no modifica.
- **Estado funcional V1.8-A:** implementado, verificado y validado adversarialmente (CHECK) el 2026-09-17; 91 pruebas unitarias; E2E 148/148 por archivo; mutaciones 10/10 detectadas; verify-migrations V1.0 → V1.8 PASS; CHECK V1.8-A 30/30 por HTTP real. Regresión V1.9: los archivos E2E de V1.7/V1.8 pasan con los mismos conteos que la línea base.
- **Definition of Done:** requisitos V1.10-A verificados localmente (ver VERIFICATION.md). La suite E2E pasa completa por archivo, sin fallos; en una sola corrida de Vitest sigue apareciendo la caída nativa de workers en Windows. Docker sigue pospuesto por el propietario.
- **Modalidad vigente:** Node.js y PostgreSQL locales; no levantar contenedores.
- **Base local configurada:** `mandaria_db`; base separada para E2E: `mandaria_test`.
- **Configuración:** `.env` local. **Alerta 2026-09-16:** el commit del propietario `2ccd1c5` («git fix») lo quitó de `.gitignore` y lo versionó con valores reales en un repositorio público (origin/main, QA y ramas de trabajo). Se informó al propietario, que decidió no tocarlo por ahora; se recomienda rotar la API key de Google, los tres secretos JWT y las contraseñas. V1.6.1 no modifica `.env` ni `.gitignore`. No copiar sus valores a esta bitácora.
- **Servidor:** detenido. Para V1.6.1 se levantó temporalmente `node dist/main.js` con `MAIL_PROVIDER=local_outbox`, `MANDARIA_WEB_URL=http://localhost:5173` y `ROUTING_PROVIDER=local_fake` en variables de proceso (sin editar `.env`) y se detuvo. Producción requiere MAIL_PROVIDER=smtp, SMTP_HOST, MAIL_FROM y MANDARIA_WEB_URL https.
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
- DeliveryProvider representa oferta logística, separado de IntegrationClient. Tipos FLEET/INDEPENDENT; estados PENDING/ACTIVE/SUSPENDED. No hay relación a integración ni Wallet; desde V1.4 posee Drivers y Vehicles.
- ProviderMembership relaciona User existente con uno o varios proveedores. Roles OWNER/ADMIN locales; se exige User activo con rol global PROVIDER_ADMIN al asignar. Par providerId/userId único. Retirar sólo borra la relación.
- Limits maxDrivers/maxVehicles: enteros 1–10000 con validación DTO y CHECK SQL. Defaults de entorno FLEET 10/10 e INDEPENDENT 1/2. Desde V1.4 se aplican contando todos los Drivers/Vehicles (cualquier estado) con bloqueo FOR UPDATE del proveedor; no pueden bajarse por debajo del uso.
- V1.4: Driver = perfil logístico de un User DRIVER existente (userId único, sin credenciales). Vehicle pertenece al proveedor (identifier único por proveedor). DriverVehicleAssignment conserva historial; asignación vigente única por Driver y Vehicle vía índices parciales; FKs compuestas impiden cruzar proveedores. Rutas de proveedor siempre con AccessGuard + RolesGuard(PROVIDER_ADMIN) + ProviderMembershipGuard; recursos de otro proveedor → 404.
- Admin Providers: sólo SUPER_ADMIN. Perfil: AccessGuard + RolesGuard + ProviderMembershipGuard. Sin membership se devuelve 403 aun si el JWT sigue vigente; tokens B2B devuelven 401.
- `/provider/profile?providerId=UUID` selecciona una asociación; omitir ID sólo funciona con una membership. `/provider/profiles` lista asociaciones propias. Perfiles de proveedores suspendidos siguen consultables; no hay operaciones logísticas.
- V1.5: DeliveryRequest = demanda de un IntegrationClient (ownership desde el JWT B2B, nunca del body). Sin providerId/driverId/vehicleId: la unión con la oferta pertenece a Dispatch. Estados CREATED/CANCELLED; inmutable salvo cancelación; sin PATCH/DELETE.
- V1.5: stops como snapshot (sin FKs externas), exactamente PICKUP #1 y DROPOFF #2 en la API aunque el modelo es 1:N; packages genéricos (≥1, sin carrito); DeliveryFinancialContext 1:1 con NUMERIC(14,2) y ISO 4217: PREPAID (Driver paga 0; valor opcional) y COURIER_ADVANCE (Driver adelanta y recupera; valor > 0 obligatorio). No hay deliveryFee, wallet ni créditos.
- V1.5: publicId `MDR-NNNNNN` desde la secuencia `DeliveryRequest_publicId_seq` dentro de la transacción. Idempotency-Key obligatoria con ApiIdempotencyRecord reutilizable (único por IntegrationClient + key, hash SHA-256 de payload normalizado, sin payload): replay 200, conflicto 409, concurrencia bloqueada por el índice único dentro de la misma transacción atómica.
- V1.5: rutas `/delivery-requests` (scopes V1.1 deliveries:create/read/cancel, independientes) y `/admin/delivery-requests` (SUPER_ADMIN lectura/cancelación). Recursos ajenos → 404. PROVIDER_ADMIN/DRIVER → 403 admin y 401 B2B. Creación limitada a 60/min por IP. Logs con IDs y actor, sin datos personales.
- V1.6: DeliveryRequest.serviceType (enum ServiceType, sólo LOCAL_DELIVERY; default para filas V1.5). Se omite del hash de idempotencia mientras sea el default, preservando reintentos V1.5. Sólo servicio inmediato; expiresAt de Quote ≠ scheduledFor (futuro).
- V1.6: ServiceZone con boundary GeoJSON Polygon/MultiPolygon validado y bbox; geometría encapsulada en `src/geo/geometry.ts` (bordes cuentan como dentro, huecos excluyen), sin PostGIS. Activación rechaza zonas que intersequen o toquen otra ACTIVE (advisory lock); boundary editable sólo INACTIVE.
- V1.6: RatePlan versionado DRAFT → ACTIVE → INACTIVE, índice único parcial (1 ACTIVE por zona+servicio), activación atómica, triggers de inmutabilidad (bandas sólo en DRAFT, estructura fija fuera de DRAFT). RateBand [min, max) en metros enteros, contiguas desde 0, NUMERIC(14,2). TTL LOCAL_DELIVERY 1–120 min (recomendado 15; DB 1–10080).
- V1.6: RoutingProvider (token ROUTING_PROVIDER) con GoogleRoutingProvider (Routes API computeRoutes, key sólo en header, field mask, timeout por intento, ≤ 1 reintento transitorio por defecto) y local_fake LOCAL/TEST ONLY rechazado en producción. ROUTE_NOT_FOUND vs ROUTING_UNAVAILABLE; nunca fallback Haversine.
- V1.6: DeliveryQuote snapshot inmutable (trigger) con MQ publicId por secuencia; FKs compuestas banda∈plan∈zona; índices parciales 1 OFFERED y 1 ACCEPTED por solicitud; expiración perezosa (lectura informa EXPIRED, escritura persiste). Cotización con FOR UPDATE de la DeliveryRequest (reutiliza OFFERED/ACCEPTED sin routing; configuración de tarifa comprobada antes de routing). Cancelar solicitud cancela OFFERED y conserva ACCEPTED. Errores de dominio con `code` estable (422/503/409). Scopes quotes:create/read/accept independientes.
- V1.6.1: alta de personas sólo por invitación (SUPER_ADMIN → PROVIDER_ADMIN/DRIVER; PROVIDER_ADMIN → DRIVER en proveedores con membership). Ningún administrador define contraseñas ajenas; SUPER_ADMIN sólo por bootstrap. Seeds locales no son aprovisionamiento de producción.
- V1.6.1: estado de cuenta derivado sin columna nueva: ACTIVE = `active`; INVITED = inactivo sin `passwordHash` (ahora opcional); DISABLED = inactivo con contraseña. CHECK `User_active_password_check`. Login de INVITED → mismo 401 que contraseña incorrecta.
- V1.6.1: UserInvitation (PENDING/ACCEPTED/REVOKED; EXPIRED derivado de expiresAt, sin cron) con token de 256 bits guardado sólo como SHA-256, TTL configurable (24 h), índice único parcial de una PENDING por User, reenvío que rota el token en la misma fila con enfriamiento bajo bloqueo, revocación idempotente y trigger de inmutabilidad.
- V1.6.1: membership/Driver se materializan al activar (opción B) para conservar las invariantes V1.2/V1.4; las invitaciones DRIVER pendientes vigentes reservan lugar de maxDrivers. Activación en una transacción con orden de bloqueo proveedor → User → invitación.
- V1.6.1: MailProvider (`src/mail/`) con SMTP (nodemailer, producción), local_outbox (LOCAL/TEST ONLY, rechazado en producción) y FakeMailProvider en pruebas. Correo tras el commit; fallo → `emailDelivery: FAILED` y resend. Política de contraseña 16–128 compartida (`src/common/password-policy.ts`).
- V1.7: Dispatch se abre en la misma transacción que acepta la Quote (único por deliveryQuoteId; backfill EXPIRED para ACCEPTED previas). Elegibilidad = proveedor ACTIVE + ProviderServiceCoverage ACTIVE de la ServiceZone y ServiceType de la Quote; candidatos como snapshot. Sin candidatos no falla la aceptación: OPEN sin candidatos y señal derivada noProviderAvailable (sin estado NO_PROVIDER_FOUND).
- V1.7: estados Dispatch OPEN/CLAIMED/EXPIRED/CANCELLED y candidato OFFERED/CLAIMED/RELEASED (sin EXCLUDED); expiración perezosa con DISPATCH_TTL_MINUTES (10). Claim con bloqueo FOR UPDATE de la fila del Dispatch, índice parcial de un candidato CLAIMED y triggers de transición; liberación sólo del dueño, sin reclamo posterior; cancelación integrada en la cancelación oficial de DeliveryRequest conservando claimedByProviderId.
- V1.7: vistas de proveedor por access OWNER/OFFER/SUMMARY (contactos, instrucciones y referencias sólo para el dueño; nunca IntegrationClient ni otros candidatos). SUPER_ADMIN, DRIVER e IntegrationClient no reclaman.
- V1.8: DeliveryAssignment es historial (ACTIVE/REASSIGNED/CANCELLED); nunca se sobrescribe y Dispatch no guarda driverId/vehicleId. Tres índices únicos parciales garantizan una sola ACTIVE por Dispatch, por Driver y por Vehicle; FKs compuestas (driverId, providerId) y (vehicleId, providerId) impiden cruzar flotillas; trigger DeliveryAssignment_guard (nace ACTIVE para un Dispatch CLAIMED del mismo proveedor, identidad inmutable, filas cerradas congeladas) y dispatch_guard ampliado (no salir de CLAIMED con asignación ACTIVE).
- V1.8: asignar no cambia el estado del Dispatch ni crea estados de ejecución; el Driver no acepta ni rechaza (sin Driver App). Elegibilidad = proveedor ACTIVE + Driver ACTIVE con User activo + Vehicle ACTIVE + ninguno ocupado + emparejamiento V1.4 coherente; recursos ajenos → 404. Orden de bloqueo dispatch → proveedor (SHARE) → driver → vehicle; conflicto único → 409 ASSIGNMENT_CONFLICT.
- V1.8: plazo por ServiceType con LOCAL_DELIVERY_ASSIGNMENT_TTL_MINUTES (5); assignmentDeadline = claimedAt + TTL y assignmentOverdue son derivados, sin cron ni liberación automática. paymentContext (deliveryFee, goodsValue, goodsPaymentMode, driverAdvancesGoods, driverAdvanceAmount) informa el adelanto COURIER_ADVANCE sin mover dinero ni validar efectivo; no hay wallet ni saldos.
- V1.8: release con asignación ACTIVE → 409 DISPATCH_HAS_ACTIVE_ASSIGNMENT; cancelar la DeliveryRequest cierra la ACTIVE con DELIVERY_CANCELLED en la misma transacción; el emparejamiento V1.4 no puede cambiarse mientras el Driver ejecuta una entrega.
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
| `src/drivers/`, `src/vehicles/`, `src/assignments/` | V1.4: Driver, Vehicle, asignaciones, `/driver` y controllers admin/proveedor |
| `src/providers/provider-capacity.ts` | Bloqueo de fila del proveedor para límites y orden de locks |
| `prisma/migrations/20260915000400_drivers_vehicles/migration.sql` | Migración V1.4 con FKs compuestas, índices parciales y CHECK |
| `scripts/local-driver-users.ts`, `scripts/verify-drivers-vehicles-local.ts` | LOCAL/TEST ONLY: Users DRIVER y validación manual V1.4 |
| `test/drivers-vehicles.e2e-spec.ts`, `test/driver-self.e2e-spec.ts`, `test/logistics.spec.ts` | Pruebas V1.4 |
| `src/delivery-requests/`, `src/idempotency/` | V1.5: DeliveryRequest B2B/admin e idempotencia reutilizable |
| `prisma/migrations/20260915000500_delivery_requests/migration.sql` | Migración V1.5: tablas, secuencia publicId, CHECK e índices |
| `scripts/verify-delivery-requests-local.ts` | LOCAL/TEST ONLY: validación HTTP real V1.5 |
| `test/delivery-requests-validation.e2e-spec.ts`, `test/delivery-requests-b2b.e2e-spec.ts`, `test/delivery-requests.spec.ts` | Pruebas V1.5 |
| `src/geo/`, `src/service-zones/`, `src/routing/`, `src/rate-plans/`, `src/delivery-quotes/` | V1.6: geometría, zonas, RoutingProvider/Google, tarifas y Quotes |
| `src/common/domain-error.ts`, `src/common/public-id.ts` | Errores de dominio con code estable; publicId MDR/MQ por secuencia |
| `prisma/migrations/20260915000600_routing_pricing_quotes/migration.sql` | Migración V1.6: tablas, índices parciales, CHECK, triggers y secuencia MQ |
| `scripts/local-pricing.ts`, `scripts/seed-local-pricing.ts`, `scripts/verify-delivery-quotes-local.ts`, `scripts/check-google-routes.ts` | LOCAL/TEST ONLY: zonas/tarifa placeholder, validación HTTP V1.6 y comprobación manual de Google |
| `test/pricing.spec.ts`, `test/pricing-admin.e2e-spec.ts`, `test/delivery-quotes.e2e-spec.ts` | Pruebas V1.6 |
| `src/invitations/`, `src/mail/`, `src/common/password-policy.ts` | V1.6.1: invitaciones, activación, MailProvider/plantilla y política de contraseña |
| `prisma/migrations/20260916000700_user_invitations/migration.sql` | Migración V1.6.1: UserInvitation, passwordHash opcional, CHECK, índice parcial y trigger |
| `scripts/verify-user-invitations-local.ts` | LOCAL/TEST ONLY: validación HTTP real V1.6.1 con outbox local |
| `test/invitations.spec.ts`, `test/user-invitations.e2e-spec.ts`, `test/support/fake-mail.provider.ts` | Pruebas V1.6.1 |
| `src/dispatch/` | V1.7: Dispatch, candidatos, coberturas, claim/release y vistas por access |
| `prisma/migrations/20260917000800_dispatch_engine/migration.sql` | Migración V1.7: tablas, únicos, índice parcial, CHECK, triggers y backfill |
| `test/dispatch.spec.ts`, `test/dispatch.e2e-spec.ts` | Pruebas V1.7 |
| `src/delivery-assignments/` | V1.8: política, servicio, DTOs/respuestas y controllers de asignación de Driver/Vehicle |
| `prisma/migrations/20260917000900_delivery_assignments/migration.sql` | Migración V1.8: DeliveryAssignment, índices únicos parciales ACTIVE, CHECK, trigger y dispatch_guard ampliado |
| `test/delivery-assignments.spec.ts`, `test/delivery-assignments.e2e-spec.ts` | Pruebas V1.8 |
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
3. V1.9+: Driver App y aceptación del repartidor, Drivers independientes, estados de ejecución de la entrega, hunting, elegibilidad y tarifa por vehículo, BASE_PLUS_DISTANCE, INTERCITY/FREIGHT/ERRAND, scheduling, PostGIS, tracking/GPS, Socket.IO, ciclo de entrega completo, múltiples stops, wallets/créditos/pagos, KYC/documentos e integración operativa con Coita Eats siguen fuera del alcance. No comenzar sin solicitud.
4. Recuperación/restablecimiento de contraseña, verificación de correo y auditoría persistente: preparación arquitectónica, sin infraestructura implementada.
5. En modelos futuros, los créditos pertenecen al proveedor; los vehículos son recursos operativos y los repartidores realizan entregas.
6. Deuda V1.4: provisión/invitación de Users DRIVER por API; política de la asignación vigente al suspender un Driver o dejar un vehículo no ACTIVE (hoy se conserva hasta desasignar); sin eliminación/transferencia de Drivers/Vehicles.
7. Deuda V1.5: retención de ApiIdempotencyRecord; rate limit de creación por IP (no por cliente); precisión de 2 decimales para goodsValue; datos personales de stops sin cifrado ni retención definidos; orden de packages no preservado.
8. Caída nativa intermitente de workers Vitest/Prisma en Windows (0xC0000409), previa a V1.5: investigar en Linux/Docker y con volcado de memoria antes de confiar en ejecuciones E2E completas locales.
9. Deuda V1.8: assignmentOverdue sin cron ni notificación; sin verificación de disponibilidad real, cercanía ni efectivo del repartidor; un Driver/Vehicle sólo ejecuta una entrega a la vez (entregas agrupadas exigirán relajar los índices parciales); suspender un Driver o dejar un vehículo no ACTIVE no cierra la asignación de entrega vigente.
10. Deuda V1.6: transacción retenida durante routing (considerar single-flight a escala); definir boundaries oficiales y tarifas comerciales (seed = placeholders); métricas agregadas de routing; rate limit de cotización por IP; guardia SQL para borrado manual de bandas no usadas en planes ACTIVE.

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

### 2026-09-15 — V1.4-A Drivers, Vehicles & Assignments

- **Solicitud:** Driver (perfil logístico de un User DRIVER), Vehicle genérico del proveedor, DriverVehicleAssignment con historial, estados y disponibilidad, maxDrivers/maxVehicles efectivos, administración SUPER_ADMIN/PROVIDER_ADMIN, `/driver/me` y disponibilidad propia. Sin V1.5.
- **Inspección:** se reutilizan AccessGuard/RolesGuard/ProviderMembershipGuard, PaginationQueryDto, ApiErrors y logging por eventos. No existe API de alta de Users: Driver se asocia a un User DRIVER existente (mismo criterio que memberships). ProviderMembership no se modificó.
- **Prisma:** enums DriverStatus, DriverAvailability, VehicleType y VehicleStatus; Driver (userId único), Vehicle (`providerId+identifier` único) y DriverVehicleAssignment con FKs compuestas `(driverId,providerId)`/`(vehicleId,providerId)` e índices únicos parciales para la asignación vigente; CHECK de nombre, identifier, año y periodo. Migración `20260915000400_drivers_vehicles` generada con `migrate diff` más SQL manual; `migrate diff` contra una base migrada devuelve vacío (sin drift).
- **Reglas:** todos los registros cuentan para los límites; bajar límites por debajo del uso → 409; suspender un proveedor pasa sus Drivers AVAILABLE/BUSY a OFFLINE; AVAILABLE/BUSY requieren Driver y proveedor ACTIVE; asignar requiere vehículo ACTIVE, Driver no SUSPENDED, proveedor no SUSPENDED y ambos libres; PENDING puede recibir vehículo; recursos de otro proveedor → 404.
- **Concurrencia:** `SELECT … FOR UPDATE` sobre DeliveryProvider en altas, edición de límites y suspensión; asignaciones con orden proveedor (SHARE) → Driver → Vehicle; índices parciales como respaldo.
- **API:** `/admin/providers/:providerId/{drivers,vehicles}` (SUPER_ADMIN), `/provider/{drivers,vehicles}` (AccessGuard → RolesGuard PROVIDER_ADMIN → ProviderMembershipGuard), asignar/desasignar/historial, `/admin/providers/:id/capacity`, `/provider/capacity`, `usage` en el listado admin, `/driver/me` y `/driver/availability`. Swagger 1.4.0; docs/openapi.json y API_ACCESS.md regenerados.
- **Local:** `db:seed:local-driver-users` (Users DRIVER Carlos/Pedro/José/Luis/Mario, misma protección y contraseña local compartida, sin imprimirla) y `verify:drivers-vehicles` (idempotente). Seed PROVIDER_ADMIN intacto (mismos IDs al reejecutar).
- **Verificaciones:** prisma validate, db:generate, build, tsc --noEmit, Oxlint, ESLint, docs:openapi y docs:check; migración aplicada a mandaria_db y mandaria_test; verify-migrations (bases `mandaria_clean_8e62fbfc5c_test` y `mandaria_upgrade_8e62fbfc5c_test`, más `mandaria_drift_8d9845bd_test`) con V1.2 → V1.4 preservando proveedores y memberships; npm test 31 PASS; test:e2e 63 PASS (45 previas + 11 drivers-vehicles + 7 driver-self); mutaciones (sin RolesGuard, sin límite, sin scope de vehículo) detectadas; HTTP local V1.4 16/16 dos veces y regresión verify:provider-admins 13/13; logs sin secretos ni 5xx.
- **Incidencias:** EPERM en prisma generate por un backend ajeno (PID 30660) detenido con autorización; Prettier sobre `src/**` alteró saltos de línea de archivos no relacionados (revertidos); test con scope inexistente `deliveries:write` corregido; aserción antigua de verify-migrations (0 proveedores) ajustada al nuevo fixture V1.2.
- **Pendientes:** punto 6 de pendientes; Docker sin ejecutar. Sin commit/push.

### 2026-09-15 — Publicación de V1.4-A

- **Solicitud:** commit y push de V1.4-A a la rama actual `V1_4-Repartidores_Vehiculos`.
- **Contenido:** implementación, migración, pruebas, scripts locales y documentación de la entrada anterior.
- **Verificación previa:** revisión de archivos publicables sin valores de `.env`; pruebas no repetidas tras la verificación final ya registrada (31 unitarias, 63 E2E, build/lint/docs:check correctos).
- **Destino:** origin/V1_4-Repartidores_Vehiculos (rama nueva). Sin merge.

### 2026-09-15 — V1.5-A Delivery Requests

- **Solicitud:** DeliveryRequest B2B con stops, packages, contexto financiero (PREPAID/COURIER_ADVANCE), publicId MDR, Idempotency-Key con hash, scopes existentes, aislamiento B2B, administración SUPER_ADMIN y cancelación. Sin V1.6+.
- **Inspección:** reutilizados IntegrationGuard (estado de cliente/credencial por request), IntegrationScopesGuard y catálogo de scopes V1.1 (los tres deliveries:* ya existían), ThrottlerGuard, logging por eventos, ApiErrors/paginación. No existía idempotencia ni secuencias. `/integrations/:id` es alias admin con UUID, por eso se usó `/delivery-requests`.
- **Prisma:** enums DeliveryRequestStatus, DeliveryStopType, PackageCategory, GoodsPaymentMode; modelos DeliveryRequest, DeliveryStop, DeliveryPackage, DeliveryFinancialContext y ApiIdempotencyRecord. Migración `20260915000500_delivery_requests` (diff Prisma + SQL): secuencia publicId, CHECK de publicId, cancelación, stops, packages, dinero/moneda y hash; índices por cliente+fecha, externalReference, status+fecha, fecha, unique publicId y unique cliente+key. Sin drift (base `mandaria_drift_16d9b6b2_test`).
- **Implementación:** IdempotencyService genérico (JSON canónico + SHA-256, ledger primero en la transacción, P2002 → replay/409); normalización con reglas cruzadas (layout de stops, COURIER_ADVANCE, goodsValue > 0, dinero 2 decimales); controllers B2B/admin; respuestas B2B sin UUID internos; `Idempotent-Replayed`; ApiErrorDescriptions para descripciones B2B con el mismo esquema de error. IntegrationsModule exporta IntegrationAuthService. Swagger 1.5.0.
- **Bug encontrado y corregido:** omitir `financialContext` devolvía 500 (`@ValidateNested` no rechaza ausencia); añadido `@IsObject()`. Detectado por la E2E de validación.
- **Ajuste de regresión:** la E2E V1.4 de Swagger fijaba la versión `1.4.0`; ahora compara con package.json.
- **Verificaciones:** prisma validate, db:generate, build, tsc --noEmit, Oxlint, ESLint, docs:openapi/docs:check; migración aplicada a mandaria_db y mandaria_test; verify-migrations con V1.4 → V1.5 preservando drivers/vehículos/asignaciones (bases `mandaria_clean_7a0f2299c3_test` y `mandaria_upgrade_7a0f2299c3_test`); npm test 40 PASS (+9); test:e2e 85 PASS (+22: 7 validación + 15 B2B); mutaciones (detalle sin scope de cliente, sin registro de idempotencia, publicId con COUNT+1) detectadas; HTTP local verify:delivery-requests 10/10 (MDR-000001…000004) con auditoría y logs sin datos personales ni secretos; regresiones verify:drivers-vehicles 16/16 y verify:provider-admins 13/13.
- **Hallazgo no resuelto:** caídas nativas intermitentes de workers E2E en Windows (`Worker exited unexpectedly`, código 0xC0000409). Reproducido con el archivo V1.4 drivers-vehicles solo bajo carga, así que es previo a V1.5. Descartados memoria y max_connections; limitar workers no lo corrige. Cada archivo pasa por separado y hay ejecuciones completas 85/85, pero no toda ejecución completa es limpia. Detalle en VERIFICATION.md.
- **Pendientes:** punto 7 de pendientes; investigar la caída nativa E2E en Linux/Docker; Docker sin ejecutar. Sin commit/push.

### 2026-09-15 — Publicación de V1.5-A

- **Solicitud:** commit y push de V1.5-A a la rama actual `v1.5-delivery_request`.
- **Contenido:** implementación, migración, pruebas, script de validación local y documentación de la entrada anterior.
- **Verificación previa:** archivos publicables revisados sin valores de `.env`; pruebas no repetidas tras la verificación registrada (40 unitarias; 85 E2E en ejecuciones limpias, con la caída nativa intermitente de workers documentada como pendiente).
- **Destino:** origin/v1.5-delivery_request. Sin merge.

### 2026-09-15 — V1.6-A Routing, Service Zones, Rate Plans & Delivery Quotes

- **Solicitud:** ServiceType LOCAL_DELIVERY, ServiceZone con boundary, RoutingProvider/Google Routes, RatePlan versionado con DISTANCE_BANDS, DeliveryQuote con TTL, aceptación, concurrencia, errores de dominio, auditoría y administración. Sin Dispatch.
- **Inspección y línea base:** validaciones previas correctas (Prisma, build, tsc, lint, ESLint, docs:check, 40 unitarias); E2E 75/85 por la caída nativa conocida. Contrato V1.5 real reutilizado: DeliveryRequest/Stops (Decimal 9,6), IdempotencyService, secuencias publicId, IntegrationGuard/Scopes, catálogo con `quotes:create` reservado, logging JSON.
- **Diferencias respecto a la especificación (documentadas):** (1) configuración de tarifa se comprueba antes de routing para no pagar llamadas no tarificables; (2) cotización idempotente por DeliveryRequest (bloqueo de fila) en vez de Idempotency-Key, sin segundo sistema; (3) POST de cotización devuelve la ACCEPTED existente si la hay; (4) errores de dominio 422/503/409 con `code`; SERVICE_ZONE_AMBIGUOUS añadido como defensa; (5) sin endpoint de cancelación directa de Quote (CANCELLED sólo vía cancelación de la solicitud); (6) sin aceptación por SUPER_ADMIN.
- **Prisma:** enums ServiceType, ServiceZoneStatus, RatePlanStatus, RateCalculationType, DeliveryQuoteStatus; modelos ServiceZone, RatePlan, RateBand, DeliveryQuote; columna DeliveryRequest.serviceType con default. Migración `20260915000600_routing_pricing_quotes` con secuencia MQ, índices parciales (ACTIVE plan, OFFERED/ACCEPTED quote), CHECK y triggers `RateBand_draft_only`, `RatePlan_immutable`, `DeliveryQuote_immutable`. Sin drift (`mandaria_drift_1817ccb1_test`).
- **Bugs/ajustes encontrados:** banda con monto "0" pasaba el DTO y habría chocado con el CHECK (500) → validación 400 en servicio; carrera de activación vs reemplazo de boundary → bloqueo de fila adicional; `pg_advisory_xact_lock` devuelve void (Prisma no lo deserializa) → `SELECT 1 FROM pg_advisory_xact_lock`. Test: la FK compuesta impide borrar bandas usadas (comportamiento deseado); fixtures ajustados.
- **Cambios V1.5:** cancelación de DeliveryRequest ahora transaccional con bloqueo de fila e invalidación de Quotes; `serviceType` en create/response; publicId MDR vía helper común; HttpErrorFilter expone `code` de DomainException; catálogo de scopes `quotes:read`/`quotes:accept` y `ArrayMaxSize` ligado al catálogo.
- **Verificaciones:** prisma validate/generate, build, tsc, Oxlint, ESLint, docs:openapi/docs:check; migración en mandaria_db y mandaria_test; verify-migrations V1.5 → V1.6 con datos (`mandaria_clean_6e3d764371_test`/`mandaria_upgrade_6e3d764371_test`); npm test 52 PASS (+12); E2E 100/100 completa y por archivo (+15: 4 pricing-admin, 11 delivery-quotes); mutaciones M1–M4 (sin bloqueo de cotización, sin chequeo de expiración, banda con max inclusivo, lectura sin aislamiento) detectadas; seed local-pricing; HTTP verify:delivery-quotes 9/9 con local_fake (MDR-000037 → 4509 m → 4–6 km → MQ-000001 → $50.00 → ACCEPTED); regresiones HTTP V1.5 10/10, V1.4 16/16, V1.2 13/13; logs sin coordenadas, direcciones, contactos ni secretos.
- **Google Routes real:** el propietario configuró GOOGLE_ROUTES_API_KEY en el .env local; `npm run routing:check-google` PASS (5829 m, 1408 s, 302 ms, DRIVE) y `verify:delivery-quotes` 9/9 con ROUTING_PROVIDER=google (MDR-000046 → 5829 m → banda 4–6 km → MQ-000004 → $50.00 MXN → ACCEPTED; latencias 234/89/77 ms) sin imprimir la key. Las pruebas automatizadas siguen usando un RoutingProvider falso para no consumir cuota.
- **No verificado:** Docker. Sin commit/push.

### 2026-09-15 — Publicación de V1.6-A

- **Solicitud:** commit y push de V1.6-A a la rama actual `1.6-routing_services_plan`.
- **Contenido:** implementación, migración, pruebas, scripts locales y documentación de la entrada anterior, incluida la evidencia de Google Routes real.
- **Verificación previa:** archivos publicables revisados sin valores de `.env` ni GOOGLE_ROUTES_API_KEY; pruebas no repetidas tras la verificación final registrada (52 unitarias, 100 E2E, build/lint/docs:check correctos).
- **Destino:** origin/1.6-routing_services_plan. Sin merge.

### 2026-09-16 — V1.6.1-A User Provisioning, Invitations & Account Activation

- **Solicitud:** aprovisionamiento real de PROVIDER_ADMIN y DRIVER por invitación, token seguro de un solo uso, reenvío, revocación, activación transaccional, MailProvider, auditoría, concurrencia, rate limiting, migración, Swagger, contrato API y README. Sin Dispatch, sin tocar Coita Eats. Sin commit/push.
- **Inspección previa:** rama `v1.6.1-creation_users` con commits del propietario posteriores a V1.6 (`2ccd1c5` versiona `.env` con secretos reales en repositorio público, alertado; `5a2d3cc`/`933374c`/`566ea0b`/`8703f51` Docker y `src/bootstrap-admin.ts`, que compila). User sólo tenía `active` y `passwordHash` obligatorio; memberships y Drivers exigían User activo; auditoría = logs JSON; throttler por IP; sin correo; política de contraseña real 16–128 del bootstrap; `docs/API-CONTRACT.md` vive en mandaria-frontend.
- **Línea base:** E2E 100/100; unitarias 51/52. Fallo previo: la prueba `NOT_CONFIGURED` de Google leía la API key real del `.env` porque `ConfigService.get` recurre a `process.env` (defecto de aislamiento introducido en V1.6, visible al configurar la key). Corregido con `vi.stubEnv`; nunca llamó a Google (fetch simulado).
- **Decisiones:** estado de cuenta derivado (sin enum ni cambios a `active`); membership/Driver al activar; EXPIRED derivado; reenvío rota el token en la misma fila; revocar deja el User INVITED y reinvitable; invitaciones DRIVER reservan capacidad; SUPER_ADMIN no invitable; producción exige SMTP y MANDARIA_WEB_URL https (cambio de configuración obligatorio al desplegar).
- **Prisma:** `User.passwordHash` opcional; enum UserInvitationStatus y modelo UserInvitation. Migración `20260916000700_user_invitations` con `User_active_password_check`, `UserInvitation_values_check`, índice parcial `UserInvitation_pending_user_key` y trigger `UserInvitation_immutable`. Aplicada sin reset en mandaria_db y mandaria_test; drift vacío.
- **API:** `POST /admin/providers/:providerId/invitations`, `GET /admin/user-invitations[/:id]`, `POST /admin/user-invitations/:id/resend|revoke`, `/provider/driver-invitations` (mismas operaciones con membership), `POST /auth/activate-account`, `GET /users?status`. Dependencia nueva: nodemailer ^10.0.10 (sin dependencias, MIT-0, 0 vulnerabilidades).
- **Otros cambios:** seeds locales toleran `passwordHash` nulo; bootstrap (`prisma/seed.ts`, `src/bootstrap-admin.ts`) y LoginDto usan la constante compartida de contraseña sin cambiar su comportamiento; fixture de producción válida de `test/pricing.spec.ts` incluye la configuración de correo ahora obligatoria; `verify-migrations.mjs` cubre V1.6 → V1.6.1; `docs/API-CONTRACT.md` de mandaria-frontend actualizado (sólo documentación, sin commit).
- **Ajustes durante la implementación:** Prettier sobre todo `src/test` cambió finales de línea de ~76 archivos no tocados y reformateó dos pruebas ajenas: revertidos; lint marcó 4 errores en la E2E nueva: corregidos; el script local encontró Provider A local en maxDrivers (3/3, estado del escenario V1.4): el 409 es correcto y el script continúa con Admin B en Provider B.
- **Verificaciones:** prisma validate; tsc; build; Oxlint; ESLint; Prettier (archivos nuevos); docs:openapi/docs:check; npm test 69 PASS (+17); test:e2e 124/124 completa y por archivo (+24); mutaciones M1–M8 (sin enfriamiento bajo bloqueo, sin recomprobación al activar, sin aislamiento por proveedor, email ACTIVE aceptado, expiración ignorada, reenvío sin rotar token, PROVIDER_ADMIN invitando PROVIDER_ADMIN, reservas ignoradas) detectadas; verify-migrations limpia + V1.0 → V1.6.1 (`mandaria_clean_9564c6135c_test`/`mandaria_upgrade_9564c6135c_test`); `npm run db:seed` sin cambios y sin invitaciones en mandaria_db, y creación/idempotencia en la base limpia; HTTP `verify:user-invitations` 3/3; regresiones HTTP V1.2 13/13, V1.4 16/16, V1.5 10/10, V1.6 9/9; logs con eventos USER_INVITED/ACCEPTED/ACTIVATED/EMAIL_SENT/ACTIVATION_REJECTED sin tokens, hashes, emails, JWT ni `request_failed`; escaneo de secretos en 39 archivos modificados sin coincidencias.
- **No verificado:** envío por un servidor SMTP real; Docker.
- **Pendientes:** rotación de secretos expuestos y retiro de `.env` del repositorio (decisión del propietario); configurar SMTP y MANDARIA_WEB_URL en producción antes de desplegar V1.6.1; pantallas de Mandaria Web para invitaciones/activación; recuperación de contraseña y desactivación de cuentas; caída nativa intermitente de workers E2E en Windows.

### 2026-09-16 — Commit de V1.6.1-A

- **Solicitud:** commit de V1.6.1-A en la rama actual `v1.6.1-creation_users` (sin push); después revisar la caída nativa de workers E2E en Windows.
- **Contenido:** implementación, migración, pruebas, script de validación local y documentación de la entrada anterior. No incluye `.env` ni `.gitignore` (sin cambios) ni `mandaria-frontend/docs/API-CONTRACT.md` (otro repositorio, sin commit).
- **Verificación previa:** archivos en stage revisados contra los valores de `.env` y el patrón de API key de Google; pruebas no repetidas tras la verificación registrada (69 unitarias, 124 E2E, lint/docs:check correctos).

### 2026-09-16 — CHECK V1.6.1-A (validación backend) y caída nativa de workers

- **Solicitud:** revisar la caída nativa de workers E2E (luego detenida por el propietario) y validar exhaustivamente V1.6.1-A sin nuevas features, sin commit ni push.
- **Caída nativa (investigación detenida):** `0xC0000409` reproducido fuera de Vitest, NestJS, Prisma y argon2: procesos Node paralelos con HTTP local (supertest 5/480, `node:http` 1/240); JS puro 0/120; argon2 y ciclos de PrismaClient sin caídas; sin eventos WER ni filtros de red de terceros. Conclusión: aborto de Node/Windows bajo carga, no del código; producción corre en Linux. No se ocultó con reintentos.
- **Bug de prueba corregido:** `test/delivery-requests-validation.e2e-spec.ts` contaba DeliveryStop globales y con suites paralelas fallaba por ±2; ahora cuenta sólo los del IntegrationClient de la prueba.
- **Verificador de migraciones ampliado:** fixtures V1.6 (ServiceZone, RatePlan/RateBand, DeliveryQuote ACCEPTED) antes de V1.6.1 y conteos de zonas, planes, bandas, quotes, vehículos, integraciones, memberships y drivers tras el upgrade.
- **Validación real:** validador HTTP temporal (fuera del repo) contra `dist/main.js` con outbox local y logins reales: 24/24 (flujos PROVIDER_ADMIN y DRIVER en Provider A, ataque cross-provider, escalada, IntegrationClient, duplicados, token en claro ausente de todas las tablas, tokenHash rechazado como token, reutilización, expirado, revocado, resend, concurrencia 20/10/9, política 16–128 y Argon2id, login antes/después, deshabilitación, logs sin secretos). Limpieza completa; maxDrivers de Provider A restaurado a 3.
- **Otras comprobaciones:** bootstrap (seed y `dist/bootstrap-admin.js`) rechaza email INVITED y contraseña de 15 caracteres, crea e ignora repeticiones; seeds locales y `verify:user-invitations` rechazan NODE_ENV=production y base remota; producción rechaza local_outbox, ausencia de correo y MANDARIA_WEB_URL http; ninguna ruta expone tokens.
- **Calidad:** prisma validate, tsc, build, Oxlint, ESLint, docs:check; 69 unitarias; E2E 124/124 en 3 corridas completas consecutivas; verify-migrations PASS.
- **Observado:** el `.env` local (versionado en repositorio público) contiene ahora configuración SMTP real sin commitear; no se modificó y no se envió correo real.
- **Pendientes:** entrega SMTP real no validada; una invitación PENDING vencida bloquea invitar el mismo email desde otro proveedor hasta que su creador o SUPER_ADMIN la revoque o reenvíe.

### 2026-09-16 — V1.7-A Dispatch Engine & Provider Claiming

- **Solicitud:** Dispatch automático al aceptar Quote, candidatos elegibles por zona/servicio, claim atómico por PROVIDER_ADMIN, liberación, expiración, cancelación, auditoría, migración, Swagger, contrato API y README. Sin asignación de Driver/Vehicle, sockets, GPS ni V1.8. Sin commit/push.
- **Inspección:** rama `v1.7-dispatch_engine` (merge de V1.6.1). Aceptación de Quote idempotente por estado (sin Idempotency-Key) y serializada por la fila de la DeliveryRequest; cancelación V1.5 transaccional que ya cancela Quotes OFFERED; DeliveryProvider sin relación con zonas ni tipos de servicio; auditoría en logs JSON; throttler por IP. Las E2E V1.6 insertan Quotes ACCEPTED directamente, por lo que el invariante ACCEPTED ⇒ Dispatch se garantiza con la transacción de aceptación, el único y el backfill, no con un trigger diferido.
- **Línea base:** 69 unitarias; E2E 122/124 con 1 caída nativa conocida (sin fallos reales).
- **Prisma:** enums ProviderServiceCoverageStatus, DispatchStatus, DispatchCandidateStatus; modelos ProviderServiceCoverage, Dispatch, DispatchCandidate. Migración `20260917000800_dispatch_engine` aplicada sin reset en mandaria_db (backfill: 4 Quotes ACCEPTED → 4 Dispatch EXPIRED, 0 huérfanas) y mandaria_test; drift vacío.
- **API:** `GET /provider/dispatches`, `GET /provider/dispatches/:id`, `POST /provider/dispatches/:id/claim`, `POST /provider/dispatches/:id/release`, `GET /provider/service-coverages`, `GET /admin/dispatches[/:id]`, `POST|GET /admin/providers/:providerId/service-coverages`, `PATCH …/service-coverages/:id`. Aceptación y cancelación reutilizan sus endpoints V1.5/V1.6.
- **Hallazgos durante la implementación:** el claim ignoraba en silencio un `providerId` en el body (seguro, pero ambiguo) → DTO vacío para rechazar cualquier campo con 400; la prueba de concurrencia superaba el límite real de 60 claims/min → bloque con app propia; la operación de listado de coberturas incumplía la convención documental (>60 caracteres) detectada por la E2E V1.2 → descripción completada.
- **Verificaciones:** prisma validate, tsc, build, Oxlint, ESLint, Prettier (archivos nuevos), docs:openapi/docs:check; 81 unitarias (+12); E2E por archivo 137/137 (+13 dispatch); mutaciones M1–M8 detectadas (claim sin bloqueo, elegibilidad sin estado de proveedor, reclamo tras liberar, expiración ignorada, aceptación sin Dispatch, cancelación sin cerrar Dispatch, detalle sin aislamiento, liberación por no dueño); verify-migrations limpia + V1.0 → V1.7 (`mandaria_clean_841e75113d_test`/`mandaria_upgrade_841e75113d_test`); 7 corridas completas de E2E con 1–2 caídas nativas cada una y 0 pruebas fallidas.
- **Otros cambios:** `.env.example` con DISPATCH_TTL_MINUTES; verificador de migraciones con backfill y objetos V1.7; `mandaria-frontend/docs/API-CONTRACT.md` con la extensión V1.7 (sólo documentación, sin commit). `.env` del propietario no modificado.
- **No verificado:** servidor HTTP real con `dist/main.js` para V1.7 (validado con E2E HTTP en proceso y login real); Docker.
- **Pendientes:** V1.8 (notificaciones/web), asignación de Driver/Vehicle, capacidad real en elegibilidad; caída nativa E2E en Windows.

### 2026-09-16 — CHECK V1.7-A (seguridad, concurrencia y dominio de Dispatch)

- **Solicitud:** intentar romper Quote ACCEPTED → Dispatch → Candidate → Claim → Release con concurrencia y manipulación de IDs; corregir sólo bugs reales. Sin commit/push.
- **Línea base:** prisma validate, tsc, build, Oxlint, ESLint, docs:check PASS; 81 unitarias; E2E 137/137 por archivo.
- **Validación real:** validador temporal (fuera del repo) contra `dist/main.js` en 4 arranques (TTL 10 y TTL 1) con logins reales, fixtures locales propios y limpieza total: 24/24 PASS. Concurrencia: 20 aceptaciones simultáneas → 1 Dispatch y 1 DISPATCH_OPENED; A+B simultáneos (3 rondas) → 1 éxito/1 409; 40 claims (20 A + 20 B) → 1 transición, 1 evento; 20 claims del mismo proveedor → 1 evento; 8 liberaciones simultáneas → 1; carrera claim vs release (3 rondas, desenlaces B/B/OPEN) siempre en estado válido; cancelación CLAIMED concurrente con claim y release → CANCELLED coherente.
- **Seguridad:** C (otra zona) y D (SUSPENDED) sin acceso a lista/detalle/claim/release con IDs conocidos, aleatorios o malformados; Admin A → Provider B por query 403 y por body 400; campos de estado en body 400; DRIVER/SUPER_ADMIN 403 e IntegrationClient 401 en claim, release y listas; respuestas y logs sin JWT, clientSecret, passwordHash, tokenHash ni contactos.
- **Base de datos:** 0 violaciones en mandaria_db y mandaria_test (un Dispatch por Quote, un candidato por Dispatch+Provider, máximo un CLAIMED, owner con candidatura CLAIMED, ACCEPTED sin Dispatch, Dispatch de Quote no ACCEPTED, solicitud cancelada con Dispatch operativo); verify-migrations V1.6.1 → V1.7 PASS; migrate status al día.
- **Calidad final:** sin cambios de código durante el CHECK; E2E completa 137/137 sin caídas en una corrida.
- **Bugs:** ninguno en el producto. Error en el validador (emails de fixtures con mayúsculas frente a login normalizado) corregido en el propio validador.
- **Riesgos:** caída nativa intermitente de workers E2E en Windows; expiración perezosa sin cron (OPEN vencido se persiste al interactuar); sin notificaciones hasta V1.8.

### 2026-09-17 — V1.8-A Provider Driver & Vehicle Assignment

- **Solicitud:** tras el claim, decidir qué Driver y qué Vehicle del proveedor ejecutan el servicio, con historial sin sobrescritura, reasignación con motivo, liberación de recursos, protección del servicio en curso, plazo de asignación, recursos asignables, contexto de pago (adelanto de mercancía) sin wallet, auditoría, migración sin reset, Swagger/contrato/README y pruebas (unitarias, E2E, concurrencia) con regresión V1.0–V1.7. Sin Driver App, aceptación del repartidor, Drivers independientes, GPS, tracking, sockets, push, créditos ni estados de ejecución. Sin commit/push.
- **Inspección previa:** rama `v1.8-provider_driver_vehicle_assignment` (merge de V1.7, PR #12). Reutilizados Driver/Vehicle y el emparejamiento V1.4 (DriverVehicleAssignment con índices parciales), Dispatch/DispatchCandidate y las vistas por access V1.7, DeliveryFinancialContext V1.5 (PREPAID/COURIER_ADVANCE) y la Quote V1.6 para el precio logístico; nada de esto se modificó en su contrato.
- **Prisma:** enums DeliveryAssignmentStatus y DeliveryAssignmentEndReason; modelo DeliveryAssignment con FKs compuestas a Driver y Vehicle. Migración `20260917000900_delivery_assignments` aplicada sin reset en mandaria_db y mandaria_test (0 filas creadas para datos existentes); drift vacío.
- **API:** `POST /provider/dispatches/:id/assignment`, `…/assignment/reassign`, `…/assignment/cancel`, `GET …/assignments`, `GET …/available-drivers`, `GET …/available-vehicles` y `GET /admin/dispatches/:id/assignments`. El detalle del Dispatch del dueño añade `assignment`, `assignmentDeadline` y `assignmentOverdue`; la vista de administración añade `activeAssignment`. Liberar (`/release`) con asignación ACTIVE devuelve 409.
- **Hallazgos durante la implementación:** las E2E dejaban recursos ocupados entre pruebas y entre bloques (Carlos/MOTO-03 seguían ACTIVE), lo que hacía que el caso de emparejamiento devolviera DRIVER_BUSY en vez de DRIVER_VEHICLE_MISMATCH → fixture con un segundo emparejamiento (Ana ↔ MOTO-09), casos de mismatch sobre recursos libres y liberación explícita al final del bloque; el caso de plazo vencido cancelaba con el reloj real tras adelantar el tiempo y violaba el CHECK `endedAt >= assignedAt` (500) → se cancela bajo el mismo reloj adelantado. Prettier no se aplicó al README (aquí sólo formatea TS) tras comprobar que reformateaba todo el archivo.
- **Verificaciones:** prisma validate y migrate status al día; tsc, build, Oxlint, ESLint y docs:check PASS; docs:openapi regenerado (1.8.0, 7 rutas y 12 esquemas nuevos, ninguno eliminado); 91 unitarias (+10); E2E por archivo 148/148 (+13 asignación); mutaciones M1–M10 todas detectadas (segunda ACTIVE por Dispatch, recurso ocupado, emparejamiento V1.4 ignorado, reasignación que destruye historial, release sin protección, cancelación que deja la asignación ACTIVE, plazo sin TTL, recursos de otro proveedor, cambio de emparejamiento durante la entrega, adelanto COURIER_ADVANCE no informado); verify-migrations limpia + V1.0 → V1.8 con datos preservados (`mandaria_clean_bb1e9709f6_test`/`mandaria_upgrade_bb1e9709f6_test`); arranque real de `dist/main.js` en el puerto 3010 con health 200, OpenAPI 1.8.0 y las 7 rutas mapeadas, luego detenido.
- **Otros cambios:** verificador de migraciones extendido con los objetos V1.8; README con la sección Provider Driver & Vehicle Assignment, variable de entorno, riesgos y alcance V1.9+; `mandaria-frontend/docs/API-CONTRACT.md` con la extensión V1.8 (sólo documentación). `.env` del propietario no modificado.
- **No verificado:** validación funcional completa por HTTP contra `dist/main.js` en ejecución (cubierta por E2E HTTP en proceso con logins reales) y Docker.
- **Pendientes:** V1.9 (Driver App, aceptación del repartidor, Drivers independientes) y estados de ejecución de la entrega; caída nativa intermitente de workers E2E en Windows.

### 2026-09-17 — CHECK V1.8-A (concurrencia, aislamiento e integridad de asignaciones)

- **Solicitud:** intentar romper las invariantes «1 ACTIVE por Dispatch / Driver / Vehicle» con concurrencia, manipulación de IDs y roles; validar aislamiento por proveedor, contexto de pago, plazo, historial, auditoría, invariantes de base de datos, migración V1.7 → V1.8 y regresión V1.0–V1.7. Corregir sólo bugs reales. Sin commit/push.
- **Línea base:** prisma validate, migrate status, tsc, build, Oxlint, ESLint y docs:check PASS; 91 unitarias; E2E por archivo 148/148.
- **Validación real:** validador temporal fuera del repositorio contra `dist/main.js` (puerto 3011, base `mandaria_test`, routing local_fake) con fixtures propios (proveedores A/B, 7 Drivers, 6 Vehicles, zona, tarifa, cliente B2B), logins reales y limpieza total: **30/30 PASS**. Reinicios controlados del servidor para no agotar el límite de 100 peticiones/minuto por IP: 0 respuestas 429 y 0 respuestas 5xx en 2372 líneas de log.
- **Concurrencia:** 12 asignaciones simultáneas al mismo Dispatch → 1 × 201 y 11 × 409; Carlos y MOTO-07 en dos Dispatches a la vez → 1 éxito y 409 DRIVER_BUSY/VEHICLE_BUSY; 16 peticiones sobre 4 Dispatches → 4 × 201 y 1 ACTIVE por Dispatch; reasignación contra ocupación concurrente sin doble booking; dos reasignaciones simultáneas se serializan (200 + 200) dejando exactamente 1 ACTIVE y el historial encadenado.
- **Aislamiento:** Driver o Vehicle de otro proveedor con ID válido → 404 (crear y reasignar); admin del proveedor B sobre asignación de A → 409 y con `?providerId=A` → 403; DRIVER 403; SUPER_ADMIN 403 en las tres operaciones y sólo lectura de auditoría; IntegrationClient 401.
- **Integridad:** invariantes forzadas por SQL todas rechazadas (únicos parciales, DELIVERY_ASSIGNMENT_INVALID/IMMUTABLE, DISPATCH_HAS_ACTIVE_ASSIGNMENT); escaneo de 13 consultas en `mandaria_db` y `mandaria_test` con 0 violaciones y objetos presentes; verify-migrations V1.0 → V1.8 con datos preservados.
- **Contexto de pago:** COURIER_ADVANCE informa `deliveryFee` 60.00, `goodsValue` 800.00 y `driverAdvanceAmount` 800.00 sin wallet; PREPAID nunca se presenta como adelanto del repartidor.
- **Plazo:** `assignmentDeadline` = claimedAt + 5 min, independiente de `expiresAt` (+60 min); vencido sólo enciende `assignmentOverdue` (sin auto-release ni corrupción: Dispatch y candidatura siguen CLAIMED y asignar sigue permitido).
- **Bugs:** ninguno en el producto; sin cambios de código. Dos expectativas equivocadas del validador se corrigieron en el validador (reasignaciones simultáneas serializadas; forma V1.7 del bloque `goods` con decimales en cadena frente a los objetos `{amount, currency}` de `paymentContext`) y ambos comportamientos se documentaron en README y en `mandaria-frontend/docs/API-CONTRACT.md`.
- **Riesgos restantes:** `assignmentOverdue` sin cron ni notificación; un Driver/Vehicle sólo ejecuta una entrega a la vez; suspender un Driver o dejar un vehículo no ACTIVE no cierra la asignación vigente; límite de 100 peticiones/minuto por IP compartido entre clientes detrás de la misma IP; caída nativa intermitente de workers E2E en Windows; Docker y SMTP real sin verificar.

### 2026-09-18 — V1.9-A Independent Drivers (1.9.0)

- **Solicitud:** agregar sobre el backend existente un segundo modelo de ejecución: repartidores independientes que toman un Dispatch por su cuenta, conviviendo con el modelo de flotilla. Sin crear otro backend, sin tocar Coita Eats y sin Driver App, GPS, realtime, wallet ni créditos. Inspeccionar primero el estado real de V1.8 y adaptar la especificación a sus modelos, contratos, guards, transacciones y convenciones. No commit, no push.
- **Inspección previa:** rama `v1.9-independent_drivers` sobre 1.8.0. Se leyeron esquema Prisma, migraciones V1.7/V1.8 (triggers, CHECKs, índices únicos parciales), `dispatch`, `delivery-assignments`, `drivers`, `vehicles`, `providers`, guards, DTOs, respuestas OpenAPI, README, BITACORA, VERIFICATION y pruebas. Línea base ejecutada **antes** de modificar: 91 unitarias PASS y E2E 135/136, con el fallo de `delivery-quotes` ya presente.
- **Decisión de diseño 1 — el independiente no es un proveedor:** se creó `IndependentDriverProfile` (1:1 con `Driver`, estados PENDING/APPROVED/SUSPENDED/REJECTED) en lugar de sintetizar un `DeliveryProvider` de una persona. No duplica nombre, estado, disponibilidad ni proveedor: eso sigue viviendo en `Driver`. `ProviderType.INDEPENDENT` de V1.2 es otra cosa y no se tocó.
- **Decisión de diseño 2 — los dos contextos de una misma persona:** como `Driver.providerId` es obligatorio y V1.9 no crea cuentas (el alta sigue siendo V1.6.1), un independiente conserva su `Driver` de proveedor. El contexto lo decide **la ruta**, nunca el payload: `/provider/dispatches/:id/assignment` usa recursos del proveedor y `/driver/dispatches/:id/take` sólo los vehículos propios. La separación se fuerza en la base: un `Vehicle` pertenece a un proveedor **XOR** a un perfil independiente (`Vehicle_owner_check`) y el trigger comprueba la pertenencia por modo. Queda anotado como riesgo que un independiente **puro** (sin proveedor) exigirá una invitación sin `providerId`.
- **Decisión de diseño 3 — dueño del claim:** `Dispatch` no sobrecarga `claimedByProviderId` con un id de Driver; se agregó `claimedByIndependentDriverId` con su propia FK y `Dispatch_values_check` exige exactamente un dueño mientras está CLAIMED. En `DeliveryAssignment` se agregó `mode` (FLEET/INDEPENDENT) con `DeliveryAssignment_mode_check`, para no exigir un `providerId` falso al ejecutor independiente.
- **Decisión de diseño 4 — política por ServiceType:** `SERVICE_EXECUTION_MODES` declara FLEET/INDEPENDENT/BOTH por tipo y es exhaustivo por construcción (un `ServiceType` nuevo no compila hasta decidirlo). `LOCAL_DELIVERY` = BOTH; nada queda disponible a independientes por omisión.
- **Cambio sobre una garantía de V1.8 (documentado):** las FKs compuestas `DeliveryAssignment_(driverId|vehicleId)_providerId_fkey` se retiraron, porque con `providerId` nulo PostgreSQL las omite en silencio (MATCH SIMPLE) y dejarían de garantizar nada. Se sustituyeron por FKs simples, la comprobación de pertenencia por modo dentro de `delivery_assignment_guard` y la **inmutabilidad del dueño** de Drivers y Vehicles (`resource_owner_guard`). El conjunto resultante es más estricto: la pertenencia se prueba en cada escritura y, además, un Driver ya no puede cambiar de proveedor ni un Vehicle de dueño.
- **Cambios de código:** módulo nuevo `src/independent-drivers/` (política, dos servicios, DTOs, respuestas, selects y dos controllers); `assignment-policy.ts` con el plazo de asignación limitado a flotilla; `dispatch.select.ts` expone `claimedByIndependentDriverId`, `claimMode`, el `mode` de la asignación y `openToIndependentDrivers` sin alterar el significado de `noProviderAvailable`; `driver.select.ts` y `drivers.service.ts` añaden `independent` y `activeDeliveryAssignment` a `/driver/me`; `environment.ts` con `INDEPENDENT_DRIVER_MAX_VEHICLES`; `setup.ts` y `package.json`/`package-lock.json` a 1.9.0.
- **Migración:** `20260918001000_independent_drivers`, incremental y sin reset. No reescribe filas: toda asignación previa queda `mode='FLEET'` por el DEFAULT y todo vehículo conserva su proveedor. Agrega la tabla del perfil con sus CHECKs, la pertenencia excluyente del vehículo con índice único parcial por identificador, el XOR del dueño del claim, el modo de la asignación y los triggers `Driver_owner_guard`, `Vehicle_owner_guard` e `IndependentDriverProfile_guard`; amplía `delivery_assignment_guard` y `dispatch_guard` a los dos modelos.
- **Política ante servicios en curso:** suspender o rechazar a un repartidor con asignación ACTIVE responde 409 `INDEPENDENT_DRIVER_HAS_ACTIVE_ASSIGNMENT`, y desactivar su vehículo 409 `VEHICLE_HAS_ACTIVE_ASSIGNMENT`. Se prefirió rechazar la operación administrativa antes que cancelar en silencio una entrega en curso; la regla está también en PostgreSQL.
- **Verificaciones ejecutadas (2026-09-18):** prisma validate, migrate status (10 migraciones), drift `migrate diff` vacío, migración aplicada en `mandaria_db` y `mandaria_test` sin reset, `verify-migrations.mjs` V1.0 → V1.9 PASS, tsc, build, Oxlint, ESLint, `docs:openapi` (+13 rutas y +17 esquemas, **0 eliminados**) y `docs:check`; 110 unitarias PASS; 162 E2E PASS por archivo, incluidas las 23 nuevas (carrera flotilla vs independiente repetida 3 veces, varios independientes, mismo Driver y mismo Vehicle en paralelo, ocupado en un modelo frente al otro, privacidad del listado sin 10 campos sensibles, invariantes en SQL y auditoría sin secretos). Detalle en VERIFICATION.md.
- **Otros cambios:** `verify-migrations.mjs` ampliado con los objetos V1.9 y con tolerancia a columnas **añadidas** en la comparación de instantáneas (sigue exigiendo que todo valor preexistente sea idéntico); se ajustaron dos pruebas existentes al comportamiento nuevo (`driver-self.e2e-spec.ts` por los campos nuevos de `/driver/me` y `logistics.spec.ts` por la consulta que `self()` añadió). `.env.example` con `INDEPENDENT_DRIVER_MAX_VEHICLES`; `.env` del propietario **no modificado**.
- **Resultado:** V1.9-A implementada y verificada localmente. Sin commit ni push, según la instrucción.
- **Bugs de producto:** ninguno encontrado ni introducido. El único fallo de la suite (`delivery-quotes`, 20 cotizaciones concurrentes) es **preexistente**: falla igual en la línea base antes de cualquier cambio y su causa real es el timeout del pool de conexiones de Prisma a los 10 063 ms, en el camino de cotización V1.6 que V1.9 no toca.
- **Pendientes:** validación adversarial (CHECK) equivalente a la de V1.7/V1.8 contra `dist/main.js` en ejecución; cobertura de zona de servicio por repartidor independiente (hoy un APPROVED ve todos los Dispatches OPEN de un ServiceType admitido); onboarding público con `PENDING` y verificación documental; alta de un independiente sin proveedor; `docs/API-CONTRACT.md` de `mandaria-frontend` con la extensión V1.9 (otro repositorio, no modificado); seeds y script `verify:` locales para el escenario independiente.

### 2026-09-18 — CHECK V1.9-A Independent Driver Security, Concurrency & Integrity

- **Solicitud:** validar adversarialmente el backend real de V1.9-A, intentando romper Provider vs Independent Driver y demostrar que un Dispatch sólo puede tener un ejecutor válido. Sin implementar funciones nuevas ni iniciar V1.10; corregir sólo bugs reales. No commit, no push.
- **Método:** validador temporal **fuera del repositorio** contra `dist/main.js` en ejecución (puerto 3019, base `mandaria_test`, `ROUTING_PROVIDER=local_fake`), con fixtures propios, logins reales, captura de los logs del servidor para la auditoría y limpieza total. Reinicios del servidor para no consumir el límite por IP. 34 comprobaciones más un escaneo de invariantes en ambas bases.
- **Resultado:** **34/34** por HTTP real; 0 respuestas 5xx y 0 respuestas 429; 17 consultas de invariantes en 0 violaciones en `mandaria_db` y `mandaria_test`; flujo V1.8 completo intacto; `verify-migrations` V1.0 → V1.9 PASS; regresión E2E 162.
- **Bugs reales encontrados y corregidos (3, una sola causa raíz):** `take` bloqueaba la fila de `Driver` mientras la suspensión bloquea la de `IndependentDriverProfile`, así que nunca se serializaban. Racing `take` contra `suspend` (24 rondas con desfase aleatorio) produjo: (1) perfil `SUSPENDED` con asignación ACTIVE — el estado que §46 promete no producir —; (2) **HTTP 500** cuando el trigger `delivery_assignment_guard` rechazaba el INSERT; (3) un **409 que mentía**, devuelto por un `take` que sí se había confirmado, porque la respuesta se construía con `get()` y volvía a pasar por la puerta de aprobación.
- **Corrección:** `lockEligibleResources` bloquea también la fila del perfil (`FOR UPDATE OF d, p`; orden Dispatch → perfil+Driver → Vehicle, sin ciclo posible); `take` y `release` responden con `viewFor(driverId, …)` sin repetir la puerta de aprobación sobre trabajo ya confirmado; `isGuardRejection` traduce cualquier `RAISE EXCEPTION` de los triggers a 409 `TAKE_CONFLICT` en vez de 5xx. Sin cambios de modelo de datos ni de migración.
- **Comprobación de la corrección:** 80 rondas de `suspend` vs `take` y 40 de desactivación de vehículo vs `take`: 0 estados inconsistentes y 0 respuestas 500, sólo las dos serializaciones correctas. CHECK completo repetido sobre el binario corregido: 34/34.
- **Regresión anclada:** 3 pruebas unitarias nuevas (113 en total) fijan el bloqueo del perfil, la traducción del rechazo del trigger y `isGuardRejection`. La primera se validó por mutación: quitando `, p` del `FOR UPDATE` falla; restaurándolo pasa.
- **Errores del validador, no del producto:** mover la ventana de un Dispatch (rechazado por `DISPATCH_IMMUTABLE`), cerrar una asignación con `now()` en SQL crudo (rechazado por el CHECK `endedAt >= assignedAt`, porque la sesión da hora local y la aplicación guarda UTC) y una aserción que contaba proveedores por prefijo en vez de por ejecución. Los tres se corrigieron en el validador.
- **Pendientes:** los ya anotados en la entrada de V1.9-A (cobertura de zona por repartidor independiente, onboarding público, independiente sin proveedor, `docs/API-CONTRACT.md` de `mandaria-frontend`, seeds y script `verify:` locales del escenario independiente).

### 2026-09-21 — CHECK FINAL V1.9 (backend + Mandaria Web): contrato OpenAPI de `/driver/me`

- **Solicitud:** CHECK FINAL V1.9 de extremo a extremo sobre backend y Mandaria Web reales. Corregir sólo bugs reales; si OpenAPI sigue ambiguo en `activeDeliveryAssignment`, corregir el contrato sin cambiar comportamiento. No commit, no push.
- **Cambio (sólo documentación de contrato):** `DriverSelfResponse.activeDeliveryAssignment` estaba declarado como `object` sin propiedades. Se agregó `DriverSelfActiveDeliveryAssignmentResponse` con exactamente los tres campos que selecciona `drivers.service.ts` (`id`, `mode` FLEET/INDEPENDENT, `dispatchId`), sin inventar `assignedAt`. Sin cambios de runtime, modelo ni migración. `docs/openapi.json` regenerado compilando a un directorio temporal (no se tocó el `dist/` del servidor en ejecución); `docs:check` PASS; el diff es sólo el esquema nuevo.
- **Verificación:** `tsc`, Oxlint y ESLint limpios; 113 unitarias PASS; E2E en serie 172/173 (el único fallo es el preexistente de `delivery-quotes`, siempre timeout de 5 s); en paralelo aparecen además dos aserciones de `delivery-assignments` y un timeout de `providers` que pasan aislados y en serie (interferencia entre archivos sobre `mandaria_test` y caída nativa de workers). `verify-migrations` V1.0 → V1.9 PASS; `prisma migrate diff` sin deriva.
- **Pendiente anotado:** `MyIndependentProfileResponse` declara `activeAssignment` como objeto libre, pero ningún controlador la usa (no aparece en OpenAPI); no se tocó.

### 2026-09-21 — V1.10-A Credit Accounts & Immutable Ledger (1.10.0)

- **Solicitud:** crear la base contable de los créditos Mandaria — cuentas por proveedor y por repartidor independiente, un ledger inmutable, recargas y ajustes manuales de SUPER_ADMIN con idempotencia — **sin** consumir créditos todavía en CLAIM ni TAKE. Sin CreditPolicy (V1.10-B), cálculo por distancia, cambios de precios, pagos online ni Coita Eats. No commit, no push.
- **Hallazgo previo:** el encargo daba por completada una «V1.9-C Service Coverage». No existe en el repositorio (ninguna rama local o remota, ni historial, ni documentación). La rama `v1.10-credit-monetization` parte de V1.9 (PR #14) más el commit `5aa3c16` de documentación. V1.10-A no depende de ella; se construyó sobre V1.9.
- **Inspección previa:** esquema, triggers de V1.8/V1.9, `IdempotencyService` (ligado a IntegrationClient), guard de membership, paginación, convenciones de OpenAPI y CORS. Línea base: 113 unitarias y 162 E2E, con el fallo preexistente de `delivery-quotes`.
- **Decisiones de diseño:**
  - **Créditos ≠ dinero.** Enteros, sin moneda ni decimales en ningún campo. Límites: 1 000 000 por movimiento y 1 000 000 000 de saldo, elegidos para que `balanceBefore + amount` nunca desborde un INTEGER.
  - **Dueños.** Una cuenta por proveedor (la usan todos sus Drivers de flotilla) y una por perfil independiente. La crean triggers de PostgreSQL al insertar el proveedor y la primera vez que el perfil llega a APPROVED, con `ON CONFLICT DO NOTHING`: funciona para cualquier vía de alta (API, seed, SQL) y es idempotente. Nace con saldo 0 (trigger).
  - **Sin estado de cuenta.** No se añadió ACTIVE/SUSPENDED: el dueño ya tiene estado operativo y en V1.10-A no hay débitos automáticos que bloquear. Suspender al dueño no borra ni congela el saldo ni el historial.
  - **El saldo sólo se mueve por el ledger.** Insertar una entrada actualiza el saldo en la misma sentencia (trigger `CreditLedgerEntry_apply`), sólo si la cuenta aún tiene `balanceBefore`; un UPDATE directo del saldo se rechaza (`pg_trigger_depth`). El servicio bloquea la cuenta FOR UPDATE antes de calcular.
  - **Ledger inmutable.** UPDATE, DELETE y TRUNCATE rechazados por triggers. Única excepción documentada: `SET LOCAL mandaria.ledger_purge = 'test-fixtures'` permite **borrar** (nunca editar) para limpiar bases de prueba; la aplicación no la usa.
  - **Sin `metadata` libre.** Columnas tipadas (`rechargeMethod`, `externalReference`, `reason`, `referenceType`/`referenceId`).
  - **Idempotencia en el propio ledger.** Índice único (cuenta, Idempotency-Key) más huella SHA-256 del cuerpo; mismo contrato que B2B (201/200 con `Idempotent-Replayed`, 409 con cuerpo distinto). No se reutilizó `ApiIdempotencyRecord` porque exige un IntegrationClient.
  - **Lectura del independiente sin exigir APPROVED.** Un repartidor SUSPENDED o REJECTED puede consultar su saldo e historial (se conservan); el encargo pedía APPROVED y se documentó la desviación.
  - **Datos existentes.** Cuenta con saldo 0 para cada proveedor y cada perfil aprobado alguna vez; ningún movimiento inventado.
- **Cambios de código:** módulo nuevo `src/credits/` (política, servicio, selects con vistas de admin y de dueño, DTOs, respuestas tipadas, helper HTTP de idempotencia y cuatro controllers); `app.module.ts`; `setup.ts` (versión OpenAPI 1.10.0 y `exposedHeaders: ['Idempotent-Replayed']` en CORS); `package.json`/`package-lock.json` a 1.10.0. CLAIM, TAKE, asignaciones, coberturas y precios **no se tocaron**.
- **Migración:** `20260921001100_credit_accounts_ledger`, incremental desde V1.9 y sin reset; sólo añade tablas, enums, CHECKs, índices y triggers, y el backfill de cuentas vacías.
- **Verificaciones ejecutadas (2026-09-21):** prisma validate, migrate status, drift vacío, migración en `mandaria_db` y `mandaria_test` sin reset, `verify-migrations.mjs` en tres bases (limpia, V1.0 → V1.10 con datos y **V1.9 con datos reales → V1.10**), tsc, build, Oxlint, ESLint, Prettier, `docs:openapi` (+12 rutas, +8 esquemas, 0 eliminados, 0 campos ambiguos nuevos) y `docs:check`; 130 unitarias; 186 E2E por archivo; tormenta de concurrencia contra `dist/main.js` 7/7 (30 débitos de 7 sobre 70 → exactamente 10 aplicados y saldo 0); escaneo de 11 invariantes del ledger en ambas bases en 0. Detalle en VERIFICATION.md.
- **CLAIM/TAKE:** verificado explícitamente que un proveedor y un independiente con saldo 0 siguen reclamando y tomando servicios, sin escribir en el ledger.
- **Otros cambios:** `verify-migrations.mjs` ampliado con la base intermedia V1.9 y los objetos de V1.10. `.env.example` sin cambios (los límites son constantes, no variables). `.env` del propietario no modificado.
- **Defectos encontrados y corregidos:** nulos de las respuestas nuevas publicados como `type: object` (tipo explícito); 400 sin documentar en `GET /driver/credits` (lo detectó la regresión de V1.4); cabecera `Idempotent-Replayed` no expuesta por CORS.
- **Resultado:** V1.10-A implementada y verificada localmente. Sin commit ni push.
- **Pendientes:** 130 campos anulables de V1.1–V1.9 publicados como `type: object` en OpenAPI (propuesto como tarea aparte); `docs/API-CONTRACT.md` de `mandaria-frontend` con la extensión V1.10-A (otro repositorio); aclarar con el propietario qué era «V1.9-C Service Coverage»; V1.10-B en adelante (política de costo, débito al adjudicar, devoluciones) no iniciado.

### 2026-09-21 — Corrección de cotizaciones concurrentes (V1.6)

- **Solicitud:** resolver el fallo de `delivery-quotes` que se venía documentando como preexistente y ajeno.
- **Diagnóstico:** no era de entorno. Dentro de la transacción interactiva de `quote()`, que bloquea la DeliveryRequest `FOR UPDATE`, `resolveActive` (×2) y `findActive` consultaban con el cliente global de Prisma. Cada consulta pedía una segunda conexión del pool mientras la transacción retenía la suya: con tantas cotizaciones simultáneas como conexiones, interbloqueo hasta el timeout de 10 s (`P2024`, `500`). Reproducido aislado: 0/20 a los 10 015 ms con el cliente global frente a 20/20 en 634 ms con `tx`.
- **Corrección:** ambos métodos aceptan el cliente de la transacción (por defecto el global) y `quote()` pasa `tx`. Sin cambios de esquema ni de contrato. Revisadas todas las transacciones interactivas: no hay otros casos.
- **Verificaciones:** `delivery-quotes` 11/11 ×3; prueba unitaria nueva validada por mutación; tsc, Oxlint, ESLint, Prettier y docs:check PASS; 131 unitarias; **197 E2E, 15/15 archivos, 0 fallos**.
- **Corrección de registros anteriores:** las entradas y verificaciones de V1.9, CHECK V1.9 y V1.10-A describían este fallo como «agotamiento del pool de entorno, ajeno». El diagnóstico era incompleto: el agotamiento lo provocaba el propio código de cotización. Se conservan esas entradas como historial.
- **Nota:** una tarea en segundo plano trabaja en `.claude/worktrees/` dentro del repositorio y Vitest detecta sus specs; las corridas locales deben usar `--exclude '.claude/**'` mientras exista.
- **Resultado:** corregido y verificado. Sin commit ni push.
