# Validación integrada local — verificación documental

## Alcance de esta ejecución (13 de octubre de 2026)

Web real → API Nest real → PostgreSQL 18 exclusivo. Sin integración QA, Docker, cuentas reales, producción, Coita, Spaces, SMTP, Google Routes ni despliegue. Las fuentes y documentación de Web son de sólo lectura en esta tarea.

Resultado: **31 comprobaciones integradas aprobadas** (30 del recorrido principal y 1 focalizada de cambio de cuenta). No equivale a cierre de producción. Este informe se complementa con la matriz saneada de `docs/checks/driver-verification-integrated.json`. Los resultados previos de 181 unitarias/128 E2E backend y 219 pruebas/9 checks visuales Web son **históricos**, no sumados a esta ejecución.

## Identificación y reproducción

- Backend: worktree `driver-verification/mandaria-backend`, rama `feature/driver-verification`, HEAD `90b72433f8a5476ece5fda4437dc15a0a6a314f2`.
- Web: worktree `driver-verification-web/mandaria-frontend`, rama `feature/driver-verification`, HEAD `06d976619322d9811b5325fc73cd16d15e00d829`.
- Ambos contienen implementación previa sin commit. El manifiesto local `.tmp/documentary-integrated/report.json` registra `git status` y SHA-256 de cada archivo no ignorado al inicio y al cierre; HEAD no identifica por sí solo el código probado.
- No se cambia de rama, no se usa el checkout QA ni el worktree f1fe como aplicación probada.

Requisitos existentes: Node, PostgreSQL 18 en `C:/Program Files/PostgreSQL/18/bin`, dependencias backend y Web instaladas, Chromium de Playwright disponible en Web. No instala paquetes ni navegadores.

Desde el worktree backend:

```powershell
npm run build
node scripts/driver-verification-integration/run.mjs
node scripts/driver-verification-integration/account-recovery.mjs
npm run test:public-b2b
node node_modules/typescript/bin/tsc -p tsconfig.build.json --noEmit
node node_modules/oxlint/bin/oxlint scripts/driver-verification-integration
```

El arnés crea un clúster nuevo en `%TEMP%/mandaria-doc-integrated-*`, verifica por SQL nombre de base, dirección, puerto y directorio antes de aplicar las **33 migraciones de esta rama**. No importa las migraciones de QA. Arranca sólo servicios loopback, genera secretos sintéticos en memoria y configura Vite mediante `envDir:false`; no lee credenciales de `.env`. La API recibe su configuración en el proceso, con cwd temporal antes de importar `AppModule`.

La base principal de la ejecución se llama `documentary_integration_test`. La regresión de búsqueda usa otra base del mismo clúster exclusivo: `documentary_search_regression_test`. El arnés cierra únicamente sus instancias Nest/Vite/proxy/almacenamiento y su propio `pg_ctl -D <directorio verificado>` en `finally`. Conserva el directorio de datos; no borra recursos ajenos. No distribuye contraseñas ni permite reutilizar cuentas sintéticas como cuentas reales.

`DOCUMENTARY_SKIP_SEARCH=1` omite expresamente el archivo de búsqueda cuando ya existe una ejecución aprobada de esta misma tarea. El informe registra `NOT RUN` para esa omisión; no inventa una nueva aprobación.

## Qué es real y qué es un doble

- **Navegador real**: React/Vite del worktree indicado, cliente HTTP real, autenticación, formularios, recargas, roles, imágenes y almacenamiento del navegador. Sin fixtures que respondan endpoints de Mandaria. El navegador rechaza tráfico ajeno a loopback.
- **Backend y PostgreSQL reales**: DTOs, guards, transacciones, triggers, revisión, recibos, versión e idempotencia. Los tests HTTP negativos no se presentan como recorridos de interfaz.
- **Correo capturado**: se usa `LocalOutboxMailProvider`; el adaptador conserva mensajes sintéticos en memoria y en el temporal privado. Los tokens de confirmación no aparecen en evidencia. La aceptación de correo no acredita llegada a una bandeja.
- **Almacenamiento simulado**: servidor HTTP local con tickets opacos, PUT/OPTIONS y CORS para el origen de prueba. Web transmite bytes JPEG/PNG sintéticos; backend decodifica con Sharp, normaliza y guarda metadata real. Los objetos sólo permanecen en memoria durante la ejecución. No acredita persistencia remota, firmas S3 ni CORS de Spaces.
- **Preparación por seed**: SUPER_ADMIN, representantes A/B, proveedores y memberships; recursos legacy mínimos de transición. El independiente se registra/confirma desde Web. Las invitaciones de flotilla y su activación se hacen mediante HTTP real; sus conductores aceptan términos desde sus propias sesiones. No se acredita la pantalla de activación de invitaciones.

