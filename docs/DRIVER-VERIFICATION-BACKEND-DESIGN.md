# Validación de repartidores y unidades — diseño backend y contrato candidato

2026-10-13. Rama feature/driver-verification, HEAD de análisis90b7243; producto idéntico a main1fa2cb1,32 migraciones. Sólo diseño, NO API disponible ni OpenAPI publicado. Prevalece técnicamente sobre las rutas tentativas de INDEPENDENT-ONBOARDING-PROPOSAL.md; decisiones de negocio pendientes siguen abiertas. No integra QA.

## 1. Evidencia e invariantes

Archivos inspeccionados en ESTA base:
- prisma/schema.prisma: roles SUPER_ADMIN/PROVIDER_ADMIN/DRIVER (no CUSTOMER); User.emailVerifiedAt existente; Driver.providerId obligatorio; propietarios de Vehicle excluyentes.
- src/auth/auth.guards.ts: AccessGuard relee usuario activo; RolesGuard usa rol vigente, no sólo JWT.
- src/drivers/drivers.service.ts y driver.select.ts: alta con proveedor, activación PENDING→ACTIVE, disponibilidad exige proveedor activo; proyección personal incluye proveedor.
- src/vehicles/vehicles.service.ts: alta permite Vehicle ACTIVE; no aprobación documental.
- src/independent-drivers/independent-drivers.service.ts: aprobación sobre Driver activo, createVehicle usa perfil propio y cuota; comentario declara documentación fuera de alcance actual.
- src/delivery-assignments/delivery-assignments.service.ts: asignación/reasignación bloquean despacho y después proveedor, driver, vehicle; validan estado/ocupación/pareja.
- src/assignments/assignments.service.ts: emparejamiento proveedor→driver→vehicle.
- src/mail/mail.types.ts: invitación y aviso partner, no decisión documental.
- src/idempotency/idempotency.service.ts: clave ligada a IntegrationClient; no reutilizable literalmente para humanos.
- src/common/pagination.dto.ts y http-exception.filter.ts: envoltorios existentes.
- Migraciones20260915000400,20260917000900,20260918001000: FKs/ownership/guards de recursos; resource_owner_guard impide cambiar dueño, independent_driver_profile_guard impide retirar aprobación con asignación activa, delivery_assignment_guard distingue FLEET/INDEPENDENT.
- src/dispatch/operational-tracking.ts: null/LEGACY, sin DETAILED.

No cambiar búsqueda cinco intentos, matching, claim del proveedor, precio, consentimiento, créditos/refunds o B2B. No agregar GPS/hitos/clientes de QA. La nueva política agrega elegibilidad documental a recursos para nuevas asignaciones; no altera la finalización de asignaciones existentes. No presentar toda QA como dependencia.

## 2. Modelo conceptual propuesto

Nombres candidatos, no esquema Prisma ni SQL ejecutable:

| Entidad | Contenido / integridad |
| --- | --- |
| Driver | providerId nullable; usuario único y UUID histórico preservados. null sólo para identidad independiente creada por el alta nueva. No habilitar cambio posterior de dueño. |
| IndependentDriverProfile | Se crea PENDING para alta nueva sin proveedor; no requiere que Driver ya esté ACTIVE. Aprobación administrativa existente debe exigir identidad verificada para recursos sujetos a nueva política. |
| VerificationSubject | Una fila por Driver(identity) o Vehicle(unit), XOR de FK reales, ownerScope PROVIDER/INDEPENDENT, ownerId tipado mediante FK, revision, approvedCaseId, materialVersion, requirementPolicy. Unicidad por recurso. No propiedad resuelta sólo por UUID arbitrario. |
| VerificationCase | subjectId, número de versión, DRAFT/SUBMITTED/APPROVED/REJECTED/WITHDRAWN, datos declarados versionados, policyVersion, presenterUserId, submittedAt, decisión/motivos y actor. Una abierta DRAFT o SUBMITTED por subject. |
| VerificationAttachment | caseId/categoría/versionId, clave privada, bytes/tipo/hash calculados por servidor, estado de carga/análisis, vigencia si aplica. Objeto congelado al enviar. |
| VerificationReview | checklist versionado, actor/fecha, caseVersion evaluada; notas internas separadas. Decisión final una por case. |
| VerificationCommand | actor+ámbito+operation+key únicos, hash canónico, resultado mínimo o CLOSED_NO_EFFECTS; nunca binarios, tokens ni snapshot completo. |
| VerificationEvent | Auditoría append-only de cambios y accesos privados, IDs/fecha/actor/tipo, sin contenidos documentales ni URLs firmadas. |
| VerificationNotification | outbox transaccional con decisión/canal/destinatario únicos, intentos/lease/error seguro, estado de aceptación/entrega distinguido. |
| VerificationPurge | solicitud de baja/titular/alcance, etapas, versiones pendientes, intentos y fecha de conclusión verificable. No cascade a servicios/créditos. |
| DriverRegistrationChallenge | token hasheado, email normalizado, expiración y uso único; sin identidad operativa antes de confirmación. |

No guardar contraseña sin hash ni token raw. Registrar contraseña sólo en confirmación por titular, no guardarla en el desafío. Registro público inicia verificación; confirmación establece contraseña y crea User activo para login, Driver PENDING/OFFLINE y perfil PENDING en una transacción. User.active permite autenticarse, NO operar. Confirmación repetida de desafío consumido nunca vuelve a establecer contraseña ni emite sesión: responde éxito genérico para continuar a login. Desafío no habilita cambiar credenciales de cuenta preexistente.

