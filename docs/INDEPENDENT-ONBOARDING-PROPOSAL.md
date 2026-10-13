# Registro independiente sin proveedor — propuesta

> Base vigente: feature/driver-verification desde main 1fa2cb1, 32 migraciones. QA 9ad39b9 es referencia histórica de diseño, no dependencia integrada. Leer DEPENDENCIES-DRIVER-VERIFICATION.md antes de usar contratos de QA; GPS, hitos DETAILED, clientes directos y aprobación Negocio no existen en esta base. Sólo documentación, sin implementación.

Fecha: 2026-10-13. Backend QA `9ad39b9`. Estado: análisis documental, no implementado. Autorizado: diseñar alta sin proveedor y aprobación exclusiva SUPER_ADMIN. Las decisiones recomendadas de este documento requieren confirmación antes de convertirlas en producto.

**Alcance vigente ampliado:** el propietario exige el mismo expediente y validación manual para repartidores y unidades de flotilla. §11 prevalece sobre referencias anteriores a dejar el alta de flotilla sin cambios. Se conserva el nombre del archivo para continuidad; ahora abarca ambos modelos.

## 1. Evidencia y alcance

Fuentes backend leídas: `prisma/schema.prisma`, `src/drivers/drivers.service.ts`, `src/drivers/driver.select.ts`, `src/independent-drivers/independent-drivers.service.ts`, `src/independent-drivers/independent-dispatches.service.ts`, `src/independent-drivers/independent-driver-policy.ts`. Se inspeccionaron referencias de migraciones; no se auditó exhaustivamente cada trigger.

Fuentes externas consultadas en sólo lectura:
- Web: `../mandaria-frontend/src/drivers/pages.tsx`, `src/driver-portal/pages.tsx`, `src/driver-portal/types.ts` (las dos últimas relativas a Web).
- App: `../mandaria-driver/README.md`, `androidApp/src/real/kotlin/driver/mandaria/mx/DriverApi.kt`, `RealMandariaApp.kt` (relativas a Driver).

Hallazgos:
- `Driver.providerId` y su relación son obligatorios. `IndependentDriverProfile` añade una capacidad a un Driver existente; no sustituye ese vínculo.
- `IndependentDriversService.approve` sólo habilita Drivers ACTIVE con User activo/rol DRIVER; crea directamente APPROVED, sin registro público. SUPER_ADMIN administra esta capacidad.
- `setOwnAvailability` bloquea proveedor y exige que esté ACTIVE para disponibilidad distinta de OFFLINE. Por tanto, la dependencia actual no es únicamente de alta.
- TAKE independiente usa perfil aprobado, Driver activo, vehículo propio y exclusión de ocupación; crea DeliveryAssignment con providerId null. Ya existen cuenta de créditos y vehículos del perfil independiente.
- Web administra altas/invitaciones de repartidores dentro de un proveedor. Su contrato DriverSelf tipa `provider` como objeto obligatorio.
- Android real ya lee `provider` con optJSONObject y presenta flotilla sólo si hay nombre; tolerar null no acredita que todo el flujo esté preparado. Tiene toma/liberación independiente, ejecución y GPS, pero el registro/revisión propuestos necesitan flujo nuevo.

Objetivo: permitir una persona con identidad DRIVER y sin proveedor, revisada por SUPER_ADMIN, usando la operación independiente existente. No crear proveedor ficticio, no otorgar membership administrativa ni convertir al conductor en empresa. No cambiar B2B/Coita, precios, créditos, hitos, GPS ni cinco intentos de búsqueda.

## 2. Diseño recomendado

Separar tres conceptos: identidad autenticada, solicitud de habilitación y permiso operativo vigente. No deducir aprobación del rol DRIVER, de verificar correo ni de tener vehículo.

Flujo propuesto:
1. Registro con email/contraseña y verificación de correo; sin aceptación de providerId, role, status o approval desde el cliente.
2. Crear User DRIVER y Driver PENDING/OFFLINE sin proveedor después de verificar identidad; crear perfil independiente PENDING. Acceso sólo a su registro/solicitud y sesión, nunca ofertas, GPS o servicios nuevos.
3. Completar datos y expediente privado (rostro, INE, unidad y acreditación de propiedad), finalizar cargas y enviar solicitud; SUPER_ADMIN revisa la versión congelada del expediente.
4. Aprobar en una transacción: solicitud aprobada, perfil APPROVED y Driver ACTIVE para nuevos independientes. Disponibilidad permanece OFFLINE. Usar la creación existente de cuenta de créditos sin regalar saldo ni duplicar cuentas.
5. La aprobación habilita únicamente la unidad revisada mediante creación/vinculación idempotente; el aprobado aún debe cumplir elegibilidad/créditos de cada servicio. Aprobar no asigna un servicio ni activa ubicación. Cambiar unidad o documentos materiales requiere nueva revisión, no hereda aprobación.
6. Registrar resultado y notificación durable; recomendar correo mediante Resend y estado/notificación dentro del portal. El fallo del correo no revierte ni repite la decisión. Push Android es una ampliación a evaluar, no soporte acreditado.