## Pérdida de respuesta y tiempo controlado

El proxy recibe completamente la respuesta real del backend al POST y sólo entonces retiene su entrega. La petición ya fue procesada; Web vence con su timeout real de 20 segundos. El proxy destruye la conexión retenida a los 25 segundos. No sustituye resultados por fixtures ni aborta antes de enviar.

Los casos de aceptación, presentación y decisión cotejan PostgreSQL, recargan Web y consultan el intento original. Se cuenta un único recibo/evento y se inspecciona que el marcador sólo tenga `actor`, `key`, `operation`, `target`. Consultar un recibo `SUBMITTED` después de una decisión no sustituye el estado vigente `APPROVED`.

El rechazo por URL de carga caducada se provoca sólo en el reloj de vencimiento del ticket del **doble local**; no acredita la caducidad de una URL Spaces. La licencia corta se revisa mediante APIs reales y se espera su vencimiento real, sin cambiar el reloj del equipo. El reintento de correo se adelanta moviendo `retryAt` únicamente en la base aislada y ejecutando el `flush()` existente; no se modifica la política de reintentos.

## Incidencias del arnés y límites

Se conservan los intentos fallidos en `.tmp/documentary-integrated/attempt-*.json`; no se suman como aprobaciones ni se ocultan con respuestas mock. Hubo correcciones de preparación: pipe heredado de `pg_ctl`, representación CIDR de loopback, selector ambiguo de categoría, sincronización del formulario, expectativas del arnés y límites HTTP. No se desactivó el throttler: las lecturas de detalle se espacian en el proxy.

El primer lanzamiento del archivo de búsqueda no encontró archivos por su raíz temporal; la configuración temporal posterior fija `test.root` al backend. No fue un aborto nativo ni una ejecución parcial aprobada.

### Observación para Web: cambio de archivo durante carga

Con la respuesta/refetch aún pendiente, el campo de archivo continúa editable. Seleccionar el siguiente archivo antes de que termine la carga anterior permite que `Form` lo vacíe al completar su limpieza, y el siguiente submit muestra la validación nativa de archivo requerido. Evidencia: captura local `C-identity-license-browser-JPEG-PNG-actor-0.png` del intento con latencia, que debe conservarse separada de las capturas aprobadas.

Reproducción: iniciar carga válida, seleccionar otro archivo mientras la operación todavía está ocupada y esperar su fin. Corrección propuesta al responsable Web: impedir modificar archivo/categoría mientras esa carga está pendiente, o limpiar sólo la selección correspondiente a la operación terminada. No se modificó Web; para continuar las pruebas se esperó que su botón volviera a estar habilitado. No demuestra pérdida de un documento ya persistido ni un defecto de autorización backend.

## Pendientes fuera de esta validación

Privacidad y términos definitivos, representación jurídica, baja/purga y backups, Spaces real y sus permisos/CORS/retención, correo real, aplicación móvil/captura de documentos reales, PDF y antimalware. No activar producción ni considerar contractualmente válidos los recibos `LOCAL_TEST`.

La matriz final distingue casos acreditados, bloqueos y escenarios no ejecutados. No es un cierre de rollout.


## Matriz final de esta tarea

