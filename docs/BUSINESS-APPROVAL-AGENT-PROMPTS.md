# Prompts por proyecto — aprobación manual de cuenta Negocio

> Actualización 2026-10-12: backend implementado localmente con autorización posterior. El [informe de implementación](BUSINESS-APPROVAL-IMPLEMENTATION.md) y OpenAPI describen el resultado; la regresión E2E final se completó con69/69 en bases aisladas por archivo; el aborto anterior conserva causa nativa no concluyente. Las referencias a etapa documental siguientes se conservan como historia del diseño. Sin despliegue.

2026-10-12. Preparados para compartir por el propietario; NO enviados. Etapa actual: análisis y contrato, no implementación. Propuesta canónica: C:/Users/zorgl/Documents/mandaria-backend/docs/BUSINESS-APPROVAL-PROPOSAL.md. Cada agente debe leer las instrucciones de su repositorio, confirmar rama/estado y conservar cambios ajenos. No integrar ramas ni hacer commit/push/despliegue sin autorización. No consultar Coita ni bases principales, leer secretos o activar flags.

## Decisiones actualizadas del propietario (2026-10-12)

Confirmadas: sólo SUPER_ADMIN aprueba; activación requiere cero solicitudes abiertas. Confirmada también la revisión obligatoria de existentes (§7), preservando servicios comprometidos. No volver a pedir estas decisiones. No implementar todavía ni conceder autorización histórica automática. Analizar REVIEW_REQUIRED, bloqueo de nuevas MPQ/conversiones, continuidad de MDR anteriores y descenso sólo sin abiertas.

## Actualización Backend (2026-10-12)

El análisis solicitado al BACKEND quedó documentado en [BUSINESS-APPROVAL-BACKEND-DESIGN.md](BUSINESS-APPROVAL-BACKEND-DESIGN.md). No volver a ejecutar el análisis inicial como si estuviera pendiente. Los prompts siguientes se conservan como historial y referencia de alcance; Web/APP/landing deben tomar el diseño técnico como contrato candidato, todavía no como API real. Formulario y reenvío tras rechazo/retiro ya aprobados (§11); implementación requiere nueva autorización. No enviar prompts a otros chats automáticamente.

## Prompts completos vigentes — actualización autorizada

Los siguientes archivos reemplazan los resúmenes de Web/Driver/Landing de abajo para su envío. Son autónomos y recogen formulario aprobado, nueva solicitud tras rechazo/retiro, contrato candidato y límites. Los resúmenes se conservan como antecedentes; ante diferencias prevalecen estos prompts y el diseño actualizado.

- [Web: cliente y SUPER_ADMIN](BUSINESS-APPROVAL-PROMPT-WEB.md).
- [Landing: mensajes y navegación](BUSINESS-APPROVAL-PROMPT-LANDING.md).
- [Android Driver: compatibilidad operativa](BUSINESS-APPROVAL-PROMPT-DRIVER.md).

No se han enviado. Se puede analizar en cada proyecto ahora; implementación sólo con autorización posterior y API real. Web debe acordar destino antes de que Landing lo use. Readmisión tras revocación aprobada: sólo SUPER_ADMIN habilita una nueva solicitud; no reactiva grant ni BUSINESS. Bloqueo durable aun después de descenso; habilitación conserva servicios y permite reenvío posterior a rechazo/retiro hasta otra revocación administrativa. Contrato cerrado documentalmente en BUSINESS-APPROVAL-BACKEND-DESIGN.md §13, no implementado.

## 1. Agente BACKEND — primero (análisis documentado)

Analiza y cierra el diseño de aprobación manual de clientes BUSINESS en Mandaria, sin implementar todavía. Lee AGENTS.md, BITACORA.md, README.md, VERIFICATION.md y la propuesta canónica. QA ce45dff es la referencia analizada; confirma tu revisión real y diferencias antes de trabajar.

