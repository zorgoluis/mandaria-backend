> **Registro histórico del CHECK fallido.** La corrección posterior está en [CHECK_V1_10_D_FIXES.md](CHECK_V1_10_D_FIXES.md). Este informe y su evidencia original se conservan sin sustituir el veredicto de aquella ejecución.

# CHECK V1.10-D — Atomic CLAIM / TAKE Credit Consumption

Fecha de ejecución: 2026-09-22. **Veredicto: FAILED. No se declara completada y validada.**

## Passed / Failed

Los flujos HTTP nuevos conservan la atomicidad, pero se reprodujeron **dos defectos bloqueantes**:

1. PostgreSQL acepta una adjudicación monetizada escrita directamente sin su `SERVICE_AWARD`, incluso con saldo 0.
2. La migración C → D etiqueta `MONETIZED` a servicios ya adjudicados gratis en C. Su CLAIM idempotente devuelve 200 en D sin cobrar. También queda una asignación independiente monetizada sin award.

No se modificaron reglas, servicios, schema ni migraciones para hacer pasar el CHECK. No se implementó V1.10-E.

Evidencia estructurada: [v1.10-d-evidence.json](checks/v1.10-d-evidence.json). Los scripts de comprobación están localmente en `.tmp/check-v110d/` (ignorados por Git); no contienen credenciales reales. Se usaron bases PostgreSQL creadas exclusivamente para este trabajo.

### Baseline (§1)

- Rama: `v1.10-credit-monetization`.
- HEAD: `a4daeb56fd15d533e8c7a2ccd6838e495fa90b34` (V1.10-C).
- Backend: `1.10.0`, V1.10-D presente como cambios sin commit.
- `mandaria_db`: 15 migraciones terminadas, ninguna pendiente ni revertida; drift Prisma 0.
- Estado inicial: 17 archivos modificados, incluido `.env`; migración D, service-award y tres archivos de pruebas/soporte sin seguimiento. Inventario exacto en el JSON. Todos esos cambios se conservaron.
- La base principal tenía 44 Dispatches, todos LEGACY, y 0 movimientos de ledger. El CHECK sólo la leyó.
- A/B/C saludables en regresión: Ledger 24/24, Policies 19/19 y Snapshots 14/14 E2E; unitarias completas 170/170.

### Método

HTTP real contra procesos `node dist/main.js`, PostgreSQL real, logins humanos y Client Credentials reales de fixtures. No se reemplazaron servicios de adjudicación, transacciones, cuentas ni ledger. Para preparar cotizaciones se seleccionó explícitamente el proveedor existente `local_fake`; no se llamó a Google. La instrumentación temporal sólo observó llamadas de routing y acceso a delegates Prisma de políticas/snapshots, sin cambiar sus resultados. Se reiniciaron procesos propios para respetar los rate limits existentes, sin deshabilitarlos.

Las 19 comprobaciones base HTTP se completaron en lotes (17 + 2 tras una caída del worker). Las 16 adicionales tuvieron 14 PASS y 2 FAIL; esas dos aserciones reproducen el mismo defecto SQL. La prueba de migración falló por el segundo defecto. Las 4 comprobaciones suplementarias pasan y cubren valores exactos, contexto de pago, logs y múltiples reasignaciones. En total: 40 comprobaciones agrupadas, 37 PASS y 3 FAIL correspondientes a los dos defectos; resultados individuales en el JSON.

## Provider CLAIM

**PASS en el flujo HTTP nuevo (§2, §21).** Saldo 10, snapshot 7 → HTTP 200, saldo 3, un `SERVICE_AWARD=-7`, candidato y Dispatch del proveedor ganador. Proveedor ajeno/no candidato, proveedor suspendido, rol incorrecto, B2B y Dispatch ya adjudicado no alteran saldo ni ledger. Un proveedor no puede escoger otra cuenta pagadora mediante el body.

## Independent TAKE

**PASS en el flujo HTTP nuevo (§6, §22).** Saldo 20, snapshot 14 → HTTP 200, saldo 6, un `SERVICE_AWARD=-14` y asignación ACTIVE del independiente. La cuenta de su proveedor de flotilla no se mueve.

Perfil no APPROVED, vehículo inexistente/ajeno, recursos ocupados, Dispatch no disponible, rol humano incorrecto y B2B quedan rechazados sin débito ni asignación adicional. Se probó recurso ocupado usando el mismo vehículo y usando un segundo vehículo libre con el Driver ocupado. En el modelo actual el vehículo independiente pertenece a ese Driver: la comprobación `DRIVER_BUSY` tiene precedencia cuando ambos están ocupados; no se inventó una relación inválida para exigir `VEHICLE_BUSY` como código aislado.

## Exact / Insufficient Balance