| Grupo | Medio y actores | Resultado nuevo y persistencia comprobada |
|---|---|---|
| A — Registro | Web, independiente sintético | PASS: solicitud pública, correo local, confirmación, login y reload. Driver PENDING/OFFLINE/providerId null; autoridad operativa rechazada con 409. |
| B — Términos | Web + HTTP, conductor y representantes | PASS: texto/versión de prueba, casilla inicialmente desmarcada, aceptación propia, recibo único `contractuallyEffective:false`; versión no vigente rechazada con 409. No se reemplazó la versión vigente del catálogo. |
| C — Independiente | Web + PostgreSQL | PASS: identidad/licencia y JPEG/PNG; unidades OWNED/RENTED/BORROWED; rechazo con motivo, nuevo expediente de corrección y aprobación; ambos expedientes conservados; identidad y unidades aprobadas separadamente. |
| D — Flotilla | Representante A y conductor A; invitación/activación por HTTP, términos/expedientes por Web | PASS: bloqueo antes de aceptación personal; representante no puede aceptar DRIVER (403); identidad y unidad prestada a la flotilla aprobadas por separado. |
| E — Roles | SUPER_ADMIN, representantes A/B, conductores A/B e independiente | PASS: bandeja/detalle/evidencia reales; decisión ajena 403; versión obsoleta 409 sin segundo evento; expedientes/archivos ajenos 404 y acceso anónimo 401; cambio de cuenta sin conservar vista documental. No se corrió una carrera simultánea de dos revisores en este recorrido. |
| F — Archivos | Web → PUT HTTP local → normalización backend | PASS: JPEG/PNG convertidos a PNG, metadata/asociación reales; PNG inválido y MIME no permitido rechazados (se usaron bytes PNG con MIME `application/pdf`, no un documento PDF); PUT 403 deja carga incompleta; ticket local vencido 403; identificador/key manipulados rechazados; sin archivos/URLs en almacenamiento del navegador. No acredita S3. |
| G — Recuperación | Web + PostgreSQL y negativos HTTP | PASS: aceptación/presentación/decisión perdidas después de commit, recarga y APPLIED con un solo efecto; marcador de cuatro campos; resultado histórico SUBMITTED distinto del vigente APPROVED. ABSENT→cierre técnico→POST tardío devuelve 409 VERIFICATION_ATTEMPT_CLOSED sin crear vehículo. Cambiar a otro usuario y recargar conserva bloqueo; GET ajeno 403; vuelta al iniciador recupera sin nuevo POST. Cierre explícito se comprobó por HTTP, no en su modal. |
| H — Avisos | Outbox local y fallo controlado del proveedor | PASS: decisión APPROVED permanece; notice PENDING/error/attempts tras falla; `retryAt` adelantado sólo en DB aislada y flush real produce ACCEPTED_BY_PROVIDER sin duplicar decisión. No acredita entrega de email. |
| I — Transición | HTTP + SQL de elegibilidad + Web proveedor | PASS: pairing de recursos existentes permitido con control off y rechazado con on; identidad/unidad solas insuficientes; aprobación conjunta elegible LOCAL_TEST y rechazada fuera de ese contexto; pairing flotilla aprobado por HTTP. Licencia de categoría incorrecta y vencida bloquean. Reasignación fallida conserva la asignación anterior. Lectura/revisión documental conserva claim/rondas/historial. Servicio comprometido LEGACY se completa desde Web por proveedor, queda COMPLETED/DELIVERED y no genera otro movimiento de créditos. |
| J — Regresiones | Archivos completos | PASS: `dispatch-search.e2e-spec.ts` 16/16 en base distinta; exportador público y ejemplo de firma 33/33. No suite completa. No sumar repeticiones del arnés. |

### Topología efectivamente usada

- **Principal:** PostgreSQL `127.0.0.1:62184`, datos `C:\Users\zorgl\AppData\Local\Temp\mandaria-doc-integrated-e9MR4p\pgdata`; Web `http://127.0.0.1:62187`, API `http://127.0.0.1:62185`, proxy `http://127.0.0.1:62186`. Servicios detenidos.
- **Cambio de cuenta:** PostgreSQL `127.0.0.1:49680`, datos `C:\Users\zorgl\AppData\Local\Temp\mandaria-doc-integrated-woA5I7\pgdata`; Web `http://127.0.0.1:49683`, API `http://127.0.0.1:49681`, proxy `http://127.0.0.1:49682`. Servicios detenidos.
- **Búsqueda 16/16:** PostgreSQL `127.0.0.1:64997`, datos `C:\Users\zorgl\AppData\Local\Temp\mandaria-doc-integrated-QSfa2C\pgdata`; Web `http://127.0.0.1:65000`, API `http://127.0.0.1:64998`, proxy `http://127.0.0.1:64999`. Servicios detenidos.

La regresión de búsqueda usa `documentary_search_regression_test`; los otros recorridos usan `documentary_integration_test` en clústeres distintos. Las URLs anteriores identifican evidencia, **no servidores dejados encendidos**. Temporales adicionales de preparación y ensayos incompletos se conservaron y sus clusters fueron detenidos.

### Calidad y evidencia visual

