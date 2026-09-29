# CHECK V1.13-A6 — Precotizaciones

Fecha local: 2026-09-28. **PASS: V1.13-A IMPLEMENTADA Y VALIDADA LOCALMENTE.**

Este dictamen acredita el alcance de precotización A1–A5. No habilita emisiones, no acredita Google real, no despliega y no completa la transferencia de comida ni la conversión/aceptación del precio.

## 1. Revisión y estado inicial

- Rama: `1.13-Precotización_integración_comida_prepagada`.
- HEAD inicial y final: `1172567c85c8c967424ac6ab1f6bfdbc054fe741`.
- Paquete: 1.12.0, sin cambio de versión/CHANGELOG.
- Producto tracked limpio al iniciar; `nul` era untracked preexistente y permanece intacto.
- Se revisaron AGENTS, BITACORA, README, VERIFICATION, informes A1–A5, reutilización y propuesta de transferencia. Los resultados anteriores 372/497 no se acreditaron como CHECK: se ejecutaron nuevamente.
- Se registraron hashes de 250 archivos existentes: producto, Prisma/migraciones, scripts, contratos OpenAPI/matriz, configuración y paquetes. También se comparó privadamente `.env`, sin publicar contenido ni hash.
- Se preparó matriz esperado/observado antes de las pruebas. Se revisaron los destinos de los runners y scripts antes de escribir.

### Entorno aislado

Sólo Node v24.15.0 y PostgreSQL 18.6 locales, Windows x64. Tres bases nuevas con migraciones existentes (27), comprobadas en localhost y sufijo `_test`:

| Base | Uso |
|---|---|
| mandaria_a6_reg_25c30c4ed3_test | Regresión por archivo |
| mandaria_a6_check_25c30c4ed3_test | HTTP adversarial y preservación |
| mandaria_a6_load_25c30c4ed3_test | Carga y procesos interrumpidos |

No se escribieron principal, bases preexistentes de otras tareas ni fixtures de otros procesos. No Docker, VM, producción, Web, Coita Eats, correo real ni Google real. Routing sustituido por un adaptador controlado; autenticación, scopes, idempotencia, persistencia y consumo del CHECK HTTP son componentes reales. Tokens obtenidos por `/integrations/token`; los tokens sintéticos adicionales prueban rechazo de principal/scopes a través del guard real.

Evidencia estructurada: [resultados y congelamiento](checks/v1.13-a6-evidence.json), [carga, caídas y planes SQL](checks/v1.13-a6-load.json). No incluyen JWT, secretos, cuerpos de ubicación ni registros personales. Los hashes de preservación corresponden exclusivamente a fixtures sintéticos.

## 2. Matriz integral: esperado y observado

Todas las filas siguientes tienen evidencia nueva. “A3/A4/A5” identifica suites existentes reejecutadas; no remite a sus resultados históricos. Los 36 casos nuevos del CHECK mantienen el wiring de consumo real. Las suites A3 de protocolo y A4 de orquestación conservan sus dobles de fallos históricos, diferenciados de la evidencia integral.

