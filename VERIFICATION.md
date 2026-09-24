# Verificación V1.12-A — B2B Delivery Status (2026-09-23)

Rama `v1.11-mvp-delivery-completion` sobre `fa68b3b`, paquete **1.12.0**, Node.js 24, PostgreSQL 18 local. Docker no ejecutado. **Sin commit ni push.** **Sin migración**: no se agregó ni modificó ninguna columna, tabla, índice, constraint ni trigger. Todo lo de estas tablas se ejecutó en esta tarea; las cifras de versiones anteriores se conservan más abajo como históricas.

| Verificación | Resultado |
|---|---|
| `prisma validate`; `migrate status` y drift (`migrate diff` esquema ↔ base) en **ambas** bases | Válido / al día (19 migraciones, ninguna nueva) / **sin diferencias** |
| `verify-migrations` (cadena V1.0 → V1.11-A) | PASS sin cambios: V1.12-A no toca la cadena de migraciones |
| build (`nest build`), Oxlint, ESLint, `docs:check` | PASS |
| `tsc -p tsconfig.json` | **4 errores preexistentes** en `test/migrations/award-boundary.check.ts` (importa Prisma desde `.tmp/check-v110d/…`, defecto heredado ya reportado en V1.10-E y V1.11-A); **0 en el código y las pruebas de V1.12-A** |
| Unitarias | **224/224 en 22 archivos**; 14 nuevas en `test/delivery-status.spec.ts`. Línea base: 210 |
| E2E por archivo | **331/331 en 21 archivos**, ninguno en rojo; 14 nuevas en `test/b2b-delivery-status.e2e-spec.ts`. Línea base: 317 en 20 archivos, igual a la registrada en V1.11-A |
| CHECK adversarial V1.12-A | **9/9** contra la aplicación Nest real y PostgreSQL real (`.tmp/check-v112a/adversarial.e2e-spec.ts`), sin modificar el producto |
| OpenAPI y matriz de acceso | Regenerados: ruta nueva `GET /api/v1/delivery-requests/{publicId}/status` (scope `deliveries:read`) en `docs/API_ACCESS.md`; esquemas `DeliveryStatusResponse` y `DeliveryExecutionResponse`; `info.version` sincronizado a 1.12.0 |

## Correspondencia entre estado interno y estado público (unitarias)

| Escenario del dominio | Estado público | Resultado |
|---|---|---|
| DeliveryRequest `CREATED` sin Dispatch | `REQUESTED` | PASS; `execution`, `deliveredAt` y `cancelledAt` nulos |
| DeliveryRequest `CANCELLED` sin Dispatch | `CANCELLED` | PASS; conserva `cancelledAt` |
| `Dispatch.OPEN` sin candidaturas, dentro de la ventana | `OPEN` | PASS; `execution` nulo (un OPEN sin candidatos no es un error para el cliente) |
| `Dispatch.OPEN` fuera de la ventana | `EXPIRED` | PASS; caducidad perezosa de V1.7 reutilizada, no reimplementada |
| `Dispatch.CLAIMED` por proveedor / por independiente | `ASSIGNED` | PASS; `execution.mode` `PROVIDER` / `INDEPENDENT` |
| Asignación de Driver y Vehicle sobre un servicio reclamado | `ASSIGNED` (sin cambio) | PASS; la asignación interna no es un estado público |
| `Dispatch.DELIVERED` (ambos modelos) | `DELIVERED` | PASS; `deliveredAt` presente, `cancelledAt` nulo |
| `Dispatch.CANCELLED` / `Dispatch.EXPIRED` | `CANCELLED` / `EXPIRED` | PASS; caducidad y cancelación no se confunden |
| Entrega completada y **después** cancelación de la DeliveryRequest | `DELIVERED` | PASS; el Dispatch manda, `cancelledAt` sigue nulo |
| Barrido de los cinco `DispatchStatus` internos | 5 estados públicos | PASS; ninguno produce `undefined`, `UNKNOWN` ni excepción |
| Llaves expuestas | 7 exactas | PASS; `publicId`, `externalReference`, `status`, `execution`, `requestedAt`, `deliveredAt`, `cancelledAt` |

## Ciclo real por HTTP (E2E)

| Escenario | Resultado |
|---|---|
| Proveedor: `OPEN` → CLAIM → ASSIGN → DELIVER, consultando en cada paso | PASS; `OPEN` → `ASSIGNED` → `ASSIGNED` → `DELIVERED`; `deliveredAt` **idéntico** al de la fila del Dispatch |
| Independiente: TAKE → DELIVER | PASS; misma forma pública con `execution.mode: INDEPENDENT` |
| Solicitud sin cotización aceptada | PASS; `REQUESTED`, nunca 500 |
| DeliveryRequest cancelada | PASS; `CANCELLED` con `cancelledAt`, `deliveredAt` nulo |
| Dispatch caducado | PASS; `EXPIRED`, distinto de una cancelación |
| Fuga de datos internos | PASS; ni el id del Dispatch ni `deliveredByUserId`, `driverId`, `vehicleId`, `providerId`, créditos, ledger, `goodsValue` ni `claimedBy*` aparecen en la respuesta |

## Aislamiento y autorización (E2E)

| Escenario | Resultado |
|---|---|
| Cliente B lee una solicitud del cliente A | PASS; 404 **indistinguible** del 404 de un `publicId` inexistente (idénticos salvo `timestamp` y `path`, que el propio llamante envió); ningún campo de la solicitud real se filtra; el dueño la sigue viendo con 200 |
| `publicId` inexistente para el propio dueño | PASS; mismo 404 `Delivery request not found` |
| Tokens SUPER_ADMIN, PROVIDER_ADMIN y DRIVER; sin token; token basura | PASS; **401 en los cinco** (un JWT humano no es válido en una ruta B2B) |
| Token B2B sin scope `deliveries:read` | PASS; 403 |
| Intentos de mutación (`POST`/`PATCH` `/status`, `/delivered`, claim, deliver y take de proveedor/repartidor con token B2B) | PASS; 404 o 401 en los seis; el Dispatch sigue `OPEN` |

## La lectura no tiene consecuencias (E2E)

| Escenario | Resultado |
|---|---|
| 12 lecturas seguidas de un servicio entregado | PASS; 12 respuestas idénticas; cuentas, saldos, ledger completo, snapshots y políticas **exactamente iguales**; Dispatch y asignación byte a byte iguales; 0 llamadas nuevas al proveedor de routing; ninguna línea de auditoría nueva que mencione la solicitud |
| 15 lecturas simultáneas | PASS; 15 × 200, una sola respuesta distinta, economía intacta |
| Lectura compitiendo con la entrega (10 lecturas ‖ 1 DELIVER) | PASS; toda lectura es `ASSIGNED` con `deliveredAt` nulo o `DELIVERED` con `deliveredAt` presente. **Nunca** se observó `DELIVERED` sin sello; al estabilizarse, `DELIVERED` |

## CHECK adversarial V1.12-A (9/9, sin modificar el producto)

| Barrera | Resultado |
|---|---|
| 14 identificadores hostiles (inyección SQL, `DROP TABLE`, longitud incorrecta, no ASCII, travesía de ruta, byte nulo, 400 caracteres, espacios) | PASS; sólo 400 o 404, **ningún 500**; la tabla objetivo de la inyección sigue intacta |
| Identificador en minúsculas | PASS; 200 y devuelve el `publicId` canónico, igual que el resto de rutas B2B |
| 10 rechazos repetidos del mismo recurso ajeno | PASS; una sola respuesta distinta: el 404 no crece en detalle al insistir |
| `POST`, `PUT`, `PATCH` y `DELETE` sobre la ruta de estado | PASS; 404 en los cuatro; la fila del Dispatch queda idéntica |
| Liberar un servicio ya reclamado (V1.10-E devuelve créditos) | PASS; la lectura vuelve a `OPEN` con `execution: null`; un segundo proveedor reclama y vuelve a reportarse `PROVIDER`. `execution` no es pegajoso |
| 60 lecturas seguidas | PASS; sólo 200 o 429 (límite compartido por IP), nunca error; una sola respuesta distinta; economía intacta |
| Reinicio de la aplicación entre dos lecturas | PASS; respuesta idéntica: proviene de la base, no de memoria de proceso |
| Contrato publicado vs. respuesta viva | PASS; OpenAPI declara la ruta, su 404 y los seis estados; las llaves del esquema coinciden **exactamente** con las de la respuesta real |
| Ciclo de vida completo observado | PASS; se alcanzaron `OPEN`, `ASSIGNED`, `DELIVERED`, `CANCELLED` y `EXPIRED`, todos dentro del contrato |

## Nota sobre la base de pruebas

Corridas E2E anteriores que Vitest mató a mitad (caída nativa de workers en Windows, y una corrida envenenada porque `vitest.config.e2e.ts` incluye `**/*.e2e-spec.ts` y recogió suites de CHECK dejadas en `.tmp/`, que agotaron el límite por IP) dejaron `mandaria_test` con 99 drivers, 48 proveedores, 383 solicitudes, 86 Dispatches `CLAIMED` y una asignación `ACTIVE` huérfana. Eso hacía fallar 17 pruebas ajenas a V1.12-A por paginación y recursos ocupados. Con autorización del propietario se ejecutó `npm run db:test:reset` sobre la base dedicada `mandaria_test` (`mandaria_db` no se tocó) y la batería completa quedó en verde. Queda anotado que la configuración E2E recoge suites de `.tmp/`.

---

# Verificación V1.11-A — MVP Delivery Completion (2026-09-23)

Rama `v1.11-mvp-delivery-completion` sobre `5d079db` (merge de V1.10), paquete **1.11.0**, Node.js 24, PostgreSQL 18 local. Docker no ejecutado. **Sin commit ni push.** Todo lo de estas tablas se ejecutó en esta tarea; las cifras de versiones anteriores se conservan más abajo como históricas.

| Verificación | Resultado |
|---|---|
| Migraciones `20260923001500_delivery_completion_states` y `20260923001600_delivery_completion_rules` en `mandaria_db` y `mandaria_test` (sin reset) | PASS; **0 filas históricas modificadas**: ningún Dispatch pasó a `DELIVERED` ni ninguna asignación a `COMPLETED`. `mandaria_db` al cierre: 76 Dispatches (0 DELIVERED), 54 asignaciones (0 COMPLETED) |
| `prisma validate`; `migrate status` y drift (`migrate diff` esquema ↔ base) en **ambas** bases | Válido / al día / **sin diferencias** |
| `verify-migrations` (4 bases desechables) | PASS: limpia, V1.0 → V1.10, datos V1.9 → V1.10 y V1.10-A → B → C → D → E → **V1.11-A**; en las cuatro: 0 DELIVERED, 0 COMPLETED, ambos valores de enum presentes, `deliveredAt`/`deliveredByUserId` anulables y sin default, índice `Dispatch_status_deliveredAt_idx`, FK RESTRICT, los dos CHECK reescritos y el retorno temprano de `dispatch_award_refund_required` |
| build (`nest build`), Oxlint, ESLint, `docs:check` | PASS |
| `tsc -p tsconfig.json` | **1 error preexistente** en `test/migrations/award-boundary.check.ts` (importa Prisma desde `.tmp/check-v110d/…`, defecto heredado ya reportado en V1.10-E); **0 en el código y las pruebas de V1.11-A** |
| Unitarias | **202/202 en 19 archivos**; 22 nuevas en `test/delivery-completion.spec.ts`. Línea base medida en este árbol antes de agregarlas: **180 en 18 archivos** |
| E2E por archivo | **317/317 en 20 archivos**, sin ningún archivo en rojo; 29 nuevas en `test/delivery-completion.e2e-spec.ts`. Línea base: 288 en 19 archivos, igual a la registrada en V1.10-E |
| OpenAPI y matriz de acceso | Regenerados: dos rutas nuevas en `docs/API_ACCESS.md` (`POST /api/v1/provider/dispatches/{dispatchId}/deliver` → PROVIDER_ADMIN y `POST /api/v1/driver/dispatches/{dispatchId}/deliver` → DRIVER) y `info.version` sincronizado a 1.11.0 |

