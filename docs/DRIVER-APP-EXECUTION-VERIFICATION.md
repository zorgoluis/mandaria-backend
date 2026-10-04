# Autoridad DRIVER — verificación local

2026-10-03, rama QA, base publicada `d440aef`; cambios de esta tarea aún locales. No commit/push/despliegue/activación. Se conservó `nul` preexistente. No se modificaron frontend, Coita, .env, versión ni migraciones históricas. Docker permaneció apagado.

## Alcance y evidencia

Backend implementado: hitos/entrega detallada del Driver asignado (flotilla e independiente), incidencias y permisos existentes del administrador, recuperación durable de ADVANCE/REPORT/DELIVER, cierre técnico atómico y compatibilidad legacy explícita. Se reutilizan ejecución, cierre y outbox existentes. Contrato: [APP y WEB](DRIVER-APP-EXECUTION.md).

Pruebas reales de esta misma tarea, antes de la pausa y conservadas al retomar (no son las pruebas históricas del despliegue anterior):

| Archivo / alcance | Resultado completo válido | Reporte local |
|---|---|---|
| Unitarias | 403/403, exit 0 | `.tmp/driver-app-check/unit.json` |
| delivery-execution.e2e-spec.ts | 25/25, exit 0 | `execution-final-cleanup.json` |
| delivery-completion.e2e-spec.ts y driver-self.e2e-spec.ts | 29 + 7, exit 0 | `compatibility-cleanup.json` |
| Backend histórico d440aef, delivery-execution completo | 16/16, exit 0, sólo para preparar actualización | `baseline-retry.json` |

Las 25 pruebas cubren orden y roles, Driver ajeno/anterior, transferencia y devolución, replay, pérdida simulada de respuesta, cierre antes de petición tardía, las tres operaciones en ambos modos, recreación del backend sobre los mismos recibos, concurrencia de cierre/entrega, fallo controlado del INSERT del recibo y rollback de entrega/outbox, conservación de award/refunds y cierre legacy con revisión cero. No afirman ensayo de app real ni entrega física.

Después de reanudar se repiten sólo asignaciones e independientes para obtener un comando global exit 0, sin reutilizar como aprobada la ejecución global fallida `e2e-v2.json`. Resultado final y huellas en [resumen de evidencia](checks/driver-app-execution.json). **Resultado posterior a reanudación: 36/36, exit 0**, `assignment-independent-final.json`. Casos únicos acreditados: 25 + 29 + 7 + 13 + 23 = **97 E2E**, sin contar el baseline ni repeticiones como casos adicionales.

## PostgreSQL e incremental

PG18 nativo, clúster nuevo `.tmp/driver-app-check/pgdata`, sólo 127.0.0.1:55442 y usuario sintético `driver_app_test`. No servicio instalado ni base principal. Bases exclusivas `mandaria_driver_app_v2_test` (instalación limpia) y `mandaria_driver_app_upgrade_test` (actualización). Routing doble, correo local y sin envíos externos.

- Instalación limpia: las 33 migraciones, incluido `20261004000100_driver_execution_authority`, deploy exit 0 (`migrate-v2.log`).
- Actualización real sin reset: `git archive HEAD` a directorio temporal, compilar código previo y aplicar sus 32 migraciones. Su suite HTTP completa genera historia anterior. Capturar hashes ordenados, aplicar migración 33, comparar de nuevo.
- Conservados byte a byte en serialización de filas: 160 eventos, 15 resoluciones, 31 asignaciones, 100 movimientos de ledger y 127 recibos originales. Incluye fixtures retenidos del intento histórico abortado; no se cuentan como casos aprobados.
- Se agregan 14 alias de recibos Driver ADVANCE/REPORT. Consulta y cierre con servicio nuevo devuelven APPLIED en los 14, sin reclasificar como CLOSED_NO_EFFECTS ni ejecutar operaciones físicas (`upgrade-before.json`, `upgrade-result.json`, `upgrade-deploy.log`).
- `prisma validate` y `prisma migrate status` exit 0 al reanudar. No cambio de schema Prisma: la migración cambia guards, constraint de recibos y agrega alias; no nuevos modelos/tablas.