Correo existente: respuesta pública202 genérica; no convertir roles ni crear Driver para otra persona. Driver autenticado existente usa su identidad; usuarios administrativos mantienen rol. CUSTOMER no existe en main: cualquier análisis previo sobre ese rol es contexto QA, no un permiso a introducirlo.

Nueva unidad se puede crear INACTIVE como recurso pendiente, asociada a perfil PENDING y con VerificationSubject; no esperar aprobación para poder preparar sus documentos. Esto elimina la circularidad de exigir perfil APPROVED antes de cargar unidad. Esa creación debe tener ruta de onboarding específica y cuotas; no abrir indiscriminadamente los endpoints operativos actuales.

## 3. Estados y activación

Case: DRAFT permite editar; SUBMITTED congela campos/adjuntos; APPROVED/REJECTED/WITHDRAWN son terminales. Rechazo/retiro permiten otro case según permisos y rate limit. No REVOKED nuevo inferido; suspensión existente conserva su política.

Estado efectivo por subject: NOT_SUBMITTED, UNDER_REVIEW, APPROVED, REJECTED, EXPIRED o REVALIDATION_REQUIRED; derivado de versión/material/política/decisión, no del último recibo. Crear renovación no invalida automáticamente evidencia aún vigente; cambiar material operativo sí requiere nueva aprobación. Para evitar reemplazos físicos silenciosos, propuestas de cambio permanecen en case y se aplican al aprobar; cambio de placa/serie/unidad en uso no se aplica con asignación activa (409). No editar directamente datos aprobados por otra ruta.

Identidad aprobada habilita el permiso independiente y Driver ACTIVE del alta nueva, manteniendo OFFLINE. Unidad aprobada puede pasar de pendiente INACTIVE a ACTIVE sólo si no hay suspensión/mantenimiento administrativo que deba conservarse. Aprobar evidencia no rehabilita recursos suspendidos por otra causa. Aprobar unidad antes que identidad no permite operación. Flotilla requiere ambas aprobaciones y permisos actuales; no activa proveedor entero.

No usar pérdida de aprobación para cancelar/reasignar servicios vigentes. Vencimiento bloquea sólo nuevo uso si la política finalmente aprobada lo exige. Renovación, migración de existentes y caducidades son pendientes de negocio (§11); no activar automáticamente.

## 4. Autoridad y redacción

| Actor | Lectura / comandos |
| --- | --- |
| Público | Iniciar registro/reenviar/verificar con token; sin expedientes ni consulta por email. |
| DRIVER | Su onboarding y expedientes independientes. Su identidad de flotilla: vista propia redactada; captura de flotilla a cargo del proveedor. Nunca otros Drivers. |
| PROVIDER_ADMIN | Casos de recursos actualmente de su proveedor, membership releída. No decisión, notas internas ni expediente independiente de un conductor dual. |
| SUPER_ADMIN | Bandeja y decisiones de identidad/unidad; acceso a archivos auditado. Aprobar exige checklist vigente, evidencia limpia y versión actual. |
| Integración B2B | Ninguna API/archivo de validación. |

Ownership de subject y ámbito de case se comprueba en cada acceso, incluido replay y descarga. UUID ajeno→404; rol sin capacidad→403. Rechazo público separado de nota interna; respuestas generales no incluyen INE/rostro/URLs. Cache-Control:no-store para expediente/adjuntos/recibos. Datos del revisor sólo admin, no contactos personales a solicitante. Acceso del proveedor a identidad debe tener política de presentación/consentimiento explícita: no adoptar documentos independientes anteriores automáticamente.

## 5. Contrato candidato API

Prefijo /api/v1. UUID válidos; versión entero positivo. Formularios rechazan campos no permitidos (role/status/providerId/approvedAt). Sin cambio de contrato B2B. Paginación existente items,total,page,pageSize,totalPages, pageSize20 máximo100; orden estable createdAt,id. Fechas ISO8601 UTC.

| Método/ruta | Autoridad | Éxito |
| --- | --- | --- |
| POST /independent-driver-registrations | Público, body email/termsVersion/privacyVersion | 202 genérico |
| POST /independent-driver-registrations/resend | Público, email | 202 genérico con rate limit |
| POST /independent-driver-registrations/confirm | token/password; no token en logs | 200 confirmado/continuar login |
| GET /verification-requirements?subjectType=…&vehicleType=… | Autenticado para su ámbito | 200 policyVersion/categorías/límites/checklist público |
| GET /driver/onboarding | DRIVER autenticado, incluso PENDING | 200 resumen/acciones/bloqueos |
| POST /driver/onboarding/vehicles | DRIVER independiente, body campos unidad | 201 recurso INACTIVE sujeto a revisión |
| POST /driver/verification-cases | DRIVER, subjectType/subjectId | 201 borrador propio |
| POST /provider/verification-cases?providerId=UUID | membership, subjectType/subjectId | 201 borrador del ámbito |
| GET /driver/verification-cases | propietario | 200 página propia |
| GET /provider/verification-cases?providerId=UUID | membership | 200 página del proveedor |
| GET /verification-cases/:caseId | propietario/membership/SUPER_ADMIN | 200 vista redactada |
| PATCH /verification-cases/:caseId | presentador autorizado, expectedVersion/data | 200 nueva versión DRAFT |
| POST /verification-cases/:caseId/uploads | DRAFT autorizado; categoría/MIME/tamaño | 201 uploadId/expiración/URL de carga temporal |
| POST /verification-cases/:caseId/uploads/:uploadId/complete | autorizado; expectedVersion | 202 validación/quarantine pendiente |
| DELETE /verification-cases/:caseId/attachments/:attachmentId | DRAFT autorizado, expectedVersion | 200 referencia retirada; purga programada |
| GET /verification-cases/:caseId/attachments | autorizado | 200 metadatos/estado, no URL persistente |
| POST /verification-cases/:caseId/attachments/:attachmentId/access | autorización de lectura vigente | 200 URL temporal/previsualización segura auditada |
| POST /verification-cases/:caseId/submit | expectedVersion | 200 recibo SUBMITTED |
| POST /verification-cases/:caseId/withdraw | expectedVersion | 200 recibo WITHDRAWN |
| GET /admin/verification-cases | SUPER_ADMIN; status/type/provider filtros | 200 página |
| POST /admin/verification-cases/:caseId/decision | SUPER_ADMIN | 200 recibo APPROVED/REJECTED |
| GET /verification-command-attempts/:key?operation=…&subjectId=… | actor/ámbito originales | 200 estado durable mínimo |
| POST /verification-command-attempts/:key/close | actor, operation/subjectId | 200 APPLIED o CLOSED_NO_EFFECTS |
| GET /driver/verification-notifications | propio | 200 página de resultados |
| GET /provider/verification-notifications?providerId=… | membership vigente | 200 resultados del ámbito |