## Flujo de proveedor (HTTP real)

| Escenario | Resultado |
|---|---|
| CLAIM → ASSIGN → `POST /provider/dispatches/:id/deliver` | 200; Dispatch `DELIVERED`, `deliveredByUserId` = el PROVIDER_ADMIN autenticado, `deliveredAt` del servidor, `claimedByProviderId` congelado, `cancelledAt`/`expiredAt` nulos, `access` sigue siendo OWNER |
| Asignación cerrada | `COMPLETED` con `endedAt` **idéntico** a `deliveredAt` y `endedByUserId` del mismo usuario; `endReason` y `endReasonDetail` nulos; `driverId`, `vehicleId` y `assignedAt` intactos |
| Liberación de recursos | 0 asignaciones ACTIVE del Driver tras entregar; el **mismo** Driver y el **mismo** Vehicle ejecutan y entregan el Dispatch siguiente |
| Confirmación repetida | 200 sin cambios: `deliveredAt` y `updatedAt` idénticos, sigue habiendo una sola asignación |
| Claim sin Driver ni Vehicle | 409 `NO_ACTIVE_ASSIGNMENT`; el Dispatch sigue `CLAIMED` |
| Body con `deliveredAt`, `deliveredByUserId` o `providerId` | 400 en los tres casos; el Dispatch sigue `CLAIMED` |

## Flujo independiente (HTTP real)

| Escenario | Resultado |
|---|---|
| TAKE → `POST /driver/dispatches/:id/deliver` | 200; `DELIVERED`, `claimedByIndependentDriverId` conservado, `deliveredByUserId` = el propio repartidor; asignación `COMPLETED` en modo `INDEPENDENT` sin motivo de fin |
| Disponibilidad posterior | `GET /driver/me` devuelve `independent.canTakeServices: true` y `activeDeliveryAssignment: null`; el repartidor toma y entrega otro servicio a continuación |
| Servicio liberado | 409 `DISPATCH_NOT_CLAIMED_BY_DRIVER` |
| Suspensión durante la ejecución | **Imposible por dominio**: suspender a un repartidor con asignación ACTIVE responde 409 `INDEPENDENT_DRIVER_HAS_ACTIVE_ASSIGNMENT` (invariante V1.9). Tras entregar, la suspensión sí procede (200), el repartidor suspendido ya no puede tomar servicios y el entregado permanece `DELIVERED` |
| La puerta de aprobación no se repite al cerrar | Unitaria con doble de Prisma: `complete` escribe la entrega sin leer nunca `IndependentDriverProfile` |

## Autorización — sólo el actor que tiene el servicio

| Principal | Resultado |
|---|---|
| SUPER_ADMIN | **403** en las dos rutas |
| Driver de flotilla del proveedor que ejecuta el servicio | **403** (rol global distinto de PROVIDER_ADMIN) |
| Cliente B2B | **401** (no es token humano) |
| Sin token | **401** |
| Otro proveedor candidato | **409** `DISPATCH_NOT_CLAIMED_BY_PROVIDER` |
| Proveedor que nunca fue candidato | **404**, igual que un id inexistente |
| Otro DRIVER no habilitado como independiente | **409** |
| PROVIDER_ADMIN sobre un servicio tomado por un independiente | **409** `DISPATCH_NOT_CLAIMED_BY_PROVIDER` |
| Proveedor que liberó, o servicio cancelado | **409** `DISPATCH_NOT_CLAIMED_BY_PROVIDER` |

En todos los casos el Dispatch quedó `CLAIMED` y su asignación `ACTIVE`: ninguna denegación escribió nada.

## Terminalidad e irreversibilidad

| Intento sobre un Dispatch `DELIVERED` | Resultado |
|---|---|
| `POST /provider/.../release` | 409 `DISPATCH_NOT_CLAIMED_BY_PROVIDER` |
| `POST /provider/.../assignment/reassign` | 409 `DISPATCH_NOT_CLAIMED_BY_PROVIDER` |
| `POST /provider/.../assignment/cancel` | 409 `DISPATCH_NOT_CLAIMED_BY_PROVIDER` |
| `POST /provider/.../claim` (el dueño y otro candidato) | 409 `DISPATCH_DELIVERED` en ambos |
| `POST /driver/.../take` | 409 `DISPATCH_DELIVERED`; además no aparece en `GET /driver/dispatches/available` |
| Cancelar la DeliveryRequest después de entregar | 200 en la cancelación y el Dispatch **no cambia**: sigue `DELIVERED`, `cancelledAt` nulo, `deliveredAt` idéntico y su asignación sigue `COMPLETED` |

## Cero impacto económico

| Verificación | Resultado |
|---|---|
| Saldo del proveedor antes/después de entregar | **Idéntico**; 0 entradas nuevas en el ledger para ese Dispatch; el `SERVICE_AWARD` sigue siendo exactamente uno |
| Saldo del repartidor independiente | **Idéntico** tras entregar; 0 `SERVICE_REFUND` |
| Recálculo | La Quote conserva `amount`, `distanceMeters` y hasta su `updatedAt`; los `DispatchCreditSnapshot` conservan sus créditos |
| Devolución forzada por SQL contra un servicio entregado | Rechazada; siguen 0 `SERVICE_REFUND` |
| Logs | Un solo `DELIVERY_COMPLETED` por entrega, con Dispatch, asignación, modo, actor e instante; **0 coincidencias** del JWT del proveedor, del token B2B, de la contraseña de fixtures o del teléfono de contacto |

## Escrituras forjadas en SQL rechazadas (11)

`DELIVERED` con la asignación todavía ACTIVE (`DISPATCH_HAS_ACTIVE_ASSIGNMENT`); `DELIVERED` sin sello y sello sin `DELIVERED` (`Dispatch_values_check`, 2); reabrir a `CLAIMED`, cancelar, reescribir `deliveredAt` y reescribir `deliveredByUserId` sobre un entregado (`DISPATCH_IMMUTABLE`, 4); devolver una asignación `COMPLETED` a `ACTIVE` (`DELIVERY_ASSIGNMENT_IMMUTABLE`); `COMPLETED` con motivo de fallo y `COMPLETED` sin autor del cierre (`DeliveryAssignment_values_check`, 2); e insertar un `SERVICE_REFUND` contra el award de un servicio entregado.

## Concurrencia

| Carrera | Resultado |
|---|---|
| 6 confirmaciones simultáneas del mismo proveedor | Exactamente **una** asignación, en `COMPLETED`; Dispatch `DELIVERED` una sola vez; todas las respuestas 200 o 409, ninguna 5xx |
| Entrega contra liberación (proveedor) | Exactamente una de las dos aplica: o `DELIVERED` + asignación `COMPLETED` + 0 devoluciones, o `OPEN` + `deliveredAt` nulo + asignación `CANCELLED`. Nunca ambas |
| Entrega contra liberación (independiente) | Igual, y en los dos desenlaces el repartidor queda con **0** asignaciones ACTIVE |

## Defectos propios encontrados y corregidos durante la implementación

- `claimRejection` (V1.7) y `takeRejection` (V1.9) no contemplaban `DELIVERED`: un candidato podía intentar reclamar un servicio ya entregado y el rechazo llegaba desde un trigger de PostgreSQL, lo que en el flujo de proveedor habría salido como 500. Se agregó el código de dominio `DISPATCH_DELIVERED` (409) en ambos modelos de ejecución.
- La vista de proveedor degradaba a `SUMMARY` al entregar, dejando al dueño sin el detalle del servicio que acababa de cerrar; `DELIVERED` se agregó al conjunto `OWNER`.
- `src/setup.ts` publicaba la versión OpenAPI fija `1.10.0`, que dejó de coincidir con `package.json` al subir a 1.11.0 y hacía fallar la comprobación de contrato de `driver-self.e2e-spec.ts`. Sincronizada.

## Errores del propio arnés de pruebas (no del producto)

Ruta equivocada para crear el vehículo del repartidor independiente; `financialContext` omitido en la creación de la DeliveryRequest; siete inicios de sesión contra el límite real de 5/minuto por IP (ahora se reinicia la aplicación entre bloques); casos que dejaban asignaciones ACTIVE y hacían fallar al siguiente con `DRIVER_BUSY`; una premisa equivocada sobre suspender a un repartidor en plena ejecución (lo impide V1.9, y la prueba ahora verifica esa garantía); y una aserción que apuntaba a `DeliveryAssignment_values_check` cuando el motivo `OTHER` disparaba antes `DeliveryAssignment_reason_check`.

## Acoplamiento entre suites E2E detectado y neutralizado

Una corrida de la suite nueva que Vitest mató a mitad (caída nativa de workers en Windows) dejó fixtures en `mandaria_test` con asignaciones ACTIVE y Dispatches `CLAIMED` sin ejecutor. `independent-drivers.e2e-spec.ts` recorre **toda** la base —su `freeAll()` cierra cualquier asignación ACTIVE y una de sus aserciones cuenta Dispatches independientes reclamados sin asignación ACTIVE en toda la base—, así que ese archivo falló dos veces por datos ajenos, no por código: 15/23 la primera vez y 1/23 la segunda. Correcciones aplicadas a la suite nueva:

- su limpieza entre casos ya no deja un Dispatch `CLAIMED` sin ejecutor: cierra la asignación **y** saca el Dispatch de `CLAIMED`, purgando el cargo con el interruptor que PostgreSQL sólo honra en bases `*_test`, igual que hace `freeAll()`;
- su limpieza final resuelve los fixtures **por prefijo** en la base, no desde memoria, y se ejecuta también **antes** de crear los suyos, de modo que una corrida interrumpida se limpia sola en la siguiente.

Tras estos cambios la suite completa quedó en 317/317 con 20 de 20 archivos en verde. Queda anotado, sin tocarlo, que `freeAll()` de `independent-drivers` sigue siendo global en lugar de limitarse a sus propios fixtures.

## Incidencias y notas de entorno

