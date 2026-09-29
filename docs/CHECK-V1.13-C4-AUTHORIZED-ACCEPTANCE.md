# CHECK V1.13-C4 — Aceptación autorizada

2026-09-29 UTC. **PARTIAL**: aceptación autorizada y gates locales comprobados, pero falta acreditar un archivo de la regresión E2E completa. V1.13-C no se declara cerrada.

## Alcance y línea base

Rama `1.13-Precotización_integración_comida_prepagada`, HEAD `69f757b8c5049771d6a893c77506bb81242001a9`, versión 1.12.0. [Línea base](checks/v1.13-c4-baseline.json): 348 archivos existentes de producto, pruebas, contratos, migraciones, scripts y configuración. `nul` era el único untracked preexistente; se conserva. `.env` se compara privadamente, sin publicar contenido ni huella.

Fuentes revisadas: AGENTS, BITACORA, README, VERIFICATION, [C1](V1.13-C1-AUTHORIZED-ACCEPTANCE-DESIGN.md), [C2](V1.13-C2-AUTHORIZED-ACCEPTANCE-IMPLEMENTATION.md), [C3](V1.13-C3-AUTHORIZED-ACCEPTANCE-ADVERSARIAL-VERIFICATION.md), índices C2/C3 y cierres [A6](CHECK-V1.13-A6-PREQUOTES.md) y [B4](CHECK-V1.13-B4-CONVERSION.md), incluida su [revisión independiente](REVIEW-V1.13-B4-CHECK.md). Sus cifras son históricas y no se suman a C4.

Node 24.15.0, Vitest 4.1.11, Prisma 6.19.3, TypeScript 6.0.3; PostgreSQL local (versión exacta en evidencia de migraciones). El inventario previo descubre 34 archivos unitarios y 32 E2E. C4 añade sólo `test/check-c4-recovery.e2e-spec.ts` (dos casos); inventario final 34 unitarios y 33 E2E. [Inventario](checks/v1.13-c4-inventory.json).

Bases nuevas `mandaria_c4_clean_7ea77a453d_test` y `mandaria_c4_upgrade_7ea77a453d_test`; cada archivo E2E usa además una base propia `mandaria_c4_reg_*_test`, registrada en [regresión](checks/v1.13-c4-regression.json). Ninguna conexión de pruebas/migración apunta a la principal. Sólo routing/efectos externos controlados; webhooks usa receptores locales. Sin Docker, Coita ni servicios externos reales.

## Matriz C1 → implementación → evidencia

Los resultados de ejecución se consolidan por archivo completo en la sección de resultados. Una lectura de código no sustituye una prueba.

