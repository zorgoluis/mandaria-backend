# CHECK FINAL — Mandaria V1.12 B2B Integration Infrastructure

**Veredicto: COMPLETADA Y VALIDADA END-TO-END.**

Fecha: 2026-09-24. Rama `v1.12-B2B_webhook_delivery`, HEAD `3ed3d89`. Sin commit, sin push, sin
tocar `.env`. **No se encontró ningún defecto de producto.**

---

## 1. Qué se validó

Las cinco subversiones de V1.12 juntas, como una sola infraestructura, no una por una:

| | Alcance |
|---|---|
| **V1.12-A** | estado público de la DeliveryRequest: `REQUESTED`, `OPEN`, `ASSIGNED`, `DELIVERED`, `CANCELLED`, `EXPIRED` |
| **V1.12-B** | `delivery.completed` registrado atómicamente con la entrega; Outbox inmutable |
| **V1.12-C** | endpoint por IntegrationClient, HTTP fuera de la transacción logística, política SSRF, sin redirects, intentos append-only |
| **V1.12-D** | worker durable, lease con `FOR UPDATE SKIP LOCKED`, reintentos, agotamiento, recuperación tras reinicio, multi-instancia, HMAC-SHA256, secreto cifrado y rotación, at-least-once, reenvío manual |
| **V1.12-E** | listado, filtros, detalle, intentos, `NO_DELIVERY` derivado, rescate, salud del worker y resumen por cliente |

## 2. Congelación del producto

| | Antes | Después |
|---|---|---|
| Archivos de `src/**`, `prisma/**`, `package.json`, `package-lock.json` | 193 | 193 |
| SHA-256 combinado | `3c854daacaa8a8ed…b7b94ca0` | `3c854daacaa8a8ed…b7b94ca0` |
| Archivos con diferencia | — | **0** |
| `git status` | ` M .env` (cambio local previo del propietario) | ` M .env` + `?? docs/checks/v1.12-final-evidence.json` |

**El CHECK no modificó producto.** Lo único que aparece de nuevo es la evidencia que este documento
acompaña. El árbol de trabajo y `HEAD` son los mismos antes y después.

## 3. Entorno

```text
Node.js 24.15.0 · npm 11.12.1 · NestJS 11.2.4 · Prisma 6.19.3 · Vitest 4.1.2
PostgreSQL 18.6 (x86_64-windows) · TimeZone = America/Mexico_City
mandaria_db (desarrollo) · mandaria_test (pruebas) — ambas en localhost:5432
ROUTING_PROVIDER=google · MAIL_PROVIDER=smtp · NODE_ENV=development
```

Reloj comprobado: `now()`, `now() AT TIME ZONE 'UTC'` y `Date.now()` coinciden al milisegundo en
ambas bases, de modo que las comparaciones del worker no están desplazadas.

**`B2B_WEBHOOK_SECRET_KEY` no está configurada en el `.env` del propietario.** Es opcional en
desarrollo y **obligatoria en producción** (el arranque falla sin ella), así que no rompe nada hoy,
pero sin ella no se puede firmar ningún webhook con el backend local. La suite y el CHECK generan la
suya en memoria. Queda clasificado como **ENVIRONMENT**, no como defecto, y hay que resolverlo antes
de desplegar. Su valor no se imprimió en ninguna parte.

## 4. Seguridad de datos

`mandaria_db` no se tocó. Todo corrió contra `mandaria_test`, con fixtures identificables por el
prefijo `CHKFINAL_`. **No se ejecutó ningún reset.** Al terminar, la base quedó con un único usuario
—el autor de las políticas de crédito, que otras suites necesitan— y 0 solicitudes, 0 dispatches, 0
eventos, 0 estados de transporte, 0 intentos, 0 endpoints, 0 clientes y 0 asientos de ledger.

## 5. Cadena de migraciones

