# CHECK V1.6.1-A — Validación backend (2026-09-16)

| Verificación | Resultado |
|---|---|
| Migración limpia + V1.0 → … → V1.6 → V1.6.1 con usuarios, proveedores, memberships, drivers, vehículos, integraciones, solicitudes, zonas, tarifas y quotes | PASS |
| HTTP real contra `dist/main.js` (logins reales, outbox local, 3 fases) | 24/24 PASS |
| Bootstrap (seed y Docker): email INVITED y contraseña de 15 rechazados; creación e idempotencia | PASS |
| Seeds locales y verify:user-invitations con NODE_ENV=production o base remota | Rechazados |
| Arranque en producción con local_outbox, sin correo o MANDARIA_WEB_URL http | Rechazado |
| prisma validate, tsc, build, Oxlint, ESLint, docs:check; unitarias | PASS; 69 |
| E2E completa | 124/124 en 3 corridas consecutivas |

No verificado: entrega SMTP real.

# Verificación V1.6.1-A — User Provisioning, Invitations & Account Activation (2026-09-16)

Rama `v1.6.1-creation_users`, paquete 1.6.1, Node.js 24.15.0, PostgreSQL 18 local. Docker y SMTP real no ejecutados.

| Verificación | Resultado |
|---|---|
| Línea base antes de modificar | E2E 100/100; unitarias 51/52 (fallo de aislamiento de la prueba Google NOT_CONFIGURED con la key real del .env; corregido, sin llamadas a Google) |
| Prisma validate / drift (migraciones vs schema) | PASS / migración vacía |
| Migración `20260916000700_user_invitations` en mandaria_db y mandaria_test (sin reset) | PASS |
| Limpia + V1.0 → … → V1.6 → V1.6.1 con fixtures (incluida cuenta inactiva) | PASS; usuarios y hashes idénticos, inactiva = DISABLED, 0 invitaciones; CHECK, índices, trigger y passwordHash nullable presentes |
| TypeScript / Build / Oxlint / ESLint / docs:openapi / docs:check | PASS |
| npm test | 69 PASS (52 + 17 V1.6.1: token/hash, expiración, errores, roles, contraseña, guardas de servicio, plantilla, SMTP simulado, outbox, configuración) |
| npm run test:e2e | 124/124 PASS en suite completa y en cada archivo (24 V1.6.1). Una corrida completa previa: 113/124 por la caída nativa conocida de workers en Windows |
| Flujo PROVIDER_ADMIN: invitación → User INVITED sin contraseña → token sólo como SHA-256 → activación Argon2id → membership OWNER → login, /auth/me, /provider/profile A, B 403, refresh, logout | PASS |
| Flujo DRIVER: PROVIDER_ADMIN A invita → activación → Driver PENDING/OFFLINE en Provider A → login → /driver/me | PASS |
| Payload de proveedor con role/providerId/membershipRole | 400; providerId ajeno en query 403 |
| Aislamiento: Admin A → A ✅ / B ❌; Admin B → B ✅ / A ❌; leer/reenviar/revocar invitación ajena | PASS (403 / 404) |
| DRIVER y PROVIDER_ADMIN en rutas SUPER_ADMIN; PROVIDER_ADMIN sin membership | 403 |
| IntegrationClient en invitar, listar, detalle, resend, revoke, rutas de proveedor y /users | 401 |
| Token expirado (now ≥ expiresAt) | 410 INVITATION_EXPIRED, sin activar; listado EXPIRED |
| Reenvío: token nuevo, anterior 400 INVITATION_TOKEN_INVALID, vigencia reiniciada, mismo User; reenvío inmediato 429 | PASS |
| Token reutilizado | 409 INVITATION_ALREADY_ACCEPTED |
| Token revocado; revocar dos veces; reenviar revocada; reinvitar mismo email | 410; 200 idempotente; 409; 201 con el mismo User |
| Email pendiente (también en mayúsculas), ACTIVE, SUPER_ADMIN, DISABLED | 409 USER_INVITATION_PENDING / USER_ALREADY_ACTIVE / USER_DISABLED, sin Users nuevos ni reactivación |
| Roles y campos inválidos (SUPER_ADMIN, CUSTOMER, sin membershipRole/driverName, campos cruzados) | 400 |
| Login de cuenta INVITED | 401 idéntico a contraseña incorrecta |
| Contraseñas 15 y 129 caracteres; campos extra | 400 sin efectos; 16 caracteres aceptada |
| Fallo del proveedor de correo | 201 emailDelivery FAILED; resend SENT |
| Reserva de maxDrivers con invitaciones DRIVER pendientes; PROVIDER_ADMIN no consume lugar | PASS |
| 20 invitaciones simultáneas mismo email (ruta SUPER_ADMIN y ruta PROVIDER_ADMIN) | 1 201 + 19 409; 1 User; 1 PENDING; 1 correo |
| 10 reenvíos simultáneos | 1 rotación + 9 INVITATION_RESEND_COOLDOWN; hash = token del último correo |
| 10 activaciones simultáneas del mismo token | 1 éxito + 9 409; 1 Driver |
| Rate limits por IP | activación 11.ª 429; creación 21.ª 429; reenvío 11.ª 429 |
| Invariantes SQL | User activo sin contraseña, segunda PENDING, cambiar proveedor, modificar ACCEPTED y rol SUPER_ADMIN rechazados |
| Auditoría | Eventos presentes; sin tokens, hashes, contraseñas, emails ni JWT en logs |
| Mutaciones M1–M8 | 8/8 detectadas |
| `npm run db:seed` en mandaria_db | «SUPER_ADMIN already exists; unchanged»; 0 invitaciones antes y después |
| Bootstrap en base limpia de verificación | crea SUPER_ADMIN Argon2id, segunda ejecución sin cambios, 0 invitaciones (email con espacios alrededor rechazado: comportamiento previo sin cambios) |
| HTTP local `verify:user-invitations` (outbox local) | 3/3 PASS; Provider A local en maxDrivers 3/3 → 409 PROVIDER_DRIVER_LIMIT_REACHED correcto; flujo DRIVER con Admin B en Provider B; cuentas creadas eliminadas; outbox vacío |
| Regresiones HTTP | verify:provider-admins 13/13, verify:drivers-vehicles 16/16, verify:delivery-requests 10/10, verify:delivery-quotes 9/9 (local_fake) |
| Logs de las corridas locales | USER_INVITED 3, ACCEPTED 3, ACTIVATED 3, EMAIL_SENT 3, ACTIVATION_REJECTED 2, request_failed 0; 0 tokens, hashes, JWT, emails ni clientSecret |
| Escaneo de secretos del .env en 39 archivos modificados y en API-CONTRACT.md | 0 coincidencias |

