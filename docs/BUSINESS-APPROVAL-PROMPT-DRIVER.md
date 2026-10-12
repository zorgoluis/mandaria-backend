# Prompt completo — Mandaria Android Driver

Analiza compatibilidad con la aprobación comercial de cuentas cliente en C:/Users/zorgl/Documents/mandaria-driver. Es una revisión del repartidor, no desarrollo de aplicación cliente.

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

1. Revisa androidApp/src/real/kotlin/driver/mandaria/mx/DriverApi.kt, IndependentOperations.kt y consumidores pertinentes de shippingPayment, instrucciones de cobro, autoridad operativa, GPS/hitos, entrega y reconciliación. Confirma ubicaciones reales y lista endpoints/DTO usados. No asumir que cambios del cliente llegan al DTO Driver.
2. Identifica cualquier inferencia de permisos de ejecución basada en CustomerAccount.type, autorización comercial o datos del cliente. Una revisión/rechazo/revocación posterior no elimina autoridad sobre servicios comprometidos ni cambia su pagador REQUESTER/RECIPIENT, importes, consentimiento, cobro o custodia.
3. Diseña matriz de regresión para servicio comprometido cuyo propietario está REVIEW_REQUIRED/RESTRICTED: asignación vigente, recogida, hitos, GPS, entrega, instrucciones de pago, pérdida de respuesta y recuperación, historial finalizado. Usa instrucciones/autorización persistidas del servicio; no calcularlas desde estado comercial actual.
4. No añadir formularios de Negocio, bandeja de aprobación, billing, checkout o SDK de suscripción. Solicitud de cliente no es solicitud de repartidor independiente; conservar autoridad/contextos de independiente y flotilla. Notas internas, formulario comercial, grant y datos administrativos no deben filtrarse a Driver.
5. Distingue cambios aditivos en respuestas cliente de cambios efectivos en contratos Driver. Si no se modifica el contrato consumido, concluye explícitamente “sin implementación móvil necesaria” con evidencia; no crear cambios preventivos. Ante una dependencia real, documenta ajuste mínimo candidato y su responsable antes de ampliar alcance.

## Entrega

Documento de impacto por archivo/endpoint/campo, con evidencia de lecturas y matriz de regresiones futuras. Identifica pruebas unitarias/contrato/Compose ya existentes que cubren escenarios y las nuevas que serían necesarias; no adjudicar a esta tarea resultados históricos. No repetir validación física GPS ni abrir Android Studio/emulador, consumir fixtures, enviar ubicaciones, usar base principal o iniciar operaciones en esta fase.

Conserva configuración de red release, firma, mapas/keys y canales de distribución. No cambios de producto. Detalla dependencias backend, contrato real, límites de evidencia y si no hay trabajo móvil funcional. Entrega al propietario; no enviar mensajes entre agentes.


## Actualización contractual autorizada

Leer §13 del diseño backend como cierre de las precisiones Web: customerAccountId raíz, error actual sin perfil, DTO admin/grants, paginación sin totalPages, GET query/close JSON y envelope con receipt. Añadir ALLOW_REAPPLICATION al protocolo administrativo; POST admin/customer-business-access/:customerAccountId/allow-reapplication y GET de acceso administrativo son candidatos documentales. Sólo SUPER_ADMIN habilita; cliente usa reapplicationBlocked/canApply. No implementar ahora. Este cierre sustituye pendientes anteriores del prompt, sin convertir rutas propuestas en disponibles.
