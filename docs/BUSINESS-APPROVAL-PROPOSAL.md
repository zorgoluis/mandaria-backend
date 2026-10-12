# Cuenta Negocio con aprobación manual — propuesta

> Actualización 2026-10-12: backend implementado localmente con autorización posterior. El [informe de implementación](BUSINESS-APPROVAL-IMPLEMENTATION.md) y OpenAPI describen el resultado; la regresión E2E final se completó con69/69 en bases aisladas por archivo; el aborto anterior conserva causa nativa no concluyente. Las referencias a etapa documental siguientes se conservan como historia del diseño. Sin despliegue.

Fecha: 2026-10-12. Estado: reglas de negocio aprobadas; diseño técnico propuesto, no implementado. Backend inspeccionado en QA ce45dff. Lectura de código local de mandaria-frontend, mandaria-driver y mandaria-landing; sus revisiones Git no pudieron confirmarse por permisos de lectura Git. No se modificaron esos proyectos. No se inspeccionó Coita ni bases de datos.

## Diseño técnico Backend actualizado (2026-10-12)

[Contrato candidato y diseño técnico](BUSINESS-APPROVAL-BACKEND-DESIGN.md), verificado sobre QA ce45dff sin cambios de producto. Concreta persistencia, corte durable, recuperación por clave, descenso/revocación y matriz de pruebas. Sus decisiones técnicas prevalecen sobre los nombres/alternativas preliminares de las secciones siguientes. No es una API disponible ni autorización para implementar. Formulario mínimo y nueva solicitud inmediata tras rechazo/retiro aprobados el 2026-10-12; §11 del diseño registra la actualización. Readmisión tras revocación aprobada: sólo SUPER_ADMIN habilita una nueva solicitud; no reactiva grant ni BUSINESS. Bloqueo durable aun después de descenso; habilitación conserva servicios y permite reenvío posterior a rechazo/retiro hasta otra revocación administrativa. Contrato cerrado documentalmente en BUSINESS-APPROVAL-BACKEND-DESIGN.md §13, no implementado. Implementación requiere nueva autorización.

## 1. Decisión del propietario y alcance

Confirmado por el propietario: Negocio requiere solicitud y aprobación manual; sólo SUPER_ADMIN puede aprobar y la activación exige cero solicitudes abiertas. También se aprobó la revisión obligatoria de las cuentas BUSINESS existentes, sin afectar servicios comprometidos, según §7. Preparar una frontera para cobrar después. Esta tarea sólo analiza y documenta. Las decisiones comerciales indicadas están aprobadas; los modelos y nombres de contratos siguientes son propuestas, no endpoints existentes ni autorización para implementar/publicar.

Objetivo: el cliente no puede concederse BUSINESS por registro, anexión de perfil o edición. Una aprobación permite los beneficios actuales (varias solicitudes abiertas y elegir pagador del envío), sin descuentos ni cambios en tarifas. No crea IntegrationClient, proveedor, perfil independiente, empleados ni múltiples usuarios de empresa.

Primera etapa: sin pasarela, facturas, periodicidad, precio, prueba gratis ni cobro automático. No prometer gratuidad perpetua. Cuota comercial futura distinta del precio del envío, efectivo de mercancía y créditos del repartidor/proveedor.

## 2. Evidencia y superficies actuales