Para Driver de flotilla existente: reutilizar su identidad y perfil, sin borrar providerId ni cambiar estado/autoridad de flotilla. Habilitar independencia sigue siendo una capacidad adicional. No migrar automáticamente existentes a revisión ni suspender aprobados actuales; esa política sería una decisión separada.

## 3. Estados, decisiones y formulario candidato

Solicitud separada del permiso operativo:
- DRAFT → SUBMITTED → APPROVED o REJECTED.
- DRAFT/SUBMITTED → WITHDRAWN por propietario.
- Aprobación, rechazo y retiro terminales; nuevas solicitudes crean otro registro, sin reescribir historial.
- Perfil conserva PENDING/APPROVED/SUSPENDED/REJECTED actuales. Retirar solicitud pendiente no suspende un perfil aprobado. Suspensión operativa conserva sus restricciones actuales ante servicios activos; no termina asignaciones ni elimina custodia.

Recomendación: permitir nueva solicitud tras rechazo/retiro con límite de frecuencia; suspensión sólo se levanta por SUPER_ADMIN, nunca reenviando un formulario. Una sola solicitud abierta por Driver. Detalles de readmisión requieren aprobación comercial, no heredar silenciosamente la política de cuentas Negocio.

Formulario revisado por solicitud del propietario: nombre, teléfono de contacto, zona donde pretende operar, foto de rostro, INE y datos/documentos de la unidad que acrediten propiedad. Proponer INE frente/reverso y unidad con tipo, marca, modelo, año, placa y número de serie según aplique; definir documentos aceptables y excepciones antes del contrato definitivo. Recomendar licencia vigente y tarjeta de circulación para unidades motorizadas, sujetas a política explícita por tipo de vehículo, sin afirmar requisitos legales con este diseño. Términos y aviso de privacidad versionados. Email verificado no acredita identidad personal; teléfono declarado no acredita verificación telefónica. Zona declarada no concede cobertura. Sin antecedentes, datos bancarios ni biometría automatizada añadidos por inferencia.

Email ya existente: login/recuperación, sin duplicar cuentas ni revelar existencia en respuesta pública. Driver existente puede solicitar capacidad. Cliente o administrador con el mismo email: rechazar conversión automática de rol; el modelo actual usa rol único. Proponer flujo separado de revisión/multirrol antes de soportar ese caso, sin exigir una segunda identidad como solución permanente.

## 4. Cambios backend previstos

Migración futura (no creada aquí):
- Driver.providerId/relación nullable, preservando todas las relaciones existentes y sus UUID. No separar Driver en otra entidad porque servicios, GPS, créditos y auditoría ya referencian Driver.id.
- Solicitud con propietario Driver, estado, versión, contenido revisado, fechas, decisión/actor/motivo y evidencia de términos. Auditoría append-only; unicidad parcial de solicitud abierta. Separar motivos internos del texto visible al solicitante.
- Integridad de alta: un Driver sin proveedor sólo nace mediante el flujo independiente, con perfil creado atómicamente. Diseñar constraint trigger diferido si se exige existencia cruzada al commit; un CHECK no puede validar otra tabla. Mantener XOR/FK de vehículos/asignaciones y evitar que NULL eluda reglas FLEET.
- Revisar TODOS los triggers vigentes, funciones, JOIN internos, FK compuestas y auditorías que presuponen providerId. Los JOIN a proveedor no deben ocultar al independiente en consultas personales o administrativas.

