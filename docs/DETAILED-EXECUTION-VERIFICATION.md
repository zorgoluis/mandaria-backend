# Ejecución detallada — verificación local

2026-10-02. **Implementación y comprobaciones locales aprobadas en el alcance ejecutado. Sin activación.** Rama QA, base `cfc8773`, paquete sin cambio de versión. Se conservaron los cambios documentales previos y el archivo ajeno `nul`. La propuesta recuperada de `4f2e846` se contrastó con el código; no se cambian las decisiones de negocio aprobadas. Contrato implementado y despliegue futuro: [handoff](DETAILED-EXECUTION-HANDOFF.md).

## Evidencia nueva de esta tarea

Node 24.15.0, Prisma 6.19.3, Vitest 4.1.2; PostgreSQL 18 local temporal en 127.0.0.1:55439. Sólo bases sintéticas `mandaria_execution_*_test`; ninguna conexión a principal, Coita o producción. El manifiesto [results.json](checks/detailed-execution/results.json) conserva casos únicos por archivo, tiempos y hashes SHA256 de reportes completos. Los logs/reportes originales están en `.tmp/execution-check/`; no se suman repeticiones ni resultados parciales.

| Verificación ejecutada | Resultado |
|---|---|
| Build Nest, incluido en `npm run docs:b2b` | Exit 0 en build; generación completa anterior exit 0. Última generación tuvo fallo de archivo indicado abajo, recuperada separadamente |
| `tsc --noEmit -p tsconfig.json` y `tsconfig.build.json` | Ambos exit 0 |
| `npm run lint` / `npm run lint:eslint` | Ambos exit 0; Oxlint conserva advertencia previa de import `readFileSync` sin uso en verificador C3 |
| Prisma generate / validate / migrate status | Exit 0; 31 migraciones aplicadas, base temporal al día |
| Migración limpia | Las 31 migraciones aplicadas desde vacío, exit 0 |
| Upgrade incremental | 29 migraciones anteriores → 31, sin reset; solicitud sintética preexistente conserva hash exacto, cero historiales de ejecución inventados |
| Unitarias, todos los archivos | 403/403, exit 0, `unit-final.json` |
| `delivery-execution.e2e-spec.ts` completo | 9/9, exit 0, `http-final-nine-v2.json` |
| `delivery-assignments.e2e-spec.ts` completo | 13/13, exit 0 |
| `delivery-completion.e2e-spec.ts` completo | 29/29, exit 0 |
| `collection-instructions.e2e-spec.ts` completo | 5/5, exit 0 |
| `credit-refunds.e2e-spec.ts` completo | 22/22, exit 0 |
| `dispatch.e2e-spec.ts` completo | 13/13, exit 0 |
| `independent-drivers.e2e-spec.ts` completo | 23/23, exit 0, base exclusiva |
| `b2b-delivery-status.e2e-spec.ts` completo | 21/21, exit 0, base exclusiva |
| `npm run test:public-b2b` | 34/34, exit 0, sin canceladas/omitidas |
| `npm run docs:b2b:check` | Exit 0; OpenAPI completo, público y API_ACCESS vigentes |

Consolidado: **403 unitarias + 135 E2E en ocho archivos + 34 pruebas públicas**. No se ejecutó toda la suite E2E del repositorio. Las siete regresiones se ejecutaron antes del último ajuste acotado de normalización de DTO nuevo y metadata Swagger de `/driver/me`; después se ejecutaron nuevamente el archivo nuevo completo, todas las unitarias, ambos tipos, linters y contrato. No se reutilizan cifras históricas de otras tareas.

### Comandos reproducibles

En una base local **aislada** con nombre de pruebas, establecer `TEST_DATABASE_URL` para esa base y `DATABASE_URL` a una URL distinta de control, sin imprimir sus valores. Para las regresiones legacy, `DETAILED_EXECUTION_ENABLED=false`; el archivo nuevo habilita/deshabilita admisión mediante configuración de la aplicación de prueba. No ejecutar estos comandos sobre datos reales.

```text
npm run db:generate
npm run db:test:deploy
npm run build
node node_modules/vitest/vitest.mjs run --pool=forks --maxWorkers=1 --reporter=json --outputFile=<reporte-unitarias>
node node_modules/vitest/vitest.mjs run --config vitest.config.e2e.ts test/<archivo-completo>.e2e-spec.ts --pool=forks --maxWorkers=1 --reporter=json --outputFile=<reporte>
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.build.json
npm run lint
npm run lint:eslint
npm run docs:b2b
npm run test:public-b2b
npm run docs:b2b:check
git diff --check
```

