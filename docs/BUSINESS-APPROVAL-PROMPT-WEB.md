# Prompt completo — Mandaria Web

Analiza y documenta el impacto de la aprobación manual de cuentas Negocio en C:/Users/zorgl/Documents/mandaria-frontend.

Fecha: 2026-10-12. Etapa autorizada: análisis y documentación, SIN implementación. Este prompt es completo y se comparte manualmente por el propietario; no autoriza enviar mensajes a otros chats.

Antes de trabajar lee AGENTS.md, BITACORA.md, README.md y VERIFICATION.md de tu proyecto si existen. Confirma rama, HEAD y cambios locales; preserva cambios ajenos. No cambies de rama sobre cambios sin resolver, no uses reset ni integres ramas. Lee como referencia:
- C:/Users/zorgl/Documents/mandaria-backend/docs/BUSINESS-APPROVAL-PROPOSAL.md
- C:/Users/zorgl/Documents/mandaria-backend/docs/BUSINESS-APPROVAL-BACKEND-DESIGN.md

El diseño backend se analizó sobre QA ce45dff, 45 migraciones; confirma diferencias si avanzó. Sus rutas/DTO son CANDIDATOS, no API disponible ni OpenAPI publicado. No modificar backend ni otros repositorios desde esta tarea. Si falta un documento, registra la dependencia sin inventar contrato.

Decisiones comerciales aprobadas, no volver a pedirlas:
1. Cuenta Negocio (CustomerAccount BUSINESS) sólo mediante solicitud y aprobación de SUPER_ADMIN. PROVIDER_ADMIN no decide. No concede IntegrationClient, proveedor, repartidor independiente ni roles operativos.
2. Aprobación y activación atómicas con cero DirectRequestLifecycle abiertos (closedAt IS NULL), incluidas MDR convertidas pendientes de aceptación. No aprobación parcial ni activación automática al cerrar el último servicio.
3. BUSINESS existentes pasan por revisión obligatoria, sin grant histórico automático. REVIEW_REQUIRED/RESTRICTED bloquea nuevas MPQ/conversiones, preservando MDR comprometidas antes del corte, aceptación dentro de su TTL original, seguimiento, ejecución, recuperación, cancelación legal y recibos. El servidor acredita el compromiso; no inferirlo del reloj cliente.
4. Formulario: nombre comercial, giro, ciudad/zona, volumen estimado de envíos, nota opcional; reutilizar correo verificado. No exigir teléfono/nombre de contacto adicionales ni documentos fiscales. Campos técnicos candidatos: businessName, activity, city, estimatedDeliveryVolume (cantidad y periodo en texto), note opcional; expectedAccountRevision es control técnico. Volumen no crea precio, cuota o cobertura.
5. Nueva solicitud explícita inmediata después de rechazo o retiro, con datos corregibles, nuevo ID/key, revisión actual y una sola PENDING; historial inmutable. Rate limit técnico sigue aplicando. Readmisión tras revocación aprobada: sólo SUPER_ADMIN habilita una nueva solicitud; no reactiva grant ni BUSINESS. Bloqueo durable aun después de descenso; habilitación conserva servicios y permite reenvío posterior a rechazo/retiro hasta otra revocación administrativa. Contrato cerrado documentalmente en BUSINESS-APPROVAL-BACKEND-DESIGN.md §13, no implementado.
6. Preparación para cobrar después, sin cobro ahora, precio, periodicidad, pasarela, suscripción ni promesa de gratuidad perpetua. Autorización comercial distinta de pago, tarifas de envío, mercancía, créditos y refunds.

Estados distintos: aplicación PENDING/APPROVED/REJECTED/WITHDRAWN; acceso NONE/REVIEW_REQUIRED/ACTIVE/RESTRICTED; grant ACTIVE/REVOKED. No mezclar sus significados. Personal con aplicación pendiente o rechazada conserva reglas Personal. BUSINESS heredado pendiente/retirado sigue sujeto a revisión. Rechazo no degrada automáticamente a Personal. Descenso requiere cero abiertas y acción controlada.

Alcance de esta tarea: inspección de código y propuesta documental, sin cambios de producto, APIs, OpenAPI generado, migraciones, DB, configuración, flags, .env, versiones, commit, push o despliegue. Sin Docker, operaciones reales ni acceso a Coita Eats. Preservar GPS/hitos, cinco intentos automáticos (sin ampliar a clientes directos), B2B, precios, consentimiento, cobros y autoridad logística. No ejecutar suites sólo para acreditar una propuesta. Distingue evidencia estática, pruebas históricas y verificaciones documentales nuevas. Actualiza continuidad e historial del proyecto conservando entradas anteriores. Implementación futura requiere autorización nueva y contrato backend real.

## Trabajo específico