Contrato de baja/purga se describe en §9, no habilitar ruta pública hasta decidir titular/servicio activo. Acceso de adjuntos usa POST para auditar y obtener credencial corta; no tiene idempotencia de negocio que reutilice una URL expirada.

IdentityData candidato: fullName, contactPhone, operatingCity, documentType=INE; no recopilar todos los números del INE por defecto. Adjuntos FACE_PHOTO, INE_FRONT, INE_BACK. VehicleData: type/brand/model/year/plate/serialNumber/declaredOwnerName/ownershipEvidenceType. Adjuntos REGISTRATION_CARD y OWNERSHIP_PROOF; obligatoriedad por tipo se publica en requirements(policyVersion), sin exigir placa a bicicleta. LICENSE obligatorio y vigente para operar unidades motorizadas, según decisión del 2026-10-13; ver sección vigente de licencia. Límite candidato 10MiB por archivo, PDF hasta20 páginas, imagen hasta20 megapíxeles, formatos JPEG/PNG/PDF y máximo10 archivos por case; confirmar operación/infraestructura antes de fijarlos en OpenAPI.

DecisionDto: expectedVersion, decision APPROVE|REJECT, checklistVersion, checks[{code,result:PASS|FAIL|NOT_APPLICABLE,reason?}], publicReason?, internalNote?. REJECT requiere publicReason; APPROVE exige todos los obligatorios PASS (NOT_APPLICABLE sólo si rules permiten), archivos CLEAN y snapshot completo. No poder decidir contra checklist anterior tras cambio de policy sin conflicto y recarga. Longitudes candidatas: motivo2000, nota4000; códigos de checklist acotados del servidor.

Lectura de ejemplo, datos sintéticos (IDs abreviados descriptivos en texto, no UUID de producción):
```json
{
  "subjectType": "DRIVER_IDENTITY",
  "caseStatus": "SUBMITTED",
  "version": 3,
  "verificationStatus": "UNDER_REVIEW",
  "allowedActions": ["WITHDRAW"],
  "blockingReasons": ["IDENTITY_REVIEW_PENDING"],
  "documents": [{"category": "INE_FRONT", "scanStatus": "CLEAN"}]
}
```

DriverSelf conservará campos previos con provider:null explícito para nuevo independiente y añadirá verification:{identityStatus,policyVersion,allowedActions,blockingReasons}. No adjuntos en /driver/me. canTakeServices debe tener semántica documentada: capacidad general derivada de identidad/perfil/ocupación, no garantía de vehículo/crédito ni de oferta concreta; permisos específicos se releen en TAKE. No inventar DETAILED en esta base.

Errores mantienen envelope actual statusCode/code/requestId/message/errors/timestamp/path. Candidatos:400 VALIDATION_ERROR;401 autenticación;403 VERIFICATION_FORBIDDEN;404 VERIFICATION_CASE_NOT_FOUND/ATTACHMENT_NOT_FOUND;409 VERIFICATION_VERSION_CONFLICT, VERIFICATION_CASE_NOT_DRAFT, VERIFICATION_OPEN_CASE_EXISTS, VERIFICATION_DOCUMENTS_PENDING, VERIFICATION_REQUIREMENTS_CHANGED, VERIFICATION_NOT_APPROVED, IDEMPOTENCY_KEY_REUSED, VERIFICATION_ATTEMPT_CLOSED, RESOURCE_HAS_ACTIVE_ASSIGNMENT;413 archivo demasiado grande;415 tipo no permitido;429 con Retry-After;503 STORAGE_UNAVAILABLE. No incluir campos sensibles en messages o trazas.

## 6. Idempotencia, concurrencia y recuperación

Idempotency-Key UUID obligatorio para crear recurso/borrador, editar, completar carga, retirar adjunto, submit/withdraw/decision. Hash canónico de body+operation+target+actor; misma clave distinto cuerpo409. Primer éxito fija recibo mínimo (id/revisión/resultado), mismo intento devuelve recibo sin activar otra vez ni duplicar crédito/unidad/aviso. Autorización se revisa antes del replay; receipt no sustituye GET de estado actual.

GET intento: ABSENT (ausencia no demuestra fracaso), APPLIED (recibo) o CLOSED_NO_EFFECTS. Close y ejecución serializan sobre mismo registro/clave, incluyendo tombstone si no existía; petición tardía cerrada409. Close no retira solicitud ni deshace entrega física. Los clientes conservan sólo clave/target/cuerpo no sensible; si el cuerpo contiene datos sensibles, mantenerlo en memoria y recuperar por consulta/cierre tras reinicio, no persistir INE/fotos. No extender IdempotencyScope B2B fingiendo integrationClientId humano.