Servicios afectados:
- Registro/verificación, hash de credenciales y Resend: reutilizar infraestructura segura, pero no el alta CUSTOMER que concede otro rol. Rate limit, respuesta pública genérica, tokens de verificación de un uso y expiración; no activar cuenta operativa al confirmar email.
- DriverSelf: provider null explícito; estado de onboarding accesible para pendientes. DTO/OpenAPI/clientes deben reflejar nullable. No confundir ausencia legítima con error de lectura.
- Disponibilidad: rama independiente sin lock de proveedor inexistente, validando User/Driver/perfil; rama de flotilla conserva política vigente. No cambiar de manera incidental el comportamiento de perfiles duales ligados a flotilla; explicitar su política antes de ampliar esa autonomía.
- Rutas provider-scoped siempre requieren membership y vínculo real; null nunca significa todos los Drivers. Provider admin no revisa solicitudes independientes ni ve sus documentos.
- Aprobar existente no debe activar Driver suspendido por otra razón. Separar aprobación del permiso independiente de rehabilitación global.
- Mantener locks y autoridad de TAKE/release/entrega; revisar elegibilidad y SQL ante null sin reescribir la operación. Continuidad de asignación/custodia/GPS no debe quedar condicionada al estado del formulario.

Contrato candidato, NO publicado (prefijo `/api/v1`):

| Método/ruta propuesta | Actor | Resultado |
| --- | --- | --- |
| POST /independent-driver-registrations | Público | 202 genérico; inicia verificación |
| POST /independent-driver-registrations/confirm | Token de verificación | Confirmación idempotente de identidad pendiente |
| GET /driver/independent-onboarding | DRIVER propietario | Perfil, solicitud vigente, bloqueos y acciones permitidas |
| POST /driver/independent-applications | DRIVER propietario | Envía solicitud validada |
| GET /driver/independent-applications | DRIVER propietario | Historial paginado propio |
| GET /driver/independent-applications/:id | Propietario o ruta admin equivalente | Detalle redactado por actor |
| POST /driver/independent-applications/:id/withdraw | Propietario | Retira solicitud abierta |
| GET /admin/independent-applications | SUPER_ADMIN | Bandeja filtrada/paginada |
| GET /admin/independent-applications/:id | SUPER_ADMIN | Contenido a revisar e historial |
| POST /admin/independent-applications/:id/approve o /reject | SUPER_ADMIN | Decisión atómica y auditada |

El guard de onboarding debe permitir DRIVER pendiente sin exigir perfil APPROVED. El guard operativo continúa exigiéndolo. Decisiones usan expectedVersion e Idempotency-Key: mismo cuerpo/clave devuelve recibo, otra decisión concurrente 409. Autoridad siempre releída en servidor, no confiada a JWT antiguo. El token verifica autenticación, no aprobación vigente.

Antes de implementar, cerrar DTO/status/errors y mecanismo durable de consulta/cierre de intentos para submit/withdraw/decisión. Reusar el patrón comercial existente, no sus permisos ni tablas de negocio. Un timeout no crea segunda solicitud ni nueva aprobación; recibo histórico no reemplaza el estado vigente. No almacenar contraseña/tokens/documentos personales en marcadores cliente. Auditoría sin secretos.

## 5. Impacto Web

- Ruta pública de alta independiente con verificación y acceso a solicitud; no reutilizar formulario de proveedor como si fuera equivalente.
- Área de solicitud/estado/historial para DRIVER pendiente, fuera del guard de portal operativo APPROVED. UI de motivos y corrección tras rechazo.
- Bandeja y detalle SUPER_ADMIN con revisión y confirmación de decisión, recuperación de respuesta perdida y refresco del estado vigente.
- Tipos DriverSelf.provider nullable y UI «Independiente», sin pedir escoger proveedor; ocultar acciones de flotilla cuando no hay vínculo.
- Mantener formularios e invitaciones provider-scoped existentes para flota. No permitir providerId arbitrario desde nueva alta.
- Portal independiente sólo opera según permisos/estado backend. La solicitud pendiente no bloquea recuperación de servicios previamente comprometidos de perfiles existentes.

## 6. Impacto Android

- Recomendación inicial: CTA «Quiero ser repartidor independiente» hacia Web configurada, con retorno a app/login; evita dos formularios de alta distintos. URL por entorno, sin producción fija. Esta elección requiere aprobación.
- Pantalla propia de onboarding pendiente/rechazado/suspendido y actualizar estado; no tratar pendiente como fallo de sesión ni como flotilla faltante.
- Revisar DTO, caché, navegación y disponibilidad para provider null, además del parser ya tolerante. Distinguir estado desconocido/error de no tener proveedor.
- Aprobado sin flotilla usa vehículos propios y toma existente; mantener confirmaciones, marcadores de intentos, recuperación tras muerte de proceso y exclusión de conductor ocupado.
- No iniciar GPS por registrarse/aprobarse/ponerse disponible; conserva inicio explícito y autoridad del servicio actual. Logout/cambio de cuenta no filtra estado/documentos de otra solicitud.
- Android real es el alcance observado; no acreditar soporte iOS con esta inspección.

