# Cierre de limitaciones WEB — 2026-10-04

Base QA `94cdde4`. Sin frontend, Docker, Coita, producción, commit/push ni activación. `nul` preexistente conservado. Contrato vigente en [APP/WEB](DRIVER-APP-EXECUTION.md#cierre-de-limitaciones-web--2026-10-04).

## Cambios

- `trackingMode` superior LEGACY/DETAILED/null en vistas de despacho de proveedor, Driver y administración, y asignación activa de `/driver/me`. Derivado de DeliveryExecution e historia de asignaciones, nunca del flag actual, pago, ausencia de respuesta o error HTTP. Sin asignación histórica: null; sin asignación activa: no hay autorización de entrega. Se conserva el campo anidado anterior.
- GET `/provider/dispatches/:id/execution-attempt` consulta recibo ADVANCE histórico propio; POST `/close` cierra explícitamente clave desconocida. Idempotency-Key UUID original y providerId cuando corresponda. APPLIED acredita revisión sin mostrar respuesta privada; ausencia permanece incierta. `canStartNewAttempt=false` siempre: no hay permiso para avanzar.
- Migración `20261004000200_provider_historical_attempts`: amplía constraint de tombstones al namespace original ADVANCE. No altera recibos originales ni datos financieros; no añade tablas. Aplicada sobre 33 migraciones previas en dos bases aisladas, sin reset.

## Prueba histórica real y límites

Clúster PG18 nativo de pruebas, 127.0.0.1:55442, datos sintéticos retenidos de la tarea anterior. Las bases terminan `_test`; no se leyó .env. `mandaria_driver_app_upgrade_test` contiene historia generada con código archivado de d440aef mediante su suite HTTP completa (evidencia previa documentada en DRIVER-APP-EXECUTION-VERIFICATION). Esta tarea **no** repite ni cuenta aquellos 16 casos.

La verificación nueva usa **80 recibos APPLIED auténticos de PROVIDER_ADMIN**: lectura y cierre devuelven APPLIED con su revisión original; no ejecuta esos avances. Se crea una clave nueva desconocida para comprobar GET PENDING_OR_UNKNOWN → POST CLOSED_NO_EFFECTS. Después se invoca el servicio original d440aef con esa clave: rechaza EXECUTION_ATTEMPT_CLOSED. Recuento de eventos, resoluciones y ledger antes/después idéntico. El único cambio es el tombstone de prueba.

Esto es una verificación directa de servicios contra PostgreSQL real, no una prueba HTTP de la versión antigua ni autorización de despliegue mixto. El E2E actual prueba HTTP/permisos/reinicio y carrera del POST actual retirado frente al cierre. No se levantó una instancia antigua conectada a otra base.

Runner reproducible: `scripts/verify-provider-historical-receipts.mjs`. Exige TEST_DATABASE_URL localhost y nombre `_test`, historial sintético previo y ruta del módulo histórico compilado. El build histórico se obtiene con `git archive d440aef` y sus migraciones/suite en una base nueva de prueba antes de aplicar las siguientes; no se fabrica un recibo con SQL. Ejecución utilizada:

```powershell
# TEST_DATABASE_URL apunta exclusivamente a la base histórica aislada.
node scripts/verify-provider-historical-receipts.mjs .tmp/driver-app-check/baseline/dist/delivery-execution/execution.service.js
```

Sólo imprime conteos/códigos seguros. Evidencia `.tmp/provider-history-check/historical-result.json` y resumen versionable de esta tarea.

## Resultados nuevos

- E2E secuencial completo: **86/86**, exit 0 (ejecución 27, driver-self 7, cierre legacy 29, independientes 23).
- Ejecución completa repetida sobre build final: **27/27**, exit 0 (`execution-current.json`); no suma casos nuevos al total 86.
- Unitarias secuenciales completas: **403/403**, exit 0.
- Runner histórico reproducible: exit 0, 80 recibos APPLIED y comando original tardío rechazado, sin cambio de eventos/resoluciones/ledger.
- Build y OpenAPI generados; docs:b2b:check y ambos tsc --noEmit exit 0 contra el build final. Oxlint y ESLint exit 0; Oxlint conserva advertencia previa de import no usado ajeno a esta tarea. Pruebas públicas **34/34**, exit 0.
- [Huella de reportes y conteos por archivo](checks/provider-historical-attempts.json). No se suman ejecuciones anteriores.

## Pruebas y comandos

Logs/reportes en `.tmp/provider-history-check/`. Se ejecutan archivos completos, no se suman repeticiones ni pruebas omitidas:

```powershell
npm run docs:b2b
node node_modules/vitest/vitest.mjs run --config vitest.config.e2e.ts test/delivery-execution.e2e-spec.ts test/driver-self.e2e-spec.ts test/delivery-completion.e2e-spec.ts test/independent-drivers.e2e-spec.ts --pool=threads --maxWorkers=1 --reporter=json --outputFile=.tmp/provider-history-check/e2e-sequential.json
node node_modules/vitest/vitest.mjs run --maxWorkers=1 --reporter=json --outputFile=.tmp/provider-history-check/unit-sequential.json
npm run docs:b2b:check
# Esperar a que docs:check termine su rebuild antes de tipos.
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.build.json
npm run lint
npm run lint:eslint
npm run test:public-b2b
git diff --check
```

Casos nuevos: nunca asignado OPEN/CLAIMED devuelve null; asignado detallado expone DETAILED en las tres superficies y `/driver/me`; legacy expone LEGACY sin fabricar ejecución. Intento desconocido no se considera fallo; cuenta ajena/roles diferentes rechazados; cierre concurrente con POST del proveedor retirado, replay tardío 403, consulta durable tras recrear backend, revisión sin cambios. Se conservan las pruebas completas de entrega legacy y detallada, custodia, independencia y créditos/outbox.

## Intentos no aprobados

- Primer E2E: helper async de la prueba nueva usado como Supertest directo; TypeError y posteriores conflictos de recursos por no terminar el fixture. Se corrigió la espera de Promise y la aserción de status; no se debilitaron controles de producto.
- Primeras unitarias: EPERM al renombrar caché temporal dentro del sandbox, cero casos acreditados. Se reejecutan fuera del sandbox con autorización local.
- Ejecución simultánea unitarias/E2E: hook HTTP excedió 10 segundos y dos E2E alcanzaron 5 segundos. No se cambian timeouts ni aserciones; se ejecutan secuencialmente. No se atribuye causa nativa no demostrada ni se cuentan reportes parciales.

- Dos regeneraciones finales fallaron con UNKNOWN al abrir docs/openapi.json y docs/API_ACCESS.md (docs-current.log / docs-current-outside.log). La generación anterior exit 0 (docs-final.log) produjo los artefactos; la comprobación final de sólo lectura reconstruyó el backend y confirmó ambos artefactos y contrato público vigentes, exit 0. No se afirma causa resuelta ni se cambia el generador.

La evidencia de la adaptación DRIVER anterior es histórica para esta solicitud y permanece separada. No suite E2E total, prueba visual WEB ni app móvil. La activación y el despliegue coordinado siguen pendientes.