Uploads son máquina separada CREATED→UPLOADED→QUARANTINED→CLEAN|REJECTED, con completado idempotente. Clave de objeto única inmutable por intento; complete verifica dueño, generación/tamaño/hash servidor. No confiar en hash cliente. Escaneo fuera de transacción; compare-and-set de uploadVersion impide resultados tardíos sobre archivo sustituido. Submit sólo referencia versión CLEAN fija.

Orden candidato, respetando rutas base: despacho (sólo operaciones existentes) → proveedor si existe → Driver → perfil independiente si procede → Vehicle → subjects ordenados → case → command. Decisiones/ediciones usan el mismo orden de recursos y nunca adquieren después despacho; no necesita locks inversos para comprobar servicio activo porque altas de asignación también bloquean Driver/Vehicle. Preparar matriz de locks de TODOS los writers antes de implementar; la inspección actual no demuestra ausencia de deadlocks. Cierre sólo toma command, no espera recursos. TAKE/assign valida evidencia vigente bajo locks, y el guard SQL de INSERT comprueba identidad/unidad de modo consistente; UPDATE de finalización no exige nueva revisión. Concurrencia decisión/edición/asignación requiere pruebas reales aisladas.

## 7. Archivos privados y notificación

Almacenamiento privado por adaptador a seleccionar; no decisión de proveedor cloud aquí. Cifrado, acceso corto, no URLs permanentes, cuarentena y análisis de contenido real, límites descompresión/dimensiones/PDF; denegar SVG/HTML/ejecutables. No fetch de URL enviada por solicitante. Normalizar previews sin metadatos innecesarios, guardar referencia al original revisado mientras aplique retención. Sin docenas de copias en logs/telemetría/correo. Endpoint de acceso vuelve a consultar rol/ownership y estado de baja. URL firmada emitida puede sobrevivir hasta expirar: usar proxy autenticado si se exige revocación inmediata, decidir antes de prometerlo. MFA/reautenticación de revisor recomendado; no existe soporte acreditado por este diseño.

Decision+audit+outbox en una transacción; worker fuera de ella, lease y reintentos acotados/backoff. Releer destinatario/ámbito antes de enviar. Persistir templateVersion, eventId, estado/error seguro y providerMessageId, sin body privado. Email por Resend HTTPS, nunca SMTP. Deduplicar por evento/canal/destinatario; un timeout externo deja envío incierto y no garantiza exactly-once: diseñar idempotencia del adaptador y reconciliación, sin repetir decisión. Sent=aceptación proveedor; Delivered sólo con evidencia de entrega. UI muestra resultado aunque falle correo. Push Android no incluido.

## 8. Migración y controles para main

Nueva migración posterior a las32 existentes, no las14 QA. Crear tablas/índices/FK y transición providerId nullable, conservar owner_guard y exclusión de propietarios. Constraint trigger diferido para Driver sin proveedor requiere perfil independiente al commit; evitar transacción circular imposible. Revisar composite FKs y SQL NULL con IS DISTINCT FROM; no permitir que NULL convierta ámbito proveedor en wildcard.

Cambios operativos mínimos futuros:
- Alta independiente/vehicles de onboarding sin alterar alta CUSTOMER (no existe).
- Alta flota crea estado documental pendiente; activación administrativa vieja no elude check al uso.
- setOwnAvailability sin proveedor usa User/Driver/perfil y revisión; dual conserva política de proveedor actual, salvo decisión explícita futura.
- Asignación/reasignación, emparejamiento y TAKE comprueban ambos recursos; rutas SUPER_ADMIN también. Vehículo editado fuera de expediente rechaza material changes o crea revisión, nunca mantiene aprobación antigua con datos nuevos.
- No cambia claim del proveedor ni búsqueda. Proveedor puede quedar tomado sin pareja elegible: UI debe advertir y permitir mecanismos existentes, y negocio debe decidir si quiere cambiar claim en otra ampliación. No auto-refund nuevo.
- Al completar servicio existente no validar expediente otra vez ni borrar relaciones históricas.

Migración de existentes no debe inventar aprobación documental. Candidato: identificar LEGACY_REVIEW_REQUIRED con evidencia de origen para inventario, pero regla de bloqueo/gracia pendiente del propietario. No desplegar enforcement global hasta decidir tratamiento; no dejar bypass permanente oculto. Mantener snapshots B2B y ledger intactos. Despliegue coordinado con Web/App por provider:null; rollback a main antiguo no seguro cuando haya registros null. Restauración ensayada aislada y reparación hacia adelante; no ejecutar ahora.

## 9. Baja y retención

Independiente: cuenta vigente conserva archivos; baja revoca acceso y programa purga durable incluyendo versiones/previews/temporales. Rechazo/suspensión no es baja. No eliminar Driver/User por cascade si conservan historial operativo; conservar referencia anonimizada y evidencia mínima de purga no autoriza retener imágenes.

API candidata separada (NO cerrada): POST /driver/account-closure con reautenticación e idempotencia; GET /driver/account-closure antes de revocar sesión o recibo de consulta dedicado de alcance mínimo. Decidir servicio activo y consulta posterior sin reutilizar refresh token revocado. DELETE inmediato de User no es solución.

Flotilla: falta decidir bajas por administrador/conductor/unidad/proveedor y titular de documentos compartidos. Purga no debe borrar otro expediente propietario. Respaldos: definir plazo/método (ciclo acotado o borrado criptográfico), propagación de tombstones al restaurar, verificación final y mensaje honesto al titular. Proveedor de almacenamiento, plazos y política de restauración bloquean cierre de esta parte del contrato. No retener por siempre ni prometer borrado instantáneo.