| Proyecto | Archivos inspeccionados | Hallazgo / impacto |
| --- | --- | --- |
| Backend | src/customers/customers.dto.ts; customers.controller.ts; customers.service.ts | RegisterCustomerDto y CustomerProfileDto aceptan BUSINESS; register/resend guardan tipo en CustomerChallenge.profile; confirm crea cuenta con ese tipo; attach anexa perfil; changeType permite ascenso propio. Proteger todas las vías. |
| Backend | src/customers/shipping-terms.ts; demand-owner.ts; src/delivery-prequotes/prequote-conversion.service.ts | Pagador depende de tipo, revisión entra en términos; conversión ocupa cupo con lock de cuenta. Cambios de autorización afectan MPQ aún no convertidas. |
| Backend | prisma/schema.prisma; prisma/migrations/20261006000200_direct_demand_and_shipping/migration.sql | DirectRequestLifecycle.personalSlot y guards ligan tipo a solicitudes abiertas. No degradar cuentas con servicios abiertos ni reescribir sus términos. |
| Web | src/customer/identity.tsx; ProfilePage.tsx; service.ts; contract.ts | Selector Negocio en alta y perfil; service llama profile/type. Debe sustituirse ascenso por solicitud y leer autorización del servidor. |
| Web | src/customer/QuoteForm.tsx; RequestActions.tsx; src/app/App.tsx; src/partner-applications/* | Revisar capacidades, errores y navegación; crear revisión SUPER_ADMIN separada. Solicitud comercial cliente no es solicitud de socio transportista. |
| Android Driver | androidApp/src/real/kotlin/driver/mandaria/mx/DriverApi.kt; IndependentOperations.kt; README.md | Consume shippingPayment y permisos de ejecución. No es app cliente ni lugar para solicitar/aprobar Negocio. Impacto esperado de regresión; no nueva pantalla de suscripción para Driver. |
| Landing | src/components/Negocios.tsx; src/lib/motion.ts; src/lib/api.ts | CTA actual “Integrar mi negocio” se refiere a conexión de sistemas y apunta a LOGIN_URL. Diferenciar solicitar cuenta cliente de integración B2B, sin reutilizar formularios de socios. |

Los archivos de pruebas Web customer.test.tsx, customer-service.test.ts, customer-reconciliation.test.tsx y customer-request-design.test.tsx son candidatos de regresión. Nombres de rutas/componentes nuevos se acuerdan después del contrato backend. No se encontró ni se auditó una app móvil cliente separada; si existe se añade al inventario antes del rollout.

## 3. Experiencia propuesta

1. Crear/confirmar cuenta Personal y verificar correo. El registro muestra que Negocio requiere solicitud; no concede privilegios.
2. Desde perfil autenticado: “Solicitar cuenta Negocio”. Recoger nombre comercial, giro, ciudad/zona de operación, volumen estimado y nota opcional. Usar correo verificado actual; no exigir RFC, documentos fiscales o comprobantes en esta etapa.
3. Mostrar EN_REVISIÓN; puede seguir usando Personal. Solicitar no reserva cupo ni modifica servicios.
4. SUPER_ADMIN revisa. Aprobación o rechazo con razón para cliente; notas internas separadas, nunca expuestas en DTO público. PROVIDER_ADMIN no decide sobre clientes ajenos.
5. Aprobación y activación atómicas sólo si no hay solicitudes abiertas, conservando la restricción actual. Si existen, devolver conflicto sin grabar aprobación parcial; cliente/admin pueden continuar cuando terminen. No crear un estado aprobado-pero-inactivo implícito.
6. Tras aprobar, Web vuelve a consultar perfil/capabilities y muestra beneficios. Rechazo no bloquea acceso Personal. Aprobado: permitir nueva solicitud explícita inmediata después de rechazo o retiro, con rate limit, nueva clave y nuevo ID; no editar una decisión histórica.

Datos mínimos, longitud y catálogos se fijan en DTO; ciudad declarada no crea geocerca ni cobertura. No guardar tokens/cuerpos comerciales en logs. Bandeja propia es la confirmación fiable; no se añade correo automático de decisiones en esta etapa según el diseño backend.

## 4. Modelo propuesto y preparación de cobro

Separar tres conceptos:

- CustomerAccount.type: compatibilidad de perfil y reglas existentes PERSONAL/BUSINESS; no significa pagado.
- BusinessApplication: solicitud y decisión. Estados PENDING, APPROVED, REJECTED, WITHDRAWN; NONE es ausencia derivada. ID, owner, datos de solicitud, revision, fechas, actor decisor, razón visible. Una PENDING por cuenta mediante índice único parcial; solicitudes terminales inmutables.
- Estado comercial businessAccess incluye REVIEW_REQUIRED para existentes (no equivale a grant activo), además de estados del permiso; concretar persistencia sin contradicciones entre tipo, revisión y grant.
- BusinessAccessGrant: permiso comercial. Fuente MANUAL_ADMIN en etapa1; relación a solicitud aprobada, cliente, actor, revisión y fechas. ACTIVE/REVOKED, sin expiración en etapa1. Evidencia/auditoría append-only de decisiones y cambios; no inferir autorización del texto businessName.

Aprobación crea grant y cambia tipo en la misma transacción; una cuenta BUSINESS nueva exige grant activo. Account.active conserva su significado de acceso general, no se usa como interruptor de suscripción. Consultar una función común de capacidades de negocio en todos los escritores; no múltiples booleanos editables por clientes. SQL debe respaldar consistencia de cuenta/grant/decisión y restricciones de unicidad, sin pretender sustituir autenticación por datos enviados en el cuerpo.

Cobro futuro: agregar catálogo/contrato de plan y eventos de facturación verificados que alimenten esta misma autorización. Aprobación comercial y pago seguirán siendo hechos separados. No implementar ahora suscripciones ficticias, estados PAID, webhooks de pasarela ni tablas de planes sin definición. Fuente futura de grant se añade con migración/contrato cuando exista producto comercial aprobado.

Suspensión/vencimiento futuros no deben cancelar viajes ni transformar BUSINESS en PERSONAL con varias solicitudes abiertas. Propuesta futura: negar nuevas conversiones, conservar tipo histórico y permitir terminar/cancelar legalmente servicios comprometidos. La semántica de MPQ no convertida, MDR aún sin aceptación, reactivación y periodo de gracia necesitará diseño explícito antes de cobrar. Etapa1 no implementa expiración automática.

## 5. Seguridad, concurrencia y recuperación

- Registro y resend nuevos rechazan type=BUSINESS con error claro BUSINESS_APPROVAL_REQUIRED; conservar PERSONAL para clientes actuales. No transformar silenciosamente una elección de Negocio en aprobación.
- Confirmación de tokens REGISTER anteriores: perfil BUSINESS guardado no otorga acceso. Propuesta: consumir token y crear Personal, informar al cliente que debe solicitar Negocio; sin perder su verificación ni crear una solicitud comercial sin consentimiento. RESET/VERIFY no cambian tipo.
- attach para usuarios existentes también sólo Personal; conserva rol operativo, identidad y permisos actuales.
- POST profile/type no puede ascender. Descenso voluntario: ruta controlada, sin solicitudes abiertas; revoca grant y cambia a Personal atómicamente, preservando historial. Si se retira esta ruta, contrato de reemplazo explícito y error compatible, nunca fallback permisivo.
- Estado autenticado/verificado/activo comprobado en submit y decisiones. Decisiones SUPER_ADMIN, ownership en lecturas cliente, paginación y redacción de notas; 404 ante recurso ajeno.
- UUID Idempotency-Key para solicitud/decisión/retiro; hash del cuerpo, actor+operación, recibo durable y expectedRevision. Misma clave devuelve recibo original, cuerpo distinto409; no crear otra solicitud tras timeout. GET own/list recupera ID; GET de intento por clave debe permitir recuperar respuesta perdida sin reenviar cuerpo. No copiar indiscriminadamente protocolo logístico ni sus estados de cierre: las mutaciones comerciales requieren su contrato de recibos explícito.
- Lock de CustomerAccount como operaciones actuales, luego solicitud/grant; revalidar solicitudes abiertas bajo ese lock. Carreras aprobación/conversión, rechazo/aprobación, retiro/aprobación y dos admins tienen un resultado durable. Nunca cobrar por un replay.
- Incrementar revisión de cuenta al activar/revocar; MPQ previas deben recibir renovación requerida por cambio de política al convertir, conforme mecanismo existente. MDR/MQ ya comprometidas, consentimiento, tarifas y cobros no se reinterpretan. Mantener recuperación de recibos históricos.
- No cambios de B2B, scope IntegrationClient, cinco búsquedas, claim/take, asignación, GPS, custodia, ledger o refunds.

## 6. Contrato candidato (NO disponible hoy)

Prefijo /api/v1. Nombres definitivos y DTO/OpenAPI se fijan con backend antes de implementación de consumidores.

| Superficie propuesta | Uso |
| --- | --- |
| POST /customer/business-applications | Crear solicitud propia idempotente, sin cambiar tipo |
| GET /customer/business-applications | Lista propia y solicitud vigente |
| GET /customer/business-applications/:id | Estado/decisión visible propia |
| POST /customer/business-applications/:id/withdraw | Retirar PENDING con key/revisión |
| GET /customer/business-application-attempts/:key | Recibo de SUBMIT/WITHDRAW propio; operación explícita |
| GET /admin/customer-business-applications | Bandeja paginada sólo SUPER_ADMIN |
| GET /admin/customer-business-applications/:id | Detalle autorizado para revisión |
| POST /admin/customer-business-applications/:id/decision | APPROVE/REJECT, reason, expectedRevision y key |
| GET /admin/customer-business-application-attempts/:key | Recuperación de decisión propia por operación/key |
| GET /customer/profile y /customer/capabilities existentes | Adición businessAccess y businessApplication; capacidades autoritativas |

Ejemplo conceptual tras aprobar: type=BUSINESS; businessAccess={state:ACTIVE,source:MANUAL_ADMIN}; businessApplication={status:APPROVED}; allowedShippingPayers=[REQUESTER,RECIPIENT]. No paymentStatus ni precio de plan; conservar campos actuales. DTO desconocido/ausente no autoriza ascenso en UI. Errores propuestos: BUSINESS_APPROVAL_REQUIRED, BUSINESS_APPLICATION_PENDING, BUSINESS_APPLICATION_NOT_PENDING, PROFILE_REVISION_CONFLICT, CUSTOMER_ACTIVE_REQUESTS, IDEMPOTENCY_KEY_REUSED. Publicar el contrato HTTP exacto con implementación, no regenerar OpenAPI ahora con rutas inexistentes.

## 7. Cuentas existentes — revisión obligatoria aprobada

Decisión del propietario del 2026-10-12: revisión obligatoria de cuentas existentes aprobada, preservando servicios en curso. Sólo SUPER_ADMIN aprueba y la activación exige cero solicitudes abiertas. Las cuentas actuales podían autoelegir BUSINESS; esa selección no acredita revisión comercial. La aprobación del criterio NO autoriza implementar, migrar ni desplegar: esta etapa sigue siendo documental.

1. Antes del corte, inventario autorizado: cuentas BUSINESS, lifecycle abiertos, MDR convertidas pendientes de aceptación y challenges pendientes. No se consultó la base en este análisis. Si no existen cuentas BUSINESS, no crear un flujo de transición innecesario.
2. Marcar existentes como REVIEW_REQUIRED en autorización comercial, conservando CustomerAccount.type=BUSINESS y evidencia de origen histórico; no crear grant ACTIVE, pago ni aprobación ficticia. Incluir este estado en el diseño de acceso; su persistencia y DTO definitivos quedan por cerrar técnicamente. Es una revisión de cuenta existente, no una solicitud supuestamente enviada por el usuario: registrar origin=LEGACY_REVIEW y completar información comercial con consentimiento.
3. Desde el corte, sin nuevas MPQ ni conversiones para esas cuentas hasta resolver revisión. MPQ no convertidas no reservan servicio y no pueden convertir tras el corte. No usar type=BUSINESS como bypass; capabilities y escritores comparten el control de acceso. Perfil, historial, recibos y seguimiento siguen disponibles.
4. MDR/MQ convertidas antes del corte conservan términos y pueden aceptarse dentro de su TTL, cancelarse legalmente y concluir conforme reglas existentes. No extender vigencia ni reabrir. No bloquear entrega, custodia, GPS o recuperación ni modificar precio/cobro. No cancelar automáticamente viajes. Es una excepción por recurso ya comprometido, no permiso general de nuevas solicitudes.
5. SUPER_ADMIN aprueba sólo al quedar cero lifecycle abiertos: revisión, grant ACTIVE y revisión de cuenta atómicos. Si quedan abiertos, conflicto sin aprobación parcial; no activar automáticamente más tarde. Reutilizar recuperabilidad e idempotencia definidas para decisiones.
6. Si se rechaza, registrar decisión/reason comercial, mantener bloqueo de nuevas operaciones de Negocio y permitir terminar las existentes. Cambio a PERSONAL sólo cuando cero abiertas, mediante acción controlada y auditable bajo lock; nunca degradar durante varias solicitudes activas. Hasta completar esa transición, UI indica revisión rechazada y servicios pendientes de cierre. No borrar historial, datos ni cambiar rol operativo.
7. Sin cuotas retroactivas ni condiciones de pago inventadas. Notificar el cambio de política y la acción requerida antes del corte; definir responsable operativo y canal de soporte. No fijar un plazo arbitrario de revisión ni suspender acceso general por vencimiento. La pausa de nuevas solicitudes forma parte de la transición aprobada; no afecta la continuidad de los servicios comprometidos.

Antecedente descartado: conceder grant LEGACY_MIGRATION activo automáticamente a existentes. No forma parte del alcance aprobado: la migración registra origen LEGACY_REVIEW sin inventar solicitud del usuario, aprobación administrativa ni pago. No conceder excepciones automáticas.

Despliegue coordinado: migración incremental, backend que cierre todas las vías de autoascenso, Web con REVIEW_REQUIRED y retirada de escritores antiguos. Simular corte con servicios abiertos y decisiones concurrentes; ninguna instancia antigua puede seguir usando type como único permiso. Probar rollback compatible sin borrar decisiones/grants; no revertir SQL automáticamente. La política ya está decidida; aún se requiere diseño técnico, inventario autorizado y autorización posterior de implementación/despliegue. No ejecutar migración/activación en esta etapa. Sin cambios de configuración en esta tarea.

## 8. Pruebas de aceptación propuestas (no ejecutadas)

- Registro, resend, confirm de challenge anterior, attach y profile/type no conceden Negocio sin autorización.
- Personal puede seguir cotizando y usando un servicio; solicitud comercial no modifica cupo. Rechazo conserva Personal; aprobación habilita capacidades existentes sin cambiar precios.
- Dos submits: una pendiente; replay recuperable después de reinicio; aprobación vs rechazo/retiro: un ganador; aprobación vs conversión: invariantes y cero cambios parciales.
- Sin permisos ni acceso cruzado; notas internas no llegan a cliente/Driver/B2B; razón visible saneada.
- Negocio existente REVIEW_REQUIRED: bloquear nuevas MPQ/conversiones, pero aceptar MDR/MQ previas dentro de TTL y conservar seguimiento, ejecución, recuperación, cancelación legal, historia/términos/ledger. Probar corte concurrente con conversión y decisiones; clasificación anterior/posterior al corte durable, no inferida del reloj cliente. Migración desde QA45 sin grant activo automático; constraints SQL, no sólo mocks.
- Cambio de revisión invalida MPQ incompatible sin cambiar MDR ni su aceptación original; bloqueo de descenso con abiertas.
- Web: alta Personal, solicitud, estado pendiente/rechazo/aprobación, timeout y recarga; bandeja SUPER_ADMIN; usuario común sin acciones admin; cliente antiguo recibe error útil.
- Android: instrucciones REQUESTER/RECIPIENT, cobro, hitos, GPS y recuperación permanecen iguales; sin datos de suscripción del cliente.
- Regresión focal de demanda directa y cinco intentos B2B; no ampliar búsqueda a clientes directos. Build/tipos/linters, OpenAPI completo y exportador B2B, archivos completos afectados; no suite general indiscriminada.

## 9. Secuencia y decisiones antes de implementar

1. Confirmado: sólo SUPER_ADMIN aprueba y activación sólo sin solicitudes abiertas. También confirmada revisión obligatoria controlada de existentes (§7), sin autorización automática histórica. Aprobados nombre comercial, giro, ciudad/zona, volumen estimado, nota opcional y correo verificado reutilizado; nueva solicitud inmediata tras rechazo/retiro, una pendiente e historial conservado. Contrato técnico cerrado documentalmente en §13 del diseño y readmisión con habilitación SUPER_ADMIN aprobada; no volver a pedir decisiones ya confirmadas.
2. Backend cierra contrato y migración con esas decisiones, después implementa con autorización nueva. Publica evidencia y handoff.
3. Web integra cliente + administración contra contrato real. Landing alinea mensaje y destino confirmado. Android revisa regresión; no inventar módulo cliente.
4. Prueba conjunta aislada y revisión operativa antes de rollout. Etapa de cobro se diseña después, con autorización separada.

Preparados prompts en BUSINESS-APPROVAL-AGENT-PROMPTS.md. No se enviaron a agentes. Esta propuesta no asigna versión ni modifica código, configuración o base. Verificación actual: lectura de archivos listados y revisión documental; ninguna prueba funcional nueva.