| Área / esperado | Observado | Evidencia |
|---|---|---|
| POST válido → 201, GET/replay → 200 mismo ID/fechas | PASS; una MPQ persistida, mismo snapshot | CHECK HTTP + A5 real |
| Replay vencido no renueva ni llama routing | PASS; EXPIRED con vencimiento original | CHECK, A4 |
| Igualdad now=expiresAt es EXPIRED | PASS; reloj de lectura controlado, sin modificar DB | CHECK, A3/A4 y unitarias |
| Mismo cuerpo canónico y key reutiliza; orden/nullable normalizados | PASS; mismo recurso y una llamada | CHECK, unitarias de condiciones |
| Cuerpo u operación distintos bajo misma key → conflicto | PASS; también key de MDR creada realmente por HTTP usada para MPQ | CHECK, A3/A4 |
| Keys iguales en integraciones distintas son independientes | PASS; dos recursos propios distintos | CHECK y A3 |
| Campos desconocidos/sensibles inválidos antes de reserva | PASS; 6 casos nuevos, sin permiso ni routing; DTO/condiciones existentes también reejecutados | CHECK + A4/unitarias |
| Ownership ajeno/inexistente indistinguible; humanos rechazados | PASS; 404/404 y 401; sin campos internos | CHECK |
| Scopes, suspensión, revocación y expiración de credencial vigentes | PASS; 403/401; no routing/replay indebido | CHECK, B2B |
| Revocar mientras admisión espera impide start | PASS; lock DB real, permiso CANCELLED, 401 | CHECK |
| Revocar durante routing impide publicar | PASS; ninguna MPQ persistida | CHECK |
| Snapshot zona/plan/banda/ruta/importe/moneda coherente | PASS; cotejo SQL contra banda real y precio 25.10 MXN | CHECK, A3 SQL |
| Vigencia empieza después de routing/publicación, independiente TTL legacy | PASS; duración MPQ 12345 ms frente a tarifa 15 min; legacy conserva su reloj | CHECK + pricing unitarias/A2 |
| Cambios durante cálculo se revalidan; posteriores no reprecian | PASS; 409 seguro o snapshot final coherente; publicación inmutable | CHECK, A3/A4 |
| Sin ruta no hay distancia/precio alternativos | PASS; error terminal y sin oferta; adaptador Google probado con fetch simulado | CHECK y pricing/regresión |
| Dos instancias, misma key simultánea | PASS; un recurso, un STARTED y una llamada controlada | CHECK, A5 |
| Dos instancias, keys distintas/último cupo | PASS; una admisión, sin reserva parcial perdedora | CHECK/A5 |
| Lease vencido, dos recuperadores, ejecutor anterior | PASS; un adquirido, otro en progreso; owner viejo no publica ni falla | CHECK y A3 |
| Intentos agotados y estados terminales no se reabren | PASS; contadores persistidos y sin routing adicional | CHECK/A3/A4 |
| Commit confirmado y respuesta perdida | PASS; abortado cliente HTTP con MPQ ya SUCCEEDED y finish esperando lock; replay en segunda app, un recurso/start | CHECK; A4 cubre además pérdida de respuesta de publish |
| Fallo SQL de publicación → rollback íntegro | PASS; trigger adicional del CHECK rechaza SUCCEEDED: 0 MPQ, RETRYABLE_FAILED y consumo conservado; retry publica | CHECK, A3 |
| Minuto/24 horas móviles y bordes exclusivos | PASS en proyección pura, filas DB reales y reloj controlado; no se esperaron 24 horas de pared | Unitarias A5 y E2E A5 |
| Reservas provisionales, cancelación sin start | PASS; liberación segura, sin consumo externo inventado | A5 y CHECK |
| start consume aunque no se publique; retries+1 unidades | PASS; 1/2/3 unidades según política, sin reembolso ambiguo | A5 y CHECK |
| GET/replay no admiten ni consumen | PASS; filas sin cambios y ningún routing nuevo | A5 y CHECK |
| Retry-After considera todos los límites conocidos | PASS; máximo de fechas necesarias en unitarias, respuesta real 429/código/header/requestId | A5 y CHECK |
| Keys nuevas y recuperaciones no eluden límites | PASS; todas pasan por admisión; fallos de routing siguen contados | A5 y CHECK |
| Configuración divergente o control indisponible falla cerrado | PASS; fingerprint/config inválida y timeout real del advisory lock → 503 sin key/permiso/routing | A5, CHECK |
| Cuota MPQ no restringe Quotes legacy | PASS; MPQ 429 por global agotado, MDR y Quote nuevas 201, ningún permiso extra | CHECK |
| start repetido, owner forjado, assertReady vencido | PASS; rechazo sin nueva autorización | A5 |
| finish repetido/tardío no libera sucesor | PASS; unidades/tiempos conservados, identidad independiente | A5 |
| Recuperación perezosa acotada y etiquetas pendientes | PASS; 105 reservas vencidas, sólo 100 etiquetadas en primera admisión; las otras 5 no impiden capacidad | CHECK |
| SQL protege condiciones, relaciones, moneda/banda/distancia y éxito atómico | PASS; ataques existentes ejecutados con triggers activos | A3 24 casos, CHECK |
| SQL impide mutación/borrado de snapshot y permisos terminales | PASS; rechazo y evidencia intacta | CHECK/A3/A5 |
| Efectos ajenos no vacíos preservados | PASS; 10 tablas idénticas por hash antes/después | CHECK, detalle abajo |
| Default deshabilitado y presupuesto explícito obligatorio | PASS; validación unitaria nueva ejecución y comparación de configuración congelada | Unitarias/config |
| Desactivar antes de routing bloquea; trabajo iniciado conserva semántica | PASS; GET/replay siguen; llamada iniciada puede publicar con fencing/auth | A5/A4 y CHECK |
| No concesión automática de scopes | PASS por revisión de registro/config y pruebas de scope insuficiente | Código congelado/B2B/CHECK |
| Rutas de conversión/accept de MPQ ausentes | PASS; 404 convert/accept/accept-authorized | CHECK y OpenAPI |