El propietario decidió que Negocio requiere solicitud y aprobación manual, con frontera preparada para cobrar después. No hay autorización para pasarela, suscripciones, cambios de precio ni cobros. Diferencia CustomerAccount, BusinessApplication y autorización BusinessAccessGrant; BUSINESS no acredita pago ni concede IntegrationClient/roles operativos.

Inspecciona customers DTO/service/controller, challenges REGISTER, attach de perfil existente, profile/type, capabilities, shipping-terms, demand-owner, conversión/aceptación directa y guards SQL de lifecycle. Enumera todas las vías de autoascenso y cómo cerrar tokens antiguos. Propón contrato final de solicitud propia, revisión SUPER_ADMIN, decisión/retiro con revisión e idempotencia y recuperación por clave después de timeout. No anunciar rutas como disponibles ni generar OpenAPI ficticio.

Conserva el lock de cuenta, bloqueo de cambio de tipo con solicitudes abiertas, cupo Personal, términos/consentimiento comprometidos y recuperación histórica. Proponer aprobación+grant+tipo atómicos; no cambiar el cliente mientras tiene abiertas. Descenso/revocación no debe cancelar ni reinterpretar entregas. Resuelve cómo cambios de revisión afectan MPQ anteriores. Separa cuota futura del envío, mercancía, créditos y refunds.

Entrega: diagrama de estados, DTO/rutas/errores candidatos, permisos y redacciones, constraints/transacciones, plan incremental desde QA45, transición de challenges y cuentas BUSINESS existentes, rollout sin escritores antiguos, matriz de pruebas y decisiones que requieren al propietario. La revisión obligatoria de existentes está aprobada; LEGACY_MIGRATION activo automático queda descartado. Diseña el corte durable y su carrera con conversión: REVIEW_REQUIRED bloquea nuevas MPQ/conversiones, conserva aceptación dentro del TTL de MDR/MQ previas, seguimiento, ejecución y recibos; rechazo no degrada cuentas con servicios abiertos. No asumir pago/aprobación histórica. Tarifas, B2B, cinco intentos automáticos, GPS/hitos y ejecución quedan fuera de cambios. Actualiza documentación, sin producto ni migraciones ejecutables todavía. Sólo con nueva autorización implementar la propuesta aprobada y validar archivos completos pertinentes, tipos/build/linters y contratos.

## 2. Agente WEB — cliente y SUPER_ADMIN

Analiza el impacto de la aprobación manual de cuenta Negocio, sin implementar hasta que backend entregue contrato aprobado. Lee la propuesta canónica y la continuidad de tu repositorio; no uses esta lista de endpoints candidatos como API disponible.

Revisa src/customer/identity.tsx, ProfilePage.tsx, service.ts, contract.ts, QuoteForm.tsx, RequestActions.tsx, src/app/App.tsx y pruebas customer*. Actualmente hay selección de BUSINESS en alta/anexión y cambio directo de tipo. Diseña registro Personal y acción “Solicitar cuenta Negocio” después de verificar correo. Diseña formulario mínimo, estado en revisión, rechazo con motivo visible, retiro, nueva solicitud y activación reflejada desde capabilities del servidor. No habilitar beneficios por localStorage, selección de UI, businessName o respuesta de submit. No convertir BUSINESS en pago ni prometer gratuidad perpetua.

Diseña bandeja y detalle SUPER_ADMIN separados de partner-applications de transportistas. No dar permisos a PROVIDER_ADMIN. Confirmar decisiones con revisión; conflicto por solicitudes abiertas no se muestra como aprobado. Ante timeout conservar clave/identidad mínima, consultar recibo y estado vigente; no reenviar con clave nueva ni duplicar solicitudes. No guardar datos comerciales completos o notas internas como marcadores.

