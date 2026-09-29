# CHECK V1.13-B4 — Subsanación final (2026-09-29)

**Dictamen: PASS — V1.13-B IMPLEMENTADA Y VALIDADA LOCALMENTE.** Cierre limitado a conversión única MPQ → MDR PREPAID + MQ OFFERED y barreras pre-C. No habilita emisión/conversión, aceptación autorizada, despacho, cobro, interfaces, despliegue ni inicio automático de C/D.

Este dictamen combina **ejecuciones nuevas y evidencia histórica comprobada**, no una ejecución nueva de toda la suite. [Evidencia final sanitizada](checks/v1.13-b4-final-evidence.json). Los informes PARTIAL y PASS anteriores se conservan íntegros debajo como historial.

## 1. Baseline y producto congelado

Rama `1.13-Precotización_integración_comida_prepagada`, HEAD `be2e76b48afb649bfc9ce70d1a661c97fa918564`, paquete 1.12.0. Único archivo preexistente sin seguimiento: `nul`, intacto. Leídos AGENTS, BITACORA, README, VERIFICATION, B1/B2/B3, informe/revisión/evidencia B4 y runners referenciados.

Los **262 archivos** de la referencia actual siguen idénticos antes/después, incluido el consolidador previamente publicado. Sus 261 archivos originales también coinciden con la referencia B4 anterior. `.env` comparado privadamente e idéntico; no se publica huella. Sin cambios en producto, schema/migraciones, configuración compartida de Vitest, versión, contrato, TTL, semántica económica ni barreras pre-C.

Node v24.15.0, Vitest 4.1.11, Prisma Client 6.19.3, PostgreSQL 18.6 local. Nuevas bases `mandaria_b4_final_reg_29579f6562_test` y `mandaria_b4_final_integral_29579f6562_test`: migradas con las 28 migraciones existentes. La segunda sólo se preparó/escaneó; la regresión se ejecutó en la primera. Un ensayo comparativo de webhooks usó la base histórica aislada `mandaria_b4_reg_150bdb98b9_test`. Ninguna escritura/migración en principal, Docker, servicio externo real o dato operativo.

## 2. Diagnóstico del aborto — hechos y límites

Archivo exacto: `test/b2b-webhooks.e2e-spec.ts`. El runner histórico `.tmp/b4r/run.mjs` ejecutaba:

```text
node node_modules/vitest/vitest.mjs run --config vitest.config.e2e.ts test/b2b-webhooks.e2e-spec.ts --pool=<forks|threads> --maxWorkers=1 --hookTimeout=30000 --reporter=default --reporter=json --outputFile=<directorio del intento>/report.json
```

Los intentos históricos quedaron conservados con UUID, base, horarios, exit, señal, log y reporter cuando existió. Threads terminó con código 3221226505; forks devolvió exit 1 y `Worker exited unexpectedly`. Los reportes parciales mostraban 7/54 y 14/54 con cero aserciones fallidas: **no son PASS**, aunque un reporter llegara a indicar success. No se observó timeout del padre (límite 300 s) ni error de aserción que explique la salida. No hay dump/stack nativo que identifique módulo culpable; no se atribuye a Windows, Prisma o Vitest como causa raíz probada. Las versiones históricas no se guardaron por intento; las versiones exactas publicadas arriba fueron medidas ahora.

Plan acotado: dos ejecuciones completas con `forks`, maxWorkers 1 y mismo archivo/configuración; una sobre base nueva y otra sobre la base histórica aislada. Se añadió un reporter observador que registra inicio/fin/nombre/estado de cada caso, sin datos de requests. Resultados:

| Intento nuevo | Base | Resultado |
|---|---|---|
| `4ef700bb-f175-4392-bbaa-7c0196b0afda` | Nueva | 54/54, exit 0, cierre normal, ~29 s |
| `ba601d81-434a-4a88-8304-390c6e70481d` | Histórica aislada | 54/54, exit 0, cierre normal, ~31 s |

**No se modificó webhooks ni se demostró una corrección causal del aborto.** Estas ejecuciones acreditan el archivo completo. No demuestran que la intermitencia haya desaparecido. La comparación no respalda afirmar que limpiar la base, cambiar pool o cerrar un recurso concreto resolvió el problema. No hubo acumulación visible de recursos que impidiera terminar en estos dos procesos; esto no es un perfil exhaustivo de recursos. No se repitió webhooks hasta conseguir verde: ambos ensayos previstos pasaron a la primera.

Durante la regresión nueva, B3 sufrió otro `Worker exited unexpectedly` con forks: 45/58, cero aserciones fallidas, último caso iniciado `replay denies client-suspended`; intento excluido. Se hizo **un** ensayo diagnóstico completo con threads, pool de su evidencia histórica válida: 58/58, exit 0. Observador adicional de procesos hijos/uncaught monitor sin alterar producto. El primer preload tenía una llave faltante: Node rechazó su sintaxis antes de iniciar runner/pruebas; corregido y comprobado con `node --check`. Este fallo de infraestructura no se acredita como ejecución de tests.

El pool alternativo está limitado al comando de ese ensayo; no se cambió configuración compartida ni cobertura. El éxito no prueba que el pool causara la caída. **Riesgo residual: terminación intermitente del worker sin causa raíz confirmada.** Si reaparece, conservar dump/stack nativo y salida del proceso hijo antes de intentar una corrección. No se justifica cambiar producto por esta evidencia.

## 3. Correcciones de tipos

Inventario reproducido inicialmente: nueve diagnósticos, ocho TS2345 y un TS2493.