**PASS (§3–5, §7–8).** Provider: 7−7=0; 6 y 0 con costo 7 → 409 `INSUFFICIENT_CREDITS`. Independent: 14−14=0; 13 y 0 con costo 14 → mismo rechazo. Se compararon Dispatch, candidatos, asignaciones, saldos y ledger antes/después: sin mutación en los rechazos, Dispatch disponible según sus reglas.

## Snapshot vs Charged Cost

**PASS (§9–12).** `creditCost` mostrado = `abs(SERVICE_AWARD.amount)`: 7 para Provider y 14 para Independent. Se abrió a 7, se activó FLAT 20 y se cobró 7; una apertura posterior congeló 20. La prueba base también cambió PER_KM a 20 y conservó el costo antiguo.

Durante CLAIM y TAKE: 0 accesos a delegates de políticas y 0 llamadas al RoutingProvider; sí se observó lectura del snapshot. La revisión de `chargeDispatchAward` y del guard SQL confirma que el importe se obtiene de `DispatchCreditSnapshot.credits`, sin política activa ni recálculo de distancia.

## Provider vs Independent Race

**PASS (§13–15).**

- 10 proveedores distintos sobre un Dispatch: 1 HTTP 200 + 9 HTTP 409, un award.
- 10 independientes elegibles distintos: 1 HTTP 200 + 9 HTTP 409, un award y una asignación ACTIVE.
- CLAIM frente a TAKE: un ganador operacional, una cuenta pagadora y un award; actor y pagador corresponden.

Se distinguieron actores distintos de reintentos del mismo proveedor, que pueden responder 200 por idempotencia sin crear otra adjudicación.

## Same Account Concurrency

**PASS (§16–17).** Saldo 10 y dos costos 7 → un éxito, un saldo insuficiente, saldo final 3. Saldo 14 y dos costos 7 → dos éxitos, saldo final 0 y dos movimientos. El flujo Provider permite ambos claims sin inventar restricciones de asignación.

## High Contention

**PASS (§18).** Saldo 50, veinte Dispatches de costo 7, veinte CLAIM simultáneos de la misma cuenta: **7 éxitos, 13 `INSUFFICIENT_CREDITS`, saldo 1, siete awards**. No apareció un octavo débito. Las cadenas de saldo y los importes contra snapshot no presentan violaciones.

## Atomic Rollback

**PASS (§23–25, §28).** Se agregaron temporalmente triggers de fallo en la base aislada, sin desactivar los guards existentes. Para CLAIM y TAKE se forzaron:

- rechazo de la inserción `SERVICE_AWARD`: HTTP 409;
- rechazo de la actualización de CreditAccount durante el débito: HTTP 409;
- fallo diferido al commit, después de las mutaciones: HTTP 500 sanitizado.

En los seis casos se recuperaron exactamente Dispatch, candidatos, asignaciones, saldo y ledger previos. Se retiró cada trigger de fallo en `finally`.

Se eliminaron temporalmente cuentas vacías de fixtures de ambos actores y se restauraron después: HTTP 409 `CREDIT_ACCOUNT_UNAVAILABLE`, sin adjudicación ni ledger. No se creó una cuenta silenciosamente al cobrar.

## Retry Protection

**PASS para servicios nuevos (§19–20).** CLAIM repetido responde idempotentemente con máximo un débito. TAKE repetido no crea otra asignación ni otro cargo. La excepción encontrada es el CLAIM ya adjudicado antes de D, descrito en Migration.

## Legacy Handling

**PASS (§26).** Se compiló el backend B del commit `7881efb` con su propio Prisma Client en un directorio temporal. Se creó un Dispatch por HTTP en una base con las 13 migraciones de B. Luego se aplicaron C y D, sin reset. Ese Dispatch quedó LEGACY; CLAIM por el backend D fue exitoso, con 0 snapshots fabricados, 0 awards y evento `LEGACY_DISPATCH_CREDIT_SKIPPED`.

Esto complementa la prueba de fixtures legacy de la suite; la evidencia principal de esta barrera proviene de una apertura real anterior a C.

## Corrupted Missing Snapshot

**PASS (§27).** Un Dispatch MONETIZED al que se le retiraron snapshots usando el mecanismo de fixtures exclusivo de bases `_test` devolvió 409 `CREDIT_SNAPSHOT_UNAVAILABLE` en CLAIM y TAKE. Permaneció OPEN, sin asignación ni movimiento. La falta de snapshot no lo convirtió en legacy gratuito.

## Reassignment / Release / Cancellation

**PASS conforme a las reglas actuales, con riesgo esperado (§29–32).** Se verificaron tres reasignaciones de Driver/Vehicle, cancelación de asignación y release: se conserva un único award y el saldo consumido. Cancelar DeliveryRequest después del cobro tampoco devuelve créditos. El release independiente cancela su asignación pero no reintegra el débito.