- La caída nativa de workers de Vitest en Windows apareció en varias corridas (`providers`, `user-invitations`, `credit-refunds`, `delivery-quotes`, `delivery-requests-b2b` y la suite nueva); todas pasaron completas al repetirlas, como en versiones anteriores. En la corrida final sólo `user-invitations` necesitó un reintento.
- Discrepancia en el conteo histórico: este árbol (HEAD `5d079db`, que ya incluye V1.10-E) tiene **180** pruebas unitarias antes de esta tarea, mientras que el registro de V1.10-E anota 188. No se reprodujo ni se investigó esa cifra; las de esta verificación son las medidas ahora.

## Limpieza

Fixtures de la suite nueva eliminados de `mandaria_test`: 0 usuarios `@completion.test`, 0 proveedores `E2E_DEL_`, 0 asignaciones ACTIVE en toda la base, 0 Dispatches independientes reclamados sin ejecutor y 0 Dispatches `DELIVERED` residuales. Las 4 bases desechables que `verify-migrations` creó en esta tarea fueron eliminadas; las de tareas anteriores no se tocaron. No quedó ningún servidor ni worker levantado. `mandaria_db` sólo recibió las dos migraciones nuevas; **no se modificó `.env`**.

# CHECK FINAL V1.10-E — Refunds & Reversals, validación adversarial (2026-09-23)

Rama `v1.10-credit-monetization`, HEAD `0a5ab3f` + V1.10-E sin commit, paquete 1.10.0, `NODE_ENV=test`, routing `spy` (proveedor doble con contador). Validador temporal fuera del código del producto (`.tmp/check-v110e/`) contra la aplicación real levantada en puerto efímero sobre `mandaria_test`, con autenticación real y fixtures propios. Migraciones reales (17), sin `db push`. `mandaria_db` no se tocó. **69/69 comprobaciones PASS, 0 FAIL. Sin cambios de código ni de reglas durante el CHECK.**

| # | Verificación | Resultado |
|---|---|---|
| 1-2 | Línea base y estados reales | Dispatch {OPEN,CLAIMED,EXPIRED,CANCELLED}, DeliveryRequest {CREATED,CANCELLED}, DeliveryAssignment {ACTIVE,REASSIGNED,CANCELLED}; 0 saldos negativos y 0 descuadres; eventos de reversión: `/provider/.../release`, `/driver/.../release`, cancelación de DeliveryRequest; **no existen** STARTED/IN_PROGRESS/PICKED_UP |
| 3-6 | Devolución del proveedor | 20 → cargo −7 → 13 → release → **20**; la fila del award queda idéntica; refund +7; con la política cambiada a 20 créditos/km el refund sigue siendo +7; **0 llamadas de routing** |
| 7-8 | Release y otro proveedor | A queda en neto 0 y B paga su propio −7; el mismo proveedor **no puede** volver a reclamar (409 `DISPATCH_RECLAIM_NOT_ALLOWED`), así que «award #2 del mismo proveedor» no existe en el dominio |
| 9-10 | Reasignación y cancelación de asignación | Dos reasignaciones y una cancelación de asignación: 0 devoluciones, saldo intacto, Dispatch sigue CLAIMED por su proveedor |
| 11-12 | Cancelación de la entrega | Devuelve +7 al proveedor y deja el Dispatch CANCELLED; cancelar antes de que alguien gane no escribe ningún movimiento (ni de 0 créditos) |
| 13-14 | Repartidor independiente | TAKE −14 y devolución +14 tanto por release como por cancelación; siempre a la cuenta del repartidor, nunca a la del proveedor; el refund cae en la **misma cuenta** que pagó |
| 15-17 | Duplicados | Dos releases seguidos → 1 refund (el segundo 409); 10 releases simultáneos → 1 refund; 10 cancelaciones simultáneas → 1 refund |
| 18-20 | Carreras y repetición | Release contra cancelación → 1 refund (nunca saldo +7 de más); 20 operaciones concurrentes → 1 refund y 0 duplicados en toda la base; devolver de nuevo un award ya compensado no acredita nada |
| 21-23 | Frontera histórica | LEGACY: reclamado y liberado sin award ni refund (`SERVICE_REFUND_SKIPPED_LEGACY`); la exención PRE_ENFORCEMENT **no se puede fabricar** (`CREDIT_HISTORY_IMMUTABLE`, sólo migración); ENFORCED sin cargo → **falla cerrado** 409 `CREDIT_REFUND_INTEGRITY_ERROR`, nada se mueve y queda `SERVICE_REFUND_INTEGRITY_FAILURE` |
| 24-33, 36, 38-40 | 20 escrituras forjadas en SQL | Rechazadas todas: sin award, award inexistente, +8, +6, −7, 0, a otro proveedor, a un repartidor, del award de otro Dispatch, apuntando a otro Dispatch, sin reversión operacional, duplicada (secuencial y 4 concurrentes), UPDATE y DELETE de award y de refund, y subir el saldo sin ledger |
| 34-35, 37 | Reversión operacional en SQL | Liberar o cancelar a mano un servicio pagado → `CREDIT_REFUND_REQUIRED` (trigger diferido) y el Dispatch queda intacto; la transacción legítima (reversión + refund) **sí** confirma |
| 41-44 | Rollback con fallo inyectado | Con un trigger temporal que hace fallar el `SERVICE_REFUND` de esa cuenta: release y cancelación fallan y revierten todo (Dispatch CLAIMED, DeliveryRequest CREATED, saldo 13, 0 refunds); al retirar la inyección el mismo release funciona |
| 45-49 | Concurrencia económica | Refund contra recarga → saldo 30 con ledger reconstruible; refund contra ajuste → 12 sin lost update; refund contra un cobro nuevo → sólo los dos órdenes válidos; release de A contra claim de B → un único dueño y B paga sólo si gana; cancelación contra claim → neto 0 |
| 50-55 | Seguridad de API | `refundAmount`, `credits`, `amount`, `awardId`, `reversesEntryId`, `creditAccountId`, `actorType`, `refundReason` y `balanceAfter` enviados por el cliente no deciden nada (el contrato rechaza el cuerpo con 400); 24 intentos sobre 6 rutas plausibles de refund manual con SUPER_ADMIN, PROVIDER_ADMIN, DRIVER y B2B → **404** |
| 56-59 | Regresiones e integridad | `deliveryFee` 60.00 MXN, `goodsValue` 800.00, `driverAdvanceAmount` 800.00 y el modo de pago intactos; los 2 snapshots idénticos; la fila completa del award idéntica; cada refund responde quién pagó, cuánto, por qué Dispatch, cuándo y por qué motivo |
| 60-62 | Ledger y varios awards | 24 movimientos (RECHARGE, SERVICE_AWARD, SERVICE_REFUND, ADMIN_ADJUSTMENT) reconstruyen exactamente el saldo; devolver uno de tres awards sólo afecta a ese; el refund nombra su award (el de B, con importe distinto al de A, para descartar la heurística del «último award») |
| 63-65 | Escaneos | 0 violaciones: sin refund sin award, cuenta o Dispatch equivocados, importe distinto al opuesto, refunds no positivos, duplicados, actor incoherente, saldos negativos, descuadres, reversión sin devolución o devolución con el servicio aún adjudicado. LEGACY y PRE_ENFORCEMENT reportados aparte: 0 créditos gratis |
| 66-67 | Migración V1.10-D → V1.10-E | Base temporal con el esquema previo a la frontera, historia sembrada (cuentas, recarga, ajuste, 3 Dispatches: LEGACY, ENFORCED con award y uno pre-enforcement), migración de frontera V1.10-D aplicada (crea la exención) y luego **V1.10-E con `migrate deploy`**: todas las tablas previas idénticas (filas y hash), **0 devoluciones creadas**, saldo 373, 1 award, 1 exención, 4 snapshots, sin drift. Base temporal eliminada |
| 68-74 | Regresión y calidad | prisma validate, migrate status (ambas), sin drift (ambas), verify-migrations (cadena V1.0 → V1.10-E), build, Oxlint, ESLint, docs:check PASS; **188/188 unitarias**; **288/288 E2E en 19 archivos**, sin caída de workers en esta corrida |
| 75 | Conteo adversarial | **69 PASS / 0 FAIL** |
| 76 | Logs | 3307 líneas: 0 JWT, 0 cabeceras de autorización, 0 secretos B2B/SMTP, 0 respuestas 5xx, 0 unhandled, 0 deadlocks, 0 errores de serialización; 19 `SERVICE_REFUND_ISSUED`, 1 `SERVICE_REFUND_SKIPPED_LEGACY`, 1 `SERVICE_REFUND_INTEGRITY_FAILURE`; los errores SQL provocados a propósito quedaron en el cliente del CHECK, no en el servidor |
| 77 | Limpieza | Fixtures del CHECK eliminados de `mandaria_test` (0 proveedores, 0 clientes, 0 usuarios `@check-v110e.test`), 0 descuadres, 0 saldos negativos, políticas operativas base intactas (2 ACTIVE); triggers de inyección retirados; bases temporales borradas |
| 78 | Documentación | README, BITACORA, VERIFICATION y API-CONTRACT dicen explícitamente que el `SERVICE_AWARD` nunca se modifica y que la devolución es un `SERVICE_REFUND` compensatorio; ninguno afirma lo contrario |

**Bugs del producto encontrados: ninguno.** No se modificó código ni reglas durante el CHECK.

**Errores del propio validador (corregidos en el validador, no en el producto):** identificadores de vehículo en minúsculas contra el CHECK de formato; el límite real de 20 releases/minuto por IP exigía reiniciar la aplicación entre bloques de tormenta; una premisa equivocada en el punto 62 (el costo se congela al **abrir** el Dispatch, no al reclamarlo, así que los tres awards salían iguales); y restos de una corrida anterior del propio CHECK que descuadraban dos cuentas de fixtures en la línea base. Ninguno afectó al producto.

**Defecto heredado ya reportado (sigue abierto):** `test/migrations/award-boundary.check.ts`, commiteado en V1.10-D, importa Prisma desde `.tmp/check-v110d/...`; rompe `tsc -p tsconfig.json` con 4 errores (el `build` del proyecto no lo ve). No se tocó en este CHECK.

**Riesgos restantes.** Sin penalización por reservar y soltar (reclamar y liberar repetidamente tiene costo neto 0). Sólo devoluciones completas. Un Dispatch monetizado cuyo cargo desaparezca queda inrevertible hasta corregir los datos. El dueño de las tablas puede desactivar triggers: en producción, rol que no sea dueño y base que no termine en `_test`.

# Verificación V1.10-E — Refunds & Reversals (2026-09-23)

Rama `v1.10-credit-monetization` sobre `0a5ab3f` (V1.10-D publicada), paquete 1.10.0, Node.js 24, PostgreSQL 18 local. Docker no ejecutado. Sin commit ni push. **V1.10-E nunca modifica un SERVICE_AWARD: una devolución es un SERVICE_REFUND compensatorio e inmutable, y sólo existen devoluciones completas asociadas a eventos operacionales soportados.**