Los cambios de nombre/geometría administrativos que sigan dejando configuración válida se vuelven a resolver al publicar. No se promete invalidar todo cambio de metadata. La oferta congela precio; `availabilityGuaranteed=false` distingue expresamente capacidad logística no reservada.

## 3. Caídas y límites de las garantías

| Momento | Mecanismo ejecutado | Resultado |
|---|---|---|
| Después de admit, antes de start | Proceso hijo independiente terminado con SIGKILL | Reserva durable existente, luego EXPIRED; ningún startedAt |
| Después de start, antes de routing | Proceso hijo terminado con SIGKILL | STARTED y unidades sobreviven; protectedUntil sigue vigente |
| Durante routing / después de routing sin publicar | Adaptador controlado y fallos/lease en suites A4/A5 | Consumo potencial conservado; publicación sólo con lease actual |
| Publicación rechazada tras insertar snapshot | Trigger de fallo adicional en DB exclusiva, retirado en finally | Oferta y SUCCEEDED hacen rollback juntos; intento/consumo no desaparecen |
| Publicación confirmada antes de finish/respuesta | Lock global externo al orquestador; cliente HTTP abortado | Segundo proceso lógico recupera mismo resultado sin otro start |
| Respuesta start perdida | A5 ejecuta start real y pierde confirmación mediante fault injection | Ningún routing; consumo permanece |
| Respuesta finish perdida | A5 ejecuta finish real y pierde confirmación | Repetición idempotente; consumo inmutable |
| Ejecutor viejo / permiso fuera de plazo | Dos servicios reales y reloj/espera controlados | Rechazo de publish/fail/assertReady; no libera sucesor |

Sólo se mataron los procesos hijos creados para esta prueba; no PostgreSQL ni procesos del usuario. Las interrupciones de proceso prueban durabilidad antes/después de start, no cancelación de un socket real de Google. Las demás caídas usan mecanismos controlados indicados, no se presentan como SIGKILL.

El lease de publicación pertenece a A3; la protección temporal del permiso pertenece a A5. Son registros, relojes y funciones distintas. Fencing bloquea publicación vieja, pero una pausa después de assertReady, un envío externo ya efectuado o cancelación ineficaz pueden mantener sockets externos. No se garantiza exactamente una llamada externa ni un techo absoluto de sockets Google. El presupuesto es MPQ, no el total de la cuenta Google: Quotes legacy continúan aparte.

## 4. Preservación SQL y económica

En la ejecución final, después de preparar fixtures reales (incluida una entrega completada mediante servicios existentes y una Quote legacy con cuota MPQ agotada), se congeló esta referencia. La comparación posterior a todos los casos MPQ conserva exactamente cantidad y hash:

| Tabla | Filas antes/después |
|---|---:|
| DeliveryRequest | 10 |
| DeliveryQuote | 10 |
| DeliveryStop | 20 |
| DeliveryPackage | 10 |
| DeliveryFinancialContext | 10 |
| Dispatch | 8 |
| DeliveryAssignment | 5 |
| CreditAccount | 8 |
| CreditLedgerEntry | 13 |
| B2bOutboxEvent | 5 |

Las filas incluyen fixtures conservados de los intentos previos del CHECK; no se purgaron para mejorar resultados. Las acciones logísticas de preparación son explícitas y preceden a la referencia; no se atribuyen a emitir MPQ. El ensayo legacy adicional compara primero el 429 MPQ contra la referencia intacta y sólo después amplía deliberadamente el fixture legacy, antes de las emisiones restantes.