Un award histórico cuyo claim fue liberado no es un débito huérfano: se valida contra el candidato con `claimedAt` o la asignación histórica, no exigiendo que el pagador siga siendo dueño actual. Refunds/reversals quedan pendientes para V1.10-E y no se implementaron.

## Recharge / Adjustment Concurrency

**PASS (§33–35).** Saldo inicial 0, RECHARGE +20, CLAIM −7 → 13. Recarga +10 frente a CLAIM −7 acepta los órdenes serializables previstos (rechazo + saldo 10, o éxito + saldo 3). Ajuste −7 frente a CLAIM −7 sobre saldo 7 mantiene coherencia, sin negativo. Se verifican `balanceBefore`, `balanceAfter` y suma completa de la cadena.

## Security

**PASS del contrato HTTP (§36–40).** Campos forjados de costo, snapshot, cuenta y actor no determinan el cobro: CLAIM los ignora según su contrato sin body o los rechaza; TAKE rechaza campos desconocidos con 400. El cargo válido usa 7/14, nunca el costo 1 enviado por el cliente. Se mantienen controles de rol, membership y separación de JWT humano/B2B.

`deliveryFee=60.00 MXN`, `goodsValue=800.00` y `driverAdvanceAmount=800.00` se mantienen exactamente antes y después del débito. Créditos y dinero no se mezclan.

## Database Invariants

**PARCIAL / FAILED (§41–42).** PostgreSQL rechaza saldo negativo, award duplicado por cuenta/Dispatch, importe incorrecto, award de un actor ajeno o sin adjudicación, UPDATE y DELETE de ledger, saldo modificado sin movimiento y cambio fraudulento de creditMode. Se verificaron las razones de rechazo existentes.

Falta la garantía inversa: un writer puede confirmar la adjudicación sin insertar ningún award. La prueba no deshabilitó triggers ni activó el interruptor de fixtures para ese ataque.

Reproducción mínima, con un Dispatch OPEN monetizado y candidato OFFERED válidos:

```sql
BEGIN;
UPDATE "DispatchCandidate"
SET status = 'CLAIMED', "claimedAt" = now()
WHERE "dispatchId" = :dispatch_id AND "providerId" = :provider_id;
UPDATE "Dispatch"
SET status = 'CLAIMED', "claimedByProviderId" = :provider_id,
    "claimedAt" = now()
WHERE id = :dispatch_id;
COMMIT;
-- No INSERT en CreditLedgerEntry. PostgreSQL acepta el commit.
```

Resultado observado: Dispatch `111c3b2f-e165-49a2-96de-146e35a98dd4`, CLAIMED, MONETIZED, snapshot 7, saldo del pagador 0, awards 0.

Escaneo de la base adversarial (34 cuentas): negativos 0, duplicados económicos 0, importes erróneos 0, cadenas incoherentes 0, **ganador monetizado sin award 1** (la reproducción SQL). Excluyendo ese ataque deliberado, los flujos HTTP no produjeron violaciones. Escaneos de la base principal y de regresión: 0 en todas las categorías. Legacy legítimos se excluyeron de la exigencia de award.

## Migration

**Preservación PASS; frontera económica FAILED (§43).**

Además de `verify-migrations`, se ejecutaron backends B (`7881efb`), C (`a4daeb5`) y D (working tree) contra la misma base aislada, aplicando las migraciones secuencialmente sin reset:

| Estado previo | Resultado D |
|---|---|
| Dispatch abierto en B, sin snapshots | LEGACY; CLAIM exitoso sin cobro ni snapshot fabricado |
| Dispatch OPEN con snapshots creado por C | MONETIZED; primer CLAIM en D cobra −7 |
| Dispatch ya CLAIMED por Provider en C | MONETIZED, 0 awards; repetir CLAIM en D devuelve 200, sigue sin débito |
| Dispatch ya tomado por Independent en C | MONETIZED, asignación existente, 0 awards |

IDs, estados operacionales, snapshots, cuentas y ledger quedaron preservados exactamente. El problema está en la clasificación económica: el UPDATE de la migración marca MONETIZED a toda fila con snapshot, mientras `ALREADY_OWNER` retorna antes de cobrar. El verificador existente sólo tenía fixtures legacy en esa frontera y no detectaba el caso.

No se propone cobrar retroactivamente para ocultarlo: hace falta definir explícitamente cómo se conservan y representan las adjudicaciones previas a D, y probar esa decisión sin alterar su historia.

## Regression

**PASS final (§44).** 170 unitarias en 17 archivos y **249 E2E en los 18 archivos presentes**, ejecutados secuencialmente por archivo con PostgreSQL aislado. Incluye Providers, Independents, Accounts/Ledger, Policies, Snapshots, Coverage, Quotes, Assignments, Payment Context y B2B.