## 10. Validación futura focalizada

- Registro/confirmación duplicados/expirados/rol existente; cuenta PENDING con login pero sin operación.
- Matriz real de permisos, ownership, descargas cross-tenant, replay tras pérdida membership y sin datos sensibles en DTO/logs.
- Draft/upload/scan/submit; obj ajeno, archivo malicioso/grande, callback tardío, URL vencida, decisión sobre versión vieja.
- Decisión concurrente/replay/close tardío, aprobación sin duplicar cuenta crédito/unidad/outbox, aviso perdido/fallido.
- Identidad/unidad aprobadas separadamente; material edits y vencimiento; rutas actuales de create/update/admin no eluden control.
- Carreras assign/take con decisión/rechazo/edición y SQL directo; independencia null, dual y flota; finalización de servicio activo preservada.
- Cinco intentos completos, B2B contract, crédito/refunds sin cambios; main sólo LEGACY, no pruebas GPS inventadas.
- Migración limpia/upgrade de copia sintética de32, constraints/drift, backup/restore y purga; sin documentos reales.
- Tipos/build/lint y archivos completos afectados cuando se implemente, no suite completa por defecto. Actualmente ninguna prueba funcional acredita el diseño.

## 11. Decisiones pendientes antes de implementar

1. Tratamiento de recursos ya existentes: revisión y gracia/bloqueo, sin aprobación ficticia.
2. Catálogo documental por tipo de unidad, propiedad empresa/terceros, licencia, vencimientos y checklist verificable.
3. Alta Web primero y límites de ficheros propuestos; almacenamiento/análisis/MFA y presupuesto operativo.
4. Política de baja con servicio activo, purga de flotillas y plazo de backups.
5. Notificación al conductor de flotilla además del presentador, destinatarios y reintentos.
6. Matriz de locks/funciones definitivas y contrato Web/App según sus informes. Propuestas de routes/DTO aquí no son promesa de API disponible.

## 12. Evidencia de esta tarea

Lectura de main y contratos/guards/migraciones indicados, búsqueda de definiciones SQL, refs/status, comprobación documental. No auditoría exhaustiva de todas las funciones reconstruidas en PostgreSQL; no SQL ejecutado. No SDK/cloud ni servicios/DB/Docker; sin suites/build, OpenAPI ejecutable, cambios de schema/código/env/versiones. No merge QA, commit ni push. Los resultados históricos en VERIFICATION siguen siendo históricos.
## Informe Android recibido — 2026-10-13

Referencia leída: C:/Users/zorgl/Documents/mandaria-driver/androidApp/DRIVER-VERIFICATION-MAIN-COMPATIBILITY.md. Inspección estática reportada sobre APP QA68ce641; APP main00ade1b no tiene src/real. No se reejecutaron pruebas ni se verificó integración real en esta recepción.

Bloqueos: main take/release devuelven vista de despacho y Android espera recibo QA; TAKE puede confirmar cargo aunque el parser falle. Entrega main usa /deliver, mientras app emite /execution-completion; reconocer LEGACY no prueba operación compatible. Recuperación independent-attempt/assignments-attempt de QA ausente. Lectura/finalización Driver de flotilla requiere contrato explícito; no usar credenciales de proveedor. El controlador main confirma /deliver exclusivo independiente y no exige perfil APPROVED para cierre, pero no equivale a todos los permisos de lectura/recuperación necesarios.

Separar aceptación de onboarding documental de aceptación operativa Android. No habilitar app actual contra main ni resolver incompatibilidades mediante fallback tras escritura, nueva clave o borrado de marcador. Se requiere diseño adicional de adaptador y contrato operativo mínimo durable con garantías de idempotencia/consulta/cierre, limitado a operaciones autorizadas. Los recibos de VerificationCommand propuestos son del expediente y NO solucionan TAKE/RELEASE/DELIVER.

La recomendación del agente de partir de APP QA68ce641 para futura adaptación es una propuesta, no autorización para integrar QA ni selección de rama aprobada. APP main carece de integración operativa según su informe: debe decidirse base cliente explícitamente con el propietario. Backend continúa basado en main. Mantener GPS/DETAILED fuera del alcance backend y no importar clientes/Negocio. Pendiente informe Web y decisión del alcance de compatibilidad operativa; no implementar automáticamente.
## Informe Web recibido — 2026-10-13

Leído C:/Users/zorgl/Documents/mandaria-frontend/docs/DRIVER-VERIFICATION-MAIN-COMPATIBILITY.md. Evidencia estática del agente: Web main06d9766 recomendado como base, QAe303739 observado. No se verificaron HTTP/build ni actualidad remota en esta recepción. No se crea rama ni se autoriza integrar QA.

Web main también contiene rutas/menú de custodia DETAILED y ExecutionRecovery que backend main no soporta. Antes de publicar, limitar rutas/consultas por capacidades explícitas del contrato y aislar marcadores por origen/actor/protocolo; jamás borrar pendientes o interpretar404 como no aplicación. No añadir DETAILED al backend para satisfacer esas pantallas.

Adaptación localizada candidata: provider nullable en DriverSelf y referencias independientes, onboarding fuera del guard operativo APPROVED, estados/expedientes separados por recurso, revisión SUPER_ADMIN. Rutas Web propuestas /driver/register y /driver/onboarding, todavía no implementadas ni publicables en Landing/App. No derivar existencia/autorización de un404 driver/me.

Precisión a reconciliar: Web contempla onboarding sin Driver operativo aún; el diseño backend propone creación atómica de Driver PENDING/perfil PENDING al confirmar email. Ambos deben acordar estados de preconfirmación y postconfirmación, no manejar404 como señal de crear otro perfil. Contratos de adjuntos/decisión/intentos siguen candidatos.