## 7. Validación y despliegue futuros

Backend: registro/verificación/duplicados/rate limits; pendiente sin TAKE; aprobación sólo SUPER_ADMIN; rechazo/retiro/readmisión; concurrencia aprobación/retiro y replay perdido; constraints SQL directos; disponibilidad sin proveedor; aislamiento provider-admin; permisos con tokens antiguos; una sola cuenta crédito y cero saldo nuevo implícito.

Regresión: flota sin cambios, perfil dual existente, independiente sin proveedor con vehículo propio, toma/liberación/entrega y GPS; continuidad ante incidencias/suspensión; carreras CLAIM/TAKE; búsqueda cinco intentos, ventanas/historial intactos; contratos B2B sin cambio semántico. No probar sobre servicios reales.

Web/App: null explícito, pendiente con sesión válida, rechazo, aprobación con caché antigua, permisos desconocidos, cambio de cuenta, respuesta perdida, móvil/teclado; Android proceso muerto y navegación de verificación. Integración real en PostgreSQL aislado con cuentas sintéticas y correo de prueba controlado. Pruebas completas de archivos afectados y build/tipos/lint; suites adicionales sólo por dependencia demostrada.

Orden recomendado: cerrar decisiones y OpenAPI candidato → implementar backend/migración y pruebas aisladas → adaptar Web y app para null/pendientes → probar conjunto → migrar y habilitar alta coordinadamente. No habilitar altas sin actualizar consumidores. No revertir a binario que presupone proveedor una vez existan Drivers null; recuperación preferentemente hacia adelante. Ensayar backup/restauración y revisar inventario antes de rollout.

## 8. Pendientes para aprobación

1. Documentos requeridos confirmados: rostro, INE, datos de unidad y prueba de propiedad. Pendientes: formatos de prueba aceptados, vigencias, licencia/circulación por tipo de unidad, plazo de retención y tratamiento de cambios/vencimientos. Ver §10.
2. Nueva solicitud tras rechazo/retiro y política de suspensión (propuesta en §3).
3. Primera alta desde Web con enlace Android, o registro nativo también (recomendado Web primero).
4. Cómo tratar usuarios existentes con rol CUSTOMER/admin y futura afiliación/desafiliación de flotilla. Se recomienda dejarlos fuera de esta primera implementación, con mensaje explícito; no migración automática ni cambio de rol.
5. Contrato durable exacto, reglas de identidad/duplicados, restricciones de DB y auditoría completa de triggers antes de código.

## 9. Handoff por proyecto

### Recomendaciones concretas para cerrar pendientes — 2026-10-13

Son recomendaciones listas para revisión del propietario, no decisiones comerciales aprobadas ni contrato publicado.

1. **Formulario con expediente (reemplaza recomendación inicial sin adjuntos):** datos personales, rostro, INE, datos de unidad y prueba de propiedad, con revisión SUPER_ADMIN previa a habilitación. El usuario confirmó esta ampliación documental; formatos, vigencias y retención siguen pendientes. Ver §10. No se afirma autenticidad garantizada por recibir archivos.
2. **Rechazo y retiro:** permitir corregir y enviar nueva solicitud inmediatamente, manteniendo historial y una sola abierta. Separar límite antiabuso de una espera comercial: el backend puede devolver 429/Retry-After, sin inventar castigo de días. Motivo de rechazo visible al propietario y nota interna separada. No editar la solicitud ya enviada: retirar y presentar otra. Suspensión sólo se rehabilita por SUPER_ADMIN y conserva el bloqueo actual si hay asignación activa; no introducir revocación destructiva.
3. **Web primero:** formulario completo en Web responsive; Android abre esa Web por URL configurada por entorno. Retorno manual a app/login en la primera entrega; enlace profundo automático opcional posterior con diseño validado. Nunca tokens o credenciales en URL. Android ofrece estado y actualización autenticados, sin segundo formulario ni decisiones administrativas.
4. **Identidad existente:** reutilizar Driver existente, conservar perfil dual/flotilla y no obligarlo a repetir registro. Correo con otro rol dirige a login/soporte sin cambio automático de rol. No permitir segunda cuenta con mismo correo ni recomendar duplicación para eludirlo. Multirrol, afiliación/desafiliación y autonomía de perfiles duales respecto de suspensión de flotilla son alcance posterior explícito; no cambiar sus reglas actuales incidentalmente.
5. **Aprobación y crédito:** exclusivamente SUPER_ADMIN; nuevo Driver queda ACTIVE y OFFLINE, perfil APPROVED, cuenta propia sin saldo regalado. Mantener requisitos actuales de vehículo, crédito y elegibilidad; no suscripción ni cobro nuevo. Pendiente no recibe ofertas/GPS. Una solicitud no restringe la ejecución autorizada de servicios existentes.
6. **Cierre técnico previo a implementación:** backend debe publicar DTO/errores/rutas definitivos, lectura de permisos vigentes, provider nullable explícito, recibos y consulta/cierre durable para comandos, y auditoría de triggers/locks. Verificación de correo repetida debe ser segura sin crear duplicados ni volver a emitir credenciales. Web/App no deben inventar esos contratos. Cerrar mediante revisión documental, luego autorización independiente de implementación.