| Requisito | Implementación contrastada | Prueba/evidencia C4 | Resultado |
|---|---|---|---|
| Atestación de MQ exacta, posterior a conversión | `authorized-acceptance.dto.ts`, `AuthorizedAcceptanceService.accept`, SQL `AuthorizedQuoteAcceptance` | C2/C3: importe, moneda, publicId, expiry, fechas anteriores/futuras, DTO estricto; C4 recuperación a precio igual/menor | PASS local |
| Frontera de confianza | Servicio recibe declaración B2B; SQL valida estructura/hechos, no acto humano ni firma JWT | C3 escritor SQL completo puede construir atestación válida; consentimiento y evidencia original en Coita no verificados aquí | Límite confirmado; Coita no acreditada |
| Ownership/scopes/contexto técnico | `IntegrationGuard`, auth service y locks de client/credential; metadata del token obtenida por servidor | C3 token real, ajena/inexistente indistinguibles, scope removido, suspensión/revocación y vencimiento durante espera | PASS local |
| Inmutabilidad/reciprocidad | Migración `20260929000100_authorized_quote_acceptance`: evidencia/key/MQ/MDR/conversión/Dispatch, constraints diferidos | C3 SQL válido con P0001/guarda exacta; edición, borrado, reparentado, key huérfana, destino cruzado y adopción de Dispatch anterior | PASS local |
| Atomicidad e idempotencia | `IdempotencyService.execute` + accept + `openDispatch` en una transacción; lectura posterior repetible | C3 una key/múltiples keys con locks observados; rollback de evidencia/MQ/Dispatch/snapshots/candidatos; respuesta perdida después de commit y replay desde otra instancia | PASS local |
| TTL tras espera | Relectura MQ y reloj DB después de locks; validación diferida final | C3 vencimiento por espera y durante snapshots; unitaria C3 igualdad exacta MQ/JWT/credencial; no renovación TTL | PASS local |
| Recorrido A→B→C | Servicios reales de auth, A5 durable, conversión, aceptación y PostgreSQL | C3 dos Nest/pools: emisión un permiso/una ejecución/una ruta; conversión y accept cero adicionales; una evidencia/Dispatch/dos snapshots; ledger intacto | PASS local |
| Replay | Key y recurso inmutables; guard HTTP vigente, callback de creación no se repite | C3 replay tras expiry/cancel/flag off; mismos IDs y acceptedAt, ninguna reapertura; auth inválida bloquea lectura | PASS local |
| Cancelación y recuperación | Cancel bloquea MDR y cierra Dispatch; `/status` conserva prioridad DELIVERED | C3 ambos órdenes cancel/accept y cancel/completion; MQ vencida OFFERED/EXPIRED; C4 cancela y consulta estado antes de emitir otra MPQ | PASS local |
| Nueva MQ/nuevo consentimiento | Comparación estricta de tuple y fecha; MPQ consumida no reutilizable | C4 dos casos precio igual/menor rechazan atestación anterior y aceptan nueva, conservan snapshot/TTL anteriores y comida; C2/C3 mismatch e identidad de MQ | PASS local |
| Coordinación por pedido | `externalReference` no tiene UNIQUE empresarial | C3 dos recursos misma referencia son válidos. Serializar generaciones y bloquear reemplazo incierto corresponde a Coita; aplicación externa no acreditada | Límite confirmado; Coita no acreditada |
| Flag apagado/historia | Guard sólo creación; replay y lifecycle siguen rutas existentes | C3 revoca B2B, vence MQ, apaga flag y ejecutor completa; backend antiguo lee/cancela pero no ofrece accept/replay C | PASS local |
| Legacy y contrato B | Accept vacío legacy delegado al servicio existente; conversión conserva manifiestos/snapshots; C no restaura bloqueo absoluto sobre historia autorizada | Archivos completos A6, B2/B3/B4, quotes, dispatch, independent, assignments, créditos/refunds/completion/outbox; legacy PREPAID/COURIER_ADVANCE y colección CASH | Focalizados PASS; regresión integral PARTIAL (solicitudes B2B) |
| Separación financiera | PREPAID es comida; accept no SERVICE_AWARD; créditos se consumen al CLAIM/TAKE según reglas existentes | C2/C3/C4 ledger intacto en accept; lifecycle/refunds de créditos cubiertos por regresión; ninguna confirmación de cobro del envío | PASS local |

## Recuperación y límites operativos

La barrera aprobada es **MDR CANCELLED y estado logístico CANCELLED/EXPIRED, con deliveredAt null**. Cancel200/MDR CANCELLED puede coexistir con DELIVERED cuando completion ganó: no iniciar sucesor. Mientras una respuesta sea incierta, Coita conserva key/intención, reintenta/consulta y no inicia otra generación. Esta responsabilidad externa no se acredita por los tests Mandaria.

Una vez confirmada la barrera: nueva MPQ vigente → conversión B con confirmación de restaurante/pago conservada y pedido aún vigente → consentimiento nuevo de MQ exacta → accept con key propia. No se reutiliza MPQ consumida ni se renueva precio/TTL. No sustitución enlazada/atómica. Reiniciar envío no exige nueva transferencia de comida ni implica devolución. Entrega física, aceptación y cobro efectivo son hechos distintos.