No se deshabilitaron triggers para acreditar integridad. El nuevo CHECK sólo añadió temporalmente un trigger de rechazo de publicación y lo retiró. Los tests de regresión existentes mantienen su limpieza de fixtures mediante mecanismos `_test` ya previstos; no se cambió ni debilitó una aserción o regla para obtener PASS. La base de carga conserva toda su historia.

## 5. Carga y advisory lock global

Host: Intel Core Ultra 7 155H, 22 CPU lógicas, 31 GiB aproximados de RAM; Windows x64, Node v24.15.0, PostgreSQL 18.6 local. Dos aplicaciones Nest independientes y 100 integraciones sintéticas distribuidas. Las muestras incluyen otras tareas locales: no son benchmark de hardware dedicado.

Se sembraron progresivamente 0/1000/5000 permisos históricos EXPIRED y la misma cantidad STARTED→FINISHED todavía contabilizable en 24h. Se respetaron las transiciones SQL; ningún trigger fue deshabilitado. Los permisos sintéticos representan carga de ledger, no llamadas externas ejecutadas ni facturación real. No se borraron filas entre etapas. 100 admisiones por celda, concurrencia 2 u 8; finish posterior sin start en cada solicitud de carga. Dos subprocesos se usaron para caídas. Routing externo: 0 llamadas.

| Histórico / iniciado vigente | Concurrencia | Éxitos/solicitudes | p50 admisión ms | p95 | p99 | Ciclos admit+finish/s |
|---|---:|---:|---:|---:|---:|---:|
| 0 / 0 | 2 | 100/100 | 10.49 | 17.32 | 26.04 | 102.35 |
| 0 / 0 | 8 | 100/100 | 42.23 | 105.61 | 171.61 | 87.56 |
| 1000 / 1000 | 2 | 100/100 | 50.04 | 76.98 | 80.27 | 27.08 |
| 1000 / 1000 | 8 | 100/100 | 156.50 | 268.88 | 295.14 | 26.41 |
| 5000 / 5000 | 2 | 100/100 | 198.84 | 339.07 | 360.08 | 6.46 |
| 5000 / 5000 | 8 | 100/100 | 634.17 | 1144.45 | 1260.01 | 6.90 |

600/600 admitidas, cero denegaciones/timeouts/errores en esta carga; 10 604 filas al final. Cada p99 es el orden estadístico 99 de sólo 100 muestras, con incertidumbre considerable. Duraciones por celda: 0.977, 1.142, 3.693, 3.787, 15.482 y 14.496 segundos. Latencia mide admit; throughput incluye finish, que también toma el lock. No se midió aquí tiempo de routing ni un endpoint HTTP completo.

Plan de consulta parametrizado como el producto: Seq Scan, 5001 filas devueltas y 5603 descartadas, 10 604 examinadas; ejecución SQL ~1.47 ms en esa lectura caliente. Los índices existentes no se modificaron. El primer diagnóstico con clock_timestamp volátil se conserva por separado en JSON y no se confunde con el plan parametrizado. El tiempo SQL aislado no incluye transferencia/deserialización Prisma, cálculo de ventanas ni espera de lock.

Conclusión local: al crecer el consumo de 24h, el mutex global serializa lecturas y proyección de muchas filas, degradando throughput. No se encontró incoherencia de cuotas bajo esta carga. No prueba comportamiento con un millón de filas ni un SLA productivo. Antes de activar: dimensionar demanda y presupuesto, repetir carga representativa y decidir si la capacidad observada basta. No se añadieron índices ni optimizaciones durante CHECK.

## 6. Configuración y cambio coordinado de política

Default efectivo: PREQUOTE_ENABLED=false. Defaults: 10/minuto, 500/24h, 2 slots por integración, reserva 30000 ms. PREQUOTE_GLOBAL_DAILY_ROUTING_UNITS no tiene default operativo y debe ser válido al habilitar. Los scopes no se conceden automáticamente. No se cambió `.env`.

Fingerprint durable SHA-256 del JSON con **este orden** y valores numéricos validados:

```text
minute, day, concurrent, globalUnits, reserveMs, retries, timeoutMs
```

