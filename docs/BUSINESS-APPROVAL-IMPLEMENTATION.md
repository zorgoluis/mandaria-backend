# Aprobación manual Negocio — implementación backend y handoff

2026-10-12. Base QA `ce45dff`; implementación local sin commit/push/despliegue. **Validación final E2E completada:69/69**, con base aislada por archivo; integración Web y rollout siguen pendientes. [Evidencia estructurada](checks/business-approval-verification.json), [ejemplos HTTP sintéticos reales](checks/business-approval-examples.json). Propuesta/diseño previos conservan el historial; este informe describe lo implementado.

## Comportamiento

- Registro/resend y anexión no conceden BUSINESS. Tokens REGISTER anteriores BUSINESS crean Personal, con `profileType=PERSONAL` y `businessApplicationRequired=true`. RESET/VERIFY conservan su función.
- Aplicación propia, revisión exclusiva SUPER_ADMIN, una PENDING y activación atómica con cero lifecycle abiertos, incluyendo MDR convertidas aún sin aceptar. Solicitar/rechazar/retirar no activa Negocio.
- Revocación bloquea futuras solicitudes incluso tras descenso a Personal. SUPER_ADMIN habilita readmisión con revisión/key; permite solicitar de nuevo, no reactiva grant ni cuenta Negocio. Rechazo/retiro posterior permite nueva solicitud explícita; futura revocación vuelve a bloquear.
- Recibos comerciales y cierre durable separados de recuperación logística. Misma clave/cuerpo reproduce resultado original; una clave distinta no sirve para resolver un timeout. Rechazo administrativo aplicado es APPLIED con applicationStatus REJECTED; comando rechazado es REJECTED.
- Cinco nuevos comandos submit/withdraw por minuto por cuenta, compartidos por PostgreSQL. Replay y lecturas no consumen ese límite; HTTP429 expone Retry-After.
- Tipo/pagador/precio y autoridad operativa de servicios comprometidos no se recalculan por revisión comercial. No cambios en B2B, cinco rondas, GPS/hitos, cobros, ledger o refunds.

## Endpoints (prefijo /api/v1)

| Método y ruta | Uso / permisos |
| --- | --- |
| POST /customer/business-applications | Titular activo/verificado; formulario y expectedAccountRevision; Idempotency-Key; 201 Receipt |
| GET /customer/business-applications | Historia propia paginada, sin notas internas |
| GET /customer/business-applications/:id | Detalle propio; ajeno404 |
| POST /customer/business-applications/:id/withdraw | Titular, expectedApplicationRevision y key; 200 Receipt |
| GET /customer/business-application-attempts/:key | operation/target en query; SUBMIT omite target |
| POST /customer/business-application-attempts/:key/close | operation/target en JSON; key en ruta; 200 AttemptView |
| GET /admin/customer-business-applications | SUPER_ADMIN, lista/revisión |
| GET /admin/customer-business-applications/:id | SUPER_ADMIN, notas y acceso administrativo |
| POST /admin/customer-business-applications/:id/decision | APPROVE/REJECT, revisiones y key; SUPER_ADMIN |
| GET /admin/customer-business-access/:customerAccountId | Cuenta/grant/revocación para acciones admin |
| POST /admin/customer-business-access/:customerAccountId/revoke | grantId, revisión, motivo y key; SUPER_ADMIN |
| POST /admin/customer-business-access/:customerAccountId/allow-reapplication | revokedGrantId, revisión, motivo y key; SUPER_ADMIN |
| GET /admin/customer-business-application-attempts/:key | operation/customerAccountId/target en query; sólo scope del actor |
| POST /admin/customer-business-application-attempts/:key/close | Mismo scope en JSON; no revierte operaciones aplicadas |
| POST /customer/profile/type | Cambio: descenso PERSONAL con key/expectedRevision, ahora devuelve Receipt; BUSINESS rechazado |
| GET /customer/profile, /customer/capabilities | Añaden customerAccountId, businessAccess y businessApplication |