SQL no garantiza commit físico anterior a expiry si un escritor valida el conjunto completo con `SET CONSTRAINTS ALL IMMEDIATE` antes de vencer y demora después el COMMIT. C3 comprueba ese límite aceptado, conservando expiry original. HTTP mantiene sus revalidaciones y constraints diferidos. DDL/superusuario y fabricación de atestaciones por un escritor privilegiado quedan fuera de esa confianza.

## Ejecución, intentos y diagnóstico

[Índice de comandos](checks/v1.13-c4-evidence.json), [regresión por archivo](checks/v1.13-c4-regression.json), [unitarias](checks/v1.13-c4-unit.json). Cada intento conserva comando sanitizado, exit/señal, log y referencia al reporte. Un reporte parcial aunque diga `success: true` no cuenta; se exige exit 0, archivo completo y todas las aserciones aprobadas. Semillas filtradas de upgrade no cuentan como suite adicional.

Se ejecutan los E2E secuencialmente, una base por archivo, sin builds concurrentes. Pool threads para familias authorized-acceptance/check/prequote; forks para las restantes, siguiendo la experiencia documentada C3. No se modifica configuración compartida de Vitest ni casos existentes. Ante terminación incompleta, sólo un ensayo diagnóstico por archivo con el pool alternativo sobre su misma base; logs separados y observador adicional de fin/errores del runner. Cambiar pool no acredita causa raíz ni estabilidad absoluta.

Generación API_ACCESS: primer intento exit 1 por `UNKNOWN errno -4094` de Node al abrir `docs/openapi.json`; único reintento sin cambios de fuente exit 0 y docs:check posterior exit 0. No se atribuye a Windows ni a producto sin evidencia causal. Se conserva el log original.

## Migraciones, invariantes y limpieza

Runner C4 revisado: instalación limpia, baseline de todas las migraciones previas a C, conversión B real por HTTP, hashes de nueve tablas antes/después, sin backfill de autorizaciones. Status/reaplicación/drift sólo sobre las dos bases aisladas; catálogo de triggers activos comparado. El verificador A3 obsoleto no se ejecuta ni se corrige; estos runners y la suite A6/B2/B3/B4 cubren la cadena actual, sin afirmar que reparan aquel script.

El escaneo C4 extiende C3 con vínculos A/B, manifiestos, snapshot/expiry, tuple C, cadena y saldo de ledger, awards/refunds duplicados y Outbox de completion. Reevalúa además la función existente de integridad de adjudicación en lectura: no es un algoritmo independiente del constraint. Conserva exenciones LEGACY/pre-enforcement; no aplica la antigua regla B de prohibir todo Dispatch convertido, que sería incorrecta para historia C autorizada.

## Resultados y dictamen

| Verificación nueva | Resultado |
|---|---|
| Unitarias, inventario completo | **393/393, 34/34 archivos**, exit 0, reporte completo |
| E2E acreditadas | **738 casos, 32/33 archivos** completos exitosos; no se suman fragmentos ni repeticiones |
| Archivo pendiente | `test/delivery-requests-b2b.e2e-spec.ts`, 15 casos descubiertos; ningún intento completo exitoso en C4 |
| Focalizados nuevos/repetidos íntegros | A6 36; B2 39; B3 58; B4 24; C2 35; C3 62; recuperación C4 2 |
| Webhooks y estado B2B | 54/54 y 21/21 respectivamente en único diagnóstico threads, exit 0; primeros intentos incompletos excluidos |
| Prisma validate/generate, build | PASS |
| `tsc --noEmit --incremental false` para tsconfig.json y tsconfig.build.json | PASS, cero errores |
| Oxlint, ESLint | PASS; Oxlint repetido después de agregar runners C4 |
| OpenAPI, API_ACCESS, docs:check | PASS; artefactos idénticos al baseline. Fallo inicial de lectura conservado |
| Limpia/upgrade B no vacío | PASS, 29 migraciones; nueve tablas históricas idénticas por hash, sin backfill de autorización |
| Status/reaplicación/drift | PASS en limpia y upgrade; catálogos iguales, 70 triggers activos |
| Invariantes en 35 bases | PASS; 23 contadores en cero por base y función de integridad económica aprobada |
| Limpieza | 0 credenciales sintéticas activas; usuarios/zonas/proveedores retirados; 0 otras conexiones observadas por base; historia preservada |
| Congelación | **348/348 archivos idénticos**, `.env` comparado privadamente e idéntico, HEAD/versión intactos |
| Referencias, JSON, secretos, diff | Verificador C4: referencias existentes, JSON parseable, ningún JWT/URL de DB/valor privado conocido; `git diff --check` |