Corresponden a PREQUOTE_PER_MINUTE, PREQUOTE_PER_DAY, PREQUOTE_MAX_CONCURRENT, PREQUOTE_GLOBAL_DAILY_ROUTING_UNITS, PREQUOTE_PERMIT_RESERVE_MS, GOOGLE_ROUTES_MAX_RETRIES y GOOGLE_ROUTES_TIMEOUT_MS. PREQUOTE_ENABLED, vigencia MPQ, lease A3 y maxAttempts no forman parte de ese fingerprint; conservan sus validaciones y presupuestos propios.

### Procedimiento revisado para una futura operación autorizada (no ejecutado)

1. Registrar configuración/fingerprint actuales, uso vigente y nueva política validada. Conservar respaldo y plan de rollback no destructivo. No editar permisos ni contadores.
2. Cerrar temporalmente ingreso de nuevas emisiones en todas las instancias. PREQUOTE_ENABLED se carga por instancia: no es un interruptor central ni hot reload acreditado. Coordinar mantenimiento/reinicio y, si hace falta, bloquear temporalmente POST de emisión en ingreso; esa barrera también puede afectar replay POST. GET permanece en servidores compatibles.
3. Drenar peticiones ya iniciadas; pueden publicar conforme al contrato anterior. Impedir que instancias viejas vuelvan a aceptar trabajo. Terminar procesos detenidos/suspendidos que pudieran despertar. Esperar las reservas y protecciones activas según **reloj DB**, y resolver leases A3 en curso mediante el protocolo existente. No marcar consumo ambiguo como no consumido. Respetar el riesgo residual de llamadas externas ya enviadas.
4. Con todos los emisores detenidos y las ventanas activas tratadas, preparar todas las instancias con la misma política nueva y flag deshabilitado. Verificar compatibilidad de lease A3 con timeout/retries nuevos.
5. Mediante una operación administrativa explícita y revisada, en transacción bajo `pg_advisory_xact_lock(1313,5)`, comprobar fingerprint anterior esperado y actualizar **sólo** la fila singleton id=1 al fingerprint nuevo. Exigir una fila afectada; abortar ante divergencia. No borrar/recrear singleton ni ledger. Registrar cambio sin secretos. No existe actualmente una herramienta/endpoint administrativo que automatice esto; requiere un runbook operacional aprobado.
6. Verificar que todas las instancias calculan ese fingerprint. Revisar uso histórico y condiciones de admisión con la política nueva. Habilitar posteriormente en una tarea autorizada, de forma coordinada, con observación de errores/429/latencia. Ante rollback, repetir coordinación; conservar historia.

Reducir un límite por debajo del uso actual debe denegar nuevas admisiones hasta liberar suficiente ventana, nunca reiniciar cuotas. El CHECK redujo global por debajo de 3 unidades ya consumidas y verificó denegación e historia idéntica. Aumentar retries carga más unidades a nuevos permisos; los anteriores conservan su units. Cambiar timeout no reescribe protectedUntil/routingBudgetMs previos. Instancias con fingerprint anterior/divergente fallan cerrado en admit/start/assertReady. finish del propietario anterior sólo finaliza su permiso, sin devolver consumo ni modificar al sucesor.

**Pendiente de activación:** aprobar, automatizar si se decide y ensayar este runbook en el entorno destinado al piloto; definir propietarios/alertas/retención y capacidad requerida. La secuencia se revisó contra código y se ejercitaron sus primitivas en bases aisladas; no se ejecutó una operación de configuración distribuida de producción.

## 7. Migraciones y futuro despliegue

- Tres bases A6 nuevas: instalación de las 27 migraciones existentes, sin reset.
- Verificador de upgrade A5 reejecutado: `mandaria_a5_clean_b3c65761f2_test` y `mandaria_a5_upgrade_b3c65761f2_test`, 27 migraciones, 14 tablas comparadas. Incluye MPQ/ejecución A3, solicitud, Quote, contexto financiero e idempotencia legacy. Ningún permiso/uso histórico inventado por migración.
- Sobre base de carga con A5 no vacío: migrate deploy idempotente + migrate status exit 0; 10 604 permisos y hash completo antes/después idénticos. Se conservan ambos hashes en evidencia.
- Las cinco bases nuevas quedan retenidas. Ninguna migración aplicada fue editada. Principal permanece sin migrar.