- `check-a6-prequotes.e2e-spec.ts`, `check-b3-conversion.e2e-spec.ts`, `prequote-consumption.e2e-spec.ts`, `prequote-conversion.e2e-spec.ts`, `prequotes-http.e2e-spec.ts`: ocho parámetros de helpers HTTP pasan de `unknown` a `object`. Sus fixtures, incluidos DTOs intencionalmente inválidos, son cuerpos JSON objeto admitidos por `supertest.send`. No se pretende validar el DTO en el helper; el backend sigue recibiendo y rechazando los casos adversariales. Sin casts ni filtrado de casos.
- `pricing.spec.ts`: firma genérica de `vi.fn` describe callback transaccional y opciones opcionales `maxWait`, `timeout`, `isolationLevel` conforme al contrato Prisma. El mock ejecuta el mismo callback y la aserción de opciones permanece. Una primera versión introdujo un parámetro de implementación sin uso señalado por ESLint; se corrigió tipando la firma del mock, sin desactivar reglas.

No exclusiones, `@ts-ignore`, cambio de strict ni nuevas conversiones indiscriminadas. Los seis archivos anteriores son los únicos cambios de pruebas; ninguna aserción de negocio fue retirada o debilitada.

## 4. Verificaciones nuevas e históricas

| Archivo/gate | Evidencia actual |
|---|---|
| Unitarias completas, incluida pricing | **380/380, 32 archivos**, nueva ejecución final exit 0 |
| Webhooks | **54/54**, nueva; segunda pasada no suma casos |
| CHECK A6 | **36/36**, nueva exit 0 |
| CHECK B3 | **58/58**, nueva exit 0; aborto previo excluido |
| Prequote consumption | **21/21**, nueva exit 0 |
| Prequote conversion B2 | **39/39**, nueva exit 0 |
| Prequotes HTTP | **40/40**, nueva exit 0 |
| Otros 24 archivos E2E, incluido CHECK B4 24/24 y user-invitations 24/24 | **406 casos históricos**, no reejecutados ahora |
| Total E2E consolidado por archivo | **654/654 en 30/30 archivos: 248 nuevos + 406 históricos** |
| `tsc --noEmit -p tsconfig.json` | **exit 0**, nueva ejecución |
| `tsc --noEmit -p tsconfig.build.json` | **exit 0**, nueva ejecución |
| Prisma validate, Oxlint, ESLint | **exit 0**, nuevos |
| `git diff --check` | **exit 0**, nuevo |
| Build, docs:check, upgrade/reapply/drift y recorrido integral B4 | Históricos retenidos; producto/contrato/configuración idénticos, no reejecutados ahora |

Procedencia: los reportes históricos se contrastaron con sus SHA-256 publicados; los 24 archivos no afectados coinciden con los blobs del commit `be2e76b` que publicó esa evidencia (normalización LF/CRLF sólo para comparar fuente). No se afirma que el runner histórico capturara hash de fuente por intento: la vinculación adicional es al snapshot Git publicado y la referencia de producto. Los archivos con cambios de tipos usan resultados nuevos completos, nunca su éxito histórico como sustituto.

Consolidador existente: exige exit 0, sin señal/error, reporte completo exitoso, todas las aserciones aprobadas, inventario de archivos y hash del reporte. `node scripts/consolidate-conversion-check.mjs .tmp/b4-final/merged` termina exit 0, sin faltantes. Las copias de reportes no alteran bytes y conservan ruta original y edad de evidencia. Cinco controles negativos reejecutados pasan: descartar exit no cero, señal, reporte fallido/incompleto y rechazar hash adulterado. Repeticiones no inflan casos.

Runners/evidencia privada: `.tmp/b4-final/run.mjs`, `trace.mjs`, `process-diagnostics.cjs`, `provenance.mjs`, `merge.mjs` y `attempts/<UUID>/`. Cada intento retiene comando sanitizado, versiones actuales, log, reporter, hash, exit/señal, base y traza. La evidencia final versionable incluye comandos, metadata, hashes y procedencia; no incluye cuerpos, tokens ni logs privados completos.

## 5. Revisión independiente y cierre

- Falso positivo Dispatch: candidato SQL válido y código exacto `AUTHORIZED_ACCEPT_REQUIRED`; corrección histórica del CHECK intacta, B4 completo histórico verificado. B2/B3 se reejecutaron ahora con sus barreras.
- Concurrencia: aserciones estrictas de mismo ganador y códigos de negocio permanecen; no se reintrodujo aceptación arbitraria de 409/503.
- Consolidación: exit 0 obligatorio y registros inmutables por intento; user-invitations tiene evidencia histórica completa verificable. Webhooks ahora tiene dos ejecuciones completas nuevas.
- Gate de tipos acordado: ambos tsconfig pasan sin emisiones ni exclusiones.
- Verificador antiguo A3: mantenimiento separado, no se modificó ni ejecutó para este cierre.

Escaneo final de las dos bases nuevas: cero violaciones de vínculos, keys, manifiesto, snapshot y Dispatch prematuro; cero triggers de fallo/deshabilitados, 17/17 guardas del subconjunto inspeccionado activas y dos FKs diferidas. Revocados/desactivados fixtures B2/B3/A6 residuales cuando correspondía; bases e historia conservadas. Webhooks ejecuta su teardown propio. No se hicieron despachos operativos: los flujos legacy completos de E2E usan exclusivamente datos sintéticos en bases de pruebas.

Se conserva el límite B1/B2/B3 de SQL directo con constraints inmediatas y commit tardío, y la incompatibilidad de lectores antiguos. No se amplía garantía temporal ni se acredita despliegue mixto. Siguen abiertos los pendientes operativos A: capacidad/mutex/volumen, política coordinada, entorno/migración de despliegue, observabilidad/responsables/retención.

**PASS local de B**, con causa raíz de abortos no confirmada como riesgo de infraestructura. Sin defecto de producto demostrado ni modificación de su semántica. Sin `.env`, versión/CHANGELOG, commit, push, despliegue o activación. **C y D continúan pendientes.**


---

## Historial conservado — reejecución PARTIAL anterior