| Comprobación | Resultado |
|---|---|
| `prisma validate` | válido |
| `migrate status` en `mandaria_db` y `mandaria_test` | **23 migraciones**, al día en ambas |
| Migraciones en el repositorio | 23 |
| Drift (schema ↔ base) | **sin diferencias**, código de salida 0 |
| `verify-migrations` | **PASS** en cuatro bases desechables: cadena limpia V1.0 → V1.12-E, actualización V1.0 → V1.10, datos V1.9 → V1.10 y ledger V1.10-A → V1.12-E |

## 6. Barreras

39 casos en `.tmp/check-final/final.e2e-spec.ts` contra Nest real, PostgreSQL real y un receptor
HTTP local que **verifica la firma**. 51 barreras registradas, **51 en verde**. La evidencia
detallada está en [`docs/checks/v1.12-final-evidence.json`](checks/v1.12-final-evidence.json).

### Flujo y contrato

| § | Barrera | Resultado |
|---|---|---|
| 6 | Proveedor: B2B → quote → accept → CLAIM → assignment → DELIVER → Outbox → webhook | PASS; `/status` recorre OPEN → ASSIGNED → DELIVERED, un solo intento, firma verificada |
| 7 | Independiente: TAKE → DELIVER | PASS; mismo transporte, `execution.mode = INDEPENDENT` |
| 8 | Contrato del evento | PASS; sobre `{eventId, type, occurredAt, data}` y `data` con las 7 claves públicas, **comparado contra la fila del Outbox**, no reconstruido |
| 9 | Identidad: 1 completion = 1 evento | PASS; repetir `/deliver` y dos `/deliver` simultáneos no crean un segundo evento, ni una segunda asignación, ni un segundo `deliveredAt` |
| 10 | Atomicidad | PASS; con un fallo inyectado en el `INSERT` del Outbox, el Dispatch sigue `CLAIMED`, la asignación `ACTIVE`, 0 eventos y la economía idéntica |
| 11 | Observabilidad pública | PASS; `CLAIMED` se publica como `ASSIGNED` y el cuerpo tiene exactamente 7 campos |
| 12 | Frontera entre clientes | PASS; el 404 de una solicitud ajena es idéntico campo a campo al de una inexistente |
| 13 | Aislamiento de mutación B2B | PASS; las 11 operaciones (claim, assign, deliver, take, release, rescate, reenvío, rotar secreto, configurar webhook, detalle admin) rechazadas, sin mover nada |

### Inmutabilidad

| § | Barrera | Resultado |
|---|---|---|
| 14 | Outbox | PASS; payload, `occurredAt`, tipo, dueño, sujeto, DELETE, TRUNCATE y evento forjado: los 8 rechazados |
| 15 | Intentos | PASS; resultado, código HTTP, ordinal, evento, endpoint, DELETE, TRUNCATE, éxito sin 2xx y éxito sin código: los 9 rechazados |
| 16 | Congelación del payload | PASS; el cuerpo del reenvío es **byte a byte** el del primer envío |
| 49 | Barrido adversarial del transporte | PASS; **17 escrituras forjadas, ninguna aceptada** |
| 50 | Escaneo de integridad | PASS; **22 consultas, todas en 0** |

Nota honesta de §16: cambiar `DeliveryRequest.externalReference` por SQL crudo **sí se acepta** —esa
tabla no está declarada inmutable por ninguna versión— y el payload del evento **no cambió**. Eso es
precisamente la prueba de que es una instantánea y no una consulta con `JOIN`.

### Transporte