Se recomienda aceptar como dirección Web desde su main con ajustes acotados; la base Android y su compatibilidad operativa requieren decisión aparte. No todos los problemas de Android se trasladan a Web: su portal consume contratos distintos y no utiliza independent-attempt actualmente según informe. Revisión conjunta por endpoint obligatoria, sin concluir compatibilidad global de ningún cliente por esta lectura.
## Almacenamiento elegido y estructura — decisión 2026-10-13

Propietario elige bucket DigitalOcean Spaces y organización por repartidor/unidad. Esto sustituye la elección de proveedor antes pendiente; NO autoriza crear infraestructura ni implementar. Bucket privado, listado privado y objetos privados; sin CDN público para expedientes. Región, nombre, credenciales por entorno y cuotas siguen pendientes. Recomendar bucket separado por entorno; no compartir documentos reales con desarrollo.

Estructura candidata de claves (carpetas lógicas/prefijos, no permisos):

    verification/v1/independents/{driverId}/identity/{caseId}/{attachmentId}/original.jpg
    verification/v1/independents/{driverId}/vehicles/{vehicleId}/{caseId}/{attachmentId}/original.pdf
    verification/v1/providers/{providerId}/drivers/{driverId}/identity/{caseId}/{attachmentId}/original.jpg
    verification/v1/providers/{providerId}/vehicles/{vehicleId}/{caseId}/{attachmentId}/original.pdf
    verification/v1/quarantine/{uploadId}/source

Los identificadores son UUID del servidor. Extensión se determina por contenido validado; nunca usar nombres de persona, email, INE, placa o nombre original de archivo como clave. Adjuntos FACE_PHOTO/INE_FRONT/INE_BACK/REGISTRATION_CARD/OWNERSHIP_PROOF se clasifican en DB; UI presenta nombres comprensibles al autorizado. Derivados bajo el mismo attachmentId (preview.jpg, por ejemplo), nunca sobrescribir original de una versión enviada. Cada reemplazo tiene nuevo attachmentId/caseVersion según contrato.

Unidades de flota dependen del proveedor, no de la carpeta de un conductor: pueden ser utilizadas por distintos repartidores sin duplicar documentos. Perfil dual mantiene ámbitos independiente/flotilla separados; no compartir identidad privada automáticamente entre ambos. El prefijo facilita inventario pero NO concede acceso: autorización por ownership/membership/rol y snapshot en DB antes de cada lectura/carga.

El backend genera claves; cliente no puede elegir bucket/prefijo ni aportar path arbitrario. Guardar bucket/key/objectVersion si aplica, hash servidor, bytes y relación al expediente en PostgreSQL, no URL firmada permanente. Cuarentena privada no descargable por solicitantes; sólo publicar referencia CLEAN tras análisis y copia verificada a destino inmutable. Registrar ambas ubicaciones para reintentos y limpieza de huérfanos, sin depender de rename atómico.

Para baja: inventario por filas/objetos/versiones y derivados; no borrar recursivamente un prefijo tomado del cliente ni toda la carpeta de proveedor por baja de un administrador. Verificar alcance exacto, reintentos y resultado; excluir adjuntos de otros titulares. Respaldos/versionado requieren política específica todavía pendiente. Carpetas no reemplazan bitácora ni validación de propiedad.

Referencias oficiales consultadas: https://docs.digitalocean.com/products/spaces/how-to/set-file-permissions/ (privacidad y acceso temporal), https://docs.digitalocean.com/products/spaces/reference/s3-compatibility/ (API S3 parcial), https://docs.digitalocean.com/products/spaces/how-to/ (organización en carpetas). No asumir todas las funciones AWS S3 ni malware scanning automático por usar Spaces. Sin bucket/keys/cargas reales creados.
## Decisión vigente: existentes sin nuevas asignaciones — 2026-10-13

El propietario aprueba bloquear nuevas asignaciones desde la activación de la revisión, SIN periodo de gracia. Sustituye las menciones previas que dejaban pendiente revisión/gracia de existentes. Aplica a nuevos y existentes, flota e independientes: identidad y unidad deben tener aprobación documental vigente antes de admitir una nueva asignación. No backfill de aprobaciones por estar ACTIVE o tener historial.

Al corte, clasificar existentes no revisados como REVIEW_REQUIRED (etiqueta de transición; mapear explícitamente a verificationStatus del contrato antes de implementar). No confundir esta clasificación con suspensión de User/Driver ni retirar acceso a sesión, expediente, servicio en curso o recuperación. Perfil independiente APPROVED histórico no demuestra validación documental.

Conservar asignaciones ya ACTIVE antes del corte y sus operaciones de cierre/liberación/recuperación autorizadas. No cancelarlas, reasignarlas, iniciar refunds o cambiar precio/créditos por la revisión. Una reasignación crea nueva asignación: sus recursos destino deben estar aprobados, sin terminar la asignación anterior si la nueva operación falla. Un pairing de flota previo no exime de validar al asignar otro servicio. TAKE independiente crea asignación y también queda sujeto a la regla.

Futuro corte durable auditado en backend/DB, no basado únicamente en menú/flag de cliente. Diseñar barrera transaccional que serialice activación y admisión: cada operación queda inequívocamente antes o después del corte. Pruebas de carrera deben demostrar que no se publica una asignación no revisada después de activar. La mecánica exacta de locks/migración sigue siendo trabajo técnico pendiente, no se activó ninguna política ahora.