## Comandos reproducibles

En una base **nueva aislada** ya migrada, establecer TEST_DATABASE_URL explícita (nombre terminado `_test`) y DATABASE_URL distinta para la guardia del runner. Nunca utilizar .env de producción. Estos comandos no crean datos en otra base ni requieren Docker:

```powershell
npm run build
node node_modules/vitest/vitest.mjs run --reporter=json --outputFile=.tmp/driver-app-check/unit.json
node node_modules/vitest/vitest.mjs run --config vitest.config.e2e.ts test/delivery-execution.e2e-spec.ts --pool=threads --maxWorkers=1 --reporter=json --outputFile=.tmp/driver-app-check/execution-final-cleanup.json
node node_modules/vitest/vitest.mjs run --config vitest.config.e2e.ts test/delivery-completion.e2e-spec.ts test/driver-self.e2e-spec.ts --pool=threads --maxWorkers=1 --reporter=json --outputFile=.tmp/driver-app-check/compatibility-cleanup.json
node node_modules/vitest/vitest.mjs run --config vitest.config.e2e.ts test/delivery-assignments.e2e-spec.ts test/independent-drivers.e2e-spec.ts --pool=threads --maxWorkers=1 --reporter=json --outputFile=.tmp/driver-app-check/assignment-independent-final.json
npm run docs:b2b
npm run docs:b2b:check
# docs:check reconstruye dist: esperar a que termine antes de tsc.
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.build.json
npm run lint
npm run lint:eslint
npm run test:public-b2b
node --check scripts/prepare-desktop-execution-fixtures.mjs
git diff --check
```

Build/generación OpenAPI y Oxlint exit 0 antes de la pausa (advertencia preexistente de import no usado en `verify-authorized-acceptance-c3-regression.mjs`, no ocultada). Al reanudar: ambos tsc exit 0, ESLint exit 0, docs:b2b:check exit 0, 34/34 pruebas públicas exit 0 y sintaxis del preparador exit 0. No se ejecutó el preparador Docker modificado: sólo revisión estática; los recorridos Docker anteriores requieren imagen/migración futura compatibles.

## Intentos no acreditados y correcciones

- `e2e-v2.json`: comando exit 1, 67 aprobados, 1 fallo y 29 pendientes. Swagger carecía de descripción en rutas Driver y la zona sintética retenida de ejecución colisionaba con la suite legacy. Se añadieron descripciones y se desactiva exclusivamente la zona propia al terminar, conservando historia. La suite legacy fija flag false expresamente. Ejecuciones completas posteriores acreditan los archivos afectados; no se suman los resultados parciales.
- `completion-diagnostic.log`: sin acceso a localhost desde sandbox; no pruebas aprobadas. Diagnóstico con acceso local (`completion-diagnostic-network.log`) identifica 409 al activar zona, no fallo del cierre de producto. Se conservan logs de intentos posteriores anteriores al teardown corregido.
- Baseline inicial: aborto nativo exit -1073740791, sin reporte; causa no acreditada. Único intento adicional con pool forks y un worker, archivo histórico completo 16/16 exit 0. No se atribuye la causa a Windows ni se afirma haber reparado el runner.
- Tipos al reanudar: primera ejecución coincidió con `docs:check` reconstruyendo dist y dio módulos ausentes. Tras terminar la reconstrucción, ambos tsc completos exit 0 (`types-final-0.log`, `types-final-1.log`); no se alteraron tipos para ocultarlo.

## Límites y entrega

No suite E2E total, carga, móvil, revisión visual, despliegue mixto ni servicios externos. OpenAPI B2B no agrega operaciones de Driver ni nuevos eventos. App y adaptación WEB están pendientes; no se activa la función hasta disponer de cliente Driver y soporte SUPER_ADMIN. El handoff prescribe ventana coordinada, guarda legacy y prohíbe escritores antiguos después de la migración. PostgreSQL temporal se detiene conservando datos/evidencia; no se borran recursos ajenos.
