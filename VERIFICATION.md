# Corrección — cotizaciones concurrentes de V1.6 (2026-09-21)

Rama `v1.10-credit-monetization`, sobre el commit `533bf10` (V1.10-A). El fallo que se venía arrastrando desde la línea base de V1.9 — `test/delivery-quotes.e2e-spec.ts > 20 cotizaciones concurrentes` — era un **defecto real del producto**, no del entorno.

**Causa.** `DeliveryQuotesService.quote()` abre una transacción interactiva, bloquea la DeliveryRequest `FOR UPDATE` y, dentro de ella, resolvía la zona (`ServiceZonesService.resolveActive`, dos veces en paralelo) y la tarifa (`RatePlansService.findActive`) con el **cliente global** de Prisma, no con `tx`. Cada una de esas consultas necesita **otra** conexión del pool mientras la transacción retiene la suya. Con tantas cotizaciones simultáneas como conexiones del pool, todas quedaban esperando el bloqueo de la fila y quien lo tenía esperaba una conexión que nunca se liberaba: interbloqueo hasta el timeout del pool (10 s), `P2024` y `500` en casi todas.

**Reproducción aislada** (fuera de la aplicación, 20 transacciones sobre la misma fila en `mandaria_test`):

| Variante | Resultado |
|---|---|
| Consultas con el cliente global dentro de la transacción (código anterior) | **0/20 OK**; todas fallan a los **10 015 ms** con `P2024` — la misma firma que los `500` a ~10 s del test |
| Mismas consultas con `tx` | **20/20 OK en 634 ms** |
| Sólo bloqueo `FOR UPDATE` + 150 ms de espera (control) | 20/20 OK en ~3,1 s: el bloqueo y el pool por sí solos no eran el problema |

**Corrección.** `resolveActive` y `findActive` aceptan opcionalmente el cliente de la transacción (por defecto el global, así que los demás llamadores no cambian) y `quote()` les pasa `tx`; las dos búsquedas de zona pasan a ser secuenciales dentro de la misma conexión. Sin cambios de esquema, de contrato ni de respuestas.

**¿Hay más casos?** Se revisaron todas las transacciones interactivas de `src/` buscando consultas con `this.prisma` o llamadas a otros servicios dentro del cuerpo: sólo existían estas tres, en la cotización. Las otras tres llamadas encontradas no consultan la base (routing HTTP, lectura de configuración, validación pura).

**Verificación.**

| Verificación | Resultado |
|---|---|
| `delivery-quotes.e2e-spec.ts` | **11/11 en 3 corridas seguidas** (antes 10/11 siempre) |
| Prueba unitaria nueva en `test/pricing.spec.ts` | Comprueba que zona y tarifa reciben `tx` y que no se llama al routing si no hay tarifa. **Validada por mutación**: quitando `tx` de la llamada, falla; restaurado, pasa |
| TypeScript / Oxlint / ESLint / Prettier / docs:check | PASS |
| Unitarias | **131 PASS** (130 + 1) |
| E2E por archivo | **197 PASS, 15/15 archivos, 0 fallos**: primera corrida completamente verde registrada en el proyecto (un archivo necesitó un reintento por la caída conocida de workers en Windows, no por un fallo de prueba) |

**Nota de entorno.** Mientras se ejecutaba, una tarea en segundo plano trabajaba en un worktree dentro de la carpeta del repositorio (`.claude/worktrees/`) y Vitest tomaba también sus copias de los specs. Las corridas de esta verificación usan `--exclude '.claude/**'`; los resultados anteriores son sólo del repositorio principal.

# Verificación V1.10-A — Credit Accounts & Immutable Ledger (2026-09-21)

Rama `v1.10-credit-monetization`, paquete 1.10.0, Node.js 24.15.0, PostgreSQL 18 local. Docker no ejecutado. Sin commit ni push.