No verificado: entrega por un servidor SMTP real (sin credenciales configuradas; adaptador probado con transporte simulado) y Docker.

# Verificación V1.6-A — Routing, Service Zones, Rate Plans & Delivery Quotes (2026-09-15)

Rama `1.6-routing_services_plan`, paquete 1.6.0, Node.js 24.15.0, PostgreSQL 18 local. Docker no ejecutado.

| Verificación | Resultado |
|---|---|
| Línea base previa (V1.5 en QA) | Prisma/build/tsc/lint/docs PASS; 40 unitarias; E2E 75/85 por caída nativa conocida |
| Prisma validate / generate / drift | PASS / PASS / vacío |
| Migración `20260915000600_routing_pricing_quotes` en mandaria_db y mandaria_test (sin reset) | PASS |
| Limpia + V1.0 → … → V1.5 → V1.6 con fixtures V1.5 | PASS; serviceType = LOCAL_DELIVERY; índices parciales, triggers y secuencia MQ presentes |
| Build / TypeScript / Oxlint / ESLint / docs:check | PASS |
| npm test | 52 PASS (40 + 12 V1.6) |
| npm run test:e2e | 100/100 PASS (suite completa y cada archivo por separado) |
| GeoJSON inválido (tipo, anillo abierto, <4 puntos, rangos, autointersección, área 0) | PASS 400 |
| Punto en polígono (dentro, borde, fuera, hueco, MultiPolygon) | PASS |
| Zonas: solape, contacto, anidada → 409; disjunta → ACTIVE; boundary ACTIVE → 409 | PASS |
| RatePlan: DRAFT editable, ACTIVE/INACTIVE inmutables (API 409 y triggers SQL) | PASS |
| Versionado, clonación, activación atómica (ACTIVE anterior → INACTIVE) | PASS |
| 5 creaciones y 5 activaciones concurrentes | PASS: versiones 1–5 únicas, 1 ACTIVE |
| Huecos, solapes, inicio ≠ 0, monto ≤ 0, moneda distinta, TTL 0/−5/121/10081 | PASS 400/422 |
| Bandas 0/1999/2000/3999/4000/9999 → 35/35/40/40/50/70; 10000 y 11400 → DISTANCE_NOT_SUPPORTED | PASS |
| Quote OFFERED (MQ, snapshot, TTL 15 min, sin IDs internos) | PASS |
| OFFERED vigente reutilizada sin routing; ACCEPTED devuelta | PASS |
| Aceptación idempotente; precio congelado tras nueva versión de tarifa (50.00 vs 80.00) | PASS |
| Expiración con reloj simulado: lectura EXPIRED, accept 409 QUOTE_EXPIRED, nueva Quote con nuevo routing; ACCEPTED no expira | PASS |
| OUT_OF_SERVICE_AREA (pickup/dropoff), CROSS_ZONE_NOT_SUPPORTED, zona INACTIVE, RATE_CONFIGURATION_UNAVAILABLE sin llamar routing | PASS |
| ROUTE_NOT_FOUND, ROUTING_UNAVAILABLE (timeout, 503, respuesta inválida, error inesperado), reintento posterior 201 | PASS |
| RATE_CONFIGURATION_INVALID (hueco inyectado en SQL) | PASS 503 |
| Fallo no crea Quote ni cambia la solicitud (sigue CREATED) | PASS |
| Adaptador Google con HTTP simulado: normalización, field mask, key sólo en header, sin rutas, 429/5xx/timeout/red con 1 reintento, 4xx/respuesta inválida sin reintento, sin key sin llamada | PASS |
| Cancelar solicitud: OFFERED → CANCELLED, accept 409, cotizar 409; ACCEPTED preservada | PASS |
| 20 cotizaciones concurrentes | PASS: 1 × 201 + 19 × 200, 1 llamada de routing, 1 Quote |
| 10 aceptaciones concurrentes | PASS: 10 × 200, 1 ACCEPTED, 1 evento |
| Cotización vs cancelación en carrera | PASS: ninguna OFFERED en solicitud cancelada |
| Índices únicos parciales y trigger de snapshot (inserción/actualización directa) | PASS rechazadas |
| Separación goodsValue/COURIER_ADVANCE vs amount | PASS |
| Aislamiento B2B (cotizar, leer, aceptar, listar ajenas) | PASS 404 |
| Scopes quotes:create/read/accept independientes; deliveries:* sin quotes → 403 | PASS |
| PROVIDER_ADMIN/DRIVER → admin zonas/planes/Quotes 403; humanos en B2B 401; B2B en admin 401; sin accept/edición/borrado admin | PASS |
| Mutaciones M1 (sin bloqueo) / M2 (sin expiración) / M3 (max inclusivo) / M4 (sin aislamiento) | Detectadas (1 / 2 / 2 / 1 pruebas fallan) |
| Validación de entorno: local_fake y google sin key rechazados en producción | PASS |
| HTTP local `verify:delivery-quotes` con ROUTING_PROVIDER=local_fake | 9/9 PASS: MDR-000037 → 4509 m → 4–6 km → MQ-000001 → $50.00 MXN → ACCEPTED |
| HTTP local `verify:delivery-quotes` con ROUTING_PROVIDER=google (rutas reales) | 9/9 PASS: MDR-000046 → 5829 m (Google) → 4–6 km → MQ-000004 → $50.00 MXN → ACCEPTED; 3 ROUTING_CALCULATED (234/89/77 ms), 0 ROUTING_FAILED, key ausente de logs |
| Regresión HTTP V1.5 / V1.4 / V1.2 | 10/10, 16/16, 13/13 PASS |
| Logs reales | Eventos de Quote/routing con reasonCode; sin coordenadas, direcciones, contactos, secretos ni JWT; 0 request_failed |
| Google Routes real (`routing:check-google`) | PASS el 2026-09-15 tras configurar el propietario GOOGLE_ROUTES_API_KEY: 1 llamada real a computeRoutes, 5829 m / 1408 s / 302 ms, travelMode DRIVE; la key no se imprimió |

