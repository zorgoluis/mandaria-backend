# V1.10-D — corrección de bloqueantes y repetición del CHECK

**Veredicto: PASS. Mandaria V1.10-D Atomic CLAIM / TAKE Credit Consumption — COMPLETADA Y VALIDADA.**

Ejecución: 2026-09-22, Node/PostgreSQL locales. Rama `v1.10-credit-monetization`, HEAD `a4daeb56fd15d533e8c7a2ccd6838e495fa90b34`, paquete `1.10.0`. Sin commit/push, Docker ni V1.10-E.

El CHECK fallido original se conserva íntegro en [CHECK_V1_10_D.md](CHECK_V1_10_D.md) y [su evidencia](checks/v1.10-d-evidence.json). Esta ejecución volvió a reproducir ambos defectos **antes** de corregirlos. Los nuevos resultados se guardan separadamente en `checks/v1.10-d-fixes-evidence.json`.

## Root Cause

El guard del ledger comprobaba debit → ganador, pero no ganador → debit. El CLAIM idempotente omitía cobrar a un propietario existente y la migración sólo distinguía LEGACY/MONETIZED: no conservaba la excepción histórica de las adjudicaciones C anteriores al cobro.

## Database Enforcement Design

Migración nueva `20260923000200_award_integrity_boundary`, transaccional e incremental; no reescribe `20260923000100`.

- Cinco constraint triggers diferidos: Dispatch, Candidate, Assignment, Ledger y modificación/eliminación de snapshots.
- La comprobación al COMMIT permite el orden legítimo claim → assignment → debit; captura también el evento de adjudicación aunque se libere dentro de la misma transacción.
- Cada adjudicación ENFORCED exige un único ledger correspondiente al actor/cuenta reales y exactamente `-snapshot.credits`.
- Cada débito requiere historial operacional persistente. El historial liberado/cancelado también cuenta; borrarlo no puede dejar un ledger huérfano.
- Se conserva la unicidad por cuenta/Dispatch y se respalda en SQL la prohibición ya existente de retomar el mismo servicio como independiente.
- No se consultan políticas ni routing durante el cobro.

## Historical Boundary Design

`Dispatch.creditMode` conserva la frontera LEGACY/MONETIZED. La nueva tabla `DispatchPreEnforcementAward` registra actor, ID, fecha de adjudicación y fecha de clasificación. Sólo la migración inserta esas excepciones; el uso normal no puede insertarlas, editarlas ni eliminarlas.

La excepción corresponde a una adjudicación, no a todo el futuro del Dispatch. `creditEnforcementMode` hace visible LEGACY / PRE_ENFORCEMENT_AWARD / ENFORCED en OpenAPI y las vistas autorizadas. No equivale a un recibo.

## Migration Classification

LEGACY permanece LEGACY. Historial con snapshot y sin cargo queda registrado como PRE_ENFORCEMENT_AWARD, sin inventar cargos. OPEN sin adjudicación no obtiene excepción. Los nuevos premios son ENFORCED. Se preservan también las excepciones de adjudicaciones ya liberadas/canceladas.

## Provider SQL Attack

PASS: repetir el ataque original sin ledger ahora rechaza el COMMIT y revierte candidato/Dispatch. También se rechaza claim+release sin debit dentro de una misma transacción. Una transacción SQL correcta con cargo 7 hace COMMIT.

## Independent SQL Attack

PASS: TAKE operacional con assignment pero sin ledger se revierte por PostgreSQL. La transacción válida con cargo 14 conserva exactamente una asignación y un débito.

## Wrong Amount / Actor / Account

PASS para ambos actores: monto incorrecto, otro pagador, tipo de actor opuesto, duplicado y débito con Dispatch OPEN. Se comprueba rollback de saldos, ledger, Dispatch y assignment. La excepción histórica no puede fabricarse por SQL normal. No se desactivaron triggers para estos ataques.

## V1.10-C Transitional Provider

PASS: backend C real adjudica gratis; al migrar, retry CLAIM 200 devuelve PRE_ENFORCEMENT_AWARD y mantiene cero cargos. Emite observabilidad transicional.

## V1.10-C Transitional Independent

PASS: la asignación C permanece intacta, la vista declara PRE_ENFORCEMENT_AWARD, retry TAKE sigue rechazado sin segunda asignación ni cobro. Hay observabilidad transicional.

## OPEN V1.10-C Dispatch

PASS: sin excepción histórica; CLAIM bajo D cobra 7. Liberar después una adjudicación histórica y otorgarla a otro actor también cobra 7; sus registros transicionales permanecen inmutables.

## Authentic Legacy

PASS: creado con backend B real, migrado C→D sin snapshots inventados ni cobros. Se observa LEGACY_DISPATCH_CREDIT_SKIPPED. Un nuevo monetizado al que se retira el snapshot bajo el mecanismo exclusivo de fixtures sigue fallando cerrado.

## Application Regression

PASS: Provider suficiente/exacto/insuficiente y cero; Independent suficiente/exacto/insuficiente y cero; costos mostrados iguales al debit; retries sin doble cargo; cambio de política sin alterar precio congelado; sin cambios al payment context. Reasignación, release y cancelaciones no cobran otra vez ni devuelven créditos.