[Consolidación por archivo y caso](checks/v1.13-c4-consolidated.json), [upgrade](checks/v1.13-c4-upgrade.json), [migraciones finales](checks/v1.13-c4-migrations-final.json), [escaneo](checks/v1.13-c4-all-database-scan.json), [limpieza](checks/v1.13-c4-cleanup.json), [comparación de artefactos](checks/v1.13-c4-artifact-check.json).

Oxlint termina exit 0 con una advertencia preexistente: import `readFileSync` no usado en `scripts/verify-authorized-acceptance-c3-regression.mjs:4`; el archivo congelado se conserva. La comprobación adicional de whitespace de los 201 archivos nuevos C4 encontró cero incidencias, además de `git diff --check` para los tres documentos tracked.

El total descubierto es 753 E2E; **no** se declara 753 aprobadas. Quince pertenecen al archivo no acreditado. Los casos parametrizados con el mismo nombre visible se identifican por archivo y ordinal dentro del único reporte completo elegido; `prequotes-http` tiene ocho entradas diferentes con el mismo rótulo. El primer consolidador rechazó esa repetición de etiquetas (33 nombres frente a 40 casos); se corrigió su identidad de caso sin modificar ni repetir pruebas. Su exit 1 final es deliberado por 32/33 archivos, no un fallo de aserción de producto.

### Terminaciones incompletas y diagnóstico acotado

[Intentos alternativos](checks/v1.13-c4-diagnostics.json), [consulta de eventos](checks/v1.13-c4-native-events.json). Misma base por archivo en ambos intentos; sólo cambia pool y se amplía el reporter de observación. No hay exclusiones de casos ni cambio de timeout para aprobar.

| Archivo | Primer intento forks | Único diagnóstico threads | Resultado acreditable |
|---|---|---|---|
| b2b-delivery-status | exit 1, JSON parcial 16/21; 0 aserciones fallidas | exit 0, 21/21, fin normal sin unhandled errors | 21 |
| b2b-webhooks | exit 1, JSON parcial 6/54; 0 aserciones fallidas | exit 0, 54/54, fin normal sin unhandled errors | 54 |
| delivery-requests-b2b | exit 1, JSON parcial 11/15; 0 aserciones fallidas | **3221226505 / 0xC0000409**, señal null, sin JSON ni evento de fin | **0; pendiente** |

El primer intento de solicitudes B2B termina tras comenzar el caso de administración SUPER_ADMIN; el segundo después de comenzar `rate-limits creation per the existing throttler` (línea 639), que envía 61 requests inválidos secuenciales y exige el 429 final. Diferentes puntos de corte no demuestran un defecto de ese test ni una causa de producto. Ambos duran aproximadamente 9 segundos: no alcanzan el timeout de 300 segundos del padre; no hay evidencia de aserción fallida o timeout. La base propia descarta mezcla entre archivos, pero no demuestra ausencia absoluta de interferencia interna ni recursos abiertos.

Los intentos usaron `--report-on-fatalerror --report-exclude-env --report-exclude-network`; no se generó reporte nativo. La consulta acotada del log Application no encontró eventos Node 1000/1001. Falta stack/dump que identifique el módulo causante; no se atribuye a Windows, Prisma, Vitest ni a un recurso abierto sin evidencia. No se repite de nuevo. Un reporte parcial con `success:true` es insuficiente y fue excluido explícitamente.