Preserva cotización, consentimiento, términos de envío, historial, GPS y recuperación actuales. Usuarios Personal pueden seguir operando durante revisión. Para BUSINESS existentes, diseña aviso REVIEW_REQUIRED con nuevas cotizaciones/conversiones bloqueadas, sin bloquear detalle, seguimiento, recuperación, aceptación vigente de MDR previas ni cierre legal. No ocultar todos los servicios por falta de autorización comercial. Tras rechazo conservar servicios abiertos y mostrar transición pendiente a Personal; no cambiar tipo localmente. Propón compatibilidad con backend anterior y actualizado sin fallback de autoascenso; no inventar rutas/flags ni ocultar un fallo contractual. Entrega mapa de pantallas/rutas, estados/textos, dependencias exactas backend, pruebas y secuencia de rollout. No cambiar código, contrato generado, .env ni desplegar en esta fase. Implementación posterior sólo con contrato real y autorización.

## 3. Agente ANDROID DRIVER — compatibilidad, no módulo comercial

Revisa en modo análisis el impacto de la futura aprobación de cuentas cliente Negocio. Lee la propuesta canónica y tu continuidad. Mandaria Driver es aplicación del repartidor; la aprobación del cliente no es aprobación de independiente ni suscripción del repartidor.

Revisa androidApp/src/real/kotlin/driver/mandaria/mx/DriverApi.kt, consumidores shippingPayment, instrucciones de cobro, hitos/GPS y recuperación. Determina si algún DTO o pantalla infiere permisos a partir del tipo de cliente. El objetivo es que una entrega ya comprometida conserve instrucciones REQUESTER/RECIPIENT y autoridad del repartidor sin importar solicitudes comerciales posteriores. Incluye cuentas existentes REVIEW_REQUIRED o rechazadas: la revisión comercial no retira autoridad del repartidor sobre servicios en curso ni bloquea sus comandos por esa sola causa. No exponer solicitud, notas del administrador, plan o datos de facturación al Driver.

Entrega análisis de impacto y regresiones necesarias: cobro en recogida/entrega, ausencia de cobro duplicado, término/historial, GPS, entrega e intentos. Si no cambia el contrato consumido, declara que no hace falta implementación móvil. No añadir pantallas cliente, aprobación, checkout, subscription SDK ni controles de negocio por inferencia. No modificar red release, firma, maps keys o configuración. Sin operaciones reales, fixtures consumidos, commit/push o pruebas físicas en esta etapa.

## 4. Agente LANDING — separar cliente Negocio de integración B2B

Analiza mensajes y navegación para solicitud manual de cuenta Negocio, sin modificar todavía. Lee la propuesta canónica y tus instrucciones. Revisa src/components/Negocios.tsx, src/lib/motion.ts y src/lib/api.ts: “Integrar mi negocio” actualmente comunica conexión de sistemas y usa LOGIN_URL.

Propón distinguir “Solicitar cuenta Negocio” para un cliente humano de “Integrar mi sistema” para B2B, conservando flujos actuales de socios/flotillas/independientes. No reenviar solicitudes comerciales a partner-applications ni conceder BUSINESS desde landing. El destino autenticado sólo se fija cuando WEB lo confirme; no inventar URL, precio, SLA, aprobación inmediata o gratuidad permanente.

Entrega inventario de CTA/textos afectados, propuesta de copy, destinos pendientes y verificaciones de navegación/accesibilidad. No crear registro paralelo, almacenar datos de solicitud, credenciales o llamar APIs admin. Sin cambios de producto/publicación hasta autorización posterior.

## Orden de coordinación y evidencia

BACKEND define el contrato aprobado; WEB confirma navegación y estados; LANDING confirma destinos reales; DRIVER confirma que su contrato no cambia o detalla regresión mínima. Cada agente distingue hallazgo de código, propuesta y prueba ejecutada. El propietario comparte estos prompts: ningún mensaje entre chats está autorizado automáticamente por este documento. Las tres decisiones están confirmadas: SUPER_ADMIN, activación sin abiertas y revisión obligatoria de existentes preservando servicios. Falta cerrar contrato y diseño técnico; implementación y despliegue requieren autorización posterior explícita. No enviar mensajes a otros agentes.