---

# Verificación V1.5-A — Delivery Requests (2026-09-15)

Rama `v1.5-delivery_request`, paquete 1.5.0, Node.js 24.15.0, PostgreSQL 18 local. Docker no ejecutado.

| Verificación | Resultado |
|---|---|
| Prisma validate / generate | PASS |
| Migración `20260915000500_delivery_requests` en mandaria_db y mandaria_test (sin reset) | PASS |
| Instalación limpia + V1.0 → V1.1 → V1.2 → V1.4 → V1.5 con fixtures | PASS; datos V1.4 idénticos; constraints, índices y secuencia presentes |
| Drift schema ↔ migraciones | Vacío |
| Build / TypeScript / Oxlint / ESLint / docs:check | PASS |
| npm test | 40 PASS (31 previas + 9 V1.5) |
| npm run test:e2e | 85/85 PASS en ejecuciones limpias (63 previas + 7 validación + 15 B2B); cada archivo pasa por separado. **Intermitente:** algunas ejecuciones completas terminan con `Worker exited unexpectedly` (ver nota) |
| publicId concurrente (20 creaciones simultáneas) | PASS, 20 únicos `MDR-\d{6,}` |
| Misma key + mismo payload (y payload equivalente normalizado) | PASS, 200 misma solicitud, `Idempotent-Replayed: true` |
| Misma key + payload distinto | PASS 409, original intacta |
| Misma key en otro IntegrationClient | PASS, independiente |
| 10 peticiones concurrentes misma key / 6 con payloads distintos | PASS, 1 × 201 + 9 × 200 / 1 × 201 + 5 × 409; 1 solicitud |
| Atomicidad (fallo forzado al insertar package) | PASS, 0 filas y key no consumida |
| Stops: 1 PICKUP + 1 DROPOFF, sequence, coordenadas, dirección/contacto | PASS 400 en inválidos; límites ±90/±180 válidos |
| Packages: mínimo 1, quantity, peso, dimensiones, categoría, campos de carrito/vehículo | PASS 400; FOOD sin peso/dimensiones 201 |
| Financiero: PREPAID 450/null/omitido ✅; COURIER_ADVANCE 450 ✅; COURIER_ADVANCE null/0 ❌; 0.1+0.2, 3 decimales, exponente, moneda inválida ❌ | PASS; columna `numeric(…,2)` |
| integrationClientId/status/publicId/providerId/deliveryFee en body | PASS 400 |
| Aislamiento A/B (leer, listar, cancelar) | PASS 200 propias / 404 ajenas |
| Scopes create-only / read-only / cancel-only / quotes-only | PASS, cada uno sólo su operación (403 el resto) |
| IntegrationClient suspendido con token emitido | PASS 401; reactivado 200 |
| Cancelación, repetición, concurrencia, sin PATCH/DELETE | PASS; razón/fecha originales; un solo evento |
| Filtros publicId/externalReference/status/fechas y paginación | PASS |
| SUPER_ADMIN listar/filtrar/consultar/cancelar; sin crear/editar/eliminar | PASS |
| PROVIDER_ADMIN / DRIVER | PASS 403 admin, 401 B2B |
| Rate limit de creación | PASS, petición 61 → 429 |
| Swagger: scopes, Idempotency-Key, 200/201/409, enums, sin deliveryFee/providerId | PASS |
| Auditoría CREATED/CANCELLED con actor; logs sin direcciones, contactos, teléfonos ni secretos | PASS (E2E y log real) |
| Mutaciones: detalle sin scope de cliente / sin registro de idempotencia / publicId COUNT+1 | Detectadas (1 / 5 / 1 pruebas fallan) |
| HTTP local `verify:delivery-requests` (punto 70) | 10/10 PASS |
| Regresión HTTP `verify:drivers-vehicles` / `verify:provider-admins` | 16/16 y 13/13 PASS |