1. Inspecciona src/customer/identity.tsx, ProfilePage.tsx, service.ts, contract.ts, QuoteForm.tsx, RequestActions.tsx, src/app/App.tsx y pruebas customer*. Confirma nombres reales. Identifica registro/resend/confirm, anexión de perfil, selector de tipo, capabilities, marcadores de recuperación y mutaciones que actualizan caché. No modificar componentes todavía.
2. Diseña registro/anexión Personal y CTA autenticado “Solicitar cuenta Negocio”. Registro/resend/attach/type con BUSINESS devolverán BUSINESS_APPROVAL_REQUIRED. Confirmación de token REGISTER antiguo BUSINESS creará Personal: contempla profileType y businessApplicationRequired sin confundirlo con aprobación. RESET/VERIFY no cambian tipo. Nunca restaurar ascenso directo si faltan campos del backend.
3. Diseña formulario aprobado, validación accesible, pantalla de estado/historial, retiro y nueva solicitud después de rechazo/retiro. Formularios terminales no se editan; corregir implica nueva intención. No habilitar ventajas por tipo, businessName, submit exitoso o localStorage. Usar capabilities vigentes, businessAccess y businessApplication; missing contractual fields requieren estado explícito de incompatibilidad, no permiso por defecto.
4. Diseña bandeja/detalle/decisión sólo SUPER_ADMIN, separada de partner-applications. Datos y notas internas sólo en vistas autorizadas. Rechazo requiere publicReason; internalNote nunca llega a cliente. Aprobación con abiertas es conflicto, no éxito parcial. Releer revisiones antes de una nueva intención tras conflicto. Documentar revocación/descenso con servicios existentes y la habilitación de readmisión revocada por SUPER_ADMIN.
5. Diseña transición para existentes: bloquear exclusivamente nuevas MPQ/conversiones según capacidades. No ocultar servicios ni bloquear aceptación de compromisos anteriores vigentes, ejecución, tracking o recuperación por el solo estado comercial. allowedShippingPayers=[] no autoriza REQUESTER aunque exista defaultShippingPayer; maxActiveRequests=null tampoco concede permiso. No cambiar shippingPayment congelado ni TTL.

## Contrato candidato que debes mapear

Base /api/v1; confirma DTO completos y respuestas en diseño backend §4–6:
- POST/GET /customer/business-applications; GET /customer/business-applications/:id; POST /customer/business-applications/:id/withdraw.
- GET /customer/business-application-attempts/:key; POST /customer/business-application-attempts/:key/close.
- GET /admin/customer-business-applications y /:id; POST /admin/customer-business-applications/:id/decision.
- POST /admin/customer-business-access/:customerAccountId/revoke; recuperación administrativa según rutas exactas del diseño, restringida al actor original.
- profile/type sólo admite descenso controlado; cambia a respuesta Receipt con Idempotency-Key y revisión. Revisar todos sus consumidores, no sólo solicitud nueva.
- Submit incluye expectedAccountRevision. Withdraw expectedApplicationRevision. Decision incluye decision APPROVE/REJECT, ambas revisiones, publicReason e internalNote según permisos. Leer límites candidatos en diseño, no tratarlos como API vigente.
- businessAccess={state,source,restrictionReason,canApply,canDowngrade}; businessApplication nullable con id,status,revision. No tratar estados de acceso como estados de solicitud.

Idempotencia y recuperación comercial: conservar clave y metadatos mínimos (operación/objetivo/cuenta), aislar por identidad y limpiar contexto de sesión correctamente. No persistir formulario completo, token o notas internas como marcador. Ante timeout/5xx no iniciar otra clave: consultar recibo original y luego estado vigente. AttemptView.state es NOT_OBSERVED/APPLIED/REJECTED/CLOSED. NOT_OBSERVED no prueba fracaso; cierre explícito impide llegada tardía y no cancela entregas. Reenvío sólo misma clave y mismo cuerpo si aún se dispone de él. Si el cuerpo se perdió, consultar/cerrar según contrato; no reconstruirlo a partir del perfil actual. Receipt.outcome=APPLIED con applicationStatus=REJECTED significa rechazo administrativo registrado correctamente; outcome=REJECTED indica fallo del comando. Replay es resultado original, no estado actual. Una nueva intención tras rechazo/retiro usa clave nueva únicamente después de confirmar resolución; no confundir con reintentar timeout. Mantener recuperación logística existente independiente.

Mapea errores 409 de revisión, una PENDING, activación con abiertas, acceso restringido y aprobación requerida; 429 con política real sin inventar espera; 503 y pérdida de respuesta; 401/403/404 con aislamiento. No traducir todos a “rechazada”.

## Entrega

Crea propuesta documental con inventario de consumidores/archivos y hallazgos verificables, pantallas y navegación propuestas, copy en español, matriz estados/capacidades/acciones, contrato requerido y cambios de caché/recovery, compatibilidad de despliegue sin fallback permisivo. Define destino de CTA para Landing como PROPUESTA hasta que esté implementado; no anunciar URL disponible.

Planifica pruebas focalizadas futuras: formulario; alta/token antiguo; Personal pendiente; BUSINESS existente con compromiso previo; revisión/decisión concurrente; timeout/recarga/cambio de sesión; cierre y respuesta tardía; reenvío corregido tras rechazo/retiro; permisos/redacción; aceptación/seguimiento preservados. Identifica archivos completos a ejecutar, tipos/build y lint cuando se implemente, sin suite completa ni otra etapa CHECK. No reportar pruebas propuestas como ejecutadas.

Cierra con dependencias exactas y pendientes, especialmente contrato real y autorización de implementación. Si el diseño backend contradice reglas aprobadas, documenta el caso antes de inventar comportamiento.


## Actualización contractual autorizada

Leer §13 del diseño backend como cierre de las precisiones Web: customerAccountId raíz, error actual sin perfil, DTO admin/grants, paginación sin totalPages, GET query/close JSON y envelope con receipt. Añadir ALLOW_REAPPLICATION al protocolo administrativo; POST admin/customer-business-access/:customerAccountId/allow-reapplication y GET de acceso administrativo son candidatos documentales. Sólo SUPER_ADMIN habilita; cliente usa reapplicationBlocked/canApply. No implementar ahora. Este cierre sustituye pendientes anteriores del prompt, sin convertir rutas propuestas en disponibles.