# CHECK V1.13-B4 — Reejecución integral y revisión de evidencia

**Dictamen actual: PARTIAL — evidencia incompleta.** No se ratifica el PASS histórico conservado al final. No se ha demostrado un defecto bloqueante de conversión, pero falta una ejecución completa exitosa de webhooks y el chequeo global de tipos tiene deuda existente.

## Baseline y alcance

Ejecución local del 28/29 de septiembre de 2026, rama `1.13-Precotización_integración_comida_prepagada`, HEAD `7660f1392e1af6d8aae880381e3a271da0e69aa3`, paquete 1.12.0. Alcance: MPQ → MDR PREPAID + MQ OFFERED, barreras pre-C. No acredita aceptación autorizada, despacho, cobro, interfaces ni transferencia completa.

Preexistían modificaciones de BITACORA/VERIFICATION y archivos de informe, revisión, evidencia y suite B4, además de `nul`. Se conservaron copias en `.tmp/b4r/prior`; la revisión y evidencia anteriores permanecen intactas. La nueva evidencia es [v1.13-b4-rerun-evidence.json](checks/v1.13-b4-rerun-evidence.json). Las cifras históricas no se acreditan a esta ejecución.

Bases nuevas locales: `mandaria_b4_integral_150bdb98b9_test`, `mandaria_b4_reg_150bdb98b9_test`, `mandaria_b2_clean_ab00c4ccc3_test` y `mandaria_b2_upgrade_ab00c4ccc3_test`. Destino verificado antes de escribir. Node/PostgreSQL locales, routing controlado; sin Docker, VM, datos operativos ni routing pagado.

## Matriz esperado/observado — evidencia nueva

| Barrera esperada | Observado |
|---|---|
| Recorrido con auth/consumo/idempotencia/conversión/persistencia reales | B4 24/24 exit 0, dos Nest/pools; sólo routing externo controlado |
| Emisión consume; conversión no | Un permiso FINISHED, ejecución A3 y llamada de routing por emisión; ninguno adicional por conversión |
| 201 nuevo, 200 replay y vínculos únicos | Misma key concurrente exige exactamente [200,201] y mismos MDR/MQ; ocho keys: un 201 y siete 409 PREQUOTE_ALREADY_CONVERTED |
| Contrato, scopes y ownership | Headers, tres scopes, ajena/inexistente, revocación/suspensión/expiry, flag false y replay autorizado verificados |
| DTO y declaraciones | Doce cuerpos inválidos rechazados antes de crear key; PREPAID/MXN/FOOD, goodsValue omitido/null/positivo; no se acredita verificación bancaria |
| Proyección segura | Referencias opacas/manifiesto/relaciones internas ausentes en superficies y logs capturados |
| Snapshot sin recálculo | Importe 31.50 conservado frente a tarifa reemplazada de 999.00; rutas, referencias, metadata y expiry congelados |
| Zona inactiva | Nueva conversión 409 PREQUOTE_SERVICE_UNAVAILABLE; replay autorizado disponible |
| Lock cruza expiry | Lock real 2.6 s sobre vigencia 1.5 s: 409 PREQUOTE_EXPIRED, rollback de key/conversión |
| SQL rechaza ataques por causa correcta | 16 ataques B4 exigen P2010/SQLSTATE P0001 y código de guarda exacto; B2 39/39 y B3 58/58 reejecutados |
| Rollback/recuperación/manifiesto | B2/B3 completos: construcción, validación final, hijos, savepoints, constraints, key/owner y barreras Dispatch |
| Respuesta perdida | Fallo inducido al cargar respuesta tras commit; otra instancia recupera ganador. No es prueba de corte TCP real |
| Cancelación no libera MPQ | Replay conserva vínculos y estados actuales; otra key no crea recursos |
| Preservación no vacía | Ocho tablas idénticas por hash tras tres conversiones; MPQ emitidas antes de fotografía; legacy PREPAID/COURIER_ADVANCE intacto |
| Suite completa | 380/380 unitarias en 32 archivos; 600 E2E aprobadas en 29/30 archivos; webhooks incompleto |
| Escaneo final | Cero violaciones/residuos en ambas bases; 17/17 triggers en cinco tablas inspeccionadas y dos FKs diferidas |

El catálogo más amplio dentro de B4 verifica 24 triggers en nueve tablas; no confundirlo con el subconjunto de 17 del escaneo final.

## Correcciones del CHECK y trazabilidad

1. El INSERT Dispatch anterior usaba una columna inexistente. Ahora usa columnas reales y todos los campos requeridos, y exige `AUTHORIZED_ACCEPT_REQUIRED`; un error de sintaxis ya no pasa.
2. Se eliminaron aserciones amplias de concurrencia. Cada perdedor debe tener el código de negocio esperado, no un 409/503 arbitrario.
3. El nuevo `scripts/consolidate-conversion-check.mjs` exige exit 0, ausencia de señal/error, reporter exitoso, todas las aserciones aprobadas, archivo completo y SHA-256 del reporter coincidente. Pruebas negativas: exit no cero, señal, reporter fallido/incompleto y hash adulterado rechazados (5/5).
4. La limpieza heredada de `delivery-quotes.e2e-spec.ts` deshabilitaba un trigger. Se sustituyó únicamente esa limpieza por crear una tarifa DRAFT completa y activarla mediante transición normal; se conservaron las aserciones. La ejecución exitosa final 14/14 no deshabilita guardas. El intento anterior abortado no permite asegurar hasta qué sentencia llegó.
5. El descubrimiento inicial omitió una unitaria ubicada en src. El inventario final recorre src y test: 32 archivos. La ejecución unitaria ya había ejecutado los 32.
6. El escaneo final comprueba Dispatch por MDR directamente, además de por MQ.

## Suites, comandos y procesos