- `npm run build`: exit 0, antes del arranque.
- `node node_modules/typescript/bin/tsc -p tsconfig.build.json --noEmit`: exit 0.
- Oxlint sobre las cinco utilidades nuevas: exit 0, sin advertencias. `node --check` en cada archivo: exit 0.
- Archivo E2E de búsqueda: 16/16, exit 0; tests públicos: 33/33, exit 0. No nuevas ejecuciones de las suites históricas de 181/128/219.
- Cero errores `pageerror` en el recorrido principal; errores de red deliberados corresponden a los fallos de prueba. No se afirma consola global libre de advertencias.
- Capturas locales sólo sintéticas en `.tmp/documentary-integrated/`: `unit-owned.png`, `unit-rented.png`, `unit-borrowed.png`, `cross-fleet-denied.png`, `onboarding-mobile.png`, `legacy-committed-after-activation.png`, `legacy-delivered.png`. Revisión visual efectiva de unidad aprobada/escritorio, denegación por ámbito, onboarding móvil 390×844 y entrega LEGACY. Teclado: smoke de Tab/foco, no auditoría exhaustiva.
- Marcador de cuenta ajena y recuperación: `.tmp/documentary-account-recovery/pending-other-account.png` y `recovered-own-account.png`.
- Web sin cambios: comparación SHA-256 de todos sus archivos no ignorados antes/después, PASS en ambos recorridos. No se modificaron fuentes, documentos ni configuración Web.

## Cambios de esta tarea y pendientes precisos

Sólo backend: cinco utilidades en `scripts/driver-verification-integration/`, este informe, índice saneado y continuidad BITACORA/VERIFICATION. **No se demostró un defecto funcional backend que requiriera corregir código de producto**; se preserva la implementación previa. Las correcciones fueron del arnés: precondiciones/selección de campo, sincronización y pacing, sin relajar guards ni triggers.

Handoff W-01 para Web queda sin aplicar por el alcance autorizado. Pendientes de validación: reemplazo real de versión de términos con nuevo consentimiento, modal Web de cierre ABSENT, alta/invitación de flotilla enteramente por navegador, toma independiente positiva de un nuevo despacho y auditoría completa de accesibilidad. No confundir la prueba SQL de elegibilidad con esa toma integrada.

No hubo aborto nativo del runner en esta tarea. Los ensayos iniciales fallidos no acreditan sus casos dependientes. El arnés final conserva estados y devuelve exit no cero si existen FAIL/errores; los resultados se evalúan por matriz, no únicamente por el código de salida de sus primeras versiones.

## 2026-10-13 — Reconciliación de evidencia integrada existente

Al retomar la solicitud adjunta se encontraron el informe y los reportes de integración ya presentes. Esta revisión no volvió a ejecutar navegador, suites ni servicios. Se contrastaron 933 huellas del snapshot backend y 250 Web: Web coincide íntegramente; las diferencias backend corresponden a cuatro utilidades del arnés (environment, operational, run y scenarios) y BITACORA/VERIFICATION, sin diferencias en producto dentro del inventario contrastado. Ambas ramas siguen feature/driver-verification, HEAD backend90b7243 y Web06d9766. Git diff --check terminó con exit0.

El reporte principal conserva30 PASS y un NOT RUN de búsqueda; el reporte separado de recuperación conserva1 PASS, cero errores y stopped=true. Son evidencias existentes, no31 pruebas nuevas de esta revisión. Los cuatro archivos del arnés tampoco coinciden con el snapshot backendAfter: no se acredita una nueva ejecución de su contenido actual. Se conserva la limitación para reproducibilidad sin invalidar ni atribuir al código actual los resultados históricos.

Resultado: validación integrada parcial con evidencia existente; W-01 y los NOT RUN del informe permanecen pendientes. No se modificó producto ni Web ni se arrancaron procesos. Sin QA, migraciones, .env, commit, push o despliegue.

## 2026-10-13 — Revalidación ejecutada: W-01 y pendientes

**Completado el alcance de integración local descrito aquí**, sin aptitud ni activación productiva. Consolidado nuevo: **35 escenarios únicos PASS**: 30 recorridos reejecutados y 5 escenarios adicionales. No se suman a las31 históricas ni a pruebas unitarias/E2E anteriores. Principal:34 PASS,1 FAIL del arnés y1 NOT RUN; repetición focalizada de términos:1 PASS; repetición de toma con espera de render:1 PASS ya incluido en el consolidado. Sin aborto nativo.

### Matriz nueva

