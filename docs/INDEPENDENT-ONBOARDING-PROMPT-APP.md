# Prompt para Mandaria Driver Android — sólo análisis y documentación

> Base vigente: feature/driver-verification desde main 1fa2cb1, 32 migraciones. QA 9ad39b9 es referencia histórica de diseño, no dependencia integrada. Leer DEPENDENCIES-DRIVER-VERIFICATION.md antes de usar contratos de QA; GPS, hitos DETAILED, clientes directos y aprobación Negocio no existen en esta base. Sólo documentación, sin implementación.

**Ampliación vigente:** misma validación documental para FLOTA. PROVIDER_ADMIN presenta identidad y unidades desde Web; SUPER_ADMIN decide por recurso. Leer §11, que prevalece sobre la preservación del alta de flota como alcance intocable. Android debe analizar estados/bloqueos documentales de identidad y unidad, diferenciarlos de disponibilidad y conservar ejecución/GPS/recuperación de servicios activos. No otorgar permisos de carga empresarial ni aprobación al conductor. No copiar documentos a caché operativa. Transición de existentes, notificaciones al conductor y baja/purga por titular pendientes de contrato. Sólo documentación.

Analiza y documenta soporte para repartidor independiente sin proveedor y aprobación exclusiva SUPER_ADMIN. NO implementes todavía.

Lee AGENTS.md, BITACORA.md, README.md y VERIFICATION.md si existen; confirma rama, HEAD y cambios locales, preservando ajenos sin reset ni cambio de rama sobre trabajo sin resolver. Referencia de sólo lectura: C:/Users/zorgl/.codex/worktrees/driver-verification/mandaria-backend/docs/INDEPENDENT-ONBOARDING-PROPOSAL.md, particularmente §9. Las recomendaciones no son contrato aprobado/implementado.

Contexto: hoy Driver requiere proveedor; se propone provider null para nuevo independiente. DriverApi.kt ya usa optJSONObject para provider, pero esto no demuestra compatibilidad de navegación, disponibilidad ni permisos. Backend todavía requiere ajuste de modelo y disponibilidad. Mantener operación existente independiente/flotilla.

Base recomendada:
- Registro completo en Web responsive, con verificación de email y solicitud manual. Android abre URL Web configurada por entorno; nunca dominio de producción fijo ni tokens en URL. Retorno manual a app/login inicialmente; no asumir deep links existentes.
- Nuevo Driver pendiente tiene sesión para consultar onboarding, sin ofertas/toma/GPS. SUPER_ADMIN aprueba desde Web; al aprobar queda OFFLINE y necesita vehículo propio y requisitos actuales de crédito/elegibilidad.
- Separar estado de solicitud de autorización operativa. Rechazo/retiro permiten nueva solicitud según permisos/backend; suspensión requiere SUPER_ADMIN y no destruye custodia/servicios activos.
- La propuesta revisada exige expediente privado: rostro, INE, datos de unidad y acreditación de propiedad; ver §10. No biometría/liveness automático ni validación oficial implícita. Sin cobros nuevos. Existentes conservan identidad/flotilla; otros roles no se convierten automáticamente. Multirrol fuera de esta etapa.

Trabajo:

Decisión posterior: tarjeta de circulación y comprobante de propiedad se recaban separadamente en Web. Archivos se conservan mientras exista la cuenta y se eliminan con su baja; no por simple logout, rechazo o suspensión. Documentar baja autenticada, estado de eliminación y limpieza de temporales/previews de app; respetar contrato de purga backend y no prometer borrado de backups instantáneo. No alterar servicios activos ni su recuperación. Ver precisión vigente al inicio de §10; sólo diseño.