Los intentos se guardan separados por UUID en `.tmp/b4r/attempts`, con reporter, hash, tiempos, pool, base y exit. Se consolidan casos únicos por archivo, nunca repeticiones. Evidencia JSON conserva los nueve procesos no exitosos y los ganadores completos.

- `node .tmp/b4r/run.mjs unit`: exit 0, 380/380.
- `node .tmp/b4r/run.mjs all` y repeticiones `retry <archivo>`: 29 archivos completos exitosos, 600 casos. Incluyen A6 36, B2 39, B3 58, B4 24 y user-invitations 24 con exit 0 verificable.
- B4 además pasó focalizado 24/24 en base integral; no se suma otra vez.
- `b2b-webhooks.e2e-spec.ts`: inventario del reporter 54 casos; ningún intento completo exitoso. Threads termina con 3221226505 y forks con exit 1/Worker exited unexpectedly. Reporters parciales 7/54 y 14/54 no se acreditan. Causa nativa no confirmada; no se atribuye al producto sin diagnóstico.
- `node scripts/consolidate-conversion-check.mjs .tmp/b4r`: **exit 1**, correctamente identifica webhooks faltante.
- Build y docs:check: exit 0 antes de E2E, sin builds concurrentes.
- Prisma validate, `tsc --noEmit -p tsconfig.build.json`, Oxlint, ESLint: exit 0.
- `tsc --noEmit -p tsconfig.json`: **exit 2, nueve errores preexistentes de pruebas** (check-a6, check-b3, prequote-consumption, prequote-conversion, prequotes-http y pricing.spec). No se corrigieron fuera de alcance. No afirmar que todos los tipos pasan.

## Migraciones y límites

Verificador `verify-prequote-conversion-migrations.mjs`: instalación limpia y upgrade no vacío, 28 migraciones y 14 tablas históricas preservadas. Reaplicación dos veces sin pendientes en integral: 46 conversiones, 72 MPQ y conteos/hashes de 15 tablas idénticos. Estado exit 0, cero migraciones fallidas, drift explícito URL local → schema datamodel exit 0. Un intento auxiliar con datasource ambiguo dio drift 2 y no se acredita; el resultado final usa destino explícito. No se migró principal.

B3 reejecutó `SET CONSTRAINTS IMMEDIATE` tras construcción y commit tardío: SQL conserva estructura, pero el escritor directo puede adelantar validación temporal. HTTP mantiene evaluación diferida. Expiry no se renueva y aceptación/despacho siguen bloqueados. No se promete validar el reloj en el instante físico de todo commit directo.

Código B1 `5978807270c038d9d7e555ad985ee7bfe35718a5` compilado en salida aislada con dependencias/Prisma actuales: legacy funciona; accept/requote convertido rechazados por SQL y rollback. No equivale a artefacto histórico completo. Lectores anteriores no garantizan CONVERTED, metadata congelada ni scopes nuevos; revisión de esos límites, no certificación de despliegue mixto. Actualizar todas las instancias antes de activar B.

## Congelación, limpieza y pendientes

Los 261 archivos originales de producto/migraciones/configuración/contratos/paquetes siguen idénticos; hash combinado original `6b16d0eb8fdb91a10d6d902f3cf2017050e22509d20e757b8d71aef748b7732c`. El archivo adicional bajo scripts es sólo el consolidador del CHECK. `.env` comparado privadamente e idéntico; no se publica huella. HEAD/versión/CHANGELOG intactos.

Escaneo final y limpieza exit 0: fixtures B2/B3/B4/A6 revocados/desactivados cuando correspondía, cero triggers de fallo y cero deshabilitados. Bases e historia conservadas; no se afirma borrar todos los fixtures legacy de suites. Logs privados de runners permanecen locales; documentación contiene únicamente observaciones sanitizadas. Auditoría final contra secretos conocidos del entorno: cero coincidencias en archivos cambiados; git diff --check exit 0. Esta búsqueda no equivale a una prueba universal de ausencia de secretos.

**Pendiente para cerrar B4:** diagnosticar el aborto de webhooks y obtener su archivo completo con exit 0; resolver o acordar explícitamente el alcance de los nueve errores de tipos de pruebas, sin ocultarlos. No se requiere cambiar lógica de conversión por evidencia actual.

Permanecen abiertos capacidad/volumen del mutex, política coordinada, migraciones y entorno de despliegue, observabilidad, responsables y retención de A. C: aceptación autorizada; D: instrucciones a ejecutores. Sin cambio de versión/CHANGELOG, commit, push, despliegue ni activación.


---

## Informe preexistente conservado — evidencia histórica cuestionada por revisión

# CHECK V1.13-B4 — Conversión única de precotizaciones

**Dictamen: PASS — V1.13-B IMPLEMENTADA Y VALIDADA LOCALMENTE.**

2026-09-28/29. Rama `1.13-Precotización_integración_comida_prepagada`, HEAD `7660f13` antes y
después. Sin cambio de versión, CHANGELOG, commit, push, despliegue ni activación.

**Este PASS no habilita emisión ni conversión y no permite despachar recursos convertidos.** C sigue
pendiente de diseño e implementación de aceptación autorizada; D sigue pendiente de exposición de
instrucciones a ejecutores.

---

## 1. Baseline y alcance

El cierre cubre **sólo** la conversión MPQ → MDR PREPAID + MQ OFFERED con barreras pre-C. No
acredita aceptación autorizada, despacho de solicitudes convertidas, cobro efectivo, interfaces,
activación, despliegue ni el flujo completo de transferencia.

| | |
|---|---|
| Rama | `1.13-Precotización_integración_comida_prepagada` |
| HEAD inicial y final | `7660f1392e1af6d8aae880381e3a271da0e69aa3` |
| Paquete | 1.12.0, sin cambio |
| Cambios preexistentes | archivo untracked `nul`, **conservado intacto** |
| Documentación leída | AGENTS, BITACORA, README, VERIFICATION, informes B1/B2/B3, `docs/CHECK-V1.13-A6-PREQUOTES.md`, propuesta de precotización y evaluación de reutilización |