| Verificación | Resultado |
|---|---|
| Migración `20260923000300_service_refunds` en `mandaria_db` y `mandaria_test` (sin reset) | PASS; **0 devoluciones creadas**: los awards históricos quedan exactamente como estaban |
| `verify-migrations` | PASS: limpia, V1.0 → V1.10, datos V1.9 → V1.10 y V1.10-A ledger → V1.10-B → V1.10-C → V1.10-D → **V1.10-E**; 0 SERVICE_REFUND en las bases migradas; trigger de refund, trigger diferido de reversión, índice único parcial, CHECK, FK y enum presentes; el ledger V1.10-A conserva cada columna anterior con el mismo valor |
| prisma validate / migrate status (ambas) / drift (ambas) | PASS / al día / vacío |
| build, Oxlint, ESLint, docs:check | PASS |
| tsc | 4 errores **preexistentes** en `test/migrations/award-boundary.check.ts` (importa Prisma desde `.tmp/check-v110d/...`, ver «Defectos heredados»); 0 en el código de V1.10-E |
| Unitarias | **188/188** (10 nuevas de devoluciones) |
| E2E por archivo | **288/288** en 19 archivos (22 nuevas); `providers` y `user-invitations` sufrieron la caída nativa de workers de Windows y pasaron completas al repetirlas |
| Release de proveedor | Saldo 20 → award −7 → 13 → release → **20**; el award queda idéntico byte a byte y el refund +7 lo referencia con motivo `PROVIDER_RELEASE`; impacto neto 0 |
| Política irrelevante | Con la política cambiada a 20 créditos/km después del cobro, la devolución sigue siendo **+7** |
| Release y nuevo proveedor | A libera (neto 0) y B reclama pagando **su propio** award; al liberar B recibe su propia devolución (2 awards, 2 refunds) |
| Release de repartidor independiente | Devuelve a la cuenta del repartidor (14), nunca a la del proveedor de su flotilla; motivo `INDEPENDENT_RELEASE` |
| Cancelación de la entrega | Devuelve al proveedor (7) y al repartidor (14) según quién tuviera el servicio; motivo `DELIVERY_CANCELLED`; el Dispatch queda CANCELLED |
| Cancelación sin adjudicación | 0 awards, 0 refunds y **ningún movimiento de 0 créditos** |
| Reasignación y cancelación de asignación | Asignar, reasignar y cancelar la asignación **no devuelven nada**: el Dispatch sigue reclamado por el proveedor; al liberarlo después sí se devuelve |
| Duplicados | Release repetido → 409 y 1 solo refund; cancelación repetida (×3) → 200 y 1 solo refund |
| Alta contención | 10 reversiones simultáneas (5 releases + 5 cancelaciones) → **1 refund** y saldo íntegro |
| Release contra cancelación | Simultáneos → exactamente **1** refund; estado final permitido por las reglas existentes |
| Devolución contra recarga y ajuste | Release + recarga 20 + ajuste 5 simultáneos → 200/201/201, saldo 32 y ledger reconstruible entrada por entrada |
| Devolución contra un cobro nuevo | Sólo dos resultados posibles según el orden serializado (el nuevo claim cobra la devolución, o falla por saldo); ningún otro |
| Legacy | Release de un Dispatch LEGACY: 0 devolución, nada se mueve, log `SERVICE_REFUND_SKIPPED_LEGACY` |
| Pre-enforcement | La exención histórica es **sólo de migración** (V1.10-D): un intento de fabricarla se rechaza con `CREDIT_HISTORY_IMMUTABLE`, así que la clase no se puede forjar; la regla de no devolver para esa clase está cubierta por unitaria |
| Corrupción (ENFORCED sin cargo) | Release → 409 `CREDIT_REFUND_INTEGRITY_ERROR`, **falla cerrado**: nada se mueve, el Dispatch sigue CLAIMED y queda `SERVICE_REFUND_INTEGRITY_FAILURE` en el log |
| Garantías SQL (14 escrituras forjadas) | Rechazadas: devolución sin reversión operacional, de un award inexistente, sin award, del award de otro, acreditada a otro proveedor, apuntando a otro Dispatch, con el actor equivocado, sin motivo, sobre una recarga, segunda devolución del mismo award (índice único), editar o borrar una devolución escrita, y devolver **más** o **menos** que el award |
| Reversión por SQL sin devolución | Liberar o cancelar a mano un servicio pagado → `CREDIT_REFUND_REQUIRED` (trigger diferido); el Dispatch queda intacto |
| Escaneo de integridad | 0 devoluciones sin award, 0 con cuenta o Dispatch equivocados, 0 con importe distinto al opuesto, 0 duplicadas, 0 saldos negativos, 0 descuadres y 0 servicios cerrados con cargo sin devolver |
| Contexto de pago | `deliveryFee` 60.00 MXN, `goodsValue` 800.00 y `driverAdvanceAmount` 800.00 intactos tras la devolución; los créditos no son pesos |
| Logs | Sin JWT ni contraseñas en ninguna línea de devolución |

**Defectos heredados encontrados (no introducidos por V1.10-E).** `test/migrations/award-boundary.check.ts`, commiteado en V1.10-D (`ec98980`), importa `PrismaClient` desde `../../.tmp/check-v110d/previous-c/node_modules/@prisma/client/index.js`: un directorio temporal fuera del repositorio. Eso rompe `tsc -p tsconfig.json` con 4 errores (el `build` del proyecto no lo ve porque `tsconfig.build.json` excluye `test`) y el archivo no está enganchado a ningún script ni configuración de Vitest. Propuesta: sacarlo del repositorio (como el resto de validadores temporales) o reapuntarlo a `@prisma/client`. No se tocó en esta tarea.

**Defectos propios corregidos.** El helper de purga de fixtures borraba el ledger en un solo paso y ahora un refund retiene su award (FK RESTRICT): se borran primero las devoluciones. Un fixture de `independent-drivers` revertía Dispatches a mano y la nueva garantía lo rechazó correctamente: ahora purga el cargo antes (sólo en bases `*_test`). Una aserción de V1.10-A exigía 0 movimientos SERVICE_* en **toda** la base y ahora se acota a su propio Dispatch, porque otras suites escriben movimientos legítimos.

**Riesgos conocidos.** No hay penalización por reservar y soltar: un proveedor puede reclamar y liberar repetidamente con costo neto 0. Sólo existen devoluciones completas; una penalización por etapa exigirá estados de ejecución que el modelo todavía no tiene. Un Dispatch monetizado cuyo cargo desaparezca queda inrevertible (409) hasta que un administrador corrija los datos. Sigue vigente que el dueño de las tablas puede desactivar triggers: en producción la aplicación debe usar un rol que no sea dueño y una base cuyo nombre no termine en `_test`.

# Verificación correctiva V1.10-D — 2026-09-22

**PASS — COMPLETADA Y VALIDADA.** Resultados de esta tarea, separados de las verificaciones históricas que siguen:

- Ambos bloqueantes reproducidos antes del fix; evidencia histórica preservada.
- 49/49 adversariales + 3/3 protección de historial; frontera B/C/D real con premios C gratis correctamente clasificados y siguiente premio cobrado.
- 178/178 unitarias; 266/266 E2E en 18 archivos, con repeticiones documentadas.
- Prisma generate/validate/status/drift, tsc/build, Oxlint/ESLint, docs:check y verify-migrations PASS.
- Migración incremental `20260923000200_award_integrity_boundary` en local/test: hashes de seis tablas preservados, 0 cargos retroactivos.
- Escáner: 0 violaciones; excepciones históricas reportadas aparte. Cleanup: 18 bases temporales propias eliminadas y evidencia exportada.
- Detalles, incidencias y riesgos: [informe correctivo](docs/CHECK_V1_10_D_FIXES.md). No commit/push; no V1.10-E.

---

# CHECK V1.10-D — FAILED (2026-09-22)

Validación actual del working tree: **dos defectos bloqueantes**, sin correcciones de producto. PostgreSQL permite un ganador MONETIZED sin award; la migración C→D clasifica adjudicaciones anteriores como MONETIZED sin débito y el retry CLAIM devuelve 200. Los resultados históricos siguientes no equivalen a aprobar este CHECK.

Informe completo y matriz de las barreras: [CHECK_V1_10_D.md](docs/CHECK_V1_10_D.md). Evidencia: [v1.10-d-evidence.json](docs/checks/v1.10-d-evidence.json).

- CHECK: 40 comprobaciones agrupadas, 37 PASS / 3 FAIL (dos defectos).
- Regresión: 170 unitarias; 249 E2E en 18 archivos, con repetición del archivo cuyo fork nativo cayó (15/15 en la repetición).
- Quality: Prisma validate/status/drift, verify-migrations, tsc, build, Oxlint, ESLint y docs:check PASS.
- Bases existentes intactas; sólo dos 500 de fallos inyectados, revertidos. Cleanup de bases propias completado.
- No commit, push ni V1.10-E.

---

# Verificación V1.10-D — Atomic CLAIM / TAKE Credit Consumption (2026-09-23)

Rama `v1.10-credit-monetization` sobre `a4daeb5` (V1.10-C), paquete 1.10.0, Node.js 24, PostgreSQL 18 local. Docker no ejecutado. Sin commit ni push. **V1.10-D cobra al adjudicar; todavía no devuelve.**