OpenAPI completo regenerado en [openapi.json](openapi.json); [API_ACCESS](API_ACCESS.md). Contrato público B2B verificado sin regenerar diferencias. Las nuevas rutas sólo existen en este código local: no se afirma disponibilidad en VM.

## Campos y recuperación para Web

`businessAccess`: state, source, restrictionReason, canApply, canDowngrade, reapplicationBlocked. `businessApplication`: id/status/revision o null; PENDING actual o última terminal. No confundir aplicación APPROVED histórica con acceso ACTIVE. El correo verificado se reutiliza; el formulario sólo contiene businessName/activity/city/estimatedDeliveryVolume/note opcional más revisión técnica. Snapshot note ausente se devuelve null. Descenso deja historial y bloqueo administrativo cuando corresponda.

Receipt: key/operation/outcome/code/resourceId/committedAt/result. HTTP409 de precondición durable incluye receipt; errores previos/fallos técnicos lo devuelven null. AttemptView usa NOT_OBSERVED/APPLIED/REJECTED/CLOSED. NOT_OBSERVED no acredita fracaso. GET/close devuelve200 incluso si el recibo original es REJECTED; mutación tardía tras cierre devuelve409. Consultar perfil actual después de recuperar recibo. Sólo metadatos mínimos del intento deben persistirse en Web, nunca formulario completo ni notas.

Paginación: items/total/page/pageSize, sin totalPages. Perfil y capacidades exponen ID en raíz; ausencia de perfil conserva CUSTOMER_ACCESS_DENIED403. No dar acceso por tipo ni usar un gate global que oculte servicios/recuperación/aceptación de MDR comprometidas. Landing todavía debe esperar el destino real confirmado por Web; Driver no requiere nuevos DTO comerciales.

## Persistencia y transición

Migración incremental `20261012000100_business_approval`: 45→46. CustomerAccount agrega estado y bloqueo durable; seis modelos comerciales registran aplicación, grant, evento, recibo, corte y evidencia de admisión. FK/índices parciales/constraints diferidos e historia inmutable acompañan los locks de cuenta/actor/key. Grant y decisión no acreditan pago.

Corte transaccional: BUSINESS existentes pasan a REVIEW_REQUIRED, revision+1, sin crear solicitudes ni grants. MDR abiertas con conversión persistida reciben PRE_REVIEW_COMMITMENT. Futuras conversiones BUSINESS capturan MANUAL_GRANT en la transacción original; aceptación verifica evidencia del recurso y conserva reglas existentes. Personal conserva su cupo/pagador.

El rollout sigue requiriendo retirar escritores antiguos, inventario/backup autorizado y Web compatible; no es un despliegue mixto. No se ejecutó ninguna migración sobre la base principal ni se activó configuración. Mantener TTL originales; no reabrir vencidos.

## Verificación inicial y límites (histórica; cierre final al final del informe)

- Instalación limpia de46 migraciones y upgrade de clon desechable reconstruido a esquema45. No se presenta ese clon como backup real de producción. Comparados63 perfiles y once tablas históricas por cantidad/huella antes/después; sin modificaciones a esas tablas por el corte. Verificado HTTP409 BUSINESS_REVIEW_REQUIRED al crear nueva demanda y HTTP200 al aceptar MDR preexistente. Routing/presupuesto falsos sólo para fixture; HTTP, PostgreSQL, migración y aceptación reales locales.
- Una ejecución completa de cuatro archivos E2E pasó69 pruebas durante esta tarea: business-approval9, customers13, direct-demand30, dispatch-search17. Esta evidencia precede refinamientos finales de SQL/locks/contrato, enumerados en el JSON. No acredita por sí sola el árbol final.
- Una ejecución posterior abortó su worker. Su conteo parcial no se acredita; se retiró un caso auxiliar que sólo exportaba fixture, conservando pruebas funcionales. Ya se había realizado el único diagnóstico adicional permitido; no se repitió diagnóstico. **Pendiente de aquella ejecución, resuelto por la validación final documentada al final de este informe.**
- Tres archivos unitarios completos: prequote-conversion, prequote-orchestration y authorized-acceptance,27 aprobadas. Contrato/firma B2B40 aprobadas; exportador público --check sin diferencias.
- Build, TypeScript sin emit, Oxlint (warning preexistente en verify-authorized-acceptance-c3-regression.mjs), ESLint de archivos afectados, OpenAPI/docs:check y diff. El primer intento de tipos coincidió con regeneración de dist y falló por módulos ausentes; repetición secuencial completa aprobada. Una invocación unitaria bloqueada por permisos de caché no contó; ejecución autorizada completa pasó.
- HTTP final independiente del runner: perfil/grant administrativo, bloqueo retenido, recuperación histórica y falta de Idempotency-Key→400 con receipt:null. Ejemplos obtenidos realmente en base sintética, no respuestas de VM.