| § | Barrera | Resultado |
|---|---|---|
| 17 | Éxito al primer intento | PASS; 200/201/202/204 → `DELIVERED`, 1 intento, sin reintento |
| 18 | Clasificación | PASS; 408/425/429/500/503 → `PENDING`; 400/401/403/404/405/409/410/422/451 → `EXHAUSTED` al primer intento; timeout → `TIMEOUT`; puerto cerrado → `NETWORK`; 302 → terminal |
| 19 | Calendario | PASS; intervalos medidos **1, 5, 15 y 60 minutos**, sin esperar tiempo real |
| 20 | Agotamiento | PASS; 5 intentos → `EXHAUSTED`, con evento, `eventId`, payload y los 5 intentos intactos |
| 21 | Rescate | PASS; `RESCHEDULED`, no envía nada por sí mismo, no borra historia y compra exactamente un intento |
| 22 | Concurrencia de rescates | PASS; cuatro simultáneos → un `RESCHEDULED` y tres `ALREADY_PENDING`, contador en 5 |
| 23 | Reenvío de algo ya entregado | PASS; mismo `eventId`, `type`, `occurredAt` y cuerpo; timestamp y firma nuevos; `deliveredAt` no se vuelve a sellar |
| 24 | At-least-once | PASS; el mismo `eventId` llega dos veces con cuerpo idéntico. **Es el contrato, no un defecto** |
| 34 | Redirect | PASS; 302 hacia 127.0.0.1 registrado como fallo terminal, sin segunda petición |
| 36 | Lease | PASS; nadie toca un lease vigente; al caducar, otro worker recupera el trabajo |
| 37 | Multi-instancia | PASS; dos backends drenando a la vez, cada evento con exactamente un intento y un estado |
| 38 | Recuperación tras reinicio | PASS; un evento comprometido sin poder enviarse se descubre desde el Outbox tras rearrancar, sin intervención |

### Firma, secreto y destino

| § | Barrera | Resultado |
|---|---|---|
| 25 | HMAC | PASS; las cuatro cabeceras presentes, `v1=<64 hex>`, timestamp del **intento** |
| 26 | Manipulación | PASS; cuerpo, timestamp, firma alterados y secreto equivocado: los cuatro fallan |
| 27 | Reintento | PASS; mismo cuerpo, prueba propia de cada intento, ambas verificables |
| 28 | Almacenamiento del secreto | PASS; `v1:<iv>:<tag>:<ciphertext>`, descifra con la clave maestra y falla con otra; texto plano y estructura inválida rechazados por la columna |
| 29 | Barrido de fugas | PASS; **10 superficies** + logs + `docs/openapi.json`: **0 fugas** |
| 30 | Rotación | PASS; se muestra sólo al emitirlo; el intento siguiente firma con el nuevo y falla con el anterior; la historia no se regenera |
| 31 | Endpoint deshabilitado | PASS; sin petición y sin intentos inventados; se muestra como `NO_DELIVERY` y se reanuda al rehabilitarlo |
| 32 | Cambio de endpoint | PASS; el intento histórico conserva su URL, el nuevo va al destino de hoy |
| 33 | Regresión SSRF | PASS; **28 destinos hostiles rechazados** bajo ajustes de producción, un destino público legítimo aceptado, direcciones resueltas comprobadas en el momento de usarlas |

`http`, `localhost`, `127.0.0.1`, `127.1`, `[::1]`, `[::]`, IPv4 disfrazada de IPv6
(`[::ffff:127.0.0.1]`, `[::ffff:169.254.169.254]`), metadatos `169.254.169.254`, privadas 10/172/192,
CGNAT, benchmarking, ULA `fd00::`, link-local `fe80::`, `fc00::`, documentación `2001:db8::`,
multicast `ff02::`, credenciales en la URL, fragmento, `file://`, `ftp://`, `.internal`, `.local`,
`.home.arpa`, URL de más de 2048 caracteres y texto que no es una URL. Además, producción rechaza el
interruptor de destinos inseguros, la falta de clave maestra y los proveedores locales.

### Operación

| § | Barrera | Resultado |
|---|---|---|
| 39 | Salud del worker | PASS; conteos idénticos a SQL directo y `thisInstance` separado, declarando la configuración real |
| 40 | Listado | PASS; orden estable, varias páginas reconstruyen la misma lista, seis filtros coherentes |
| 41 | Detalle | PASS; 20 campos, instantánea congelada, endpoint sin secreto, historial completo |
| 42 | `NO_DELIVERY` | PASS; las tres razones reproducidas con casos reales; el enum de PostgreSQL sigue con tres etiquetas y ninguna fila lo guarda |
| 43 | Resumen por cliente | PASS; idéntico a SQL directo |
| 44 | Aislamiento por rol | PASS; sobre las **8 rutas**: PROVIDER_ADMIN 403, DRIVER 403, token B2B 401, anónimo 401 |