Prompts completos de análisis: [Web](INDEPENDENT-ONBOARDING-PROMPT-WEB.md) y [Android](INDEPENDENT-ONBOARDING-PROMPT-APP.md). No se enviaron a otros agentes.

Backend: validar este diseño contra todos los guards/triggers y cerrar contrato de estados, null, errores, idempotencia y recuperación; no entregar sólo un cambio nullable. Preservar ejecución y datos históricos.

Web: inventariar rutas/guards, proponer pantallas públicas/pendientes/SUPER_ADMIN y consumo del contrato; eliminar supuestos de proveedor obligatorio sólo donde corresponde. No inventar aprobación ni habilitar TAKE localmente.

App: inventariar navegación, DriverProfile, disponibilidad y recuperación; proponer enlace de alta y pantalla de estado; demostrar que null no rompe ejecución/GPS. No cambiar endpoint real ni flags para simular aprobación.

Estos handoffs son instrucciones para una etapa posterior aprobada, no autorizaciones de implementación o mensajes a agentes.

## 10. Expediente privado y revisión manual — revisión 2026-10-13

### Precisión del propietario: circulación y conservación

Actualización vigente: se solicita tarjeta de circulación además del expediente de identidad y propiedad. Para el formulario, distinguir «Tarjeta de circulación» (datos del registro, placas y unidad) de «Comprobante de propiedad» (proponer factura/CFDI o carta factura, con documentación de transmisión cuando proceda). La tarjeta no sustituye por sí sola la revisión de propiedad. Contrastar nombre, placa y serie entre los documentos; diferencias impiden aprobación automática y requieren resolución documentada del revisor. La lista de comprobantes alternativos aceptados y unidades sin placas sigue pendiente, sin aceptar cualquier archivo por su nombre.

