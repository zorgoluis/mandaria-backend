# Verificación local de seguimiento público B2B

2026-10-04. Base QA `b4318ce` más cambios locales; no publicado ni desplegado. Contrato: [PUBLIC-B2B-TRACKING.md](PUBLIC-B2B-TRACKING.md). Evidencia ejecutada en esta tarea, no reutilizada como nueva desde informes anteriores.

## Entorno y resultados

Node 24.15.0, Prisma 6.19.3, Vitest 4.1.2 y PostgreSQL 18 nativo en loopback:55442. Bases sintéticas nuevas `mandaria_b2b_tracking_test`, `mandaria_b2b_execution_test`, `mandaria_b2b_tracking_final_test` y `mandaria_b2b_tracking_upgrade_test`. No reset, base principal, Docker, Coita ni servicios productivos. Logs/reportes locales en `.tmp/public-tracking-check/`; resumen y huellas en [checks/public-b2b-tracking.json](checks/public-b2b-tracking.json).

| Verificación nueva | Resultado acreditado |
|---|---|
| delivery-execution.e2e-spec.ts completo, intento final verbose+JSON | 29/29, exit 0 |
| b2b-delivery-status.e2e-spec.ts completo | 21/21, exit 0 |
| public-delivery-tracking.e2e-spec.ts completo | 2/2, exit 0 |
| Cinco archivos unitarios pertinentes | 59/59, exit 0 |
| Exportador público y firma | 35/35, exit 0 |
| Build y generación OpenAPI completo/público | exit 0 |
| TypeScript sin emisión, tsconfig.json y tsconfig.build.json | exit 0; comprobación final secuencial |
| Oxlint / ESLint | exit 0; Oxlint conserva warning preexistente de readFileSync no usado en verificador C3 |
| docs:b2b:check | exit 0, documentación y artefacto vigentes |
| Prisma generate, validate, migrate status | exit 0; 35 migraciones |
| Instalación limpia y upgrade con datos | 35 migraciones; upgrade 34→35 preservado |
| Drift final | exit 0, No difference detected |

Total E2E: **52 casos únicos** en tres archivos completos. No se suman repeticiones ni resultados parciales. Cobertura: cinco hitos, cierre real, legacy, ausencia de asignación, incidencia, devolución, transferencia con receptor público actualizado, reasignación, nombres visibles, snapshots repetidos/concurrentes, descarte de respuestas fuera de orden, rollback, nueva conexión Prisma, expiración observada durable, privacidad/ownership y compatibilidad del payload delivery.completed. Se conserva la regresión financiera/custodia/recibos incluida en el archivo de ejecución; no se ejecutó la suite completa del repositorio.

El upgrade parte de una copia nueva de la base sintética previa con 34 migraciones, no de una base vacía. `verify-public-tracking-upgrade.mjs` comprobó conteos/huellas iguales antes/después en nueve tablas: solicitudes, dispatches, asignaciones, eventos de ejecución, incidencias, resoluciones, recibos, ledger y outbox. 25 solicitudes anteriores recibieron 25 filas técnicas; 160 eventos, 143 recibos y 100 movimientos conservados. El resumen incorpora las huellas de esa ejecución.

## Comandos reproducibles

Preparar `TEST_DATABASE_URL` exclusivamente para una base nueva identificada, local y terminada en `_test`, y `DATABASE_URL` distinto para satisfacer la protección del config de pruebas. No imprimir URLs con credenciales. El script de upgrade exige sufijo `_upgrade_test` y datos sintéticos anteriores; no ejecutar contra una base operativa.