| Verificación | Resultado |
|---|---|
| Migración `20260923000100_dispatch_credit_consumption` en `mandaria_db` y `mandaria_test` (sin reset) | PASS; los 44 y 18 Dispatches existentes quedaron `creditMode: LEGACY` sin reescribir filas ni tocar su historia; 0 cargos retroactivos |
| `verify-migrations` | PASS: limpia, V1.0 → V1.10, datos V1.9 → V1.10 y V1.10-A ledger → V1.10-B → V1.10-C → **V1.10-D**; en las bases migradas todo Dispatch es LEGACY, 0 SERVICE_AWARD/REFUND, trigger de modo, guardián del award, índice único parcial, CHECK y `creditMode` por defecto MONETIZED |
| prisma validate / migrate status (ambas) / drift (ambas) | PASS / al día / vacío |
| build, tsc, Oxlint, ESLint, docs:check | PASS |
| OpenAPI | CLAIM y TAKE documentan el cobro y los 409 económicos (`INSUFFICIENT_CREDITS`, `CREDIT_ACCOUNT_UNAVAILABLE`, `CREDIT_SNAPSHOT_UNAVAILABLE`, `CREDIT_MOVEMENT_CONFLICT`); el cliente no envía costo, cuenta ni snapshot |
| Unitarias | **170/170** (12 nuevas de consumo de créditos) |
| E2E por archivo | **249/249** en 19 archivos (19 nuevas); `delivery-assignments` y `delivery-requests-b2b` sufrieron la caída nativa de workers de Windows y pasaron completos al repetirlos |
| Provider CLAIM | Saldo 10, costo mostrado 7 → 200, saldo 3, exactamente 1 `SERVICE_AWARD` de −7 con `referenceType: DISPATCH`, `referenceId` del Dispatch, autor y cuenta del proveedor; `creditCost` mostrado = créditos cobrados |
| Independent TAKE | Saldo 14, costo 14 → 200 con su asignación ACTIVE, saldo 0, 1 award; la cuenta del proveedor de su flotilla no se mueve |
| Saldo exacto y saldo insuficiente | 7 − 7 = 0 permitido; con 6 créditos → 409 `INSUFFICIENT_CREDITS`, Dispatch OPEN, sin candidatura CLAIMED, sin asignación, ledger intacto; el mismo Dispatch lo reclama después quien sí puede pagar |
| Costo autoritativo | Con la política cambiada a 20 créditos/km, el Dispatch abierto a 7 sigue cobrando **7**; uno nuevo congela 140 |
| Sin recálculo ni routing | El cobro sólo lee el snapshot: el contador del proveedor de routing no aumenta durante CLAIM/TAKE, y las unitarias usan un doble de transacción sin política ni routing |
| Un solo cargo | Repetir el CLAIM del dueño (×3) responde 200 y deja 1 award; el índice único parcial `(creditAccountId, referenceId)` rechaza un segundo cargo escrito a mano |
| Reasignación, cancelación y release | Asignar, reasignar y cancelar la asignación no generan un segundo award; liberar tampoco devuelve créditos (V1.10-E) |
| CLAIM fallido | Dispatch inexistente (404), rol incorrecto (403), B2B (401), vehículo ajeno (404) y llegar tarde (409): saldos y ledger idénticos |
| Concurrencia sobre un Dispatch | 10 claims simultáneos: un único ganador y **1** award; sólo se movió la cuenta del ganador |
| Provider CLAIM vs Independent TAKE | Simultáneos: 200 y 409; exactamente **1** actor paga, nunca los dos ni el perdedor |
| Misma cuenta, dos servicios | Saldo 10 y dos servicios de 7: 1 éxito + 1 `INSUFFICIENT_CREDITS`, saldo 3, 1 award (nunca −4) |
| Saldo compartido exacto | Saldo 14 y dos servicios de 7: ambos ganan, saldo 0, 2 awards |
| Recarga y ajuste concurrentes | Recarga contra claim y ajuste contra claim: cualquiera de los dos órdenes es válido, el saldo siempre cuadra con el ledger reconstruido entrada por entrada y nunca queda negativo |
| Dispatches legacy | Adjudicados sin cobro, con `LEGACY_DISPATCH_CREDIT_SKIPPED` en el log, sin movimiento de 0 créditos y sin snapshot inventado |
| Snapshot faltante en monetizado | **Falla cerrado**: 409 `CREDIT_SNAPSHOT_UNAVAILABLE` en CLAIM y en TAKE, Dispatch sigue OPEN, nada cobrado |
| Garantías SQL | 14 escrituras forjadas rechazadas con su razón: segundo award (índice único), award de un Dispatch no reclamado, de uno legacy, cargado a otro proveedor, con importe falsificado, sin referencia, apuntando a algo que no es un Dispatch, con signo positivo, que dejaría saldo negativo, editar o borrar un award, mover el saldo sin ledger y reetiquetar un Dispatch monetizado como legacy |
| Seguridad | `creditCost`, `credits`, `amount`, `creditSnapshotId`, `creditAccountId`, `actorType` y `type` enviados por el cliente no cambian el cargo (el contrato de CLAIM rechaza cuerpos) |
| Contexto de pago | `deliveryFee` 60.00 MXN, `goodsValue` 800.00, `driverAdvanceAmount` 800.00 y `creditCost` 7 créditos conviven sin conversión; la historia de recargas queda intacta (`SERVICE_AWARD` −7 sobre `RECHARGE` +20) |
| Humo real (`dist/main.js` sobre `mandaria_db`, sólo lectura) | **6/6**: los 44 Dispatches son LEGACY y se leen sin costo inventado, ningún monetizado sin snapshot, 0 cargos retroactivos, políticas operativas intactas, nada escrito, log sin secretos ni 5xx |
| Mutaciones | **5/5 detectadas**: no saltar los legacy, no fallar cerrado sin snapshot, quitar la comprobación de saldo, cobrar un importe distinto al congelado y quitar el bloqueo de la cuenta |
| Logs | `SERVICE_AWARD_CHARGED` (con cuenta, créditos, snapshot, secuencia y saldos), `SERVICE_AWARD_REJECTED_INSUFFICIENT_CREDITS` y `LEGACY_DISPATCH_CREDIT_SKIPPED`, sin JWT ni contraseñas |

**Defectos propios corregidos durante la implementación.** El backfill de la migración chocaba con el guard V1.7 que congela los Dispatches resueltos (se resolvió etiquetando por valor por defecto y ejecutando el único UPDATE necesario con ese trigger desactivado dentro de la transacción de la migración); la inmutabilidad del nuevo modo impedía construir un Dispatch legacy en pruebas (se permitió con el mismo interruptor de fixtures que ya usan ledger y políticas, que PostgreSQL sólo honra en bases `*_test`); y un filtro de logs de V1.10-C capturaba por subcadena el nuevo motivo `DISPATCH_OPENED_BEFORE_CREDIT_SNAPSHOTS`.

**Riesgos conocidos.** No hay devoluciones: liberar un servicio pagado, cancelar la asignación o cancelar la entrega dejan los créditos consumidos hasta V1.10-E, y un proveedor que reclama y libera repetidamente gasta sin ejecutar. Un saldo en cero deja al actor fuera de juego sin alertas ni recarga automática. Entre congelar el costo y cobrarlo puede pasar tiempo y ya no se puede corregir salvo cancelando el Dispatch. Un Dispatch monetizado que pierda su snapshot queda inadjudicable a propósito y exige intervención administrativa. Sigue vigente que el dueño de las tablas puede desactivar triggers: en producción la aplicación debe usar un rol que no sea dueño y una base cuyo nombre no termine en `_test`.

# CHECK V1.10-C — Dispatch Credit Snapshot, validación adversarial (2026-09-22)

Rama `v1.10-credit-monetization`, HEAD `7881efb` + V1.10-C sin commit, paquete 1.10.0; `mandaria_db` y `mandaria_test` al día (14 migraciones). Validador temporal fuera del repositorio contra `dist/main.js` en ejecución (puerto 3016, base `mandaria_test`), con fixtures propios, logins reales y reinicios para no agotar los límites de peticiones, cotizaciones y logins. `mandaria_db` sólo se leyó (consultas y `pg_dump`). Sin cambios de código: **33/33 PASS**.

| # | Verificación | Resultado |
|---|---|---|
| 1 | Línea base | Ledger sin roturas ni descuadres, 0 saldos negativos; 2 políticas ACTIVE sin duplicados; 14 migraciones aplicadas; cálculo 6240 m → 7; cuenta nueva con saldo 0 |
| 2 | Escenario de dos actores | Políticas PROVIDER 1/km e INDEPENDENT_DRIVER 2/km (mínimo 3); Dispatch real con distancia canónica 6240 m → exactamente 2 snapshots |
| 3 | Costo del proveedor | DB y API: `billableKm` 7 × 1 = **7** |
| 4 | Costo del independiente | DB y API: 7 × 2 = **14** |
| 5 | Aislamiento de vistas | Proveedor: única clave de créditos `creditCost` = 7 (detalle y listado); repartidor: 14; SUPER_ADMIN audita los dos; proveedor y repartidor reciben 403 en `/admin/dispatches/:id` y `/admin/credit-policies` |
| 6 | Inmutabilidad del snapshot | Tras versionar a 3/km y 4/km, las filas de A son idénticas byte a byte y la API sigue devolviendo 7 / 14 |
| 7 | Dispatch nuevo | Con las políticas nuevas y la misma distancia: **21 / 28**; A sigue en 7 / 14 aunque recalcular hoy daría 21 / 28 |
| 8 | Política histórica | Cada snapshot referencia la versión exacta usada (v3, hoy INACTIVE) con su `policyVersion`, no la ACTIVE actual; A se creó dentro de la ventana de vigencia de esa versión |
| 9 | Inmutabilidad por SQL | UPDATE de créditos, de política/versión y de `createdAt`, DELETE, DELETE con un valor de purga falso y TRUNCATE → `CREDIT_SNAPSHOT_IMMUTABLE`; A intacto |
| 10 | Snapshot duplicado | Segundo `PROVIDER` en la misma apertura → índice único (`Unique constraint`); fila extra sobre un Dispatch existente → `CREDIT_SNAPSHOT_INVALID` |
| 11 | Datos inválidos | credits 0, negativos, > 1 000 000 y falsificados → `CREDIT_SNAPSHOT_MISMATCH`; distancia < 0 y FK de política inexistente → `CREDIT_SNAPSHOT_INVALID`; PER_KM sin `billableKm` → CHECK 23514; el CHECK acota además créditos 1–1 000 000 y distancia ≥ 0 |
| 12 | Actor cruzado | Fila PROVIDER con la política del independiente, fila INDEPENDENT con la del proveedor y versión superada del actor correcto → `CREDIT_SNAPSHOT_INVALID` |
| 13 | ServiceType cruzado | Enum real = {LOCAL_DELIVERY}: el escenario **no puede ejecutarse sin inventar dominio** y no se agregó ningún ServiceType. La comparación de `serviceType` (contra la cotización y contra la política) sí existe en el guardián SQL |
| 14 | Sin política de PROVIDER | Aceptar → 409 `CREDIT_POLICY_UNAVAILABLE`; cotización OFFERED, 0 Dispatch, 0 snapshots huérfanos; al restaurarla, el mismo reintento abre con 21/28 |
| 15 | Sin política de INDEPENDENT_DRIVER | Idéntico (LOCAL_DELIVERY = BOTH, el independiente está permitido) |
| 16 | Política irrelevante | `credit_required_actors('LOCAL_DELIVERY')` = PROVIDER,INDEPENDENT_DRIVER; ningún ServiceType real excluye a un actor, así que el caso se cubre con la prueba de dominio «a FLEET-only or INDEPENDENT-only service gets only its own actor» |
| 17 | Rollback transaccional | Servidor real con el 2.º actor a 1 000 000/km: 422 `CREDIT_COST_OUT_OF_RANGE`, cotización OFFERED, 0 Dispatch, 0 snapshots, sin `DISPATCH_OPENED` en el log. Por SQL: 1.er snapshot insertado y 2.º falsificado → `CREDIT_SNAPSHOT_MISMATCH` y no queda nada |
| 18 | Carrera con la activación | 12 aperturas simultáneas + 2 versiones nuevas: 12 × 200 y 2 × 201; cada snapshot coincide exactamente con una versión (0 incoherencias); reparto PROVIDER 2 viejas/10 nuevas, INDEPENDENT 1/11; 1 Dispatch quedó con un actor viejo y el otro nuevo (ver garantía abajo) |
| 19 | Reintentos | Re-aceptar A ×3 → 200 idempotente y sigue con 2 snapshots; 10 aceptaciones simultáneas → 1 Dispatch, 2 snapshots; **0 duplicados** en toda la base |
| 20 | Llamadas de routing | 1 por cotización, **0 al aceptar y snapshotear**, 0 al re-aceptar; 20 `ROUTING_CALCULATED` para 20 cotizaciones |
| 21 | FLAT | `calculationType` FLAT, `credits` = `flatCredits` = 5, sin evidencia falsa (`billableKm`, `creditsPerKm`, `minimumCredits`, `calculatedCredits` y rango en NULL) |
| 22 | DISTANCE_RANGE | 6240 m → rango #2 [3000, 10000) → 8 con id, posición y límites; tras reemplazar la política por PER_KM la fila es idéntica y sigue siendo interpretable (API incluida) |
| 23 | Distancia 0 | Cotización real de 0 m: FLAT → 5, primer rango → 3, PER_KM 1/km mínimo 3 → `billableKm` 0, calculado 0, **credits 3** |
| 24 | Independencia de cuentas | 185 cuentas con el mismo saldo y `updatedAt` tras 24 Dispatches (46 snapshots) |
| 25 | Independencia del ledger | Entradas y secuencia sin cambios; **0** SERVICE_AWARD / SERVICE_REFUND |
| 26 | CLAIM con saldo 0 | Saldo 0 y `creditCost` 7 → claim 200 CLAIMED, saldo sigue 0, sin movimientos |
| 27 | TAKE con saldo 0 | Saldo 0 y `creditCost` 14 → take 200, saldo sigue 0, sin movimientos |
| 28 | Contexto de pago | `deliveryFee` 60.00 MXN, `goodsValue` 300.00, `driverAdvanceAmount` 300.00 (cadenas con moneda) y `creditCost` entero sin moneda; A y B comparten tarifa 60.00 con créditos 7 y 21 (ninguna conversión ni suma cruzada) |
| 29 | Aislamiento B2B | 20 rutas de créditos y de dispatch con el token de IntegrationClient → 401; los payloads B2B (alta, cotización, aceptación, lectura) no contienen ninguna clave de créditos |
| 30 | Dispatch legacy | Fixture sin snapshots: proveedor y repartidor `creditCost: null`, admin `[]` + `legacyWithoutCreditSnapshots: true`, listados 200; los 18 Dispatches previos de `mandaria_test` se leen igual; CLAIM 200 y **no se creó ningún snapshot retroactivo** |
| 31 | Migración V1.10-B → V1.10-C | Base temporal con el esquema V1.10-B (13 migraciones) y **los datos reales de `mandaria_db`** (28 tablas idénticas): al aplicar sólo la migración V1.10-C, las 28 tablas quedan con las mismas filas y el mismo hash; 44 Dispatches, 0 snapshots, 44 legacy, ledger y políticas sin tocar; sin drift contra `schema.prisma`. Base temporal y volcado eliminados |
| 32 | Escaneo de base | `mandaria_test` (46 snapshots) y `mandaria_db` (0): **0 duplicados, 0 huérfanos, 0 créditos ≤ 0, 0 distancias < 0, 0 desajustes de política y 0 de costo recalculado en SQL, 0 conjuntos incompletos** |
| 33 | OpenAPI | `creditCost` entero anulable en proveedor y repartidor; `creditSnapshots` como arreglo de `DispatchCreditSnapshotResponse` (18 propiedades tipadas, enum de actor, 0 sin estructura); `legacyWithoutCreditSnapshots` booleano; 0 esquemas B2B con créditos |
| 34-35 | Regresión y calidad | prisma validate, migrate status (ambas), sin drift (ambas), verify-migrations, build, tsc, Oxlint, ESLint, docs:check PASS; **158 unitarias**; **E2E 230/230 en 17 archivos** (sin caída de workers en esta corrida) |
| 36 | Limpieza | Fixtures, usuarios, credenciales temporales y versiones de política del CHECK eliminados; políticas ACTIVE base restauradas (PER_KM 1/km, mínimo 3, autor de E2E) en `mandaria_test`; `mandaria_db` idéntica antes y después |
| — | Logs | 1216 líneas sin secretos ni JWT, 0 respuestas 5xx; los 24 `DISPATCH_OPENED` incluyen `creditCosts` |