| Escenario | Actor/precondiciones y acción real | Resultado y persistencia |
|---|---|---|
| W-01 confirmación A/B | Independiente sintético, nuevo borrador autorizado. Dos PNG distintos con el mismo nombre same.png,873 bytes y lastModified1700000000000; se retiene la respuesta200 real de complete después del backend y se elige B. | PASS. B conserva sus bytes y selección; mensaje distingue A confirmada/B pendiente; sólo A en DB antes de enviar B. Envío explícito de B crea su único adjunto VALIDATED. SHA256 de File, quarantine, sourceHash y objeto normalizado cotejados. El contrato conserva ambos adjuntos; no se simula reemplazo. |
| W-01 fallo A | PNG inválido A, se retiene su rechazo real mientras se selecciona B válida. | PASS. Error atribuido a A, B permanece; no carga automática; envío explícito posterior confirmado. A conserva su referencia incompleta, no una validación ficticia. |
| Cierre ABSENT desde modal | Marcador técnico mínimo sintético CREATE_VEHICLE/SELF preparado en cliente, sin comando servidor; consulta real ABSENT. | PASS. Modal explica límites y exige Confirmar cierre técnico. POST de cierre crea CLOSED_NO_EFFECTS; reload sin bloqueo. Mismos conteos de expedientes, archivos y vehículos. No se envía la intención original. Preparar el marcador no se acredita como fallo de red real. |
| Toma independiente positiva | Identidad/licencia MOTORCYCLE y unidad OWNED aprobadas; policy.enabled=true y contexto LOCAL_TEST legítimo. Servicio B2B sintético nuevo. | PASS. POST take200 desde Web; una asignación ACTIVE al driver/vehículo correctos y un solo débito. Recargas sin duplicados; searchAttempt/maxAttempts sin cambios y sin rondas nuevas en este servicio de búsqueda simple. Pantalla Servicio actual y vehículo verificados tras render, captura inspeccionada. |
| V1→V2 efectiva | Independiente con recibo V1 y pantalla V1; fixture SQL transaccional inserta V2 LOCAL_TEST inmutable y cambia driverTermsVersion únicamente en DB temporal. | PASS. POST staleV1→409 TERMS_VERSION_CONFLICT; termina reconciliación del cliente; reload muestra V2/casilla desmarcada; aceptación expresa crea un recibo V2 del actor/ámbito DRIVER y hash correcto. Texto/recibo V1 iguales antes/después. No endpoint de publicación inventado. |

Web no ofrece vista previa de la selección antes del envío: se verificaron los bytes del File seleccionado, no se inventó esa interfaz. Su vista de evidencia normalizada es posterior y separada. No se identificó un nuevo defecto Web que requiera handoff; W-01 queda acreditado contra backend real.

### Cuatro utilidades y alcance de repetición

Las cuatro tenían hashes distintos de la ejecución histórica, incluso normalizando LF/CRLF. Sólo se conservaban hashes históricos, no copias del texto de aquellas versiones: **no es posible reconstruir el diff textual histórico exacto**. Se revisó su código actual completo por responsabilidades y se reejecutaron sus escenarios funcionales. El índice registra hash histórico, baseline de esta tarea, hash ejecutado y final; en las cuatro, ejecutado=final.

- `environment.mjs`: clúster nuevo, host/puerto/base/data_directory verificados antes de migrar;33 migraciones; procesos loopback; Vite envDir:false; correo capturado/storage HTTP simulado; cierre finally. Reejecutado en los tres entornos. Sin cambios en esta tarea.
- `run.mjs`: registro, correo, términos, identidad, recuperación tras commit, revisión, checks y exit no cero ante fallos. Sólo se cambió la carpeta de evidencia para conservar la anterior. Reejecutado.
- `scenarios.mjs`: unidades, flotillas, permisos/aislamiento, archivos, recuperación y avisos. Se añadieron llamadas a los nuevos casos; aserciones anteriores conservadas y reejecutadas.
- `operational.mjs`: corte activado/desactivado, elegibilidad parcial, licencia, reasignación, preservación de búsqueda/claim y entrega LEGACY. Siete escenarios reejecutados, sin cambios en esta tarea. Su rama optativa de regresión de búsqueda quedó NOT RUN explícito: no se modificaron rutas, producto de búsqueda ni contrato público;16/16 búsqueda y33/33 públicos anteriores permanecen históricos.

