# Prompt completo — Mandaria Landing

Analiza y documenta la comunicación y navegación de cuentas Negocio en C:/Users/zorgl/Documents/mandaria-landing.

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

1. Revisa src/components/Negocios.tsx, src/lib/motion.ts, src/lib/api.ts y consumidores de LOGIN_URL/CTA de negocio. Confirma rutas reales e inventaría textos, enlaces y formularios relacionados. La evidencia anterior indica que “Integrar mi negocio” describe conexión de sistemas: verifica antes de proponer cambios.
2. Propón separar “Solicitar cuenta Negocio” (cliente humano autenticado, revisión SUPER_ADMIN) de “Integrar mi sistema” (integración B2B). Conserva alta de socios/flotillas/repartidores independientes; no reutilices partner-applications como solicitud comercial ni cambies la oferta B2B para resolver este requisito.
3. Redacta textos completos para CTA, explicación y preguntas frecuentes: aprobación manual, solicitud desde cuenta con correo verificado, datos mínimos, uso Personal mientras se revisa para perfiles Personal. No generalizar esa continuidad a BUSINESS heredado REVIEW_REQUIRED: sus nuevos servicios están restringidos, compromisos existentes se conservan.
4. No crear registro paralelo, capturar formulario comercial, llamar APIs admin ni almacenar credenciales. La solicitud vive en Web autenticada. Destino del CTA depende de ruta implementada y confirmada por Web; registra URL pendiente sin inventar ruta, query o redirección abierta. Conserva separada la navegación B2B.
5. No prometer aprobación inmediata, plazo/SLA, precio, gratuidad permanente, ventajas adicionales o envío de correo de decisión; la etapa backend propuesta no añade notificación automática. No presentar volumen declarado como cobertura ni tarifa contratada.

## Entrega

Documento con tabla archivo/texto actual/texto propuesto/motivo/destino, copy completo y estados de navegación autenticada/no autenticada a coordinar con Web. Anota qué decisiones están aprobadas y qué depende del contrato/ruta real. Planifica verificación futura de enlaces, teclado, etiquetas, lectura móvil y accesibilidad, además de tipos/build/lint pertinentes al implementar. No ejecutar publicación ni modificar componentes en esta etapa.

Entrega un handoff para el propietario: qué debe confirmar Web y cómo validar destinos después. No contactar automáticamente a su agente. La readmisión después de revocación requiere habilitación explícita de SUPER_ADMIN; no prometerla como automática.


## Actualización contractual autorizada

Leer §13 del diseño backend como cierre de las precisiones Web: customerAccountId raíz, error actual sin perfil, DTO admin/grants, paginación sin totalPages, GET query/close JSON y envelope con receipt. Añadir ALLOW_REAPPLICATION al protocolo administrativo; POST admin/customer-business-access/:customerAccountId/allow-reapplication y GET de acceso administrativo son candidatos documentales. Sólo SUPER_ADMIN habilita; cliente usa reapplicationBlocked/canApply. No implementar ahora. Este cierre sustituye pendientes anteriores del prompt, sin convertir rutas propuestas en disponibles.