**Garantía de concurrencia (detalle del punto 18).** Cada actor se resuelve bajo un bloqueo consultivo **compartido** `(71600020, "LOCAL_DELIVERY:<actor>")` que la apertura mantiene hasta el COMMIT, mientras que crear una versión lo toma en **exclusiva**. Por eso ningún snapshot mezcla dos versiones. Los actores se resuelven uno tras otro (PROVIDER y luego INDEPENDENT_DRIVER) y cada cambio de política es su propia transacción, así que un Dispatch puede quedar legítimamente con el proveedor en la versión anterior y el independiente en la nueva si esa segunda versión se confirma entre las dos resoluciones: cada costo sigue siendo exactamente el vigente en su propia resolución, y es el snapshot —no la política— lo que V1.10-D cobrará.

**Bugs del producto:** ninguno; sin cambios de código. **Del validador (corregidos en el validador):** `now()` local usado como `effectiveUntil` en una base con marcas UTC (la restricción `CreditPolicy_values_check` lo rechazó correctamente) y un contador de limpieza que confundía la política base restaurada con las del propio CHECK.

**Riesgos restantes.** Los ya documentados de V1.10-C: hay que crear las políticas antes de aceptar cotizaciones en cada entorno (si no, 409 en toda aceptación); los Dispatches legacy no tienen costo y V1.10-D debe decidir cómo tratarlos; los actores requeridos viven en dos lugares (`SERVICE_EXECUTION_MODES` y `credit_required_actors()`), así que cambiar un modo exige migración. Además: una combinación puede quedar sin política ACTIVE sólo escribiendo SQL directo (la API nunca desactiva sin reemplazar) y en ese estado no hay endpoint para volver a activarla; y el dueño de las tablas puede desactivar triggers, por lo que en producción la aplicación debe usar un rol que no sea dueño y una base cuyo nombre no termine en `_test`.

# Verificación V1.10-C — Dispatch Credit Snapshot (2026-09-22)

Rama `v1.10-credit-monetization` sobre `7881efb` (V1.10-B), paquete 1.10.0, Node.js 24, PostgreSQL 18 local. Docker no ejecutado. Sin commit ni push. **V1.10-C no cobra: CLAIM y TAKE no consumen créditos.**

| Verificación | Resultado |
|---|---|
| Migración `20260922001400_dispatch_credit_snapshots` en `mandaria_db` y `mandaria_test` (sin reset) | PASS; 28 tablas previas con las mismas filas y contenido; 0 snapshots creados (sin backfill) |
| `verify-migrations` | PASS: limpia, V1.0 → V1.10, datos V1.9 → V1.10 y V1.10-A ledger → V1.10-B → V1.10-C; 0 snapshots en las bases migradas (el Dispatch EXPIRED retrocompletado en V1.7 queda legacy); 4 restricciones, índice único, 3 triggers y `credit_required_actors('LOCAL_DELIVERY')` = `PROVIDER,INDEPENDENT_DRIVER` |
| prisma validate / migrate status (ambas) / drift (ambas) | PASS / al día / vacío |
| build, tsc, Oxlint, ESLint, docs:check | PASS |
| OpenAPI | `creditCost` entero anulable en las 8 respuestas de proveedor y repartidor (listas, detalle, claim/take/release); `creditSnapshots` + `legacyWithoutCreditSnapshots` en admin; esquemas B2B sin datos de créditos; 0 objetos sin estructura |
| Unitarias | **158/158** (10 nuevas de snapshot + `dispatch.spec` ampliado) |
| E2E por archivo | **230/230** en 17 archivos (14 nuevas); `provider-admin-access` sufrió la caída nativa de workers de Windows y pasó 9/9 dos veces al repetir |
| Costo por actor | Distancia 6240 m: proveedor ve `creditCost` 7, repartidor independiente 14 (política 2/km), admin ambos snapshots con evidencia, B2B sin datos de créditos |
| Cambio de política | Dispatch A abierto con v1 sigue 7/14 tras crear v2; Dispatch B nuevo 21/28 |
| Evidencia FLAT y DISTANCE_RANGE | FLAT con `flatCredits`; 12 400 m → rango 2 `[10000,20000)` → 20, con id, posición y límites del rango |
| Concurrencia | 10 aceptaciones simultáneas → 1 Dispatch y 2 snapshots; carrera con creación de versiones → cada snapshot coincide exactamente con una versión |
| Fallo cerrado | Sin política INDEPENDENT_DRIVER → 409 `CREDIT_POLICY_UNAVAILABLE`, cotización OFFERED, 0 Dispatch, 0 snapshots huérfanos; al restaurar, la aceptación da [35, 28] |
| Garantías SQL | 20 escrituras directas rechazadas con su razón (costo o distancia falsos, política INACTIVE u otro actor, actor no permitido, Dispatch no OPEN/antiguo/reclamado, UPDATE, DELETE, TRUNCATE, faltante al COMMIT, duplicado); borrado en cascada con el Dispatch |
| Legacy | Dispatch sin snapshot: `creditCost: null`, admin `[]` + `legacyWithoutCreditSnapshots: true`; CLAIM funciona |
| Economía intacta | CLAIM y TAKE con saldo 0 y costo > 0 → 200; saldos, `updatedAt` y ledger sin cambios; 0 SERVICE_AWARD/SERVICE_REFUND |
| Logs | `DISPATCH_OPENED` incluye `creditCosts` (actor, créditos, versión, tipo); sin secretos |
| Humo real (`dist/main.js` sobre `mandaria_db`, sólo lectura) | **5/5**: los 44 Dispatches existentes (28 CLAIMED, 14 EXPIRED, 2 CANCELLED) se leen como legacy; un CLAIMED con asignación ACTIVE se lee bien; políticas operativas v1 PER_KM 1/3 presentes; Dispatches, asignaciones, snapshots (0) y ledger (0) idénticos; log sin secretos ni 5xx |
| Mutaciones | **5/5 detectadas**: BOTH sin repartidor independiente, costo 0 aceptado, legacy informado como 0, bloqueo exclusivo en vez de compartido, apertura sin snapshots |

Estado final: `mandaria_db` con 0 snapshots y sus 44 Dispatches legacy intactos. En `mandaria_test` las suites de políticas purgan todos los snapshots con el interruptor `_test` (necesario para poder borrar políticas, FK RESTRICT), así que los Dispatches de fixtures que quedan aparecen sin snapshot; es un artefacto de limpieza sólo de la base de pruebas.

# CHECK V1.10-B — Credit Policy Engine (2026-09-22)

Rama `v1.10-credit-monetization`, HEAD `5e8e14b` + V1.10-B sin commit, paquete 1.10.0; `mandaria_db` y `mandaria_test` al día (13 migraciones). Validador temporal fuera del repositorio contra `dist/main.js` en ejecución (puerto 3014, base `mandaria_test`), con fixtures propios, logins reales y reinicios para no agotar los límites de peticiones y logins. `mandaria_db` sólo se leyó. Sin cambios de código. **Resultado: 29/29.**