No modificar claim del proveedor, matching ni cinco intentos por inferencia. Si el proveedor ya tomó un servicio pero aún no lo asignó, no puede asignarlo después del corte sin recursos aprobados; conservar vías de liberación/expiración existentes, sin excepción automática. Advertir esta consecuencia en el rollout y preparar revisores antes de activar. Falta decidir si cambiar claim en otra tarea; la prohibición de nueva asignación queda cerrada.

Validación futura: recurso existente ACTIVE sin documentos rechazado al asignar; sólo identidad aprobada o sólo unidad aprobada insuficiente; ambos aprobados más requisitos actuales habilitan; servicio preexistente termina; reasignación fallida no deja servicio sin responsable; carrera corte/TAKE/assign; proveedor sin pareja revisada no elude; no mutación de rondas, ledger o historial. Sólo diseño, sin implementación ni activación.
## Decisión vigente: licencia para vehículos motorizados — 2026-10-13

El propietario exige licencia de conducir vigente para vehículos motorizados, tanto independientes como flotilla, nuevos y existentes al activar revisión. Sustituye toda mención anterior de licencia opcional o pendiente de decidir. Es política de Mandaria, no una afirmación de requisitos legales exhaustivos.

La licencia pertenece al expediente del CONDUCTOR, no al de la unidad. Incorporar adjunto LICENSE (caras necesarias según documento) y metadatos mínimos de autoridad emisora, categoría, vigencia y versión de evidencia; no exponer número/imagen en vistas operativas. SUPER_ADMIN comprueba titular, legibilidad, vigencia y categoría compatible con la unidad. PROVIDER_ADMIN captura para su conductor pero no valida. Aprobar una unidad no acredita licencia de quien la conduce.

MOTORCYCLE/CAR/PICKUP/VAN/TRUCK requieren licencia revisada y vigente. BICYCLE no motorizada no requiere licencia por esta regla. OTHER o clasificación incierta debe resolverse explícitamente antes de admitir asignación; no constituye excepción automática. No aceptar una unidad motorizada como bicicleta para eludir control. Catálogo exacto categoría-emisor-unidad, tratamiento de licencias sin fecha de expiración y frontera horaria de vigencia aún deben concretarse; los clientes no inventan equivalencias.

La comprobación efectiva corresponde a la pareja conductor-unidad, bajo autoridad backend al asignar/reasignar o TAKE. Incorporar razones candidatas LICENSE_REQUIRED, LICENSE_UNDER_REVIEW, LICENSE_EXPIRED y LICENSE_CATEGORY_MISMATCH; cerrar su envelope HTTP en contrato definitivo. No basta revisar fecha al aprobar: releer vigencia en cada nueva asignación. Si expira, bloquear nuevos servicios motorizados sin impedir terminar el servicio vigente ni convertir expiración en suspensión global de la cuenta. Una eventual asignación no motorizada sigue su propia elegibilidad; no se concede automáticamente.

Renovación crea nueva evidencia/version y revisión SUPER_ADMIN; no sobreescribe el documento aprobado ni concede vigencia por subir un archivo. Mientras evidencia anterior continúe válida, una renovación pendiente no la invalida por sí sola; al vencer no hay gracia implícita. La licencia comparte almacenamiento privado Spaces, acceso mínimo, auditoría y retención/purga del expediente de identidad.

Web: requisito condicional claro según unidad/modalidad, campos/archivo de licencia, motivo y estado de revisión/vencimiento; checklist SUPER_ADMIN y no bypass desde formularios flota. Android: mostrar estado/bloqueo autorizado sin descargar licencia ni activar comandos con caché antigua; mantener recuperación/servicio activo. Backend: requirements por política, DTO de evidencia, elegibilidad bajo locks, pruebas de vencimiento entre lectura y comando. No agregar datos de licencia a B2B ni GPS.

Pruebas futuras: ambos modelos, licencia ausente/vencida/en revisión, categoría incompatible, motor en OTHER sin clasificar, ambas evidencias vigentes, cambio de unidad y vencimiento concurrente, renovación pendiente, bicicleta no motorizada y finalización de servicio previo. Sólo diseño; sin implementar, activar ni probar sobre documentos reales.
## Decisión vigente: terceros y términos obligatorios — 2026-10-13

El propietario admite unidades propias, rentadas y prestadas, y exige firmar términos y condiciones para TODOS, incluidos propietarios. Sustituye recomendaciones anteriores de excluir terceros. No se ha definido todavía el mecanismo jurídico/técnico de firma ni el texto legal final: no afirmar que un checkbox equivale a firma avanzada o prueba suficiente en todo caso.

Distinguir modalidad de tenencia OWNED/RENTED/BORROWED, titular de la unidad, presentador y conductor. Documentación candidata adicional: propia→propiedad/circulación; rentada→contrato vigente que identifique unidad, partes y autorización de uso; prestada→autorización del titular que identifique unidad, beneficiario, uso y vigencia cuando aplique. Catálogo y comprobación de representación/firmas a cerrar; no aceptar como suficiente cualquier PDF. Se mantiene licencia vigente para motorizados. Revisión SUPER_ADMIN comprueba también permiso de uso, no sólo nombre de propiedad coincidente. Nunca clasificar al arrendatario como propietario por conveniencia.

Propuesta de firmantes: conductor independiente acepta personalmente; conductor de flota acepta personalmente sus obligaciones, el administrador no firma por él. Representante autorizado del proveedor acepta condiciones empresariales en su ámbito. Consentimiento de operación Mandaria y autorización del dueño de unidad ajena son evidencias distintas; términos del conductor no otorgan por sí solos permiso del dueño. Aprobación de esta matriz específica de firmantes pendiente del propietario.