Referencia oficial consultada el 2026-10-13: [trámite de placas y tarjeta para vehículos usados](https://www.gob.mx/public/tramites/detalleTramite.xhtml?homoclave=SH-2021-3178-009-A) enumera factura/CFDI, carta factura y otras evidencias de propiedad. Es referencia de nomenclatura; no convierte a Mandaria en autoridad verificadora ni determina por sí sola su catálogo interno.

**Conservación decidida por el propietario:** mantener archivos del expediente mientras la cuenta exista y eliminarlos cuando su titular se dé de baja. Incluye foto de rostro, INE, propiedad, tarjeta de circulación y sus versiones/derivados. Suspensión o rechazo de solicitud no son baja de cuenta. Un registro residual para integridad referencial no autoriza conservar archivos después de la baja.

Diseñar solicitud autenticada de baja, retiro inmediato de acceso a documentos y trabajo durable/idempotente de purga con reintentos; registrar pendiente/completada/fallida y confirmar eliminación sólo al comprobarla. Inventariar objetos originales, versiones del almacenamiento, miniaturas, temporales, cachés y respaldos. No prometer borrado instantáneo de backups: definir antes de implementar eliminación criptográfica o ciclo de expiración acotado y prevención de reaparición al restaurar. Este plazo técnico queda pendiente y debe informarse al usuario; no significa conservar indefinidamente. Mantener sólo evidencia mínima de la purga, sin imágenes, números de INE o datos documentales innecesarios.

La baja no debe borrar por cascada servicios, custodia o movimientos de crédito. Diseñar por separado cómo concluir obligaciones operativas de una cuenta con servicio en curso, sin usar eso como autorización implícita para retener documentos indefinidamente. La política de archivos no decide por sí sola el plazo del resto del historial operativo. Validar compatibilidad de la política con obligaciones aplicables antes del lanzamiento; no se establece aquí una excepción legal ni retención adicional automática.

### Alcance confirmado y criterio de aprobación

El propietario pide recabar datos del conductor, foto de rostro, INE, datos de unidad y comprobante de que es propia, someterlos a solicitud con aprobación/rechazo administrativo y notificar el resultado. Se conserva SUPER_ADMIN como único revisor/aprobador según acuerdo anterior; no extender a PROVIDER_ADMIN por el uso coloquial de ADMIN.

Revisión manual con checklist versionado: legibilidad/completitud, concordancia de nombre y rostro entre documentos, coincidencia de placa/serie/unidad y cadena de propiedad, vigencia de documentos que la tengan. Registrar cada resultado, observaciones y revisor. Documento ilegible, inconsistente o prueba insuficiente impide aprobar; motivo de rechazo comprensible al solicitante, separado de notas internas. No presentar esta revisión como autenticación oficial de INE, prueba de vida o garantía antifraude. Una foto sola no demuestra que la persona esté presente; liveness/consulta oficial/OCR automático no están incluidos ni deben simularse.

La evidencia de propiedad aceptada (factura, cesión/endosos u otros comprobantes) requiere catálogo aprobado por el negocio. No aceptar automáticamente cualquier PDF como propiedad válida. El caso de unidad prestada/arrendada queda pendiente: la petición actual exige propia. No asumir que bicicleta y motocicleta requieren exactamente los mismos campos/documentos.

### Protección y almacenamiento propuestos

- Archivos fuera de tablas operativas y del bucket público: almacenamiento privado cifrado, identificadores opacos y autorización por propietario/solicitud y SUPER_ADMIN. Proveedor, cliente y otros conductores no acceden. Sin rostro/INE en perfil público, tracking, logs, correo ni analítica.
- Carga autenticada a borrador, cuotas por usuario y límites explícitos de bytes/páginas/dimensiones; formatos acotados (propuesta JPEG/PNG/PDF), validación de contenido real, cuarentena/análisis de archivos y previsualización segura. No confiar en extensión/MIME declarado. No permitir aprobación con cargas pendientes o cuarentena fallida; no fetch arbitrario de URLs entregadas por usuario.
- Modelo candidato de adjunto: applicationId, categoría, versión, clave privada, hash, tamaño, tipo validado, fecha, estado de análisis y vigencia cuando corresponda. Confirmar que objeto subido pertenece al usuario/solicitud; una URL firmada no permite sustituir adjunto de otro expediente. Accesos temporales cortos, no persistir URLs firmadas en localStorage ni logs.
- Al enviar, congelar contenido y versiones/hash de evidencias; aprobación refiere exactamente ese snapshot. Sustitución exige otro borrador/solicitud; nunca sobrescribir evidencia revisada ni validar una versión distinta de la vista por el revisor. Locks/expectedVersion para carreras entre retiro, decisión y sustitución.
- Historial append-only de envío, revisión, decisión y cambios; auditoría de consultas/descargas de documentos con actor/fecha/finalidad. Bitácora almacena referencias/metadatos, no copias de documentos ni secretos. El historial no obliga a guardar imágenes indefinidamente.
- Definir aviso de privacidad, finalidad, acceso y plazo de conservación/eliminación antes de lanzamiento, incluyendo rechazados, borradores abandonados, respaldos y temporales; no proponer conservación perpetua. Borrar archivos según política conservando evidencia mínima de decisión/purga. No se ofrece una conclusión legal en esta propuesta.
- Recomendar reautenticación y MFA del revisor para acceder al expediente/decidir; comprobar soporte antes de prometerlo. Cambios de sesión eliminan previews/archivos temporales del cliente. No recoger documentos reales durante pruebas.

### Decisión, vehículo y notificación

La aprobación debe enlazar la unidad revisada con Vehicle y el perfil sin duplicación en reintentos. Un rechazo no concede permisos ni crea unidad operativa activa. No dejar un endpoint de alta/edición de vehículo que permita al nuevo independiente sustituir placa/serie/propiedad aprobadas y eludir revisión: inventariar todas las vías antes de implementar. No imponer retroactivamente esta política a existentes sin decisión de migración específica.

Decisión y evento de notificación se guardan en la misma transacción; worker envía posteriormente por Resend HTTPS con reintentos y deduplicación por decisión/canal. Registrar pendiente/enviado/fallido y diferenciar aceptación del proveedor de entrega efectiva. Reenvío no repite aprobación. Email incluye resultado, referencia y enlace autenticado, sin adjuntos ni detalles sensibles; rechazo detallado se consulta dentro del portal. Estado visible en Web/app es autoridad aunque el correo falle. Notificación interna se propone como registro persistente; push requiere inventario de infraestructura y aprobación de alcance.

Caducidad documental, sustitución de unidad y necesidad de renovación deben tener política propia antes de habilitar operación: recomendar impedir NUEVAS tomas si falta aprobación vigente de la unidad, preservando entrega/custodia/recuperación del servicio en curso. No implementar bloqueos automáticos ni extenderlos a existentes en esta tarea.

### Impacto de contratos y validación

Contrato candidato anterior es incompleto para esta ampliación: se necesitan borrador persistente, carga/inicialización/finalización/eliminación en borrador, consulta autorizada de adjuntos, metadatos de revisión y notificaciones. Diseñar rutas/DTO/error/idempotencia con backend, sin inventarlas en clientes. No enviar binarios/base64 en recibos de operaciones ni en respuestas operativas DriverSelf.

Web: wizard de datos/rostro/INE/unidad/evidencias/resumen; reanudar borrador, progreso/reintento y errores de carga; revisión SUPER_ADMIN segura y checklist. No autosave de documentos sensibles en almacenamiento del navegador. Android sigue Web primero propuesto, con cámara/selector del navegador cuando esté disponible y alternativa de selección; si se requiere captura nativa debe aprobarse/diseñarse por separado. Estado y resultado disponibles en app; no incorporar documentos al caché operativo/GPS.

Pruebas futuras adicionales: acceso cruzado/URL caducada, usuario sin verificar, archivos inválidos o peligrosos, cuota/tamaño, objeto ajeno, sustitución después de envío, doble decisión concurrente, repetición de aprobación y creación de vehículo, fallos/doble envío de correo, persistencia del resultado sin correo, rechazo y nueva solicitud, cambio de cuenta, borrado/retención y no filtración en logs/DTO. Datos sintéticos únicamente.

## 11. Validación común de identidad y unidades de flotilla

### Decisión del propietario — 2026-10-13

Los mismos datos y documentos se solicitan para independiente y flotilla. En independiente los captura el solicitante; en flotilla los captura el administrador del proveedor dentro de su ámbito. Sólo SUPER_ADMIN valida manualmente identidad del repartidor y cada vehículo. Capturar, invitar, verificar correo o crear el recurso no lo aprueba.

| Expediente | Contenido común | Captura | Decisión |
| --- | --- | --- | --- |
| Identidad de repartidor | Datos personales, foto de rostro, INE y requisitos complementarios que se acuerden | Independiente o PROVIDER_ADMIN de su flotilla | SUPER_ADMIN |
| Unidad | Datos identificadores, tarjeta de circulación y comprobante de propiedad | Independiente o PROVIDER_ADMIN de su flotilla | SUPER_ADMIN |

En flotilla no exigir que el vehículo sea propiedad personal del repartidor. Verificar titular documentado y vínculo con el proveedor; persona física/moral, representante, unidad de tercero o arrendada requieren catálogo de evidencia y política explícitos. No asumir que captura del administrador demuestra propiedad ni autoriza uso de documentos personales. Registrar titular del expediente y actor que lo presenta, y diseñar información/aceptación del conductor sobre el tratamiento de sus datos.

### Revisiones independientes y permisos

- Separar expediente de identidad (Driver) y expediente de unidad (Vehicle), con versiones/decisiones propias. Una flotilla puede tener varios conductores/unidades: aprobar uno no aprueba los demás ni al proveedor entero.
- Estado documental distinto de ACTIVE/OFFLINE y del estado comercial del proveedor. Crear nuevo recurso pendiente es posible; habilitar operación requiere revisión aprobada vigente y requisitos operativos actuales. No reutilizar APPROVED de perfil independiente como aprobación documental de toda la flotilla.
- PROVIDER_ADMIN sólo crea/consulta/corrige/envía expedientes autorizados de su proveedor; jamás aprueba, cambia resultado o modifica snapshot enviado. SUPER_ADMIN conserva decisión, motivo, revisor y fecha.
- Definir acceso del conductor a sus propios documentos; no dar al proveedor acceso a documentos de otras flotillas, expedientes personales independientes o notas administrativas internas. Reusar versiones de identidad entre ámbitos sólo con política explícita de acceso; no copiar archivos privados automáticamente.
- Corrección tras rechazo crea nueva versión conservando historial mientras aplique retención. Cambios de nombre/INE o placa/serie/titular requieren revisión nueva; no permitir editar después de aprobar y conservar autorización sobre datos distintos. Campos no materiales deben clasificarse en el contrato.

### Operación y transición

La nueva política se debe comprobar en servidor al asignar repartidor/unidad de flotilla, emparejar recursos cuando permita operación y cualquier ruta administrativa que pudiera omitir validación. TAKE independiente requiere igualmente identidad/unidad aprobadas. Inventariar SQL/triggers y rutas de alta/edición/activación masivas; el control no puede existir sólo en formularios.

No modificar como efecto incidental la adjudicación al proveedor, los cinco intentos, precios, cobro o créditos. El punto de bloqueo de un proveedor que toma un servicio pero no tiene pareja aprobada debe diseñarse explícitamente antes de implementación; no introducir filtros de búsqueda/claim por inferencia.

Conservar entrega, GPS, custodia y recuperación de servicios ya comprometidos; una revisión documental no desasigna ni cancela en silencio. La aplicación a conductores/unidades YA existentes (revisión obligatoria, plazo y bloqueo de nuevas asignaciones) sigue pendiente de decisión; no asumir aprobación retroactiva ni suspenderlos todos mediante migración.

### Notificación y conservación

Notificar resultado al administrador solicitante de la flotilla; proponer también estado visible al conductor para su identidad. Destinatarios, preferencias y canal se deben cerrar en contrato; emails sin adjuntos/datos sensibles. Decisión persistida y notificación durable son independientes del éxito de entrega de correo.

La regla aprobada de independientes es conservar archivos hasta baja de cuenta. En flotilla hay cuentas/recursos distintos: baja de un administrador, baja de conductor, retiro de unidad y cierre del proveedor no son equivalentes. **Pendiente:** precisar disparador de purga por titular/recurso. Recomendación: baja de administrador sólo revoca su acceso, no borra expedientes de la empresa; baja del conductor purga su identidad; retiro definitivo de unidad purga su expediente; cierre del proveedor requiere resolver expedientes compartidos y purgar los que le correspondan. No dar estas recomendaciones por aprobadas ni borrar historial operativo por cascada. Backups/purga verificable siguen pendientes técnicos de §10.

### Impacto por proyecto y evidencia futura

- Backend: modelo común de revisión versionada por identidad/unidad con ownership separado del actor que carga; permisos, upload privado, decisiones, avisos, elegibilidad y transición. Contrato candidato anterior ya no cubre por sí solo flotillas y debe ampliarse antes de código.
- Web: extender alta/edición de repartidores y unidades del proveedor con borradores/documentos/estado/rechazo; bandeja SUPER_ADMIN por proveedor/tipo de expediente. No sustituir flota por registro independiente ni cambiar roles.
- App: mostrar estado de validación de identidad/unidad y bloqueos explicados para nuevas operaciones, con autoridad backend. Para flotilla, captura desde Web del proveedor en esta propuesta; no dar al conductor permisos del proveedor. Preservar servicio activo y no descargar el expediente sensible a caché operativa.
- Pruebas futuras: A no consulta/edita expedientes de B, proveedor no aprueba, una aprobación no propaga a otros recursos, cambio material invalida únicamente autorización correspondiente, asignación bloqueada con identidad o unidad pendiente, carreras revisión/asignación y edición/decisión, flota existente y perfiles duales, notificación fallida sin reversión, purga según titular sin borrar otros expedientes. Sólo fixtures sintéticos.

No implementación ni cambio de reglas reales en esta tarea. Decisión de ampliar a flotilla confirmada; transición de existentes, titularidad permitida y bajas separadas pendientes de cierre.

## Verificación realizada en esta tarea

Sólo lectura de los archivos indicados y revisión documental/diff. Backend QA/HEAD confirmado; Git de repos externos no pudo consultarse por permisos de lectura de Git, por lo que no se acredita su rama/HEAD. No se consultó DB, ejecutó Docker, corrió suites/build, creó migraciones ni modificó producto/configuración/repos externos. Cambios locales previos conservados. Sin commit/push/despliegue.