Orden futuro: expansión SQL incremental → código compatible en todas las instancias → configuración coherente validada, inicialmente deshabilitada → verificación operativa → activación autorizada. Arrancar código nuevo contra principal sin tablas A3/A5 puede causar errores de persistencia; flag false no es sustituto de migraciones para GET/replay. No desplegar basándose únicamente en este PASS local. No ejecutar downgrade destructivo ni borrar evidencia ante rollback.

## 8. Comandos, resultados e intentos incompletos

| Comprobación nueva | Resultado |
|---|---|
| `nest build` | exit 0 |
| `prisma validate` | exit 0 |
| `tsc --noEmit -p tsconfig.build.json` | exit 0 |
| `npm run lint` / `npm run lint:eslint` | exit 0 final |
| `npm run docs:check` | exit 0; OpenAPI y matriz coinciden, sin sobrescribirlos |
| Unitarias completas | 372/372, exit 0 |
| Regresión E2E existente, 26 archivos | 497/497 consolidadas con ejecuciones completas exit 0 |
| Nuevo CHECK HTTP final | 36/36, exit 0 |
| Carga / procesos / preservación tras deploy | exit 0 |
| Instalación limpia/upgrade | exit 0 |
| Producto congelado | 250 archivos idénticos; .env y HEAD idénticos |

Total E2E acreditado: **533 casos** (497 existentes + 36 CHECK), por archivo, no una pasada monolítica. Unitarias completas se ejecutaron con pool threads. E2E por archivo: threads por defecto; webhooks forks/1 worker. El runner impide destinos ajenos a las bases A6 y conserva logs privados en `.tmp/a6`.

Comandos reales utilizados: `node .tmp/a6/setup.mjs`; `node .tmp/a6/run.mjs unit`; `node .tmp/a6/run.mjs full`; `node .tmp/a6/run.mjs check`; repeticiones con `node .tmp/a6/run.mjs retry <archivos>` y `node .tmp/a6/run-forks.mjs retry-forks delivery-requests-b2b.e2e-spec.ts`; `node .tmp/a6/load.mjs`; `node scripts/verify-prequote-consumption-migrations.mjs`; `node .tmp/a6/check-load-history.mjs`.

Los runners `.tmp` son auxiliares locales ignorados, no una dependencia de producto. Pruebas reproducibles versionables: `test/check-a6-prequotes.e2e-spec.ts` vía Vitest E2E con TEST_DATABASE_URL local aislado; carga: `scripts/check-prequote-a6-load.mjs` exige base **nueva vacía ya migrada** cuyo nombre cumpla mandaria_a6_load_<hex>_test. No reutilizar la base de carga ya consumida: su singleton/historia se conservan. Credenciales sólo por entorno seguro, nunca pegarlas al informe.

### Intentos fallidos / abortados y correcciones de fixtures

- Primera regresión: cuatro procesos abortados con 3221226505 (requests B2B, dispatch, drivers/vehicles, independent). No acreditados. Repetición completa: tres PASS; requests B2B volvió a abortar. Segunda repetición íntegra con forks/1 worker: 15/15, exit 0. Ninguna aserción debilitada ni configuración global de Vitest modificada.
- Primer CHECK nuevo: antes de los casos, secreto sintético con longitud/formato distinto al DTO de token → 400; además proceso terminó 3221225477. Corregido fixture a base64url de 32 bytes (43 caracteres), manteniendo hash SHA-256 real. 0 casos acreditados en ese intento.
- Segundo CHECK: fixture esperaba Outbox al aceptar; ese evento exige entrega completada. Se amplió preparación mediante claim/asignación/completion reales.
- Preparación ampliada encontró dos restricciones válidas: usuario activo requiere hash de contraseña y proveedor requiere cobertura. Se corrigieron exclusivamente esos fixtures, sin forzar estados ni deshabilitar reglas. Cada intento previo acreditó 0 casos.
- Una ampliación del archivo de pruebas tuvo cierre sintáctico incorrecto; transform no ejecutó casos. Corregido archivo nuevo, no producto.
- ESLint inicial detectó helper nuevo sin uso; retirado. Linters finales pasan.
- Pasadas seleccionadas completas antes de la versión final: 29/29, 33/33, 35/35; versión final de 36 casos repetida completa, exit 0. No se suman estas repeticiones al total.
- Construcción de evidencia tuvo EPERM al lanzar Git dentro del sandbox; repetida con permiso de proceso y comprobación de sólo lectura exitosa. No es fallo de producto.