Secuencia propuesta: mostrar términos y aviso de privacidad antes de recabar documentos sensibles; tras autenticación/email verificado recoger acto afirmativo no premarcado y guardar evidencia, antes de habilitar carga/envío. En flota, permitir invitación mínima para que el conductor acepte antes de que el proveedor cargue su expediente personal; cerrar tratamiento de invitado y acceso sin Driver operativo, sin fingir aceptación del administrador en su nombre. Aceptación no habilita operación: revisión de identidad/unidad/licencia sigue obligatoria.

Evidencia candidata: actor autenticado, rol/capacidad de representación cuando proceda, versión inmutable del texto, hash del contenido presentado, fecha servidor, finalidad y ámbito (conductor/proveedor), método de aceptación y referencia de solicitud; no guardar sólo true. Publicar texto consultable/descargable y recibo mínimo, no una firma reutilizable en imagen. Texto y mecanismo requieren validación antes de lanzamiento; no se redacta contrato legal en esta tarea.

Backend deberá devolver versión requerida y permisos; rechazar carga/envío/aprobación cuando falte aceptación exigible con TERMS_ACCEPTANCE_REQUIRED; si versión mostrada cambió, TERMS_VERSION_CONFLICT y nueva presentación, sin aceptar silenciosamente. Comando de aceptación con Idempotency-Key y respuesta recuperable, no duplicar evidencia por reintento. No modificar consentimientos B2B/precio/cobro ni reutilizarlos como términos del conductor.

Renovación de términos no obliga por defecto a interrumpir servicios vigentes; política de reaceptación para nuevas operaciones pendiente. Baja/purga de archivos personales no determina automáticamente conservación del recibo contractual: plazo y minimización de esa evidencia se deben cerrar explícitamente, sin retención indefinida inferida.

Web/App: mostrar versión/documento y aceptación pendiente separada del estado documental; Web primero sigue recomendación, nada de biometría/firma dibujada/e.firma añadida por inferencia. Landing explica condiciones sin recabar documentos o aceptar términos de operación en nombre de futuros usuarios. Pruebas futuras: propietario también firma, arrendado/prestado requiere autorización, proveedor no suplanta conductor, versión obsoleta/replay perdido/cambio de cuenta y no nuevas asignaciones sin requisitos. Sólo diseño, sin implementación.
## Decisión vigente: aceptación electrónica Web y firmantes — 2026-10-13

Aprobado por el propietario: texto completo visible en Web, casilla sin premarcar y botón explícito «Aceptar términos y condiciones». Cada conductor acepta personalmente (independiente y de flotilla); representante autorizado acepta por la flotilla. Sustituye menciones anteriores a mecanismo/firmantes pendientes. No se solicita PDF firmado, firma dibujada, biometría ni firma avanzada para esta aceptación. Contratos/autorizaciones de uso de unidades de terceros siguen siendo documentación distinta.

Sesión autenticada e identidad verificada para aceptar; el servidor obtiene actor y ámbito autorizado, nunca acepta un userId del body para suplantar al conductor. Para representación exige membership/capacidad vigente y providerId autorizado; la evidencia vincula usuario y proveedor, no sólo rol. Si una persona actúa en ambos ámbitos, registrar dos aceptaciones independientes. Representante no acepta por conductor y aceptación personal no sustituye la de la flotilla.

UI: mostrar texto completo de versión requerida, acceso posterior al texto y recibo, casilla explícita no premarcada, botón deshabilitado hasta marcar y mientras se envía. No registrar aceptación por abrir página, hacer scroll, iniciar sesión o verificar correo. Accesibilidad teclado/lector; un indicador de scroll no demuestra lectura. Si cambia versión antes de confirmar, conflicto y nueva presentación con casilla limpia. El backend exige accepted=true, versión/hash coincidentes y autoridad actual; el botón no es el control de seguridad.

Persistir texto inmutable/version/hash, actor, ámbito personal/proveedor, capacidad de representación, fecha servidor y método WEB_CHECKBOX_BUTTON. Recibo mínimo con id/version/acceptedAt/scope; idempotencia por intención evita duplicados y permite consulta tras respuesta perdida. No confiar en fecha ni texto aportado por cliente. No sobrescribir aceptación anterior al actualizar términos ni afirmar equivalencia jurídica con firma avanzada; texto contractual final y política de conservación del recibo aún requieren cierre.

Para flotilla: representante acepta antes de presentar expedientes del proveedor; cada conductor invitado acepta antes de que se cargue/envíe su documentación personal. Flujo de invitación mínima sigue permitido, sin aceptar por él. Unidad y conductor deben cumplir además requisitos documentales/licencia y aprobación SUPER_ADMIN. No desbloquear operación por aceptar términos. Renovación de texto/reaceptación no interrumpe automáticamente servicio ya asignado; regla de nuevos cambios de versión pendiente.

Web es la superficie de aceptación; Android abre Web por entorno y consulta estado backend al volver, sin inferir aceptación por retorno ni reutilizar token por URL. Landing sólo informa/enlaza, no recoge estas aceptaciones operativas. Pruebas futuras: casilla vacía, actor ajeno, representante sin membership, ámbitos separados, versión concurrente, replay/timeout, consulta de recibo y rechazo de carga sin aceptación. Sólo documentación; no implementación ni pruebas de producto.
## Actualización de implementación — 2026-10-13

El backend local autorizado se describe en [DRIVER-VERIFICATION-IMPLEMENTATION.md](DRIVER-VERIFICATION-IMPLEMENTATION.md), con rutas efectivamente implementadas, límites y handoff. Las rutas candidatas/secciones de diseño anteriores quedan como historia; no confundirlas con el contrato final. Web/App no fueron implementados. Baja/purga, textos definitivos e integración real siguen pendientes; producción no habilitada.