Incidente registrado: `delivery-requests-b2b` tuvo una caída nativa del fork tras 13 pruebas; repetir ese archivo pasó 15/15. La batería HTTP temporal también sufrió una caída de worker; se completaron los casos faltantes por separado. Hubo además una duplicación accidental inicial del harness al tratar CRLF; se corrigió sólo el harness y se descartaron sus resultados contaminados. No se cambiaron reglas del producto para obtener verde.

## Quality

**PASS (§45).**

| Comando/comprobación | Resultado |
|---|---|
| `prisma validate` | PASS |
| `prisma migrate status` | 15 migraciones aplicadas, al día |
| `prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --exit-code` | 0, sin drift |
| `node scripts/verify-migrations.mjs` | PASS; limpio y todas las evoluciones verificadas |
| `tsc --noEmit -p tsconfig.build.json` | PASS |
| `nest build` | PASS |
| Oxlint | PASS |
| ESLint | PASS |
| `docs:check` | PASS |
| Unit | 170/170 |
| E2E por archivo | 249/249 tras repetir el fork caído |

La ausencia de drift Prisma no sustituye la inspección y las pruebas de triggers/índices SQL, realizadas por separado.

## Logs

**PASS de confidencialidad con fallos inyectados identificados (§46).** En la batería adversarial se observaron exactamente dos HTTP 500: los dos fallos diferidos al commit provocados deliberadamente, uno para cada actor. Ambos retornaron error sanitizado y revirtieron todo. No aparecieron deadlocks ni unhandled rejections del backend. Los fallos SQL controlados de ledger/cuenta devolvieron 409.

Logs de migración y de escenarios suplementarios: 0 HTTP 5xx. Búsqueda de JWT completos, contraseñas generadas, tokens de fixtures y valores sensibles configurados: 0 coincidencias. Las caídas de Vitest son fallos del runner, separados de los logs del backend. La revisión agregada quedó guardada antes de reutilizar el archivo temporal de logs en el último lote.

## Bugs Found / Fixed

- **D-CHECK-01 — Bloqueante:** falta una barrera SQL que impida confirmar un ganador monetizado sin el movimiento requerido. `service_award_guard` protege ledger → adjudicación, pero no adjudicación → ledger.
- **D-CHECK-02 — Bloqueante:** adjudicaciones anteriores a D con snapshot quedan clasificadas MONETIZED sin award; el CLAIM idempotente devuelve 200 sin débito. Afecta también al estado migrado de TAKE.
- **Corregidos en el producto:** ninguno durante este CHECK. Los problemas del harness se resolvieron sólo en archivos temporales.

Referencias: `prisma/migrations/20260923000100_dispatch_credit_consumption/migration.sql` (backfill, línea 23; guard del ledger, línea 140); `src/dispatch/dispatch.service.ts` (`ALREADY_OWNER`, línea 169; cobro, línea 199).

## Remaining Risks

- Los dos defectos bloquean el objetivo bidireccional solicitado aunque los caminos HTTP nuevos pasen.
- Sin refunds: cancelación y release conservan el débito. Es riesgo esperado para V1.10-E, todavía no iniciada.
- El rol propietario de tablas puede desactivar triggers; producción necesita un rol de aplicación restringido. El bypass de fixtures depende además de que la base termine en `_test`.
- `.env` estaba versionado y modificado antes del CHECK; no se imprimió, editó, publicó ni corrigió aquí. Sigue pendiente la exposición histórica documentada previamente.
- Persiste la inestabilidad nativa de workers Vitest en Windows; los resultados se distinguen de las pruebas terminadas.

## Cleanup

**Completado (§47).** Bases principal `mandaria_db` y compartida `mandaria_test` no se modificaron. Se eliminaron únicamente las bases creadas por este CHECK después de extraer evidencia sin credenciales: fixtures, usuarios, tokens/credenciales temporales, políticas, balances, Dispatches y movimientos de prueba se fueron con ellas. También se eliminaron las cuatro bases sintéticas que creó esta ejecución de `verify-migrations`. El inventario exacto está en el JSON.

No se borró historia legítima de las bases existentes. No quedaron backends del CHECK ejecutándose. PostgreSQL sigue disponible. Los validadores y compilaciones temporales permanecen en `.tmp/check-v110d/` para inspección local.

## Git

Sin commit, push, cambio de rama ni modificación funcional del producto. Se conservaron todos los cambios preexistentes. Entregables del CHECK: este informe, el JSON de evidencia y actualización de BITACORA/VERIFICATION.

**V1.10-D no está validada. Corresponde resolver D-CHECK-01/D-CHECK-02 y repetir las barreras afectadas antes de habilitar V1.10-E.**