| # | Verificación | Resultado |
|---|---|---|
| 1 | Línea base V1.10-A | Ledger sin roturas ni descuadres, 0 saldos negativos, todo proveedor con cuenta; recarga y ajuste 201; 147 unitarias; `credits` 24/24 y `credit-policies` 19/19 |
| 2 | Matriz de políticas | PROVIDER e INDEPENDENT_DRIVER resuelven cada uno su propia ACTIVE |
| 3 | PER_KM 1/km, mínimo 3 | 0, 1, 999, 1000, 1001, 2999, 3000 m → 3; 3001 → 4; 6240 → 7 (ambos actores; también `billableKm` y `minimumApplied`) |
| 4 | Nueva tarifa 2/km | 6240 m → 7 km × 2 = 14 |
| 5 | FLAT 5 (temporal en INDEPENDENT_DRIVER) | 9 distancias de 0 a 2 147 483 647 m → 5 |
| 6 | DISTANCE_RANGE `[0,3000)3 [3000,5000)5 [5000,10000)8 [10000,∞)15` | Antes/en/después de cada frontera exacto; en base: inicio 0, sin huecos ni solapes, un único rango abierto y al final; cada metro de 0 a 12 000 cae en exactamente un rango |
| 7 | Rangos inválidos | Solape, hueco, inicio > 0, dos abiertos, invertido, vacío, créditos 0/negativos/decimales, último cerrado, sin máximo, 51 rangos → 400; nada creado |
| 8 | Historial v1/v2/v3 | Preservado; una sola ACTIVE; `effectiveUntil` de cada versión = `effectiveFrom` de la siguiente; payload de v1 idéntico al de su creación |
| 9 | Inmutabilidad histórica | API: PATCH/PUT/DELETE 404, versionar desde v1 409, `version`/`id` en el cuerpo 400. SQL: cambiar tarifa, tipo o versión de v1, editar o borrar rangos y borrar v1 → `CREDIT_POLICY_IMMUTABLE`; v1 intacta |
| 10 | Versionado concurrente | 12 simultáneas desde la ACTIVE → 1 × 201 + 11 × 409 (versiones 1..4); 6 cadenas concurrentes de 3 → versiones 1..9 únicas y contiguas, 1 ACTIVE, fechas encadenadas |
| 11 | Activación concurrente | No existe endpoint de activación (una versión se activa al crearse). Carrera directa en SQL de 4 «desactivar + insertar»: 1 aplicada, 3 `CREDIT_POLICY_VERSION_INVALID`; reactivar INACTIVE → `CREDIT_POLICY_IMMUTABLE`; siempre 1 ACTIVE |
| 12 | Sin política | Ambas combinaciones sin ACTIVE → 409 `CREDIT_POLICY_UNAVAILABLE`; con sólo una vacía, la otra sigue calculando. Nunca 0 |
| 13 | Aislamiento de actores | Cambiar PROVIDER (2/km) deja INDEPENDENT_DRIVER en 7; su FLAT deja PROVIDER en 14 |
| 14 | Distancia canónica | Servidor con `ROUTING_PROVIDER=google` y clave inutilizable: los cálculos responden 3/3/7/25/124 y el log no registra ningún evento de routing; ningún import de routing en `src/credit-policies`; el detector sí ve las cotizaciones reales del paso 24 |
| 15 | Distancias inválidas | -1, NaN, ±Infinity, 2 147 483 648, 1e20, 20 dígitos, abc, true, vacía, 1.5, 0x10, con espacio, ausente y repetida → 400; 0 m → 3 (mínimo) |
| 16 | Enteros | 1.5/km, mínimo 3.2, flat 5.7, créditos de rango 2.5, límite 500.5 y tarifa en texto → 400; los 47 costos devueltos son enteros seguros ≥ 0 |
| 17 | Desbordamiento | 1 000 000/km: 0 y 1000 m → 1 000 000; 1001 m y distancia máxima → 422 `CREDIT_COST_OUT_OF_RANGE`; tarifas 1 000 001, 2⁵³, -1, mínimo y flat fuera de límite → 400 |
| 18 | Autorización | SUPER_ADMIN 200; PROVIDER_ADMIN, DRIVER de flotilla e independiente 403; IntegrationClient y anónimo 401 (5 rutas) |
| 19 | Campos falsificados | `version`, `createdByUserId`, `id`, `status` (ARCHIVED/ACTIVE), `createdAt`, fechas, `serviceType`/`actorType` al versionar, `id`/`position` de rango, `DRIVER`, `FREIGHT`, `PER_MINUTE` → 400 |
| 20 | Invariantes SQL | 16 escrituras inválidas rechazadas (segunda ACTIVE, versión duplicada/0/negativa/saltada, nacida INACTIVE, tarifa NULL/0, campos cruzados, FLAT 0, rangos ausentes o con hueco, mínimo fuera de límite, vigencia invertida, TRUNCATE) |
| 21 | Migración V1.10-A → V1.10-B | `verify-migrations` PASS (base V1.10-A con ledger → V1.10-B idéntica, 0 políticas creadas); aplicación real sin reset verificada en la implementación (26 tablas con mismas filas y contenido) |
| 22 | Cuentas | 185 cuentas con el mismo saldo y `updatedAt` tras todos los cálculos y versiones |
| 23 | Ledger | Mismo número de entradas y secuencia; 0 SERVICE_AWARD/SERVICE_REFUND |
| 24 | CLAIM con saldo 0 | 200, CLAIMED, 0 movimientos |
| 25 | TAKE con saldo 0 | 200, tomado por el independiente, 0 movimientos |
| 26 | Cambio de política con operaciones vivas | Tras 2 versiones nuevas, los 2 Dispatch, 2 asignaciones, candidatos, cuentas y ledger idénticos |
| 27 | OpenAPI | Enums exactos (actorType, calculationType, status, serviceType), enteros en versiones/créditos/distancias/paginación, rangos e items con `$ref`, sin DELETE/PATCH/PUT, 0 objetos sin estructura en 169 esquemas |
| 28 | Regresión | Unitarias **147/147**; E2E **216/216** en 16 archivos (`delivery-requests-b2b` sufrió la caída nativa de workers y pasó 15/15 dos veces al repetir) |
| 29 | Calidad | prisma validate, migrate status (ambas), sin drift, verify-migrations, build, tsc, Oxlint, ESLint, docs:check PASS |
| 30 | Limpieza | `mandaria_test`: 0 políticas (como estaba), 0 fixtures. `mandaria_db`: políticas operativas intactas (v1 PER_KM 1/km, mínimo 3, para ambos actores) |
| — | Logs | 2012 líneas sin contraseñas, JWT, clientSecret ni secretos de firma; eventos de política con actor; 0 respuestas 5xx |

**Bugs del producto:** ninguno; sin cambios de código. **Del validador (corregidos en el validador):** foto económica tomada antes de la recarga/ajuste de la línea base; detector de routing que contaba prosa de comentarios como imports; parche de limpieza roto por la sustitución de comandos de bash (una corrida dejó fixtures, que se limpiaron).

**Incidente de limpieza (mandaria_test).** Al final ejecuté por error el limpiador de fixtures con el prefijo genérico `E2E_`: borró de `mandaria_test` restos acumulados de corridas E2E anteriores (las 1 300 DeliveryRequest con sus cotizaciones, dispatches y stops, y las zonas `E2E_`) antes de detenerse en una FK. `mandaria_db` no se tocó. Son datos desechables que ninguna suite necesita (cada una crea los suyos); la regresión E2E completa se repitió después sobre la base limpiada con el resultado indicado en la fila 28.

# Verificación V1.10-B — Credit Policy Engine (2026-09-22)

Rama `v1.10-credit-monetization` sobre `5e8e14b` (CHECK V1.10-A), paquete 1.10.0, Node.js 24.15.0, PostgreSQL 18 local. Docker no ejecutado. Sin commit ni push. **V1.10-B sólo calcula: CLAIM y TAKE no consumen créditos.**

| Verificación | Resultado |
|---|---|
| Línea base (HEAD `5e8e14b`, barrera final del CHECK V1.10-A) | 131 unitarias; E2E 197/197 |
| Migración `20260922001300_credit_policies` en `mandaria_db` y `mandaria_test` (sin reset) | PASS; 26 tablas previas con las mismas filas y el mismo contenido (hash por tabla); 0 políticas creadas por la migración |
| `verify-migrations` | PASS: limpia, V1.0 → V1.10, datos V1.9 → V1.10 y **nueva base V1.10-A con ledger → V1.10-B** (cuentas, saldos y movimientos idénticos; 0 políticas); objetos V1.10-B presentes |
| prisma validate / migrate status (ambas) / drift | PASS / al día / vacío |
| build, tsc, Oxlint, ESLint, Prettier, docs:check | PASS |
| OpenAPI | 4 rutas `/admin/credit-policies` (sin DELETE/PATCH/PUT), 7 esquemas nuevos, 0 objetos sin estructura |
| Unitarias | **147/147** (131 + 16 V1.10-B) |
| E2E por archivo | **216/216** en 16 archivos (19 V1.10-B); `independent-drivers` sufrió la caída nativa de workers y pasó 23/23 dos veces al repetir |
| PER_KM 1 crédito/km, mínimo 3 | 0, 1, 999, 1000, 1001 m → 3; 6240 m → 7 (unitarias y HTTP); casos donde el mínimo no domina (2 créditos/km: 2001 m → 6, 6240 m → 14) |
| FLAT | Mismo costo para 0 m … 2 147 483 647 m |
| DISTANCE_RANGE `[0,3000)→3, [3000,5000)→5, [5000,10000)→8, [10000,∞)→15` | 0/1/2999 → 3; 3000/3001/4999 → 5; 5000/5001/9999 → 8; 10000/10001/máx → 15; cada distancia en exactamente un rango |
| Configuración ambigua | PER_KM con `flatCredits` o `ranges`, FLAT con `minimumCredits`/`ranges`, huecos, solapes, primer rango ≠ 0, último cerrado, 51 rangos, créditos 0/decimales/texto/2⁵³ → 400 |
| Campos falsificados | `version`, `status`, `createdByUserId`, `effectiveFrom`, `effectiveUntil`, `id`, `actorType: DRIVER`, `serviceType: FREIGHT` → 400 |
| Distancia inválida | -1, 1.5, abc, 1e20, vacía, con espacio, 2 147 483 648, NaN, Infinity y parámetro repetido → 400; en la función pura → `CREDIT_DISTANCE_INVALID` |
| Desbordamiento | 1 000 000 créditos/km × 2 km → 422 `CREDIT_COST_OUT_OF_RANGE` (nunca truncado) |
| Sin política ACTIVE | 409 `CREDIT_POLICY_UNAVAILABLE` para ambos actores; nunca 0 créditos |
| Versionado v1 → v2 → v3 → v4 | 4 versiones, sólo v4 ACTIVE; payload de v1 idéntico; `effectiveUntil` de cada una = `effectiveFrom` de la siguiente |
| Versionar desde una INACTIVE | 409 `CREDIT_POLICY_VERSION_CONFLICT`; nada escrito |
| Concurrencia | 10 versiones simultáneas desde la ACTIVE → 1 × 201 + 9 × 409; 10 cadenas concurrentes de 3 → versiones contiguas 1..n, 1 ACTIVE; 8 creaciones iniciales simultáneas → 1 v1 + 7 × 409 |
| Ataques SQL directos | **28/28 rechazados** por la garantía correcta: segunda ACTIVE (índice parcial), versión duplicada/0/-1/saltada y nacida INACTIVE (trigger), PER_KM sin tarifa (CHECK con `IS NOT NULL`), campos cruzados y límites (CHECK), rangos sin rangos/solapados/con hueco/sin 0/cerrados/en PER_KM/añadidos después (trigger diferido), edición, reactivación, cambio de autor, DELETE, TRUNCATE y otro valor del interruptor (`CREDIT_POLICY_IMMUTABLE`) |
| Autorización | PROVIDER_ADMIN y DRIVER 403, B2B y anónimo 401 en las 5 rutas |
| Ledger y cuentas | Tras 16 cálculos por HTTP: saldos, `updatedAt`, número de entradas y secuencia máxima idénticos; 0 SERVICE_AWARD/REFUND |
| Regresión V1.10-A y CLAIM/TAKE | `credits.e2e` 24/24 (recarga, ajuste, idempotencia, saldo no negativo, ledger inmutable; CLAIM y TAKE con saldo 0 sin movimiento) |
| Servidor real `dist/main.js` sobre `mandaria_db` | 14/14: políticas del seed listadas, 0/800/1001/6240/25 000 m → 3/3/3/7/25 para ambos actores, anónimo 401, saldos/ledger/políticas sin cambios, sin secretos en el log |
| Seed local | `db:seed:local-credit-policies` crea v1 PER_KM 1/3 para PROVIDER e INDEPENDENT_DRIVER en `mandaria_db`; segunda ejecución «kept existing v1» |
| Mutaciones M1–M6 | 6/6 detectadas (km redondeados hacia abajo, mínimo ignorado, máximo de rango inclusivo, campo ajeno aceptado, versionar desde una reemplazada, costo sin límite) |
| Auditoría | `CREDIT_POLICY_CREATED`/`CREDIT_POLICY_VERSIONED` con configuración, versión anterior y `actorUserId`; sin contraseñas, JWT ni clientSecret |