## Concurrency

PASS: Provider vs Independent produce un ganador/pagador/award. Diez proveedores y diez independientes por separado producen un ganador. Veinte CLAIM de 7 con saldo 50 producen **7 éxitos, 13 INSUFFICIENT_CREDITS, saldo 1**. Recarga/ajuste simultáneos conservan serialización y saldo no negativo. Los fallos inyectados en cuenta, ledger y COMMIT revierten ambos flujos.

## Database Scan

PASS, 0 violaciones:

| Base | Dispatches | Legacy | Excepciones históricas | Adjudicaciones ENFORCED | SERVICE_AWARD |
|---|---:|---:|---:|---:|---:|
| Adversarial aislada | 86 | 2 | 0 | 36 | 36 |
| Frontera B/C/D | 4 | 1 | 2 | 3 | 3 |
| Local existente | 44 | 44 | 0 | 0 | 0 |

Las dos excepciones históricas se reportan aparte, aun después de liberarlas. No se ocultan como adjudicaciones pagadas. El escáner independiente recorre historial, snapshots, cuentas y ledger, además de comprobar negativos y duplicados.

## Migration

PASS: instalación limpia; cadena V1.0→actual; preservación V1.9 y ledger A→B→C→D; backends B/C reales para frontera. `mandaria_db` y `mandaria_test` actualizadas a 16 migraciones sin reset, drift vacío. Hashes de las seis tablas operacionales/económicas idénticos antes/después; 0 excepciones nuevas y ningún movimiento financiero en ambas bases existentes.

## Tests

- 49/49 adversariales HTTP/SQL, más 3/3 controles adicionales de historial.
- 178/178 unitarias.
- 266/266 E2E en 18 archivos, completados por archivo.
- Frontera histórica real PASS, incluyendo release y siguiente adjudicación.
- Evidencia anterior FAILED conservada; no se rebajaron expectativas para obtener PASS.

Incidencias de la ejecución: el primer wrapper de regresión confundió DATABASE_URL con TEST_DATABASE_URL y el guard lo rechazó antes de probar; se corrigió. El teardown añadido inicialmente purgó antes de tiempo y rompió una aserción de cadena: se movió al cierre global. La prueba V1.7 que confirmaba una candidatura CLAIMED aislada ahora exige su rechazo y establece un CLAIM pagado antes de continuar con los mismos guards. Un worker nativo de Windows interrumpió user-invitations sin aserción fallida; repetición completa 24/24. El harness histórico usó inicialmente un motivo libre inválido para release independiente; se corrigió al enum vigente, sin cambiar reglas.

## Quality

Prisma generate/validate/status/drift, TypeScript, build, Oxlint, ESLint, OpenAPI/docs:check y verify-migrations: PASS. Documentación y scripts reproducibles incluidos. Detalle de corridas en la evidencia estructurada.

## Logs

Sin JWT, secretos B2B, contraseñas, unhandled rejection ni deadlocks detectados. Los únicos dos HTTP 500 fueron los fallos diferidos inyectados deliberadamente en CLAIM/TAKE (cuatro líneas por registro doble HTTP/filter), con rollback comprobado. Conflictos económicos/operacionales esperados son 409. Los cuatro tipos de observabilidad económica aparecen.

## Bugs Fixed

1. Adjudicación SQL sin debit: protegida al COMMIT, incluida creación y borrado del historial relacionado.
2. Adjudicaciones pre-enforcement sin clasificación: historial persistente e inmutable, visible/auditable, sin debit retroactivo ni exención futura.

## Remaining Risks

- La versión anterior no guardaba prueba de si un premio sin debit ocurrió bajo C o mediante el bypass SQL de D. La migración registra fielmente que ya existía antes del enforcement correctivo; no inventa su versión de origen. Revisar ese inventario en otro despliegue antes de aceptarlo operativamente. Aquí sólo las fixtures históricas tienen excepciones; las bases existentes tienen cero.
- Las garantías presuponen operaciones ordinarias: un propietario/superusuario que desactive triggers puede alterar la DB. El interruptor de purga preexistente sólo se utiliza en bases `_test` para fixtures.
- No refunds al liberar/cancelar: alcance pendiente de V1.10-E, no implementado.
- Sigue pendiente la remediación del `.env` preexistente versionado, documentada previamente; esta tarea no modificó ni copió sus valores.

## Cleanup

Evidencia exportada; 18 bases temporales propias eliminadas, procesos HTTP de prueba detenidos. Las bases anteriores ajenas se conservaron. La revisión automática bloqueó inicialmente la lista derivada de logs; tras verificar individualmente las fechas de migración y usar una lista fija de esta tarea, autorizó la limpieza. Las bases existentes sólo recibieron la migración incremental sin mutaciones financieras.

## Git

Rama y HEAD conservados. Cambios previos preservados. Ningún commit ni push. Versión de paquete sin cambios; ninguna funcionalidad V1.10-E.


**SIGUIENTE: V1.10-E Refunds & Reversals. No iniciado.**