**Las cifras de B2 (380 unitarias / 572 E2E) y de B3 (380 / 237 seleccionadas) no se reutilizan.**
El inventario vigente se descubrió en esta tarea y se reporta abajo con su total real.

## 2. Producto congelado

| | Antes | Al cierre |
|---|---|---|
| Archivos de referencia (`src/**`, `prisma/**`, `scripts/**`, contratos, configuración, paquetes) | 261 | 261 |
| Hash combinado SHA-256 | `6b16d0eb8fdb91a1…48b7732c` | `6b16d0eb8fdb91a1…48b7732c` |
| Archivos con diferencia | — | **0** |
| `.env` | comparado en privado | **idéntico**; contenido y huella no publicados |
| `git status` | `?? nul` | `?? nul` + `?? test/check-b4-conversion.e2e-spec.ts` |

Lo único que el CHECK agregó al árbol es su propia suite, este informe y la evidencia. **No se
modificó producto ni migraciones.**

## 3. Entorno aislado

```text
Node.js 24 · PostgreSQL 18 local · sin Docker, VM, Mandaria Web ni Coita Eats
routing controlado por doble en todas las suites; ninguna llamada pagada
```

Bases **nuevas**, inequívocamente locales y terminadas en `_test`, retenidas sin reset ni purga:

| Rol | Uso |
|---|---|
| `mandaria_b4_integral_<sufijo>_test` | recorrido integral y suites de precotización |
| `mandaria_b4_reg_<sufijo>_test` | regresión limpia de los 30 archivos E2E |
| `mandaria_b2_*`, `mandaria_a5_*`, `mandaria_clean_*`, `mandaria_upgrade_*`, `mandaria_v19_*`, `mandaria_v110a_*` | creadas por los verificadores de migraciones reejecutados |
| `mandaria_b4_a3repro*_test` | reproducción del verificador obsoleto de A3 |

Las bases se separaron a propósito: las fixtures de upgrade insertan `MDR-000001`/`MQ-000001` con
IDs manuales que **no avanzan las secuencias**, y eso choca con los IDs de un flujo real. La
regresión corre por tanto sobre una instalación limpia.

**Base principal:** 24 de 28 migraciones aplicadas y **ninguna** tabla de V1.13
(`DeliveryPrequote`, `PrequoteConversion`, `ApiIdempotencyExecution`,
`PrequoteConsumptionPermit`). Se consultó sólo de lectura para confirmarlo; **no se migró ni se
usó como destino**, y no se leyeron datos operativos.

`npm run build` y `npm run docs:check` se ejecutaron **antes** de cualquier E2E, y no se lanzaron
builds concurrentes que sustituyeran `dist` durante las pruebas.

## 4. Recorrido integral con componentes reales

Las suites B2 y B3 **sustituyen el consumo durable A5 por un doble**. Ésa era la brecha real de este
CHECK, y la cierra `test/check-b4-conversion.e2e-spec.ts`: **24 casos** en dos aplicaciones Nest con
pools independientes, donde autenticación, token por `/integrations/token`, idempotencia, consumo
durable, conversión, persistencia y PostgreSQL son los de producción, y **sólo el proveedor de
routing está controlado**.

| Paso del recorrido | Observado |
|---|---|
| Credencial y token de fixture | credencial real con los nueve scopes; token emitido por el endpoint, no firmado a mano |
| Emitir MPQ con consumo durable real | 201; **exactamente un** `PrequoteConsumptionPermit` en estado `FINISHED`, una ejecución durable A3 y **una** llamada de routing |
| Consultar y repetir la MPQ | replay con `Idempotent-Replayed: true`, mismo `publicId`, **sin** segundo permiso ni segunda llamada de routing |
| Convertir con confirmaciones válidas | 201, `Idempotent-Replayed: false`, `Location` hacia la MDR, `Cache-Control: no-store`, `X-Request-Id` presente |
| **Convertir no consume** | 0 permisos nuevos, 0 ejecuciones A3 nuevas, 0 llamadas de routing |
| Snapshot | importe, moneda, distancia, duración, proveedor, plan, banda, zona, `expiresAt` y `routeCalculatedAt` **idénticos** a la MPQ |
| Fechas propias | `MDR.createdAt`, `MDR.requestedAt` y `MQ.createdAt` son `convertedAt`, posterior a `issuedAt` |
| MPQ, MDR y MQ | MPQ pasa a `CONVERTED` y publica sus dos vínculos; MDR `CREATED`; MQ `OFFERED` |
| Accept legacy | 409 `AUTHORIZED_ACCEPT_REQUIRED` |
| Recotización legacy | 409 `PREQUOTE_REQUOTE_NOT_ALLOWED`, y la MDR sigue con una sola MQ |
| Cancelar la MDR | 200; la MPQ **sigue** `CONVERTED` |
| Repetir la conversión | 200, mismos IDs y `convertedAt`, `expiresAt` sin cambio, estados **actuales** (`CANCELLED`/`CANCELLED`) |
| Otra key sobre la misma MPQ | 409 `PREQUOTE_ALREADY_CONVERTED`; una sola conversión persiste |
| Recursos que no debe tocar | `Dispatch`, `DeliveryAssignment`, `CreditLedgerEntry`, `B2bOutboxEvent` y `DispatchCreditSnapshot` **idénticos** antes y después |

## 5. Contrato y aislamiento