Ampliación documental: analiza alta Web con captura/selección de archivos desde navegador móvil, alternativa cuando no hay permiso de cámara y reanudación de borrador, sin implementar captura nativa adicional. No guardar documentos/URLs privadas en cachés operativas, marcadores de recuperación, logs ni GPS. Diseña estado/notificación persistente de aprobación/rechazo y reconsulta al volver; correo vía backend recomendado, push sólo si se documenta soporte y se aprueba alcance. Sólo unidad revisada queda habilitada; inventaría alta/edición de vehículo que podría eludir revisión. Resultado no depende de que llegue email. Conserva servicios activos ante revisión/renovación y prueba aislamiento tras cambio de cuenta con evidencia sintética.
1. Inventaría DTO/parser, sesión, navegación, DriverProfile, disponibilidad, vehículos y portal independiente. Señala todos los supuestos de provider obligatorio y diferencia null válido de campo ausente/respuesta inválida.
2. Diseña CTA de registro, apertura Web por entorno y pantallas de estado: pendiente, rechazada, retirada, aprobada, suspendida y fallo de consulta. Proponer reconsulta tras volver del navegador/foreground, sin logout por estado pendiente ni aprobación optimista.
3. Documenta dónde el guard actual impide entrar al pendiente y cómo separar onboarding del área operativa. No crear formularios administrativos ni aprobar desde app.
4. Define protección de sesión/caché al cambiar usuario, estado durable tras muerte de proceso y recuperación. Backend es autoridad de permisos; no habilitar operaciones sólo por ausencia de flotilla o por rol DRIVER.
5. Conserva GPS explícito por servicio, hitos, asignación/custodia, términos/cobro existentes, toma/liberación y marcadores de intentos. No iniciar ubicación por registro, aprobación o disponibilidad. Una revisión de solicitud no cancela ejecución previamente autorizada.
6. Coordina documentalmente con rutas candidatas Web, sin asumir que existen. Enumera campos/endpoints/errores y recuperación que backend debe cerrar antes de implementación. No modificar configuración real para simular datos.
7. Diseña pruebas futuras unitarias/contrato/UI y nativas: provider null, perfil dual/flota, pendiente con sesión válida, transición de aprobación, suspensión con servicio, regreso de navegador, red perdida, proceso muerto y cambio de cuenta. Distingue fixtures, backend real aislado y dispositivo físico.

Entregable: androidApp/INDEPENDENT-ONBOARDING-IMPACT.md con inventario por archivo, pantallas/estados, navegación Web, dependencias contractuales, riesgos y matriz de pruebas. Actualiza README/BITACORA y VERIFICATION si existe, conservando historial. Entrega pendientes de decisión y alcance Android real; no afirmar compatibilidad iOS por inspección Android.

Sólo documentación. Sin Kotlin/producto, Gradle/dependencias, .env/local.properties, backend/Web, DB, servicios reales, migraciones, build/pruebas de producto, commit, push, despliegue ni mensajes a otros agentes. No programar hasta aprobación del diseño y publicación del contrato backend definitivo.


Decisión posterior aprobada: existentes y nuevos sin revisión de identidad/unidad no reciben nuevas asignaciones desde activar revisión, SIN gracia. Mantener servicios activos, sesión y recuperación; no inventar aprobación de existentes. Reasignar requiere recursos destino revisados y TAKE independiente también. Prevalece sobre menciones previas de transición pendiente. Sólo documentar; no activar ni implementar.


Decisión aprobada 2026-10-13: licencia vigente obligatoria para conductor de unidad motorizada, independiente o flotilla. Pertenece a identidad, con revisión SUPER_ADMIN de titular/categoría/vigencia y chequeo backend en cada nueva asignación/TAKE. Renovación versionada no concede aprobación automática. Vencida bloquea nuevo servicio motorizado, no cierre del activo; bicicleta no motorizada excluida, OTHER no permite bypass. Consultar sección vigente del diseño para catálogos pendientes y razones de bloqueo. Archivo privado, nunca caché operativa/GPS; sólo análisis documental, sin implementación.


Actualización aprobada: admitir unidades propias/rentadas/prestadas y exigir términos y condiciones para todos. Ver sección vigente del diseño: aceptación versionada previa a expediente, sin suplencia automática del proveedor por conductor; autorización del dueño/contrato de renta separados. Mecanismo de firma, texto final y matriz precisa de firmantes pendientes. No inventar validez legal o equivalencia con firma avanzada. Sólo análisis/documentación; no implementar.


Decisión vigente aprobada: aceptación electrónica en Web mediante texto completo, casilla sin premarcar y botón explícito; conductor acepta personalmente y representante por flotilla, ámbitos/evidencias separados. No PDF firmado para términos ni suplencia del proveedor. Versionado/actor/fecha servidor e idempotencia, sin aprobación operativa automática. Android sólo consulta estado tras volver de Web. Texto final y retención del recibo pendientes. Prevalece sobre mecanismo/firmantes antes pendientes; sólo documentación.

## Actualización de implementación — 2026-10-13

El backend local autorizado se describe en [DRIVER-VERIFICATION-IMPLEMENTATION.md](DRIVER-VERIFICATION-IMPLEMENTATION.md), con rutas efectivamente implementadas, límites y handoff. Las rutas candidatas/secciones de diseño anteriores quedan como historia; no confundirlas con el contrato final. Web/App no fueron implementados. Baja/purga, textos definitivos e integración real siguen pendientes; producción no habilitada.