### Preservación

| § | Barrera | Resultado |
|---|---|---|
| 45 | Créditos | PASS; cuentas, saldos, ledger, `SERVICE_AWARD`, `SERVICE_REFUND`, snapshots y políticas idénticos tras agotar, rescatar, reintentar, reenviar y observar |
| 46 | Logística | PASS; Dispatch, DeliveryAssignment y DeliveryRequest byte a byte iguales; `DELIVERED` sigue terminal |
| 47 | Routing | PASS; **0 llamadas de routing** durante todo el procesamiento de webhooks |
| 48 | Contexto de pago | PASS; `DeliveryFinancialContext` intacto y el payload público no publica importes ni moneda |

### Historia y frontera

| § | Barrera | Resultado |
|---|---|---|
| 51 | Compatibilidad histórica | PASS; eventos de las tres épocas (B sin endpoint, C con intentos y sin estado, D/E completo) se leen sin error y conservan su historia |
| 52 | Frontera de aplicación | PASS; tras rearrancar el worker, tres pasadas no recogen nada anterior a `deliverFrom` |
| 53 | Sin entrega retroactiva | PASS; **HTTP calls = 0** para los no elegibles; la entrega manual sigue posible y no crea estado |

### Coste y registro

| § | Barrera | Resultado |
|---|---|---|
| 59 | Coste | PASS; con 46 eventos: `pageSize` 1 → 57 ms, `pageSize` 100 → **12 ms**, filtrado 10 ms, detalle 12 ms, pasada del worker 3 ms. Una página de 100 no cuesta como cien de una: no hay consulta por fila |
| 60 | Registros | PASS; **5 180 líneas de log**, 0 secretos, 0 JWT, 0 clave maestra, 0 ciphertext |

## 7. Contrato publicado y matriz de acceso

| Comprobación | Resultado |
|---|---|
| `docs:check` por el proceso oficial | **al día** |
| Rutas de V1.12 presentes en `docs/openapi.json` | 10 de 10, sobre 136 publicadas |
| Esquemas con propiedad de ciphertext o clave maestra | **0** de 186 |
| Esquemas que declaran `secret` | 1: `WebhookSecretResponse`, la respuesta de emisión que lo muestra una sola vez |
| Rutas administrativas de webhooks/eventos sin SUPER_ADMIN | **0** de 10 |
| Ruta pública de V1.12-A | `GET /delivery-requests/{publicId}/status`, scope `deliveries:read` |

## 8. Regresión

| Suite | Resultado | Línea base declarada por V1.12-E |
|---|---|---|
| Unitarias | **270/270 en 24 archivos** | 270/270 en 24 |
| E2E completa, una sola corrida (13:29) | **402/402 en 23 archivos** | 402/402 en 23 |
| Legacy (V1.7 CLAIM, V1.8 asignaciones, V1.9 TAKE, V1.10 consumo y devoluciones, V1.11 cierre) | **136/136 en 6 archivos** | — |
| E2E archivo por archivo sobre base limpia (cierre del CHECK) | **22 de 23 archivos completos y en verde**; `b2b-webhooks` se completa de forma intermitente | — |

`.tmp/**` sigue excluido del descubrimiento en `vitest.config.ts` y `vitest.config.e2e.ts`; el CHECK
vive en `.tmp/check-final/` con su propia configuración y no entra en las suites oficiales.

**Caída nativa de workers de Vitest en Windows.** Se observó durante el CHECK, se diagnosticó y se
aisló. Lo que se sabe, dicho con precisión:

1. **Una causa concreta encontrada y corregida.** El receptor HTTP de las propias suites no tenía
   manejador de `error`: varios casos cortan la petición a propósito (timeout, conexión cerrada) y
   el socket moribundo mataba el proceso. V1.12-E ya lo había corregido en
   `test/b2b-webhooks.e2e-spec.ts`; el andamio del CHECK, copiado de un CHECK anterior, arrastraba
   el defecto y se corrigió igual. Con eso, la suite del CHECK pasa 39/39 de forma repetible.
2. **Queda una inestabilidad del *pool* de procesos, no del código.** A lo largo de la sesión, la
   corrida completa dejó de ser reproducible: el proceso hijo muere **sin salida de error y en
   puntos distintos cada vez** (tras 27, 39, 40 y 51 casos del archivo de webhooks). Ninguna
   aserción falla por ello.
3. **Aislamiento controlado.** Archivo por archivo y con base limpia, **22 de los 23 archivos pasan
   completos**; el de webhooks —el único que levanta aplicaciones Nest adicionales y servidores
   HTTP— se completa de forma intermitente. El mismo archivo pasa **54/54 con
   `--pool=threads`**, lo que señala al *pool* de *forks* de Vitest en esta máquina y no al
   backend.
4. **Los fallos de aserción posteriores son contaminación, no producto.** Cuando un worker muere
   deja fixtures a medias; el archivo `independent-drivers` entonces falla porque su listado de
   despachos disponibles se llena de `OPEN` ajenos. Purgando la base vuelve a pasar 23/23, lo que
   cierra el diagnóstico.
5. **Descartado como causa:** conexiones de PostgreSQL (1 activa, máximo 100), memoria (13,9 GB
   libres de 32) y agotamiento de puertos efímeros (se drenó TIME_WAIT de 2 153 a 103 y el
   comportamiento no cambió).

Se clasifica como **ENVIRONMENT**. No hay ninguna evidencia de que el backend participe: no existe
una sola aserción fallida atribuible a su comportamiento. Recomendación operativa, **no aplicada**
porque un CHECK no cambia configuración: evaluar `pool: 'threads'` en `vitest.config.e2e.ts`, o
seguir la convención ya vigente en este repositorio desde V1.10-C de dar por válida la suite
**archivo por archivo**.

## 9. Clasificación de hallazgos

### PRODUCT DEFECT

**Ninguno.**

### CHECK DEFECT — corregidos en los scripts del CHECK, sin tocar producto

1. **Repetir `/deliver` es idempotente por diseño.** El CHECK esperaba ≥400; V1.11-A responde 200 con
   «already» al mismo dueño, sin escribir, igual que un ganador que repite su claim. Lo que había que
   exigir —y se exige— es que no nazca un segundo evento.
2. **Dos `/deliver` simultáneos devuelven 200 los dos.** Por lo mismo. La barrera correcta es que
   sólo uno escriba: un evento, una asignación y un único `deliveredAt`.
3. **`CLAIMED` se publica como `ASSIGNED`.** El CHECK esperaba que la asignación del repartidor
   cambiara el estado público; el mapa de V1.12-A lo traduce desde el claim, y eso es el contrato.
4. **El fallo inyectado en el Outbox se propaga como error de dominio (409), no como 500.** La
   barrera es que la petición no tenga éxito y nada se escriba, no un código concreto.
5. **El receptor del CHECK no manejaba errores de socket** y mataba al worker de Vitest. Mismo
   defecto que V1.12-E corrigió en la suite oficial; el andamio lo arrastraba.
6. **La matriz de 18 respuestas abría 18 servicios**, lo que agotaba el limitador de peticiones y
   movía créditos ajenos a la barrera. Se rebobina el transporte de **un** servicio, que es lo que la
   barrera mide y además permite comparar la economía de verdad.
7. **El timestamp de la firma va en segundos**, así que dos intentos dentro del mismo segundo firman
   idéntico. Es correcto; el caso separa los intentos para medir lo que pretendía medir.
8. **`docs/openapi.json` menciona el nombre `B2B_WEBHOOK_SECRET_KEY`** en la prosa que explica dónde
   vive la clave maestra. Decir dónde está no es revelarla; el barrido busca valores.
