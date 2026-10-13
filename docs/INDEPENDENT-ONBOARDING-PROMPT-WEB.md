# Prompt para Mandaria Web — sólo análisis y documentación

> Base vigente: feature/driver-verification desde main 1fa2cb1, 32 migraciones. QA 9ad39b9 es referencia histórica de diseño, no dependencia integrada. Leer DEPENDENCIES-DRIVER-VERIFICATION.md antes de usar contratos de QA; GPS, hitos DETAILED, clientes directos y aprobación Negocio no existen en esta base. Sólo documentación, sin implementación.

**Ampliación vigente del propietario:** incluir también altas de repartidores y unidades de FLOTILLA. El PROVIDER_ADMIN captura los mismos datos/rostro/INE y documentos de unidad; SUPER_ADMIN valida identidad y cada unidad por separado. Leer §11 de la propuesta: prevalece sobre instrucciones anteriores de conservar el alta de flotilla sin cambios. Sólo análisis documental, no implementación. Inventariar formularios de flota, revisión por recurso/versiones, ámbito de acceso, notificaciones al solicitante y bloqueo de nuevas asignaciones no aprobadas; preservar servicios comprometidos. En flota la unidad no tiene que pertenecer personalmente al conductor; titularidad/vínculo aceptable pendiente. No inferir que baja de administrador elimina documentos de toda la empresa. Documentar pendientes de transición de recursos existentes y purga por titular.

Analiza y documenta cómo soportar registro de repartidores independientes sin proveedor, con aprobación exclusiva SUPER_ADMIN. NO implementes todavía.

Antes de trabajar lee AGENTS.md, BITACORA.md, README.md y VERIFICATION.md si existen. Confirma rama, HEAD y cambios locales; conserva ajenos, no reset, no cambio de rama sobre modificaciones sin resolver. Inspecciona backend como referencia de sólo lectura en C:/Users/zorgl/.codex/worktrees/driver-verification/mandaria-backend/docs/INDEPENDENT-ONBOARDING-PROPOSAL.md, especialmente §9. No confundas recomendaciones pendientes con aprobación comercial o API implementada.

Contexto comprobado: Driver.providerId actualmente obligatorio; la independencia es una capacidad sobre Driver existente. El nuevo modelo propone provider null para alta autónoma. La disponibilidad backend también necesita ajuste. No basta ocultar selector de proveedor. Contrato backend aún candidato.

Base recomendada para diseñar:
- Alta en Web responsive con expediente privado: nombre, email verificado, teléfono, municipio/zona, foto de rostro, INE, datos de unidad y prueba de propiedad; términos/aviso versionados. Revisa §10 de la propuesta: reemplaza la recomendación anterior sin adjuntos. Catálogo documental, vigencias y retención pendientes; no inventar verificación oficial, biometría o requisitos legales.
- Nuevo conductor pendiente no puede operar. SUPER_ADMIN revisa el snapshot documental y aprueba/rechaza; aprobado queda OFFLINE y se vincula únicamente unidad revisada, cumpliendo créditos/elegibilidad. No permitir alta/edición de unidad que eluda revisión. Sin saldo de regalo o aprobación por verificar correo.
- Solicitudes DRAFT/SUBMITTED/APPROVED/REJECTED/WITHDRAWN separadas del perfil operativo PENDING/APPROVED/SUSPENDED/REJECTED. Historial inmutable; una abierta. Recomendar reenvío inmediato tras rechazo/retiro sujeto a rate limit; suspensión sólo SUPER_ADMIN, sin terminar servicios activos.
- Drivers existentes reutilizan identidad sin perder flotilla. Usuarios de otros roles: login/soporte, nunca autoascenso ni conversión de rol. Multirrol/afiliación quedan fuera.
- Android abre la Web por entorno; primer retorno manual a la app, sin JWT en URL.

Trabajo solicitado:

Decisión posterior del propietario (prevalece sobre menciones anteriores a retención pendiente): incluir tarjeta de circulación, separada de comprobante de propiedad (factura/CFDI o carta factura como candidatos). Conservar archivos mientras exista cuenta y eliminarlos al darse de baja, incluso versiones/derivados. Diseñar baja autenticada y estado de purga sin prometer eliminación completa hasta confirmación backend; backups/plazo técnico requieren contrato explícito. Rechazo/suspensión no equivalen a baja. No borrar servicios por cascada. Ver precisión al inicio de §10; no aplicar cambios reales.

Ampliación documental: diseña wizard con borrador y carga privada de rostro/INE/unidad, reintentos y previsualización segura; checklist y evidencia versionada del revisor. Analiza acceso sólo propietario/SUPER_ADMIN, URLs temporales, limpieza al cambiar sesión y prohibición de caché local de documentos. Sin documentos reales en pruebas. Propón notificación persistente en portal y email de resultado, con motivo detallado dentro del portal; fallo de email no cambia decisión. Inventaría endpoints faltantes de borrador/adjuntos/revisión/notificación; no simules que ya existen. Incluye pruebas futuras de acceso cruzado, sustitución tras envío, cuarentena, archivos inválidos y elusión de revisión mediante edición de vehículo.
1. Inventaría archivos, rutas, DTO, guards, invitaciones, ProviderScope, DriverSelf y cachés que presuponen proveedor. Distingue flota, perfil dual y nuevo independiente.
2. Diseña pantallas: registro/verificación, formulario/estado/historial/retiro, rechazo/corrección y bandeja/detalle/decisión SUPER_ADMIN. Propón rutas (por ejemplo /driver/register y /driver/onboarding) marcadas como candidatas; comprueba colisiones y comunica destinos exactos para Android.
3. Diseña acceso de DRIVER pendiente fuera del guard operativo APPROVED, sin exponer ofertas o datos ajenos. provider null legítimo es distinto de respuesta incompleta/error.
4. Define matriz por actor/estado, estados de carga/error/429/conflicto y accesibilidad móvil/teclado. No confíes en rol JWT como aprobación vigente.
5. Detalla recuperación: idempotencia/cuerpo original, consultar antes de repetir, recibo histórico separado del estado vigente, no doble solicitud, caché por usuario y limpieza/aislamiento al cambiar sesión. Lista endpoints faltantes; no inventes API disponible.
6. Preserva servicios comprometidos, GPS, hitos, créditos, cinco intentos y alta de flotillas. Nada de proveedores ficticios o permisos amplios por provider null.
7. Prepara matriz de pruebas futuras: null, pendiente, rechazo/retiro, aprobación, decisiones concurrentes, respuesta perdida/recarga/cambio de cuenta, perfil dual, flota existente y permisos SUPER_ADMIN.

Entregable: docs/INDEPENDENT-ONBOARDING-WEB-PROPOSAL.md con inventario real, pantallas/textos, rutas candidatas, matriz, dependencias exactas backend, handoff Android y plan de validación. Actualiza continuidad en BITACORA y VERIFICATION preservando historial; enlaza desde README cuando corresponda. Distingue inspección de pruebas ejecutadas.

Sin código de producto, migraciones, OpenAPI publicado, configuración/.env, datos/servicios reales, backend/app, commit, push, despliegue ni mensajes a otros agentes. No correr suites funcionales para acreditar un diseño no implementado. Reporta recomendaciones que requieran decisión y bloqueos contractuales antes de programar.