Herramienta reproducible: `scripts/verify-business-approval-migration.mjs`. Exige BUSINESS_TEST_DATABASE_URL explícita a PostgreSQL loopback/usuario postgres sin contraseña/base *_test, BUSINESS_TEST_CONFIRM_ISOLATED=yes y opcional BUSINESS_TEST_PG_BIN. Requiere fixtures sintéticos de direct-demand E2E; modifica zonas sólo en esa base de prueba y crea clones con nombres únicos, sin borrar las bases anteriores. No usarla con datos reales. No lee .env ni usa una base predeterminada; preserva historial y logs bajo .tmp/business-migration-*. La ejecución publicada de la herramienta también completó instalación/upgrade y HTTP. No confundir este script con migración operativa de producción.

## Pendientes

Integración Web contra OpenAPI local, confirmación de CTA Landing y coordinación de rollout. No pruebas de VM, Coita, correo real, Google real ni pruebas físicas Android. Sin cambios de versión, .env, flags, commit, push o despliegue. La propuesta comercial ya está aprobada; estos pendientes no reabren esas decisiones.


## 2026-10-12 — Validación E2E final de aprobación Negocio

Solicitud: diagnosticar aborto y completar archivos E2E finales con PostgreSQL aislado, sin commit/push. QA ce45dff y cambios locales comprobados; huellas de producto/tests/migración iguales a la revisión anterior, sin modificar implementación ni pruebas. Build ejecutado antes de E2E.

Una ejecución conjunta terminó con 67 aprobadas y dos fallos de política: dispatch-search persiste límites distintos de direct-demand en PrequoteConsumptionPolicy; checkedPolicy rechaza antes de routing. No se acredita como PASS. Otra ejecución aislada reprodujo salida inesperada del worker comercial antes de pruebas. Se hizo un único diagnóstico adicional instrumentado: los cuatro archivos completos en bases nuevas independientes terminaron con exit0, 69/69 aprobadas, cero fallos/omitidas (business-approval9, customers13, direct-demand30, dispatch-search17). Cada base recibió las46 migraciones. Huella dist idéntica antes/después; no build/docs concurrentes.

Causa del aborto nativo no demostrada: no se obtuvo módulo culpable; la reconstrucción concurrente anterior era un riesgo, pero no explica por sí sola la reproducción. Aislamiento por archivo corrige la interferencia comprobada de fixtures sin relajar protecciones. Evidencia y hashes en docs/checks/business-approval-verification.json; logs retenidos en .tmp/business-e2e-review/diagnostic. Pruebas unitarias27/B2B40, upgrade45→46 y linters/tipos son evidencia de la tarea previa, no repetidos aquí. PostgreSQL aislado detenido al finalizar; bases/logs conservados. Sin principal, Docker, VM, Coita, servicios externos, .env, versión, commit, push o despliegue. Pendientes: integración Web, CTA Landing y rollout autorizado; estabilidad del runner nativo no garantizada.