## 9. Logs, defectos y riesgos

**Defectos de producto reproducidos que impidan cierre: ninguno en el alcance ejecutado.** No se corrigieron servicios, DTOs, reglas SQL, migraciones ni contratos.

Los 5xx inducidos corresponden a routing/control/publicación deliberadamente fallidos; se verificaron sus códigos sanitizados y ausencia de recursos parciales. El timeout real del mutex es error esperado del ensayo, no error espontáneo de la muestra de carga. Los abortos nativos del runner se reportan aparte. Se comprobó que logs capturados no contienen tokens/secrets del fixture ni clientSecret; no se publican logs completos.

Riesgos/pendientes de activación:

- **Capacidad, impacto medio/alto según tráfico:** lectura global y proyección de consumo bajo mutex; caída medible de throughput. Requiere dimensionamiento antes del piloto, no SLA inventado.
- **Operación:** falta herramienta administrativa de cambio coordinado de política; usar sólo runbook revisado/aprobado. No actualizar fingerprint a ciegas ni reiniciar ledger.
- **Relojes/red:** lecturas de expiración usan reloj de app, emisiones/leases DB. Requiere sincronización; fencing no cancela sockets externos. Autorización no es atómica con una revocación posterior a la última comprobación.
- **Evidencia acotada:** 100 muestras por celda, 10 604 filas, dos apps en un host. No prueba múltiples hosts, gran escala, fallo del servidor PostgreSQL completo ni proveedor Google real. El fallo real de control se ejercitó con bloqueo/timeout DB, además de fallos inyectados existentes.
- **Conservación:** retención/archivado de ledger y ubicaciones requiere política futura. No purgar para eludir límites ni evidencia comercial.

## 10. Congelamiento, limpieza y dictamen

250 archivos protegidos idénticos al inicio; `.env` idéntico sin publicar su hash; HEAD/rama sin cambiar. Archivos existentes de producto, migraciones, paquetes, configuración y OpenAPI/matriz sin modificaciones. Sólo se agregan pruebas/verificador/evidencias/documentación de CHECK y se actualizan BITACORA/VERIFICATION.

Apps/procesos hijos cerrados. En CHECK se revocaron credenciales de fixture y desactivaron zonas al finalizar; se conservan recursos, permisos y evidencia sintéticos. Bases aisladas retenidas, sin purgar historia ni borrar bases preexistentes. `nul` intacto. No se habilitan emisiones operativas.

**PASS: V1.13-A IMPLEMENTADA Y VALIDADA LOCALMENTE.**

- Cierre técnico local: sí, para precotización A1–A5.
- Aptitud de activación: condicionada a migraciones, configuración/runbook, capacidad, observabilidad y validación del entorno real en tarea posterior.
- Despliegue: no ejecutado. Sin commit/push, versión ni CHANGELOG.
- Transferencia completa: pendiente. No existe conversión MPQ→MDR/MQ ni aceptación autorizada ni interfaces/cobro nuevo.

### Dependencias preparadas para diseñar V1.13-B (sin implementar)

Reutilizar snapshot inmutable y expiración original, normalización versionada, namespace de ApiIdempotencyRecord, ownership B2B y fencing. Diseñar conversión única/atómica, conflictos/replay, vencimiento heredado, preservación exacta de importe/moneda/ruta/condiciones, confirmaciones PREPAID y autorización explícita; nunca volver a llamar routing para convertir ni extender vigencia. Definir reglas de indisponibilidad/suspensión, permisos y compatibilidad legacy antes de escribir endpoints. La oferta no certifica pago de comida ni disponibilidad de repartidor. Interfaces e integración Coita siguen siendo dependencias futuras y separadas.

Verificación final adicional: git diff --check exit 0; revisión de git status confirma únicamente documentación, evidencia y verificadores/pruebas nuevos del CHECK, además de nul preexistente.