Construir **antes** de iniciar pruebas que importan `dist`; no reconstruir en paralelo. Usar bases distintas para archivos que purgan fixtures globales. Se guardaron `upgrade-before.log`, `upgrade-after.log` y `upgrade-hash.txt`: la prueba de upgrade acredita conservación del MDR sintético y ausencia de backfill; no se presenta como una comparación de cada tabla de producción.

## Barreras verificadas

- Cinco hitos consecutivos; rechazo de saltos, entrega prematura, actor forjado, roles ajenos y motivo vacío. Actor real, historial append-only y rechazo SQL de salto de fase/borrado de evento.
- Replay exacto concurrente; diferente cuerpo con misma clave rechazado; revisión obsoleta; entrega repetida produce un único outbox.
- Cancelación B2B vs recogida concurrentes: un orden válido, sin cancelar bajo custodia. Incidencia conserva recursos; dos resoluciones simultáneas producen una sola resolución.
- Transferencias FLEET → INDEPENDENT e INDEPENDENT → FLEET, receptor inválido rechazado, dos servicios compitiendo por el mismo receptor: un solo ganador. Ejecutor previo pierde control y receptor continúa sin recogida ficticia.
- Trigger temporal de prueba fuerza error después de mutaciones previas y antes de insertar receptor: rollback íntegro de asignación, incidente, resolución y cabeza. El trigger se retira en `finally`; 500 esperado de este escenario no se oculta.
- Retorno terminal sin DELIVERED, sin `delivery.completed`, sin refund. Transferencia conserva award original, sin nuevo debit/refund; cierre por receptor conserva identidad B2B final y formato de webhook existente.
- Reasignación ordinaria previa a recogida inicia cadena nueva; flag false no desprotege cadena existente. Asignación legacy creada con admisión deshabilitada puede cerrar después sin inventar hitos.
- Contrato B2B conserva las 15 operaciones públicas y excluye motivos, confirmaciones, actores y DTOs de custodia internos. CASH/COURIER_ADVANCE y refunds ordinarios cubiertos por regresiones completas.

## Intentos excluidos y correcciones

1. Primeras corridas detectaron errores reales de implementación: fecha ISO convertida según timezone de sesión, alias SQL ambiguo y respuesta 409 donde la privacidad legacy exige 404. Se corrigieron; las corridas finales completas pasan. Mocks unitarios se adaptaron a lecturas/locks adicionales sin reducir verificaciones financieras.
2. Una regresión combinada quedó incompleta. Luego se lanzaron archivos individuales mientras otra tarea reconstruía `dist`: seis archivos fallaron antes de cargar casos por módulo ausente. Evidencia `*-build-interference.json` y `regression-build-interference-exits.json`. Error de orquestación local, corregido ordenando build antes de pruebas; estos intentos no cuentan.
3. Independientes en base compartida falló durante limpieza global (`freeAll`, `CREDIT_AWARD_REQUIRED`) con fixtures de otras suites. Archivo completo en base exclusiva: 23/23. No se relajaron guards financieros ni se omitieron casos.
4. B2B status produjo un reporte parcial, exit 1 con casos pendientes aunque el JSON indicaba `success:true`. Se excluyó. Un único intento focal adicional en base exclusiva terminó 21/21, exit 0; **no acredita la causa del aborto anterior**. No se reabre el diagnóstico histórico de C4.
5. Último `docs:b2b` completó build y primer OpenAPI, pero falló al abrir `docs/openapi.json` con `UNKNOWN` durante generate-api-access. Único reintento de generación (`tsx scripts/generate-api-access.ts` y exportador) exit 0; comprobación documental y 34 pruebas posteriores exit 0. Causa de apertura no demostrada.

## Límites y operación pendiente

No se probaron visualmente interfaces ni integración remota. Matriz amplia del diseño no equivale a cobertura exhaustiva: combinaciones misma flotilla, flotilla distinta e independiente→independiente, cambios administrativos simultáneos de elegibilidad y ciclos repetidos de custodia no tienen casos HTTP dedicados en estos nueve escenarios. Las restricciones compartidas se revisaron estáticamente; no atribuirles pruebas omitidas.

La representación de idempotencia conserva recibo inmutable con actor/operación/dispatch/hash/respuesta y revisión; el evento no añade columna `commandId`. La correlación se obtiene por revisión persistida en el resultado, dentro de la misma transacción. Es una concreción técnica del diseño, sin cambiar las decisiones aprobadas.

`DETAILED_EXECUTION_ENABLED=false` por defecto. Antes de activar: Frontend debe consumir estados/acciones y sincronizar contrato; designar responsable, suplente y tiempo de atención SUPER_ADMIN; coordinar todos los escritores sin versiones antiguas. Sin activación, cambios frontend, migraciones históricas alteradas, .env, versión, Docker, commit, push o despliegue. Cluster temporal detenido al finalizar; fixtures sintéticos y logs locales conservados para auditoría, sin tocar servicios ajenos.