No se reemplazan endpoints funcionales con fixtures. W-01 usa route.fetch seguido de entrega de la misma respuesta real, únicamente demorada. Las excepciones de checks quedan FAIL y el principal sale1, nunca PASS por silencio. Los casos HTTP auxiliares no se presentan como UI.

### Incidencias del arnés y huellas por ejecución

El principal acabó exit1 por recargar inmediatamente después del409 V1, antes del refresh/forgetMarker del cliente. Se conservan fallo y captura. Corrección: esperar que desaparezca Pendiente de reconciliación antes de navegar. Sólo se repitió V2 en un entorno nuevo, exit0. No fue un defecto backend ni un aborto nativo.

La primera toma ya confirmó200/asignación/débito, pero su captura se tomó antes del render. Se añadieron aserciones Servicio actual/identificador de vehículo y se repitió sólo toma en otro entorno, exit0. La preparación focalizada usó registro, términos, carga, presentación y aprobación por HTTP real; no acredita esos pasos como nuevas acciones de navegador. SUPER_ADMIN y políticas/fondeo de créditos de prueba fueron preparación sintética documentada.

`revalidation.mjs` cambió entre intentos únicamente por esa espera V2, las aserciones de render de toma y retirada de una variable no usada; W-01/ABSENT no cambiaron funcionalmente. Sus resultados conservan el hash exacto de ejecución anterior; las partes afectadas se repitieron con sus nuevas huellas. Copia anterior: `.tmp/documentary-revalidation/revalidation-executed.mjs`. Los reportes de cada entorno incluyen snapshot inicial/final; Web coincide íntegramente y no hay diferencias de producto backend.

### Reproducción y verificaciones nuevas

Desde el worktree backend, sin .env ni Docker:

```powershell
npm run build
$env:DOCUMENTARY_SKIP_SEARCH='1'
node scripts/driver-verification-integration/run.mjs
node scripts/driver-verification-integration/terms-revalidation.mjs
node scripts/driver-verification-integration/take-revalidation.mjs
node node_modules/oxlint/bin/oxlint scripts/driver-verification-integration
```

Cada runner crea su propio clúster nuevo. Los dos focalizados permiten repetir exclusivamente el caso afectado. Comandos ejecutados: build exit0; principal exit1 con resultados anteriores; focalizados exit0; node --check de los ocho módulos exit0; Oxlint final exit0 sin advertencias; git diff --check exit0. No se ejecutaron nuevas suites unitarias ni se cambiaron tipos/contrato/OpenAPI. La primera pasada de lint avisó una variable sin uso, eliminada; no se presenta como pasada final limpia.

Índice saneado con resultados completos, SHA Git, estados de ambos working trees, huellas, topologías y hashes de archivo: [driver-verification-revalidation.json](checks/driver-verification-revalidation.json). Logs completos de resultado: `docs/checks/driver-verification-revalidation-main.txt`, `-terms.txt` y `-take.txt`. Capturas locales sintéticas bajo `.tmp/documentary-revalidation`, `-terms` y `-take`; inspeccionadas W01-B-pending y toma final.

### Cierre y límites

Backend HEAD90b7243, Web HEAD06d9766; ambos feature/driver-verification más cambios previos sin commit. Sólo arnés y documentación backend modificados. Web sin modificaciones por hashes. Entornos dedicados conservados, servicios cerrados y pg_ctl status confirmó los tres clusters detenidos:

- `C:/Users/zorgl/AppData/Local/Temp/mandaria-doc-integrated-G3BMAR/pgdata` — PostgreSQL54929, API54930, proxy54931, Web54932, storage54933.
- `C:/Users/zorgl/AppData/Local/Temp/mandaria-doc-integrated-au0nFx/pgdata` — PostgreSQL62427, API62428, proxy62429, Web62430, storage62431.
- `C:/Users/zorgl/AppData/Local/Temp/mandaria-doc-integrated-BIPQjU/pgdata` — PostgreSQL63679, API63680, proxy63681, Web63682, storage63683.

Base documentary_integration_test en cada clúster. URLs anteriores sólo loopback; no quedan servidores activos. Temporales contienen datos/correo de prueba y no deben publicarse completos. No se borraron recursos ajenos. Correo capturado, almacenamiento simulado en memoria, sin Spaces ni entrega de correo reales. Continúan privacidad, términos definitivos, baja/purga/retención, infraestructura real y consumidores fuera de esta prueba. Sin QA, .env, base principal, commit, push ni despliegue.