```text
node node_modules/prisma/build/index.js generate
node node_modules/prisma/build/index.js validate --config prisma.test.config.ts
node node_modules/prisma/build/index.js migrate deploy --config prisma.test.config.ts
node node_modules/prisma/build/index.js migrate status --config prisma.test.config.ts
node node_modules/prisma/build/index.js migrate diff --from-config-datasource --to-schema-datamodel prisma/schema.prisma --config prisma.test.config.ts --exit-code
node scripts/verify-public-tracking-upgrade.mjs
npm run docs:b2b
npm run docs:b2b:check
npm run test:public-b2b
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.build.json
npm run lint
npm run lint:eslint
node node_modules/vitest/vitest.mjs run --pool forks --maxWorkers 1 test/delivery-status.spec.ts test/public-execution-identity.spec.ts test/b2b-outbox.spec.ts test/b2b-webhooks.spec.ts test/delivery-requests.spec.ts --reporter=json --outputFile=.tmp/public-tracking-check/unit-final.json
node node_modules/vitest/vitest.mjs run --config vitest.config.e2e.ts --pool forks --maxWorkers 1 test/b2b-delivery-status.e2e-spec.ts test/public-delivery-tracking.e2e-spec.ts --reporter=verbose --reporter=json --outputFile=.tmp/public-tracking-check/b2b.json
node node_modules/vitest/vitest.mjs run --config vitest.config.e2e.ts --pool forks --maxWorkers 1 test/delivery-execution.e2e-spec.ts --reporter=verbose --reporter=json --outputFile=.tmp/public-tracking-check/execution-diagnostic.json
git diff --check
```

## Intentos no acreditados

- Primer reporte mixto `e2e.json`: 26 aprobados, cinco fallos por expectativas antiguas del contrato aditivo y 21 pendientes. Se actualizaron allowlists y comparación explícita de los siete campos originales del webhook, conservando las aserciones de privacidad. No cuenta como suite aprobada.
- `execution.json`: 29/29 completos antes de fortalecer aserciones de nombre de proveedor/receptor. Evidencia intermedia, no se suma al total final.
- `execution-final.json`: exit 1, ocho aprobados y 21 pendientes, sin aserción fallida. Su `success=true` no acredita completitud. Causa del cierre parcial no demostrada; no se atribuye a Windows ni se declara resuelta.
- Un único diagnóstico adicional final, en base nueva y con verbose+JSON, completó 29/29 con exit 0 (`execution-diagnostic.json`). No se omitió ningún caso ni se cambió el pool forks/aislamiento del repositorio.
- Primer intento unitario bloqueado por EPERM al renombrar caché de Vitest: cero casos acreditados; repetición autorizada fuera del sandbox completó 59/59. Primer arranque nativo bajo sandbox no abrió TCP; arranque posterior autorizado habilitó sólo el cluster sintético.
- Build intermedio falló por edición de DTO posteriormente corregida; drift intermedio detectó `onUpdate` incorrecto en la relación nueva, corregido en schema sin tocar migraciones históricas. Sólo resultados finales se acreditan.
- Una verificación de tipos concurrente con docs:check produjo TS2307 sobre dist: el script documental ejecuta nest build y reconstruye ese directorio. Build seguido secuencialmente por tsc completó exit 0 (`build-final.log`, `types-verified.log`). No se excluyeron pruebas ni se cambió strict para resolver la interferencia.

## Límites y pendientes

No benchmark ni capacidad garantizada a 15 segundos. Triggers conservadores pueden aumentar contención y saltar versiones sin cambio visible; monitorizar latencia/conflictos al desplegar. La publicación tiene cinco reintentos y puede devolver 503. La versión es durable dentro de la historia de la base, no a través de un restore con pérdida de datos. No se añade timeline ni webhook de progreso.

Pruebas HTTP locales con PostgreSQL real y routing sintético; no integración con frontend/Coita ni prueba remota. Frontend del portal debe sincronizar contrato y guías. Actualización coordinada de instancias/migración y activación requieren proceso separado. Se preservan cambios previos y `nul`; sin commit/push.

Limpieza: cluster PostgreSQL sintético detenido con pg_ctl al finalizar; bases y reportes conservados para auditoría. Docker no se arrancó. Referencias locales de las cinco guías revisadas y git diff --check sin errores. No se modificaron paquete/versión, configuración operativa ni migraciones históricas.