Bug corregido: `financialContext` ausente devolvía 500; ahora 400 (`@IsObject`).

**Nota — caída nativa intermitente de workers E2E (no resuelta).** Algunas ejecuciones de `npm run test:e2e` en Windows terminan con un worker de Vitest abortado con código `0xC0000409` (STATUS_STACK_BUFFER_OVERRUN): aborto nativo sin excepción JS, sin evento de Windows Error Reporting ni informe fatal de Node; memoria < 300 MB y pico de 39 conexiones PostgreSQL (se descartaron memoria y max_connections). Afecta a archivos distintos (providers, drivers-vehicles, delivery-requests-b2b) en puntos distintos. **Es previo a V1.5:** se reprodujo con `test/drivers-vehicles.e2e-spec.ts` (V1.4) ejecutado solo bajo carga de CPU artificial. V1.5 aumenta el volumen y lo hace más frecuente. Mediciones de la suite completa: por defecto 4 de 5 ejecuciones con caída; `--maxWorkers=4` 3/5 limpias; `--maxWorkers=2` 1/5 limpias (limitar paralelismo no lo resuelve, no se cambió la configuración). Cada archivo por separado pasa; `delivery-requests-b2b` solo: 6/6 limpias en la última serie y 1 caída en otra. Coincide con incidencias conocidas de Vitest + Prisma (motor nativo) en Windows. No se observó en el backend en ejecución durante las validaciones HTTP. Pendiente: verificar en Linux/Docker y aislar el módulo nativo (volcado de memoria), sin ocultarlo con reintentos.

---

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