**Nota de partida:** el encargo daba por completada una «V1.9-C Service Coverage». No existe en el repositorio: ni en ninguna rama local o remota, ni en el historial, ni en la documentación; la rama parte de V1.9 (PR #14) más un commit de documentación, y la única cobertura es la `ProviderServiceCoverage` de V1.7. V1.10-A no depende de ella, así que se construyó sobre V1.9 y la regresión cubre la cobertura que sí existe.

| Verificación | Resultado |
|---|---|
| Línea base **antes** de modificar | PASS; 113 unitarias; E2E 162 (1 fallo preexistente, ver nota) |
| Prisma validate / migrate status | PASS / al día (11 migraciones) |
| Drift `migrate diff` schema ↔ migraciones (shadow DB temporal, eliminada después) | Vacío |
| Migración `20260921001100_credit_accounts_ledger` en `mandaria_db` y `mandaria_test` (sin reset) | PASS; 10 y 47 proveedores con exactamente una cuenta cada uno; 3 y 2 perfiles independientes aprobados alguna vez con cuenta; saldo 0 y **0 movimientos** en ambas |
| `verify-migrations.mjs` | PASS en tres bases: instalación limpia; V1.0 → … → V1.9 → V1.10 con datos; y una base **llevada a V1.9 con datos reales** antes de aplicar V1.10 |
| TypeScript / Build / Oxlint / ESLint / Prettier (archivos nuevos) | PASS |
| `docs:openapi` + `docs:check` | 1.10.0; **+12 rutas, +8 esquemas, 0 eliminados**; 0 campos ambiguos `type: object` en los esquemas nuevos; `balance`, `amount` y `credits` publicados como `integer`; 0 campos `currency` en rutas de créditos |
| `npm test` | **130 PASS** (113 previas + 17 de V1.10-A) |
| E2E por archivo, 15 archivos | **186 PASS** (162 previas + 24 de V1.10-A); 14 archivos OK; `delivery-quotes` con el fallo preexistente |
| Tormenta de concurrencia contra `dist/main.js` (fuera del repositorio) | **7/7** |
| Escaneo de invariantes del ledger en ambas bases | **0 violaciones** en 11 consultas cada una |

## Migración sobre datos reales de V1.9

La base `mandaria_v19_*_test` se llevó migración a migración hasta V1.9 y se le cargaron datos de V1.9: dos proveedores (uno SUSPENDED) y tres perfiles independientes — APPROVED, SUSPENDED después de haber sido aprobado, y PENDING nunca aprobado. Tras aplicar V1.10:

- las filas de `User`, `DeliveryProvider`, `Driver` e `IndependentDriverProfile` son **idénticas byte a byte** a las previas;
- cada proveedor, también el suspendido, tiene una cuenta con saldo 0;
- el perfil APPROVED y el SUSPENDED-tras-aprobación tienen cuenta; el PENDING **no**;
- el ledger está vacío: ninguna recarga inventada;
- después, los triggers toman el relevo: un proveedor nuevo recibe su cuenta, el perfil PENDING al aprobarse recibe la suya, y reaprobar el suspendido no crea una segunda.

## Pruebas nuevas

`test/credits.spec.ts` (17): convención de signo por tipo; `MAX_CREDIT_BALANCE + MAX_CREDIT_MOVEMENT` < 2³¹ (sin desbordamiento posible); saldo negativo y límite superior rechazados; todos los conflictos son 409; validación estricta — `0`, `-5`, `1.5`, `7.25`, `0.01`, `"10"`, `null`, `true` y valores fuera de límite rechazados; `reason` obligatorio sólo con OTHER; caracteres de control rechazados en `reason` y `externalReference`; `ownerType`, `providerId`, `creditAccountId`, `balance` y `createdByUserId` forjados en el cuerpo rechazados; Idempotency-Key ausente, corta, con espacios, demasiado larga o repetida rechazada; las vistas nunca exponen la huella del cuerpo y ocultan actor y key al dueño; débito insuficiente bajo bloqueo sin escribir; replay por key y conflicto por cuerpo distinto sin escribir; una guarda de PostgreSQL traducida a 409.

`test/credits.e2e-spec.ts` (24, HTTP real contra la aplicación y PostgreSQL):

| Área | Resultado |
|---|---|
| Cuenta de proveedor | Proveedores creados por SQL y por la API reciben exactamente una cuenta con saldo 0 y sin movimientos |
| Cuenta independiente | 404 antes de aprobar; creada al aprobar; conservada al suspender; reaprobar no duplica |
| Driver de flotilla | `GET /driver/credits` → 404 `CREDIT_ACCOUNT_NOT_FOUND`; ninguna cuenta en la base |
| Recarga | 201, `Idempotent-Replayed: false`, entrada RECHARGE con actor, método y referencia; saldo 500 |
| Idempotencia | Misma key y cuerpo → 200 con el movimiento original; cuerpo distinto → 409; recarga y ajuste con la misma key → 409; 1 sola entrada por key |
| Key y OTHER | Sin key → 400; key corta → 400; OTHER sin motivo → 400; con motivo → 201 |
| Ajuste | +50 y −20 aplicados; sobregiro → 409 `INSUFFICIENT_CREDITS` sin escribir ninguna entrada |
| Entradas inválidas | 0, decimales, texto, ±1 000 001, `null`, 2³¹ y campos forjados → 400; referencia con salto de línea → 400; el proveedor B nunca tocado |
| Ruta independiente | Recarga y ajuste por `/admin/drivers/:driverId/independent/credits`; Driver de flotilla, Driver y proveedor inexistentes → 404 |
| PROVIDER_ADMIN | Lee su cuenta e historial sin actor, key ni huella; no hay ruta de mutación (404); rutas de admin → 403 |
| Aislamiento | Admin de B sobre la cuenta de A (propia y admin) → 403; `providerId` repetido en la query → 400 |
| DRIVER independiente | Lee sólo lo suyo; mutaciones y cuenta de proveedor → 403 |
| B2B y roles | Token B2B y sin token → 401 en las 8 rutas probadas; SUPER_ADMIN en rutas propias de dueño → 403 |
| Historial | Ordenado por `sequence` descendente; página 2 exacta; `pageSize` 0/101, `page` 0/texto → 400 |
| Inmutabilidad | UPDATE, DELETE y TRUNCATE por SQL rechazados (`CREDIT_LEDGER_IMMUTABLE`); UPDATE rechazado **incluso** con el interruptor de purga; borrar un proveedor con historial rechazado |
| Ataques SQL (16) | Todos rechazados, cada uno por el objeto esperado: UPDATE directo del saldo, segunda cuenta, ownerType incoherente, dos dueños, cuenta con saldo inicial, cambio de dueño, recarga negativa, saldo negativo, movimiento 0, aritmética falsa, `balanceBefore` obsoleto, cantidad absurda, SERVICE_AWARD positivo, recarga sin actor o sin key, ajuste sin motivo |
| Concurrencia | +100/+200/+300 simultáneas → +600 y 3 entradas; −8/−8 sobre 10 → 201 + 409, saldo 2; 8 movimientos mixtos → saldo = suma de los aplicados; la misma key ×5 → 1 × 201 + 4 × 200, una entrada |
| **CLAIM/TAKE sin créditos** | Proveedor con saldo 0 reclama (200) y un independiente con saldo 0 toma (200); **ningún movimiento nuevo** en el ledger y 0 entradas SERVICE_AWARD/SERVICE_REFUND |
| Suspensión | Proveedor suspendido conserva saldo e historial legibles |
| Auditoría | CREDIT_RECHARGED, CREDIT_ADJUSTED, CREDIT_MOVEMENT_REPLAYED, CREDIT_IDEMPOTENCY_CONFLICT y CREDIT_MOVEMENT_REJECTED con actor, cuenta, dueño, entrada, importe y saldos; 0 secretos |

La suite se ejecutó 3 veces seguidas con 24/24 y no deja residuos (0 proveedores, 0 usuarios y 0 entradas de la suite).

## Tormenta de concurrencia contra el servidor real

Validador temporal fuera del repositorio contra `dist/main.js` en ejecución (base `mandaria_test`, reinicios del servidor para no consumir el límite por IP):

| Escenario | Resultado |
|---|---|
| 60 recargas y ajustes simultáneos sobre **una** cuenta | 60 aplicados; saldo 3250 = exactamente el esperado; cadena íntegra |
| 30 débitos simultáneos de 7 sobre un saldo de exactamente 70 | **10 aplicados, 20 rechazados, saldo 0**: ningún sobregiro |
| 25 copias simultáneas de la misma Idempotency-Key | 1 × 201 + 24 × 200, todas con la misma entrada; +13 una sola vez |
| La misma key con cuerpos distintos en paralelo (10) | 1 creada, 5 conflictos (cuerpo distinto), 4 replays (mismo cuerpo que la ganadora); 1 entrada |
| Cadena final | 75 entradas sin un solo hueco |
| Servidor | 0 respuestas 5xx; 0 secretos en 1 304 líneas de log |

## Escaneo de invariantes del ledger

11 consultas sobre `mandaria_db` y `mandaria_test`: todo proveedor tiene cuenta; todo perfil aprobado alguna vez la tiene y ninguno nunca aprobado; 0 saldos negativos; 0 dueños incoherentes; 0 entradas con aritmética falsa; 0 roturas de cadena; toda cadena empieza en 0; el último `balanceAfter` coincide siempre con el saldo; 0 entradas SERVICE_*; 0 keys duplicadas. **0 violaciones** en ambas.

## Defectos encontrados durante la implementación

- **Nulos publicados como `type: object`.** Los campos `string | null` de las respuestas nuevas salían en OpenAPI como objetos sin estructura, porque TypeScript refleja la unión como `Object`. Se declaró el tipo explícito en todos; auditoría de los esquemas nuevos en 0. El mismo defecto existe en **130 campos de versiones anteriores** (V1.1–V1.9, incluidos varios de V1.9): no se corrigió aquí por estar fuera de alcance y quedó propuesto como tarea aparte.
- **400 sin documentar en `GET /driver/credits`.** La regresión de V1.4 (`driver-self.e2e-spec.ts`) exige que toda ruta de drivers documente 400/401/403/429; la ruta nueva no documentaba 400. Corregido; todas las rutas de créditos cumplen la convención.
- **CORS no exponía `Idempotent-Replayed`.** Un navegador no podía leer esa cabecera. Se añadió a `exposedHeaders`.
- Errores del propio validador, corregidos en el validador: un correo con mayúsculas en el alta (el login normaliza a minúsculas) y la lectura del resultado de un script abortado.

## Fallo preexistente, ajeno a V1.10-A

`test/delivery-quotes.e2e-spec.ts > 20 cotizaciones concurrentes` falla igual que en la línea base previa: agotamiento del pool de conexiones de Prisma (500 a los ~10 s) en el camino de cotización V1.6.

## No verificado

Docker; entrega SMTP real; `docs/API-CONTRACT.md` de `mandaria-frontend` (otro repositorio, no modificado).

# CHECK V1.9-A — Independent Driver Security, Concurrency & Integrity (2026-09-18)

Rama `v1.9-independent_drivers`, paquete 1.9.0. Validador adversarial temporal **fuera del repositorio** contra `dist/main.js` en ejecución (puerto 3019, base `mandaria_test`, `ROUTING_PROVIDER=local_fake`), con fixtures propios, logins reales y limpieza total. Reinicios del servidor para no consumir el límite por IP (100/min, 5 logins/min, 30 cotizaciones/min). **Se encontraron y corrigieron 3 defectos reales** (una sola causa raíz); ver abajo.

| # | Verificación | Resultado |
|---|---|---|
| 1 | Línea base antes del CHECK (prisma validate, migrate status, tsc, build, Oxlint, ESLint, docs:check, unitarias, E2E) | PASS; 110 unitarias; E2E 162 |
| 2 | SUPER_ADMIN habilita un Driver válido (API + DB + auditoría) | 200 APPROVED con `approvedByUserId`; idempotente (1 perfil tras repetir) |
| 2c | Sin proveedor ni membership ficticios | 2 proveedores (los del fixture) y **0 memberships** del repartidor |
| 2d | Vehículos propios | `providerId` NULL en DB, dueño = perfil; 3.º → 409 `VEHICLE_LIMIT_REACHED` |
| 3 | Escalada de privilegios (habilitar/suspender/vehículos) | PROVIDER_ADMIN, DRIVER propio y DRIVER ajeno → **403 ×9**; IntegrationClient y sin token → **401 ×3**; 0 perfiles creados |
| 4 | Driver inválido | SUSPENDED y cuenta inactiva → 409 `DRIVER_NOT_ELIGIBLE`; id de User, rol no-DRIVER e inexistente → 404; malformado → 400; 0 perfiles creados |
| 5 | Vehículo de otro independiente | 404 |
| 6 | Vehículo de proveedor (A y B) e inexistente | 404 ×3; malformado 400; Dispatch sigue OPEN sin asignación |
| 6b | Sentido inverso: PROVIDER_ADMIN asigna un vehículo independiente | 404 |
| 7 | Listado de Dispatches elegibles | Sólo OPEN elegibles; el CLAIMED por un proveedor no aparece; **0 fugas** de 12 términos (contactos, teléfono, instrucciones, descripción, referencia, IntegrationClient, candidaturas, providerId); no habilitado → 409 |
| 8 | TAKE básico | 200 OWNER; Dispatch CLAIMED con `claimedByIndependentDriverId` y `claimedByProviderId` NULL; asignación ACTIVE `mode=INDEPENDENT`, `providerId` NULL |
| 9 | Atomicidad | 16 consultas de invariantes sobre toda la base, en 0, tras cada bloque y al final |
| 10 | **Carrera Provider CLAIM vs Independent TAKE** (5 repeticiones) | Siempre `200/409`; exactamente **un** dueño; ganador independiente ⇒ asignación ACTIVE, ganador flotilla ⇒ sin asignación (sigue siendo paso aparte). Se observaron ambos ganadores entre ejecuciones |
| 11 | Varios independientes sobre un Dispatch | 1 × 200 y 2 × 409; 1 ACTIVE |
| 12 | **Alta contención mixta**: 20 intentos (2 proveedores + 3 tomas) sobre 4 Dispatches | 4 ganadores / 4 Dispatches; **1 dueño por Dispatch**; claims independientes = asignaciones activas; 0 violaciones; 0 respuestas 5xx |
| 13 | Mismo repartidor sobre 2 Dispatches en paralelo | 1 × 200 + 1 × 409; 1 ACTIVE; sin claim huérfano |
| 14 | Ocupado en flotilla → TAKE independiente | 409 `DRIVER_BUSY`; `/driver/me` con `canTakeServices` false y `activeDeliveryAssignment.mode = FLEET` |
| 15 | Ocupado como independiente → asignación de proveedor | 409 `DRIVER_BUSY`; exactamente 1 ACTIVE |
| 16 | Mismo vehículo sobre 2 Dispatches en paralelo | 1 × 200 + 1 × 409; 1 ACTIVE por vehículo |
| 17 | RELEASE | Motivo ausente/inválido/OTHER sin detalle → 400 ×3; asignación CANCELLED con motivo y detalle; Dispatch OPEN con claim limpio; historial de 1 fila; quien liberó → 409 `DISPATCH_RETAKE_NOT_ALLOWED`; otro repartidor → 200 |
| 18 | Liberar servicio ajeno | Pedro → 409 `DISPATCH_NOT_CLAIMED_BY_DRIVER`; SUPER_ADMIN y PROVIDER_ADMIN → 403; la asignación sigue ACTIVE |
| 19 | Interferencia del PROVIDER_ADMIN | claim 409 `DISPATCH_ALREADY_CLAIMED`; assignment, reassign, cancel y release → 409 `DISPATCH_NOT_CLAIMED_BY_PROVIDER`; la asignación del repartidor intacta |
| 20 | DRIVER sobre rutas V1.8 | assignment, reassign, cancel y claim → 403 ×4 |
| 21/22 | Suspender / rechazar / desactivar vehículo con servicio ACTIVE | 409 `INDEPENDENT_DRIVER_HAS_ACTIVE_ASSIGNMENT` ×2 y 409 `VEHICLE_HAS_ACTIVE_ASSIGNMENT`; perfil sigue APPROVED, vehículo ACTIVE y la entrega sigue ACTIVE |
| 23 | Contexto de pago | COURIER_ADVANCE: fee 60.00, goods 800.00, `driverAdvanceAmount` 800.00. PREPAID: `driverAdvancesGoods` false y `driverAdvanceAmount` null |
| 24 | Sin wallet | 0 términos (wallet/balance/saldo/credit/ledger) en la respuesta y **0 tablas** con esos nombres |
| 25 | Ataques directos a la base (14) | Todos rechazados: dueño doble, 2.ª ACTIVE por Dispatch, asignación sin claim, vehículo ajeno, vehículo con dos dueños o ninguno, cambio de dueño de vehículo y de proveedor del Driver, `providerId` en una asignación independiente, suspensión con ACTIVE por SQL, cambio de Driver del perfil y CLAIMED sin dueño |
| 25b | Aislamiento de los CHECK | Con los triggers ya satisfechos, el dueño XOR lo rechaza **`Dispatch_values_check`** y el modo **`DeliveryAssignment_mode_check`** (nombres verificados en el mensaje) |
| 26 | Flujo V1.8 completo | claim 200, assign 201, reassign 200, historial 2, `/release` con ACTIVE → 409 `DISPATCH_HAS_ACTIVE_ASSIGNMENT`, cancel 200, release 200 → OPEN; ambas filas `mode=FLEET` con su `providerId` |
| 27 | Migración V1.8 → V1.9 | `verify-migrations` PASS: instalación limpia + V1.0 → … → V1.9 con datos preservados, sin reset |
| 28 | Auditoría | 4 eventos independientes presentes; el de `take` con `dispatchId`, `assignmentId`, `driverId`, `vehicleId`, `profileId` y `actorUserId`; **0 secretos** (contraseña, clientSecret, JWT humano y B2B, secreto de firma) y **0 datos del cliente** en 3 117 líneas de log |
| 29 | Regresión V1.0–V1.8 | E2E por archivo 162 PASS (13/14 archivos limpios) |
| 30 | Calidad final | prisma validate, migrate status, tsc, build, Oxlint, ESLint, docs:check PASS; 113 unitarias |
| 31 | Cancelación oficial B2B con asignación independiente ACTIVE | Dispatch CANCELLED, asignación CANCELLED/`DELIVERY_CANCELLED` en modo INDEPENDENT, recursos liberados y reutilizables |
| 32 | TAKE sobre Dispatch cancelado o vencido | 409 `DISPATCH_CANCELLED` y 409 `DISPATCH_EXPIRED`; mover la ventana del Dispatch por SQL → rechazado (`DISPATCH_IMMUTABLE`), así que el vencimiento se provocó dejando expirar un Dispatch real con TTL de 1 minuto; expiración perezosa persistida y fuera del listado |
| 33 | **Control negativo** | Un claim independiente huérfano fabricado a mano **sí** es detectado por el escaneo (`orphanIndependentClaim=1`) y vuelve a 0 al restaurarlo: el resto de escaneos no es vacío |
| — | Servidor durante el CHECK | **0 respuestas 5xx y 0 respuestas 429** en las 34 comprobaciones |
| — | Escaneo de invariantes en `mandaria_db` y `mandaria_test` | **0 violaciones** en 17 consultas cada una; 7 constraints, 6 triggers y 5 índices parciales presentes; 68 asignaciones FLEET previas intactas; 0 residuo de fixtures |

Resultado: **34/34 comprobaciones** por HTTP real más el escaneo de ambas bases sin violaciones.

## Defectos reales encontrados y corregidos

Las comprobaciones anteriores pasaron en la primera pasada, así que se añadió una sonda dirigida al único punto donde los bloqueos podían no encontrarse: **`take` bloqueaba la fila de `Driver` (`FOR UPDATE OF d`) mientras la suspensión bloquea la fila de `IndependentDriverProfile`**. Al ser filas distintas, las dos transacciones nunca se serializaban. Lanzando `take` y `suspend` a la vez (24 rondas, con desfase aleatorio de 0–12 ms) aparecieron **tres síntomas de una sola causa**:

1. **Estado inconsistente (3 de 24 rondas):** perfil `SUSPENDED` **con** asignación ACTIVE y Dispatch CLAIMED — justo el estado que la política V1.9 (§46) promete no producir. La suspensión comprobaba «¿hay asignación ACTIVE?» antes de que el `take` confirmara, y el trigger tampoco veía la fila aún sin confirmar.
2. **HTTP 500 (5 de 24 rondas):** cuando la suspensión confirmaba antes del INSERT, `delivery_assignment_guard` lanzaba `DELIVERY_ASSIGNMENT_INVALID` y el error de PostgreSQL llegaba al cliente como error interno en vez de un conflicto.
3. **409 que mentía:** en las rondas inconsistentes la API devolvía `409 INDEPENDENT_NOT_APPROVED` **aunque el `take` ya se había confirmado**. El repartidor creía no tener el servicio mientras la base decía que sí. Causa: tras la transacción, la respuesta se construía con `get()`, que vuelve a pasar por la puerta de aprobación.

**Corrección** (`src/independent-drivers/`, sin cambiar el modelo de datos ni la migración):

- `lockEligibleResources` bloquea ahora también la fila del perfil (`FOR UPDATE OF d, p`). Orden de bloqueo: Dispatch → perfil + Driver → Vehicle; la suspensión sólo toma el bloqueo del perfil, así que no hay ciclo. Con eso, si la suspensión va primero el `take` lee `SUSPENDED` bajo bloqueo y responde 409 limpio sin escribir nada; si el `take` va primero, la suspensión espera y encuentra la asignación ACTIVE (409 `INDEPENDENT_DRIVER_HAS_ACTIVE_ASSIGNMENT`).
- `take` y `release` construyen su respuesta con `viewFor(driverId, …)`, que no repite la puerta de aprobación: el trabajo ya está confirmado y una suspensión posterior no puede convertirlo en un error.
- Defensa en profundidad: `isGuardRejection` traduce cualquier `RAISE EXCEPTION` de los triggers a **409 `TAKE_CONFLICT`**. Una carrera perdida nunca debe salir como 5xx.

**Comprobación de la corrección:** 80 rondas de `suspend` vs `take` (2 ejecuciones de 40) y 40 rondas de desactivación de vehículo vs `take`: **0 estados inconsistentes, 0 respuestas 500**, y sólo las dos serializaciones correctas (`409/200` y `200/409`). El CHECK completo se repitió sobre el binario corregido: 34/34.

**Regresión anclada:** `test/independent-drivers.spec.ts` añade tres pruebas (113 unitarias en total) que fijan el bloqueo del perfil, la traducción del rechazo del trigger a 409 y el reconocimiento de `isGuardRejection`. La primera se validó por mutación: quitando `, p` del `FOR UPDATE` la prueba falla; restaurándolo pasa.

## Errores del propio validador (no del producto)

Tres intentos del validador fueron rechazados **por el sistema comportándose bien**, y se corrigieron en el validador:

- mover `openedAt`/`expiresAt` de un Dispatch → `DISPATCH_IMMUTABLE`; el vencimiento se provocó dejando expirar un Dispatch real;
- usar `now()` en SQL crudo para cerrar una asignación → el CHECK `endedAt >= assignedAt` lo rechazó, porque la sesión de PostgreSQL da hora local y la aplicación guarda UTC;
- una aserción que contaba proveedores por prefijo en vez de por identificador de ejecución.

## No verificado

Docker; entrega SMTP real; onboarding público del repartidor (no implementado); `docs/API-CONTRACT.md` de `mandaria-frontend` (otro repositorio, no modificado).

## Fallo preexistente, ajeno a V1.9

`test/delivery-quotes.e2e-spec.ts > 20 cotizaciones concurrentes` sigue fallando igual que en la línea base anterior a V1.9: agotamiento del pool de conexiones de Prisma (500 a los 10 063 ms) en el camino de cotización V1.6, que V1.9 no toca.

# Verificación V1.9-A — Independent Drivers (2026-09-18)

Rama `v1.9-independent_drivers`, paquete 1.9.0, Node.js 24.15.0, PostgreSQL 18 local. Docker no ejecutado. Sin commit ni push.

| Verificación | Resultado |
|---|---|
| Línea base **antes** de modificar (prisma validate, migrate status, tsc, Oxlint, unitarias, E2E por archivo) | PASS; 91 unitarias; E2E 135/136 con 1 fallo preexistente (ver nota) |
| Prisma validate / migrate status | PASS / al día (10 migraciones) |
| Drift `migrate diff` schema ↔ migraciones (shadow DB) | Vacío (`-- This is an empty migration.`) |
| Migración `20260918001000_independent_drivers` en `mandaria_db` y `mandaria_test` (sin reset) | PASS; 0 filas reescritas |
| `verify-migrations.mjs`: instalación limpia + V1.0 → … → V1.8 → V1.9 con datos | PASS; datos preservados; `IndependentDriverProfile` vacía; 0 asignaciones no-FLEET; 0 vehículos sin proveedor; 7 constraints, 3 triggers y el índice parcial V1.9 presentes |
| TypeScript / Build / Oxlint / ESLint | PASS |
| `docs:openapi` + `docs:check` | 1.9.0; **+13 rutas y +17 esquemas; 0 rutas y 0 esquemas eliminados**; matriz al día |
| `npm test` (unitarias) | **110 PASS** (91 previas + 19 de V1.9) |
| E2E por archivo, 14 archivos | **162 PASS**; 13 archivos OK; `delivery-quotes` con 1 fallo preexistente |

## Escenarios V1.9 verificados por HTTP real (`test/independent-drivers.e2e-spec.ts`, 23 pruebas)

| # | Escenario | Resultado |
|---|---|---|
| 1 | Habilitar: sólo SUPER_ADMIN | DRIVER y PROVIDER_ADMIN 403; token B2B 401; sin token 401; 0 perfiles creados |
| 2 | Habilitar Driver existente | APPROVED con `approvedAt`; idempotente (2.ª llamada no crea un segundo perfil); **0 proveedores ficticios creados** |
| 3 | Driver SUSPENDED / id inexistente | 409 `DRIVER_NOT_ELIGIBLE` / 404 |
| 4 | Vehículos propios | 2 altas con `providerId` NULL en DB; 3.ª → 409 `VEHICLE_LIMIT_REACHED` (límite 2 en la suite); PROVIDER_ADMIN y DRIVER 403 |
| 5 | Vista del repartidor | `/driver/me` con `independent.canTakeServices` true; `/driver/vehicles` sólo los suyos; Driver no habilitado → `independent: null` y 409 en las rutas independientes |
| 6 | Privacidad del listado | `access: OFFER` con ruta, direcciones y `paymentContext`; **0 coincidencias** de contactos, teléfono, instrucciones, descripción de paquete, referencia del comercio, IntegrationClient, candidaturas y `providerId` |
| 7 | `take` | 200 con `access: OWNER`; Dispatch CLAIMED con `claimedByIndependentDriverId` y `claimedByProviderId` NULL; asignación ACTIVE `mode=INDEPENDENT`, `providerId` NULL; **0 claims independientes sin asignación ACTIVE** |
| 8 | Contexto de pago | `deliveryFee` 60.00 y `driverAdvanceAmount` 800.00 con COURIER_ADVANCE, antes y después de tomar |
| 9 | Vehículo ajeno | Vehículo de la flotilla → 404; de otro independiente → 404; UUID inexistente → 404; Dispatch sigue OPEN sin asignación |
| 10 | Vehículo independiente desde ruta de proveedor | 404: un PROVIDER_ADMIN no puede asignar el vehículo propio de un repartidor |
| 11 | Repartidor SUSPENDED | `take` y listado 409 `INDEPENDENT_NOT_APPROVED`; tras reaprobar, `take` 200 |
| 12 | `release` | Asignación CANCELLED con motivo y detalle; Dispatch OPEN con claim limpio; historial de 1 fila |
| 13 | Retake tras liberar | Quien liberó 409 `DISPATCH_RETAKE_NOT_ALLOWED`; otro repartidor 200 |
| 14 | `release` sin motivo / motivo inválido / OTHER sin detalle | 400 ×3 |
| 15 | `release` por quien no lo tiene | 409 `DISPATCH_NOT_CLAIMED_BY_DRIVER`; PROVIDER_ADMIN y SUPER_ADMIN 403; la asignación sigue ACTIVE |
| 16 | Sin reasignación para DRIVER | Las 3 rutas de asignación V1.8 → 403 con token de repartidor |
| 17 | Proveedor sobre servicio de un independiente | `assignment` 409 `DISPATCH_NOT_CLAIMED_BY_PROVIDER` ×2 y `claim` 409 `DISPATCH_ALREADY_CLAIMED`; la asignación del repartidor intacta |
| 18 | **Carrera flotilla vs independiente** (3 repeticiones) | Siempre `[200, 409]`: exactamente un ganador; exactamente **una** columna de dueño no nula; si gana el independiente hay asignación ACTIVE, si gana el proveedor no (sigue siendo paso aparte en V1.8) |
| 19 | **Varios independientes** sobre un Dispatch | 1 × 200 y 2 × 409; 1 asignación ACTIVE |
| 20 | Mismo repartidor sobre 2 Dispatches en paralelo | 1 × 200 y 1 × 409; ACTIVE en exactamente 1 |
| 21 | Mismo vehículo sobre 2 Dispatches en paralelo | 1 sola asignación ACTIVE para ese vehículo |
| 22 | **Ocupado en flotilla → no puede como independiente** | 409 `DRIVER_BUSY`; `/driver/me` con `canTakeServices` false y `activeDeliveryAssignment.mode = FLEET` |
| 23 | **Ocupado como independiente → el proveedor no puede asignarlo** | 409 `DRIVER_BUSY`; exactamente 1 ACTIVE para ese Driver |
| 24 | Vehículo liberado vuelve a ser usable | `release` y nuevo `take` 200; 1 ACTIVE |
| 25 | Suspensión con servicio en curso | 409 `INDEPENDENT_DRIVER_HAS_ACTIVE_ASSIGNMENT`; perfil sigue APPROVED y la entrega sigue ACTIVE |
| 26 | Desactivar vehículo con servicio en curso | 409 `VEHICLE_HAS_ACTIVE_ASSIGNMENT`; vehículo sigue ACTIVE |
| 27 | Tras liberar | MAINTENANCE 200 y suspensión 200; un vehículo en MAINTENANCE → 409 `VEHICLE_NOT_ELIGIBLE` aunque el repartidor esté rehabilitado |
| 28 | Invariantes en SQL | Dueño doble del claim rechazado por `Dispatch_values_check` (con el trigger satisfecho, para que la prueba aísle el CHECK); asignación sobre Dispatch no tomado → `DELIVERY_ASSIGNMENT_INVALID`; vehículo con dos dueños o sin dueño → `Vehicle_owner_check`; cambiar el dueño de un vehículo → `RESOURCE_OWNER_IMMUTABLE` |
| 29 | Objetos en la base | 5 constraints, 5 triggers y los 4 índices (3 parciales ACTIVE + identificador independiente) presentes; 0 filas con `mode`/dueño incoherentes |
| 30 | Auditoría | `INDEPENDENT_DRIVER_ENABLED`, `_SUSPENDED`, `_DISPATCH_TAKEN`, `_DISPATCH_RELEASED` y `_VEHICLE_CREATED` presentes; el evento de `take` incluye `dispatchId`, `assignmentId`, `driverId`, `vehicleId`, `profileId` y `actorUserId`; **0 secretos** (contraseña, JWT humano y token B2B) en los logs |

Pruebas unitarias V1.9 (`test/independent-drivers.spec.ts`, 19): política de ejecución por ServiceType y su exhaustividad, orden de rechazo del `take` (cancelado → vencido → ya tomado → tipo no admitido → retake), mapeo de motivos al enum V1.8 sin usar `DELIVERY_CANCELLED`, todos los errores como 409, plazo de asignación nulo para un claim independiente, habilitación que exige Driver operacional y es idempotente, reaprobación que limpia la suspensión, suspensión bloqueada con servicio activo, límite de vehículos configurable y vehículo creado sin proveedor, e identidad resuelta siempre desde el JWT.

## Regresión V1.0–V1.8

E2E por archivo: b2b 14, core 7, delivery-assignments 13, delivery-requests-b2b 15, delivery-requests-validation 7, dispatch 13, driver-self 7, drivers-vehicles 11, pricing-admin 4, provider-admin-access 9, providers 15, user-invitations 24 — todos PASS, con los mismos conteos que la línea base. `delivery-assignments` (claim, release, reasignación, aislamiento por proveedor, contexto de pago) y `dispatch` (claim/liberación V1.7) pasan sin cambios de expectativas.

Dos pruebas existentes se ajustaron **al comportamiento nuevo e intencionado**, no al revés:

- `test/driver-self.e2e-spec.ts`: la aserción de campos exactos de `/driver/me` ahora incluye `independent` y `activeDeliveryAssignment`, y comprueba que un repartidor de flotilla no habilitado los recibe en `null`.
- `test/logistics.spec.ts`: el doble de Prisma de `setOwnAvailability` no cubría la consulta que `self()` añadió; se le agregó `deliveryAssignment.findFirst`.

## Fallo preexistente, no introducido por V1.9

`test/delivery-quotes.e2e-spec.ts > 20 llamadas de cotización concurrentes` falla **también en la línea base, antes de cualquier cambio** (se ejecutó dos veces sobre el código intacto). Con el timeout por defecto se manifiesta como «Test timed out in 5000ms»; subiéndolo a 30 s se ve la causa real: 18 de las 20 peticiones responden 500 tras **10 063 ms**, exactamente el timeout de pool de Prisma. Es agotamiento del pool de conexiones al mantener 20 transacciones simultáneas (cada una retiene su conexión durante la llamada de routing), un límite de entorno del camino de cotización V1.6 —que V1.9 no toca— ya anotado como deuda técnica en el README. La cotización y la aceptación funcionan: el propio test registra `DELIVERY_QUOTE_CREATED` y respuestas 201/200.

## Nota de entorno

En Windows, los *worker forks* de Vitest mueren de forma aleatoria y el archivo se reporta como «N passed (M)» con N<M y un error de pool no controlado; ya estaba documentado en V1.8. Las ejecuciones se repitieron por archivo hasta completar; los conteos de esta tabla son de ejecuciones completas. Una caída así dejó fixtures sin borrar (el `afterAll` no llega a ejecutarse) y eso destapó una aserción propia demasiado amplia en la suite nueva: contaba proveedores por prefijo en vez de por identificador de ejecución. Se corrigió para que quede acotada a su propia corrida; `test/independent-drivers.e2e-spec.ts` se ejecutó después **3 veces seguidas con 23/23** y la base de pruebas queda sin residuos (0 proveedores, 0 perfiles y 0 usuarios de la suite).

Las bases de verificación de migraciones sobrantes de corridas repetidas se eliminaron; se conservó el par de la corrida válida (`mandaria_clean_958a27f19e_test` y `mandaria_upgrade_958a27f19e_test`), como hace el script. La comprobación de drift necesita una shadow database temporal, creada y eliminada durante la verificación.

## No verificado

Docker; entrega SMTP real; onboarding público del repartidor (no implementado); `docs/API-CONTRACT.md` de `mandaria-frontend` (vive en otro repositorio y no se modificó).

# CHECK V1.8-A — Assignment Concurrency, Isolation & Integrity (2026-09-17)

Rama `v1.8-provider_driver_vehicle_assignment`, paquete 1.8.0. Validador temporal fuera del repositorio contra `dist/main.js` en ejecución (puerto 3011, base `mandaria_test`, `ROUTING_PROVIDER=local_fake`), con fixtures propios, logins reales y limpieza total. Sin cambios de código.

| # | Verificación | Resultado |
|---|---|---|
| 1 | Línea base (prisma validate, migrate status, tsc, build, Oxlint, ESLint, docs:check; 91 unitarias; E2E por archivo) | PASS; 91; 148/148 |
| 2 | Asignación básica Carlos + MOTO-03 (API y DB) | 201 ACTIVE; Dispatch sigue CLAIMED con `assignment` |
| 3 | `driverId` de proveedor B | 404 sin detalles; 0 asignaciones |
| 4 | `vehicleId` de proveedor B | 404 |
| 5 | Admin de B sobre asignación de A (crear, reasignar, cancelar, `?providerId=A`) | 409 DISPATCH_NOT_CLAIMED_BY_PROVIDER ×3 y 403; la ACTIVE de A intacta |
| 6 | Rol DRIVER (crear, reasignar, cancelar) | 403 / 403 / 403 |
| 7 | SUPER_ADMIN como flotilla | 403 / 403 / 403; sólo lectura de auditoría (historial y `activeAssignment`) |
| 8 | IntegrationClient (token B2B) en las 4 rutas | 401 ×4 |
| 9 | 12 asignaciones simultáneas al mismo Dispatch con combinaciones distintas | 1 × 201, 11 × 409; 1 ACTIVE en DB |
| 10 | Carlos a dos Dispatches CLAIMED en paralelo | 1 × 201 + 1 × 409 DRIVER_BUSY; Carlos ACTIVE en exactamente 1 |
| 11 | MOTO-03/MOTO-07 a dos Dispatches en paralelo | 1 × 201 + 1 × 409 VEHICLE_BUSY; vehículo ACTIVE en exactamente 1 |
| 12 | Alta contención: 16 peticiones concurrentes sobre 4 Dispatches | 4 × 201, 12 × 409 (DISPATCH_ALREADY_ASSIGNED/DRIVER_BUSY); 1 ACTIVE por Dispatch; 0 grupos duplicados en DB |
| 13 | Reasignación Carlos+MOTO-03 → Pedro+MOTO-07 | anterior REASSIGNED con `endedAt` y motivo; nueva ACTIVE; 2 filas |
| 14 | Dos reasignaciones simultáneas | Se serializan (200 + 200, la segunda parte de la nueva ACTIVE); historial REASSIGNED,REASSIGNED,REASSIGNED,ACTIVE con exactamente 1 ACTIVE |
| 15 | Reasignar hacia un recurso que se ocupa en paralelo | 1 aplica, la otra 409 DRIVER_BUSY; 1 ACTIVE por Driver y por Vehicle |
| 16 | Cancelación de asignación | 200 CANCELLED con motivo; Driver y Vehicle vuelven a los listados asignables; segunda cancelación 409 NO_ACTIVE_ASSIGNMENT |
| 17 | Reutilizar Carlos y MOTO-03 en otro servicio | 201 |
| 18 | `/release` con asignación ACTIVE | 409 DISPATCH_HAS_ACTIVE_ASSIGNMENT; Dispatch sigue CLAIMED con su dueño |
| 19 | Cancelar asignación y después liberar | 200 → OPEN; asignar sin claim 409 (reglas V1.7 intactas) |
| 20 | Cancelación oficial de la DeliveryRequest (B2B) | Asignación CANCELLED/DELIVERY_CANCELLED, Dispatch CANCELLED, recursos libres; sin ACTIVE huérfana |
| 21 | Driver SUSPENDED y Driver con cuenta inactiva | 409 DRIVER_NOT_ELIGIBLE ×2 |
| 22 | Vehículo en MAINTENANCE | 409 VEHICLE_NOT_ELIGIBLE |
| 23 | Driver de otro proveedor con ID válido y conocido (crear y reasignar) | 404 / 404 |
| 24 | Vehículo de otro proveedor con ID válido y conocido | 404 |
| 25 | Contexto de pago COURIER_ADVANCE | `deliveryFee` 60.00, `goodsValue` 800.00, `driverAdvancesGoods` true, `driverAdvanceAmount` 800.00 en la asignación y en el detalle del Dispatch |
| 26 | Pedido PREPAID | `driverAdvancesGoods` false y `driverAdvanceAmount` null: nunca se presenta como adelanto del repartidor |
| 27 | Plazo de asignación | `claimedAt` + 5 min, distinto de `expiresAt` del Dispatch (+60 min) y anterior a él |
| 28 | Plazo vencido forzado | `assignmentOverdue` true; Dispatch y candidatura siguen CLAIMED (sin auto-release); asignar sigue permitido y la señal vuelve a false |
| 29 | Historial Carlos → Pedro → Luis | 3 filas REASSIGNED,REASSIGNED,ACTIVE; API 3 con la ACTIVE primero |
| 30 | Auditoría | CREATED/REASSIGNED/CANCELLED con assignmentId, dispatchId, providerId, driverId, vehicleId y actorUserId; 0 secretos (contraseña, JWT humano y B2B, clientSecret, teléfono del cliente) en 2372 líneas de log |
| 31 | Invariantes forzadas en SQL | Segunda ACTIVE por Dispatch/Driver/Vehicle (únicos parciales), asignación de otro proveedor o sobre Dispatch no CLAIMED (DELIVERY_ASSIGNMENT_INVALID), cambio de identidad y reapertura de fila cerrada (DELIVERY_ASSIGNMENT_IMMUTABLE) y salida de CLAIMED con ACTIVE (DISPATCH_HAS_ACTIVE_ASSIGNMENT): todas rechazadas |
| 31b | Escaneo de invariantes en `mandaria_db` y `mandaria_test` | 0 violaciones en 13 consultas (incluidas las V1.7) + objetos presentes (3 índices parciales, 8 constraints, trigger, dispatch_guard); fixtures del CHECK sin residuo |
| 32 | verify-migrations limpia + V1.0 → … → V1.7 → V1.8 con datos, sin reset | PASS; `migrate status` al día |
| 33 | Regresión V1.0–V1.7 (claim, release, memberships, Drivers/Vehicles, cancelación, Quotes, invitaciones) | E2E por archivo 148/148 (delivery-quotes y delivery-requests-b2b sufrieron la caída nativa de workers en Windows y pasaron 11/11 y 15/15 al repetirlos) |
| 34 | Calidad final | prisma validate, tsc, build, Oxlint, ESLint, docs:check PASS; 91 unitarias |
| — | Servidor durante el CHECK | 0 respuestas 5xx y 0 excepciones; 0 respuestas 429 (reinicios del validador para no consumir el límite por IP) |

Resultado real: **30/30** comprobaciones por HTTP + escaneo de base de datos sin violaciones. Sin bugs de producto; sin cambios de código. Dos expectativas del validador estaban mal y se corrigieron en el propio validador: dos reasignaciones simultáneas pueden responder 200 las dos (se serializan) y en el detalle del Dispatch el bloque `goods` usa cadenas decimales con `currency` hermano (forma V1.7), mientras `paymentContext` usa objetos `{amount, currency}`. Ambos comportamientos quedaron documentados (README y contrato de la web).

No verificado: Docker; entrega SMTP real; comportamiento con reloj del sistema desplazado hacia atrás (el CHECK constraint `endedAt >= assignedAt` lo rechazaría).

# Verificación V1.8-A — Provider Driver & Vehicle Assignment (2026-09-17)

Rama `v1.8-provider_driver_vehicle_assignment`, paquete 1.8.0, Node.js 24.15.0, PostgreSQL 18 local. Docker no ejecutado.

| Verificación | Resultado |
|---|---|
| Línea base antes de modificar | 81 unitarias; E2E 137/137 por archivo |
| Prisma validate / migrate status / drift | PASS / al día / vacío |
| Migración `20260917000900_delivery_assignments` en mandaria_db y mandaria_test (sin reset) | PASS; 0 filas creadas; datos V1.0–V1.7 intactos |
| Limpia + V1.0 → … → V1.7 → V1.8 con datos | PASS; DeliveryAssignment vacía, 8 constraints, 3 índices únicos parciales ACTIVE, trigger y `dispatch_guard` con DISPATCH_HAS_ACTIVE_ASSIGNMENT |
| TypeScript / Build / Oxlint / ESLint / docs:check | PASS |
| docs:openapi | 1.8.0; +7 rutas y +12 esquemas; 0 rutas o esquemas eliminados |
| npm test | 91 PASS (81 + 10 V1.8) |
| E2E por archivo | 148/148 (13 V1.8); 1 caída nativa de worker en delivery-requests-b2b, 15/15 al repetir |
| Arranque real `dist/main.js` (puerto 3010) | health 200; OpenAPI 1.8.0; 7 rutas de asignación mapeadas |
| Recursos asignables: sólo del dueño del claim, ACTIVE, con cuenta activa y libres; excluidos Driver suspendido, Driver con cuenta inactiva, Driver de otro proveedor, vehículo en taller y vehículo ajeno | PASS; emparejamiento V1.4 incluido |
| Asignar → 1 ACTIVE con `paymentContext` (deliveryFee 60.00, goodsValue, COURIER_ADVANCE, driverAdvancesGoods true, driverAdvanceAmount) | PASS; Dispatch sigue CLAIMED con `assignment` y `assignmentDeadline` |
| Segunda asignación al mismo Dispatch | 409 DISPATCH_ALREADY_ASSIGNED |
| Driver/Vehicle de otro proveedor o UUID inexistente | 404 (nunca 403 con detalles) |
| Proveedor candidato no dueño / SUPER_ADMIN / DRIVER / IntegrationClient / `providerId` o `status` en body / `?providerId=` ajeno | 409 DISPATCH_NOT_CLAIMED_BY_PROVIDER / 403 / 403 / 401 / 400 / 403 |
| Emparejamiento V1.4 en ambos sentidos (driver emparejado con otro vehículo y vehículo emparejado con otro driver) | 409 DRIVER_VEHICLE_MISMATCH; sin ACTIVE creada |
| Recursos ocupados y no elegibles | 409 DRIVER_BUSY / VEHICLE_BUSY / DRIVER_NOT_ELIGIBLE (suspendido y cuenta inactiva) / VEHICLE_NOT_ELIGIBLE |
| Reasignación: mismo par, motivos inválidos (2/501 caracteres, OTHER sin detalle, DELIVERY_CANCELLED) | 409 ASSIGNMENT_UNCHANGED / 400 |
| Reasignación válida | Anterior REASSIGNED con endedAt y motivo; nueva ACTIVE; 2 filas en historial; recursos anteriores liberados |
| Liberar Dispatch con asignación ACTIVE → cancelar → liberar | 409 DISPATCH_HAS_ACTIVE_ASSIGNMENT (sigue CLAIMED); CANCELLED con motivo; segunda cancelación 409 NO_ACTIVE_ASSIGNMENT; release 200 → OPEN; asignar sin claim 409 |
| Cancelación de la DeliveryRequest (SUPER_ADMIN) con asignación ACTIVE | Asignación CANCELLED con endReason DELIVERY_CANCELLED; Dispatch CANCELLED; historial conservado; recursos libres para el siguiente Dispatch |
| Emparejamiento V1.4 durante la entrega (asignar y desasignar vehículo del Driver) | 409 en ambos; permitido tras cerrar la asignación de entrega |
| Plazo: CLAIMED sin asignar tras TTL (5 min, reloj adelantado) | `assignmentOverdue` true; false tras asignar |
| 10 asignaciones simultáneas sobre un Dispatch | 1 × 201 y 9 × 409 (DISPATCH_ALREADY_ASSIGNED/ASSIGNMENT_CONFLICT); exactamente 1 ACTIVE en DB |
| Carreras por recurso: mismo Driver y mismo Vehicle en dos Dispatches | 1 × 201 por carrera; 1 ACTIVE por Driver y por Vehicle |
| Invariantes en PostgreSQL | Segunda ACTIVE por Dispatch/Driver/Vehicle, asignación para Dispatch no CLAIMED o de otro proveedor (DELIVERY_ASSIGNMENT_INVALID), cambio de driverId y reapertura de una fila cerrada (DELIVERY_ASSIGNMENT_IMMUTABLE) y salida de CLAIMED con ACTIVE (DISPATCH_HAS_ACTIVE_ASSIGNMENT) rechazados |
| Auditoría | DELIVERY_ASSIGNMENT_CREATED/REASSIGNED/CANCELLED con assignmentId, dispatchId, providerId, driverId, vehicleId y actorUserId; sin JWT, clientSecret, contraseñas, tokens ni teléfonos del cliente |
| Mutaciones M1–M10 | 10/10 detectadas |

No verificado: validación funcional completa por HTTP contra `dist/main.js` en ejecución (cubierta por E2E HTTP en proceso con logins reales) y Docker.

# CHECK V1.7-A — Dispatch Security, Concurrency & Domain Validation (2026-09-16)

| Verificación | Resultado |
|---|---|
| Línea base (prisma, tsc, build, Oxlint, ESLint, docs:check; unitarias; E2E por archivo) | PASS; 81; 137/137 |
| HTTP real contra `dist/main.js` (4 arranques, TTL 10 y 1, logins reales) | 24/24 PASS |
| OFFERED sin Dispatch; accept → OPEN, openedAt = acceptedAt, expiresAt +10 min | PASS |
| Quote CANCELLED y EXPIRED no aceptables; sin Dispatch | 409 QUOTE_NOT_ACCEPTABLE / QUOTE_EXPIRED |
| 20 aceptaciones simultáneas + repetición | 1 Dispatch, 1 evento DISPATCH_OPENED |
| Candidatos exactos A, B; C otra zona y D SUSPENDED excluidos; snapshot intacto tras desactivar cobertura y suspender | PASS; claims 409 PROVIDER_NOT_ELIGIBLE |
| No candidatos (IDs conocidos, aleatorios, malformados) | 404/400; nunca listados |
| A → B (query/body), campos de estado en body | 403 / 400 |
| DRIVER, SUPER_ADMIN, IntegrationClient | 403, 403, 401 |
| Claim A+B simultáneo ×3; 40 claims (20+20); 20 del mismo proveedor | 1 éxito por ronda; 1 transición y 1 evento |
| Liberación: no dueño, reclamo tras liberar, siguiente proveedor, 8 simultáneas | 409, 409, 200, 1 aplica |
| Carrera claim vs release ×3 | Estados válidos (B, B, OPEN) |
| Expirado: claims simultáneos; release tras ventana | 409 sin owner y EXPIRED persistido; EXPIRED sin reabrir |
| Cancelación OPEN (B2B) y CLAIMED (SUPER_ADMIN, también en carrera) | CANCELLED; owner conservado; claim 409 |
| Respuestas y logs | Sin JWT, clientSecret, passwordHash, tokenHash ni contactos |
| Invariantes SQL en mandaria_db y mandaria_test | 0 violaciones |
| verify-migrations V1.6.1 → V1.7 / migrate status | PASS / al día |
| E2E completa final | 137/137, sin caídas |

Sin bugs de producto; sin cambios de código.

# Verificación V1.7-A — Dispatch Engine & Provider Claiming (2026-09-16)

Rama `v1.7-dispatch_engine`, paquete 1.7.0, Node.js 24.15.0, PostgreSQL 18 local. Docker no ejecutado.

| Verificación | Resultado |
|---|---|
| Línea base antes de modificar | 69 unitarias; E2E 122/124 con 1 caída nativa (sin fallos) |
| Prisma validate / drift | PASS / vacío |
| Migración `20260917000800_dispatch_engine` en mandaria_db y mandaria_test (sin reset) | PASS; backfill 4 ACCEPTED → 4 Dispatch EXPIRED, 0 huérfanas |
| Limpia + V1.0 → … → V1.6.1 → V1.7 con datos | PASS; Quote ACCEPTED previa con 1 Dispatch EXPIRED sin candidatos; CHECK, únicos, índice parcial y triggers presentes |
| TypeScript / Build / Oxlint / ESLint / docs:check | PASS |
| npm test | 81 PASS (69 + 12 V1.7) |
| E2E por archivo | 137/137 (13 V1.7) |
| E2E suite completa | 7 corridas: 1–2 caídas nativas de worker cada una, 0 pruebas fallidas |
| Accept → Dispatch OPEN automático, openedAt = acceptedAt, expiresAt = +10 min (≠ vigencia de Quote) | PASS |
| Candidatos: A, B, P1, P2 sí; C (otra zona), D (SUSPENDED), F (cobertura INACTIVE) no; snapshot no cambia al desactivar cobertura | PASS |
| Sin proveedores elegibles | Aceptación 200; Dispatch OPEN sin candidatos; noProviderAvailable true |
| Aceptación repetida y 10 simultáneas | 1 Quote ACCEPTED, 1 Dispatch |
| Atomicidad (fallo forzado al insertar Dispatch) | 500; Quote sigue OFFERED; 0 Dispatch; reintento 200 con 1 Dispatch |
| Claim con login real (vista OFFER sin contactos, instrucciones, referencia ni cliente) → CLAIMED (OWNER) | PASS; claim repetido del ganador 200; otro proveedor 409 DISPATCH_ALREADY_CLAIMED y SUMMARY |
| No candidatos (C, D, F) | 404 en detalle y claim; ausentes del listado |
| Admin A con providerId B / SUPER_ADMIN / DRIVER / IntegrationClient / body con providerId | 403 / 403 / 403 / 401 / 400 |
| Varias memberships | sin providerId 409; providerId ajeno 403; providerId propio 200 |
| Liberación: no dueño 409, no candidato 404, motivo 2/501 caracteres 400; A libera → OPEN; A no reclama (409); B reclama; 5 liberaciones simultáneas → 1 OK + 4 409 | PASS |
| 3 rondas × 15 claims simultáneos de 5 proveedores | Exactamente 1 ganador por ronda; resto 409; 1 candidato CLAIMED |
| Expirado: no listado como AVAILABLE, detalle EXPIRED, claim 409 y persistido EXPIRED; liberar tras la ventana → EXPIRED | PASS |
| Cancelación de DeliveryRequest (B2B y SUPER_ADMIN) | OPEN → CANCELLED; CLAIMED → CANCELLED conservando claimedByProviderId; claim 409 DISPATCH_CANCELLED |
| Invariantes SQL | Segundo Dispatch por Quote, Dispatch para Quote no ACCEPTED, cambio de expiresAt, CLAIMED sin candidato CLAIMED, dos candidatos CLAIMED, RELEASED → OFFERED e inserción de candidato no OFFERED rechazados |
| Auditoría | DISPATCH_OPENED/CLAIMED/RELEASED/EXPIRED/CANCELLED y PROVIDER_COVERAGE_CREATED con providerId/actorUserId; sin tokens, clientSecret, contraseñas ni contactos |
| Mutaciones M1–M8 | 8/8 detectadas |

No verificado: validación HTTP contra `dist/main.js` en ejecución y Docker.

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