9. **Dejar un evento sin estado de transporte dentro de la frontera** hace que el worker lo
   reinscriba y choque con su propio `(eventId, attemptNumber)`, abortando la pasada. Sólo lo
   producen las fixtures —el producto nunca borra una fila de transporte— pero explica por qué una
   pasada puede quedarse sin hacer nada, y queda anotado.
10. **Acoplamiento a la disponibilidad del repartidor** en una barrera que no necesitaba asignación.

### ENVIRONMENT

1. **`B2B_WEBHOOK_SECRET_KEY` ausente del `.env` del propietario.** Obligatoria en producción;
   sin ella el backend local no puede firmar. Bloqueante de despliegue, no de código.
2. **Caída nativa de workers de Vitest en Windows**, descrita arriba: intermitente, sin salida de
   error, concentrada en el archivo de webhooks bajo el *pool* de *forks* y ausente con
   `--pool=threads`. Arrastra fallos por contaminación en archivos posteriores, que desaparecen al
   purgar la base.

### DOCUMENTATION

Ninguno pendiente: las limitaciones que este CHECK observó ya están escritas en README,
`docs/V1.12-D-RELIABLE-SECURE-WEBHOOK-DELIVERY.md`, `docs/V1.12-E-WEBHOOK-OPERATIONS.md` y BITACORA.

### KNOWN ACCEPTED RISK

| Riesgo | Dónde está documentado |
|---|---|
| Ventana de DNS rebinding entre la validación y el socket; protección SSRF «buena, no perfecta» | README, V1.12-D, BITACORA |
| At-least-once, nunca exactly-once: el consumidor debe deduplicar por `eventId` | README, V1.12-D |
| Sin dead-letter ni retención | README, V1.12-D/E |
| Política de reintentos global, en código | README, V1.12-D |
| Eventos anteriores a la frontera fuera de la entrega automática | README, V1.12-D/E |
| `NO_DELIVERY` legítimo y derivado | V1.12-E |
| Salud limitada a la instancia que responde | V1.12-E |
| El rescate es de uno en uno y sin auditoría persistente | V1.12-E |

Ninguno de ellos convierte V1.12 en FAILED, por decisión explícita del alcance de este CHECK.

## 10. Criterios de FAIL

Ninguno se cumplió:

```text
entrega logística sin Outbox obligatorio        no  (§9, §10, §50 entrega_sin_evento = 0)
evento duplicado por una única completion       no  (§9, §50 eventos_duplicados = 0)
pérdida durable de evento elegible              no  (§20, §31, §36, §38)
retry imposible después de restart              no  (§38)
corrupción por concurrencia                     no  (§9, §22, §37, §50)
cross-client data leak                          no  (§12, §41, §49, §50)
secreto expuesto                                no  (§28, §29, §54, §60)
firma incorrecta                                no  (§25, §26, §27, §30)
bypass SSRF nuevo grave                         no  (§33, §34)
modificación del Outbox                         no  (§14, §16, §49)
modificación del historial de attempts          no  (§15, §49)
webhook alterando créditos                      no  (§45)
webhook alterando logística                     no  (§46)
historical avalanche                            no  (§52, §53)
SQL capaz de romper una invariante protegida    no  (§14, §15, §49, §50)
```

## 11. Cierre

Fixtures del CHECK eliminadas por prefijo `CHKFINAL_`. No se borró historia protegida: el Outbox y
los intentos de las fixtures desaparecen con sus clientes porque son fixtures completas, y lo que no
puede borrarse legítimamente no se forzó. Backend, workers, receptores HTTP y procesos auxiliares
cerrados; sin procesos `node` residuales y sin puertos ocupados. La base de pruebas quedó con un
único usuario, el autor de las políticas de crédito que otras suites necesitan.

**Mandaria V1.12 B2B Integration Infrastructure — COMPLETADA Y VALIDADA END-TO-END.**