| Área | Observado |
|---|---|
| Códigos y cabeceras | 201 nuevo / 200 replay; `Idempotent-Replayed` false/true; `Location` sólo en el 201; `Cache-Control: no-store`; `X-Request-Id` |
| Tres scopes | quitar `prequotes:convert`, `deliveries:create` o `quotes:create` → **403 en los tres casos**; con los tres, 201 |
| Ownership | MPQ ajena y MPQ inexistente devuelven **404 con envelope idéntico** salvo `requestId`, `timestamp` y el `path` que el propio llamante pidió; no se filtra nada de la MPQ ajena y el intento no crea recursos |
| Token humano | 401: no es principal de integración |
| Revocación / suspensión / expiración | credencial revocada, integración suspendida y credencial vencida devuelven **401 incluso para el replay**; restablecido el principal, el replay recupera el mismo ganador |
| Validación anidada | **12 cuerpos inválidos → 400**: campo desconocido, campo bancario extra en la confirmación, versión distinta de 1, estado de pago inventado, referencia vacía, referencia de 101 caracteres, fecha sin zona, fecha inválida, fecha futura, pagador ajeno, componente ajeno e importe de cobro. **Ninguno crea key, conversión ni solicitud** |
| PREPAID / MXN / FOOD / LOCAL_DELIVERY | `COURIER_ADVANCE`, `USD`, categoría distinta de `FOOD` e importe negativo → 400 |
| `goodsValue` | omitido, `null` y positivo aceptados; el importe de mercancía **no** se mezcla con el del envío |
| Referencias opacas | ni las referencias de confirmación, ni el manifiesto (`stopIds`, `packageIds`, `financialContextId`), ni los UUID internos, ni `idempotencyRecordId`, ni el proveedor de routing, ni la relación cruda aparecen en las cuatro proyecciones ni en los registros |
| Proyección explícita | la respuesta de conversión publica exactamente ocho campos |
| Flag en false | conversiones nuevas → **503 `PREQUOTE_CONVERSION_DISABLED`** sin crear nada; el **replay autorizado sigue disponible** con 200 |

Mandaria registra **declaraciones del integrador**, no verificación bancaria propia.

## 6. Concurrencia, idempotencia y recuperación

Dos instancias Nest con conexiones independientes. Se cuentan **filas y enlaces**, no sólo HTTP.

| Escenario | Observado |
|---|---|
| Misma key y cuerpo desde las dos instancias | un solo 201; la otra 200/409/503. **Una** conversión, **una** key, **una** MQ |
| Misma key con cuerpo distinto, otra MPQ u otra operación | 409 en los tres; la MPQ ajena a esa key sigue disponible y sin recursos |
| Ocho keys compitiendo por una MPQ | **un 201 y siete conflictos**; una sola key persistida, apuntando a una conversión que existe; cero huérfanas |
| Mismo texto de key en dos integraciones | **dos 201** independientes, dos resultados propios, dos keys |
| Commit con respuesta perdida | fallo inducido **sólo** en la carga de la respuesta → 500; la otra instancia recupera el mismo ganador por replay, sin duplicar. No se afirma un corte TCP real |
| Cancelación y lecturas concurrentes | pares coherentes (`CREATED`/`OFFERED` o `CANCELLED`/`CANCELLED`), nunca una combinación imposible; la MPQ queda consumida de forma permanente |
| Timeout y retry, rollback en construcción | reejecutados en las suites B2 y B3: 503 `PREQUOTE_CONVERSION_UNAVAILABLE` con rollback y reintento posterior exitoso |
| Sin ejecución durable A3 para conversión | **0** en el escaneo final de ambas bases |

## 7. Snapshot, tiempo y límite SQL

| Caso | Observado |
|---|---|
| Copia exacta | importe, moneda, ruta, referencias de tarifa y `expiresAt` idénticos; fechas propias de conversión |
| Sin routing ni recálculo | el doble de routing no recibe llamada alguna durante la conversión |
| Tarifa reemplazada e inactivada | con una tarifa nueva de `999.00` activa, la conversión conserva `31.50` y las referencias de plan y banda de la MPQ |
| Metadata congelada | renombrar la zona y cambiar su código **no** altera lo que publican la MQ convertida ni la MPQ |
| Zona `INACTIVE` | bloquea una conversión nueva con 409 `PREQUOTE_SERVICE_UNAVAILABLE` sin crear nada; **el replay no se ve afectado** |
| Vencimiento exacto | la vigencia se acorta **por configuración antes de emitir**, que es el único camino legítimo; antes convierte, después 409 `PREQUOTE_EXPIRED`, sin recursos y sin renovar `expiresAt`; la proyección la reporta `EXPIRED` |
| `expiresAt` inmutable | acortar, ampliar y borrar la MPQ por SQL se rechazan con `PREQUOTE_IMMUTABLE` |
| Cruce del vencimiento por espera de lock | otra sesión retiene la fila 2,6 s con una vigencia de 1,5 s: la conversión espera el lock real y responde 409 `PREQUOTE_EXPIRED` con rollback completo, sin conversión y sin key |

### `SET CONSTRAINTS IMMEDIATE` y la distinción de garantías

Con el conjunto ya comprometido, `SET CONSTRAINTS ALL IMMEDIATE` lo acepta y el manifiesto sigue
coincidiendo; los ataques posteriores siguen fallando. La variante de **commit tardío** de un
escritor directo se reverifica al reejecutar la suite B3, que la construye en SQL con sus tres
variantes; en este CHECK no puede reproducirse acortando la vigencia, precisamente porque la fila
MPQ rechaza todo `UPDATE`.

```text
HTTP            conserva la evaluación diferida y revalida antes de construir y al final
SQL             conserva la integridad estructural sin depender del instante de evaluación
escritor directo puede adelantar la comprobación temporal
expiresAt       nunca se renueva, ni por la aplicación ni por SQL
pre-C           no se permite aceptación ni despacho
```

Ese límite está documentado por B1/B2 y **no se clasifica como defecto**. No supera la frontera: no
permite reutilización, ni repricing, ni corrupción, ni despacho. Exigir que ningún commit tardío
directo sea posible requeriría una decisión arquitectónica explícita, no una relajación silenciosa.