**Defectos encontrados durante la implementación (propios, corregidos antes de entregar):** (1) el trigger diferido usaba `CASE … NEW."creditPolicyId"`, que falla en cada inserción de política (el mensaje en español «el registro "new" no tiene un campo…» llegó como `P2022 column "registro"`); se cambió por `IF` y, como la migración no estaba commiteada y sus tablas estaban vacías, se retiró y reaplicó localmente; (2) `?distanceMeters=` vacío se convertía en 0 m con `Number('')`; ahora sólo se convierten cadenas de dígitos; (3) el CHECK de cálculo habría aceptado `PER_KM` con tarifa NULL (un CHECK que evalúa a NULL pasa); se añadieron `IS NOT NULL` explícitos. En pruebas: supertest ligado al objeto servidor cerraba el servidor entre peticiones concurrentes; la suite usa ahora un puerto efímero real.

No verificado: Docker; comportamiento de V1.10-C/D (fuera de alcance).

# CHECK V1.10-A — Credit Accounts & Immutable Ledger (2026-09-21)

Rama `v1.10-credit-monetization` (HEAD `c612f6c`), paquete 1.10.0. Validación adversarial contra `dist/main.js` en ejecución (puerto 3012, base `mandaria_test`, routing local_fake) y PostgreSQL real, con fixtures propios, logins reales, fallos inyectados con triggers temporales (sólo en `mandaria_test`, retirados al terminar) y limpieza total. `mandaria_db` se consultó en sólo lectura salvo la migración. Sin commit ni push.

**Estado de partida del entorno.** El cliente Prisma de `node_modules` era del 17-sep y `mandaria_db` y `mandaria_test` estaban en V1.8: las migraciones de V1.9 y V1.10 nunca se habían aplicado en esta máquina, así que la primera línea base falló (tsc, build y casi todas las E2E) por entorno, no por el producto. Se regeneró el cliente, se respaldaron ambas bases con `pg_dump` y se aplicaron las migraciones sin reset.

| # | Verificación | Resultado |
|---|---|---|
| 1 | Propiedad de cuentas | 1 cuenta por proveedor (creado por API y por SQL), 1 por independiente APPROVED, 0 para Driver de flotilla (API 404 CREDIT_ACCOUNT_NOT_FOUND); cuentas duplicadas de proveedor e independiente rechazadas por los únicos; aprobar → suspender → aprobar sigue en 1 |
| 2 | Saldos iniciales (`mandaria_db`, datos reales) | 12 proveedores → 12 cuentas en 0; 0 independientes aprobados; 0 entradas de ledger; ninguna RECHARGE inventada |
| 3 | Recarga | 0 + 500 = 500 y 500 + 200 = 700 en API, DB y ledger (2 entradas encadenadas, actor registrado) |
| 4 | Recargas inválidas | 0, -1, 1.5, 1 000 001, texto, 10¹², método inexistente, OTHER sin motivo, campos forjados (balance, ownerType), sin Idempotency-Key y key corta → 400 ×12; saldo intacto |
| 5 | Ajustes | +100 → 800, -50 → 750 con motivo; sin motivo, 0 y decimal → 400 |
| 6 | Saldo negativo | Con 20, -21 → 409 INSUFFICIENT_CREDITS; cuenta (incl. `updatedAt`) y ledger sin cambios |
| 7 | Atomicidad | Fallo inyectado antes y **después** de mover el saldo → 409 CREDIT_MOVEMENT_CONFLICT sin medio movimiento; UPDATE directo del saldo → CREDIT_BALANCE_WITHOUT_LEDGER; entrada con saldo viejo → CREDIT_LEDGER_STALE; reintentar la misma key aplica una sola vez |
| 8 | Concurrencia | Con 10, -8 ∥ -8 → 1 × 201 + 1 × 409, saldo 2; +100 ∥ +200 ∥ +300 → exactamente 602 |
| 9 | Alta contención | 60 movimientos mixtos simultáneos en ~0,6 s: 58 × 201 + 2 × 409; saldo 16 = 50 + suma aplicada; 70 entradas encadenadas sin roturas |
| 10 | Idempotencia | Misma RECHARGE y mismo ADJUSTMENT con la misma key → 1 movimiento (201 y 200 `Idempotent-Replayed`); cuerpo distinto o otro tipo con la misma key → 409 CREDIT_IDEMPOTENCY_CONFLICT; 5 copias simultáneas → 1 movimiento (recarga y ajuste); la key es por cuenta |
| 11 | Ledger inmutable | UPDATE, DELETE, deleteMany, TRUNCATE, GUC con otro valor y borrar una cuenta con historia → rechazados |
| 12 | Restricciones | 19 estados inválidos escritos en SQL, todos rechazados (saldo inicial ≠ 0, negativo, UPDATE directo, duplicados, combinaciones de dueño inválidas, cambio de dueño, importe 0 o fuera de límite, descuadre, saldo negativo, signos por tipo, falta de actor/key/motivo, key repetida) |
| 13 | Matemática del ledger | En todas las cuentas de ambas bases: before + amount = after, cadena continua, primera en 0, última = saldo: **0 violaciones** |
| 14 | Autorización | SUPER_ADMIN lee/recarga/ajusta por rutas admin; PROVIDER_ADMIN sólo lee lo suyo; independiente sólo lo suyo; flotilla 404; B2B y anónimo 401; no existen rutas de escritura para dueños (404) |
| 15 | Aislamiento de proveedores | `providerId` ajeno 403, `accountId`/`creditAccountId` 400, rutas admin 403; la vista del dueño no expone actor ni Idempotency-Key |
| 16 | Aislamiento de independientes | Parámetros con el driver o la cuenta de B → se devuelve la cuenta propia o 400; rutas admin y de proveedor 403; 0 fugas |
| 17 | Suspensión / rechazo | Cuenta y ledger se conservan y siguen legibles (proveedor suspendido; independiente suspendido y rechazado) |
| 18 | Sin DELETE | 12 rutas de créditos en OpenAPI, ninguna DELETE/PATCH/PUT; 8 intentos → 404 |
| 19 | Créditos ≠ dinero | Ningún campo de moneda, formato decimal ni número no entero en los 8 esquemas de créditos ni en las respuestas |
| 20 | Regresión CLAIM | Proveedor con saldo 0 reclama (200, CLAIMED); ledger sin cambios |
| 21 | Regresión TAKE | Independiente con saldo 0 toma (200); ledger sin cambios; 0 entradas SERVICE_* |
| 22 | Migración | `mandaria_db` y `mandaria_test`: V1.8 → V1.9 → V1.10 sin reset; las 23 tablas previas con las mismas filas y el mismo contenido en sus columnas originales (hash por tabla); `verify-migrations` (limpia, V1.0 → V1.10 y datos V1.9 → V1.10) PASS |
| 23 | OpenAPI | Cuenta, entrada, entrada admin, recarga, ajuste, movimiento y páginas con tipos exactos; paginación `integer`; Idempotency-Key obligatoria; 0 objetos sin estructura |
| 24 | Logs / secretos | 2477 líneas sin contraseña, JWT (humanos, B2B ni de firma), clientSecret, SMTP ni clave de Google; 0 cadenas con forma de JWT; eventos de crédito presentes; 0 respuestas 5xx |
| 25 | Regresión | Unitarias **131/131**; E2E **197/197** en 15 archivos (`credits` y `drivers-vehicles` sufrieron la caída nativa de workers y pasaron 24/24 y 11/11 dos veces al repetir) |
| 26 | Calidad | prisma validate, migrate status (ambas), verify-migrations, build, tsc, Oxlint, ESLint, Prettier, docs:check PASS |
| 27 | Limpieza | Fixtures del CHECK: 0 restos. Restos de corridas de `credits` interrumpidas por la caída de workers (5 proveedores, 12 usuarios, 20 movimientos) eliminados de `mandaria_test`. Las 12 cuentas de migración de `mandaria_db` intactas |

**Defecto real encontrado y corregido.** El interruptor `SET LOCAL mandaria.ledger_purge = 'test-fixtures'`, documentado como exclusivo de bases de prueba, funcionaba en **cualquier** base y para **cualquier** rol con permiso DELETE: fijar un GUC propio no requiere privilegios. Prueba con un rol temporal sin privilegios de dueño en `mandaria_test`: no podía desactivar el trigger, pero sí borró una entrada del ledger con el interruptor; lo mismo ocurría en `mandaria_db` (probado dentro de una transacción revertida). La mitigación del README («usar un rol sin privilegios de dueño») no lo cerraba. Corrección: migración `20260921001200_credit_ledger_purge_test_only`, que sólo acepta el interruptor si el nombre de la base termina en `_test` (misma regla que `scripts/test-database-url.ts`). Después: en `mandaria_db` el borrado con interruptor se rechaza (`CREDIT_LEDGER_IMMUTABLE`) y en `mandaria_test` sigue sirviendo para limpiar fixtures. `verify-migrations` comprueba la restricción; README actualizado.

**Imprecisión preexistente corregida (sólo documentación).** La paginación compartida desde V1.2 (`page`, `pageSize`, `total`, `totalPages` en 21 respuestas y los parámetros `page`/`pageSize`) se publicaba como `number`; ahora `integer` con sus límites. Sin cambios de validación ni de respuesta.

**Otras clasificaciones.** Errores de tsc/build/E2E de la primera línea base → entorno (cliente Prisma y bases sin migrar). Los 2 errores de tsc en `test/credits.spec.ts` → orden de ejecución (los tests importan tipos de `dist/`, que venía de la compilación fallida). Caídas de workers → nativas de Windows. Dos fallos del validador → expectativas equivocadas corregidas en el validador (la prosa «sin decimales ni moneda» coincidía con el patrón).

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