Un intento inicial del verificador de artefactos no pudo lanzar su subproceso (`spawnSync EPERM`, exit del hijo null); se conserva como fallo de infraestructura de permisos, separado del aborto del runner. La ejecución con permiso para subprocesos Git de lectura pasó.

### Evidencia histórica y compatibilidad

Los 336 archivos del baseline C3 se contrastan nuevamente en el verificador de artefactos; la aplicabilidad se registra allí, sin reutilizar sus totales como C4. Además, el archivo C3 completo fue ejecutado nuevamente e incluye el ensayo del código pre-C contra schema actual. Los resultados A6/B4 anteriores se conservan como historia; los respectivos archivos de prueba se ejecutaron ahora completos.

### Limpieza y observabilidad

Escaneo final conserva 320 precotizaciones, 218 conversiones, 41 autorizaciones, 18 movimientos de ledger y 6 eventos Outbox en las bases del CHECK. Son filas sintéticas acumuladas, **no contadores de tests**. Los hooks existentes conservan o limpian sus propios fixtures; C4 no purga historia/ledger, no restaura saldos ni altera políticas. Retira sólo accesos/capacidad sintéticos remanentes en las bases nuevas identificadas. Algunas solicitudes sintéticas mantienen el estado del ensayo para auditoría; no hay backend/worker de C4 operando esas bases.

Logs de ejecución revisados y sanitizados; C3 comprueba que logs/proyecciones no filtran token ni referencia privada. Los 500/503 y fallos SQL inducidos por pruebas de rollback/timeout son escenarios explícitos, no éxito silencioso ni motivo para ignorar errores. No se acredita captura completa del log interno de PostgreSQL o estabilidad del runner. El escaneo no encontró guardas deshabilitadas ni instrumentación de fallo residual.

**Defectos de producto reproducidos: ninguno. Bloqueo del cierre: un archivo E2E sin ejecución íntegra exit 0.** Siguiente acción propuesta, con alcance propio: diagnóstico causal instrumentado de `delivery-requests-b2b` (worker/proceso nativo, stack/dump seguro y recursos), y acreditación completa del mismo archivo sin debilitar sus casos. Conservar estos intentos; no sustituirlos por una corrida histórica. No iniciar D ni activar C.

## Cambios y exclusiones

Sólo pruebas/runners/evidencia/documentación C4 y actualizaciones de continuidad. Sin cambio de producto, pruebas existentes, migraciones, .env, versión ni configuración operativa. Sin commit/push/despliegue/activación. No D ni resolución silenciosa de pendientes operativos A.

[Manifiesto de archivos](checks/v1.13-c4-files.json): nueva suite `test/check-c4-recovery.e2e-spec.ts`; runners `check-authorized-acceptance-c4-{run,full-suite,migrations,drift}`, `diagnose-authorized-acceptance-c4-runner`, `c4-runner-observer`, `scan-authorized-acceptance-c4-all`, `cleanup-authorized-acceptance-c4`, `consolidate-authorized-acceptance-c4` y `verify-authorized-acceptance-c4-artifacts`; este informe e índices/reportes/logs C4. Modificados: BITACORA.md, VERIFICATION.md y una actualización puntual de estado en README.md. Los nuevos artefactos de texto se normalizaron sólo en whitespace final y salto de línea, sin cambiar aserciones/resultados.

El cierre local no autoriza activación. Requiere actualizar coordinadamente todas las instancias antes de habilitar: el código pre-C `3e9e194a3fba78536802123d32edc4c82ac68bc7` compilado con dependencias/Prisma actuales lee/cancela historia C pero rechaza accept/replay; no equivale al artefacto histórico completo ni acredita despliegue mixto. Flag off conserva binario/schema/historia capaces de C, no es downgrade destructivo. No eliminar evidencia ni reinstalar barreras B absolutas.

Pendientes separados: causa de intermitencia del runner, revisión operativa A, mantenimiento del verificador A3, coordinación/consentimiento/retención de evidencia y UX en Coita/Web, instrucciones a ejecutores D y autorización posterior de activación. Ninguna siguiente etapa se inicia automáticamente.