## 8. SQL adversarial, manifiesto y preservación

**16 escrituras forjadas, ninguna aceptada.** Segunda conversión de la misma MPQ, mover la
conversión a otro dueño, reescribir el manifiesto, adelantar `convertedAt`, borrar la conversión,
modificar o borrar la MPQ consumida, reprecificar la MQ, ampliar su `expiresAt`, forjar `ACCEPTED`
con `acceptedAt`, segunda MQ para la MDR, hijo extra después del commit, reparentar un hijo
autorizado, borrar el contexto financiero, abrir `Dispatch` por la MQ convertida y dejar la key
huérfana. Las suites B2 y B3 reejecutadas amplían el barrido con manifiesto
incompleto/duplicado/ajeno, adopción tardía de destinos, savepoints y constraints inmediatas.

**Catálogo verificado, sin deshabilitar nada:** 17 triggers de integridad en `PrequoteConversion`,
`DeliveryPrequote`, `DeliveryQuote`, `DeliveryRequest` y `Dispatch`, **todos habilitados**; 2 FKs
`DEFERRABLE INITIALLY DEFERRED` en `PrequoteConversion`. Se retiraron únicamente fixtures, nunca
guardas.

### Escaneo SQL final — doce invariantes, **cero** en ambas bases

```text
vínculos inválidos · keys huérfanas · ejecuciones de conversión · Dispatch por MQ convertida
Dispatch por MDR convertida · MQ inválidas · manifiestos inválidos · intenciones inválidas
MPQ con dos conversiones · triggers de fallo · triggers deshabilitados
credenciales y zonas de fixture activas
```

### Preservación con fixtures no vacíos

Flujo legacy real y completo por HTTP y servicios: solicitudes `PREPAID` y `COURIER_ADVANCE`,
cotización, aceptación, proveedor con cobertura, recarga de créditos, claim, asignación y cierre.
**El punto de referencia se toma después de emitir las tres MPQ y antes de convertirlas**, porque
emitir consume por diseño y atribuirlo a la conversión sería confundir la preparación del fixture
con el flujo medido.

Ocho tablas comparadas por hash antes y después de tres conversiones — `CreditAccount`,
`CreditLedgerEntry`, `Dispatch`, `DeliveryAssignment`, `B2bOutboxEvent`, `DispatchCreditSnapshot`,
`ApiIdempotencyExecution` y `PrequoteConsumptionPermit` — todas con **contenido idéntico**, y todas
no vacías en el punto de referencia. Las MDR y MQ legacy seleccionadas tampoco cambiaron. Después de
convertir, el legacy sigue funcionando: accept idempotente, recotización y cancelación conservadas,
mientras las MDR convertidas siguen bloqueadas.

## 9. Compatibilidad, escritores anteriores y lectores

La revisión anterior `5978807` se extrajo **del historial local** con `git archive` y se compiló con
TypeScript en `.tmp/b4/old/dist`: sin checkout, sin reset, sin descargas y **sin sustituir el `dist`
activo**. La suite B3 reejecutada la arranca en otra aplicación Nest sobre el esquema actual y
confirma que el escritor anterior crea, cotiza y acepta legacy con normalidad, mientras que sobre
recursos convertidos su accept y su recotización fallan con rollback completo.

**Usar las dependencias y el Prisma Client instalados hoy no equivale a probar un artefacto
histórico de producción**, y esto confirma protección de escrituras, no compatibilidad operacional
de un despliegue mixto. Los lectores anteriores no reconocen `CONVERTED`, ignoran la metadata
congelada y su enum de claims no admite `prequotes:convert`; eso se conoce por inspección de código,
no se certifica aquí. **No se declara compatible un despliegue mixto sólo porque SQL bloquee
escrituras: hay que actualizar todas las instancias antes de activar B.**

## 10. Migraciones y suites ejecutadas

### Inventario descubierto

| | Real en esta tarea |
|---|---|
| Archivos E2E | **30** |
| Archivos unitarios | **32** |

### Resultados

| Ejecución | Comando | Resultado |
|---|---|---|
| Prisma validate | `npx prisma validate` | exit 0 |
| Build | `npm run build` | exit 0, antes de cualquier E2E |
| Contrato | `npm run docs:check` | exit 0, al día |
| Tipos de producto | `tsc --noEmit -p tsconfig.build.json` | **exit 0** |
| Oxlint / ESLint | `npm run lint` / `npm run lint:eslint` | exit 0 |
| Whitespace | `git diff --check` | exit 0 |
| Cadena histórica | `node scripts/verify-migrations.mjs` | **PASS** |
| Instalación limpia y upgrade con historia no vacía | `node scripts/verify-prequote-conversion-migrations.mjs` | **PASS**, 28 migraciones, 14 tablas históricas, catálogo de FKs diferidas |
| Consumo A5 | `node scripts/verify-prequote-consumption-migrations.mjs` | **PASS**, 28 migraciones, 14 tablas |
| Estado y reaplicación idempotente | `prisma migrate status` y `deploy` sobre las dos bases aisladas, con 199 y 127 conversiones existentes | al día, 28 aplicadas, **0 fallidas**, reaplicación sin pendientes |
| Drift | `prisma migrate diff --from-schema-datamodel --to-url <base aislada> --exit-code` | **exit 0, sin diferencias** en ambas |
| Unitarias completas | `vitest run` | **380/380 en 32 archivos** |
| E2E, todos los archivos actuales | 30 archivos completos, incluidos CHECK A6, B2, B3 y el nuevo B4 | **654/654 casos únicos** |
| Escaneo SQL final | `node .tmp/b4/scan.mjs` y `scripts/scan-prequote-b3.mjs` | doce invariantes en 0; 17 triggers activos |

Desglose por archivo, con la suite nueva destacada:

```text
check-b4-conversion 24 (nueva)   check-b3-conversion 58   prequotes-http 40   prequote-conversion 39
credit-consumption 36            check-a6-prequotes 36    b2b-webhooks 54     delivery-completion 29
credits 24                       prequote-persistence 24  user-invitations 24 b2b-delivery-status 21
prequote-consumption 21          independent-drivers 23   credit-refunds 22   credit-policies 19
b2b-outbox 17                    b2b 14                   delivery-quotes 14  dispatch-credit-snapshots 14
delivery-requests-b2b 15         providers 15             delivery-assignments 13   dispatch 13
drivers-vehicles 11              provider-admin-access 9  core 7              driver-self 7
delivery-requests-validation 7   pricing-admin 4
```

### Abortos y repeticiones

Tres archivos abortaron con la caída nativa de worker de Windows (`exit 3221226505`, sin salida):
`prequote-conversion` una vez, `user-invitations` una vez y `delivery-quotes` dos veces. **Un
proceso no exitoso no se acredita**: se repitieron completos hasta `exit 0`, sin cambiar aserciones
ni deadlines, y **las repeticiones no se suman** a los casos únicos.

### No ejecutado

- `scripts/verify-prequote-migrations.mjs`: falla por obsolescencia, ver limitaciones.
- Docker, VM, Mandaria Web, Coita Eats, Google real y migración de la base principal: fuera de
  alcance por instrucción.
- Cobertura, benchmark formal y escaneo de logs de producción.

## 11. Defectos y limitaciones

### Defectos de producto

**Ninguno.** No se modificó ningún archivo de producto, migración, contrato ni configuración, y el
hash combinado de los 261 archivos protegidos lo demuestra.

### Defectos de las fixtures del propio CHECK (diez, corregidos aquí y explicados)

1. Punto de referencia de ejecuciones A3 tomado **antes** de emitir, cuando emitir consume por
   diseño. Corregido tomándolo después de emitir, que es lo que la barrera quería medir.
2. Aserción que exigía al envelope 404 no repetir el `path` solicitado por el propio llamante.
3. Replay construido con un cuerpo nuevo en cada intento, que es legítimamente un conflicto de key.
4. Ordenación lexicográfica de códigos HTTP al identificar el ganador de una carrera.
5. Plan de tarifas creado `ACTIVE` con bandas, que la guarda `RATE_PLAN_IMMUTABLE` rechaza con
   razón; se crea `DRAFT` y se activa después.
6. Intento de devolver un plan `INACTIVE` a `ACTIVE`, transición que el dominio prohíbe; el caso
   pasó a usar **su propia zona y su propio plan**, sin tocar el fixture compartido.
7. Frontera temporal construida por `UPDATE` del `expiresAt` de la MPQ, que es inmutable; se acorta
   la vigencia por configuración antes de emitir.
8. Fotografía de preservación que encerraba también la emisión de las MPQ.
9. Drift medido con `--to-schema-datasource`, que resuelve el datasource del archivo de schema y
   por tanto apuntaba a la base principal; se repitió con `--to-url`.
10. Variable de fixture sin uso que rompía el linter.

Ninguna corrección debilitó una aserción ni deshabilitó una guarda.

### Limitaciones y entorno

- **`scripts/verify-prequote-migrations.mjs` quedó obsoleto.** Excluye sólo las dos migraciones de
  A3, así que su base de upgrade recibe también `20260928000300_prequote_consumption` y
  `20260928000400_prequote_conversion`, que dependen de las tablas que A3 crea. Reproducido tres
  veces; la migración que falla es `20260928000400_prequote_conversion` y una reaplicación posterior
  devuelve `P3009`. **No es un defecto de producto ni de migraciones**: la cadena queda verificada
  por los otros tres verificadores, los tres PASS. Se documenta y **no se corrige**, porque un CHECK
  no modifica scripts del repositorio para aprobarse.
- **`tsc -p tsconfig.json`, que incluye las pruebas, arroja 9 errores preexistentes** en las suites
  de A6, B2 y B3 (`.send(unknown)` y una tupla en `pricing.spec.ts`). El gate de producto
  `tsconfig.build.json` está en 0, y la suite nueva de B4 no agrega ninguno.
- Abortos nativos de worker en Windows, ya descritos.

### Límites conservados, no promovidos a garantía

- Un escritor directo con `SET CONSTRAINTS IMMEDIATE` puede adelantar la evaluación temporal.
- La confirmación es una **declaración del integrador**; Mandaria no verifica banco.
- Las referencias son cadenas opacas validadas por forma y longitud: no hay clasificador de PII en
  texto libre, aunque los campos bancarios y de PII adicionales sí se rechazan.
- El ensayo del escritor anterior usa dependencias y Prisma Client actuales.

## 12. Pendientes de activación

Los pendientes operativos de A siguen **abiertos** y este CHECK no los resuelve ni los activa por
inercia:

- capacidad del mutex y volumen;
- política coordinada de consumo;
- migraciones y entorno de despliegue;
- observabilidad, responsables y retención;
- actualizar **todas** las instancias antes de activar B;
- C, aceptación autorizada, y D, exposición de instrucciones a ejecutores.

## 13. Cierre

Producto congelado y verificado intacto. `.env`, HEAD y versión intactos. Cero triggers de fallo
residuales y cero triggers de integridad deshabilitados. Fixtures del CHECK y de las suites que
abortaron: credenciales revocadas y zonas desactivadas, comprobado con un segundo escaneo en cero.
Bases e historia conservadas; ninguna base preexistente se borró ni se reseteó. Sin activación
operativa, sin cambio de versión o CHANGELOG, y sin commit, push o despliegue.

Evidencia estructurada y sanitizada: [`docs/checks/v1.13-b4-evidence.json`](checks/v1.13-b4-evidence.json).

**V1.13-B IMPLEMENTADA Y VALIDADA LOCALMENTE.**
