# Dependencias de validación de repartidores — base main

2026-10-13. Rama feature/driver-verification creada en worktree separado desde origin/main 1fa2cb1, coincidente con main local después de fetch. Referencia comparada: origin/QA 9ad39b9. Main:32 migraciones; QA:46. package.json base1.12.0 conservado, sin asignar versión nueva. No merge ni cherry-pick.

## Alcance trasladado

Se copiaron exclusivamente INDEPENDENT-ONBOARDING-PROPOSAL.md y prompts WEB/APP desde el checkout QA con cambios locales. Sus referencias QA y consumidores externos son evidencia histórica, no capacidades de main. Los documentos quedaron con aviso de base y ruta al nuevo worktree. No se copiaron BITACORA/README/VERIFICATION de QA: se añaden entradas nuevas a los documentos propios de main. No se trasladaron código, migraciones, .env, node_modules ni datos. Originales en QA conservados, no eliminados.

## Matriz de dependencias

| Capacidad | Main / evidencia | Diferencia QA y decisión para esta rama |
| --- | --- | --- |
| Flotillas, Driver, Vehicle, memberships/invitaciones | Ya existen en src/drivers, vehicles, providers, invitations | Reutilizar base. Driver.providerId obligatorio y disponibilidad exige proveedor activo en ambas ramas; nullable/alta independiente son trabajo nuevo, no algo que QA resuelva. |
| Operación independiente, vehículos propios/créditos | src/independent-drivers y credits; perfil sobre Driver existente | Ya presentes. No importar toda ejecución QA para alta autónoma. Revisar todos los guards/SQL al diseñar null. |
| Solicitudes comerciales de colaboración | src/partner-applications, SOC, INDIVIDUAL/FLEET, estados RECEIVED/CONTACTED/APPROVED/REJECTED/DISCARDED | No equivalen al expediente versionado de identidad/unidad. Preservar contrato SOC; diseñar vínculo opcional, no reutilizar APPROVED como habilitación documental. |
| Autenticación/activación y correo | Auth, invitations, emailVerifiedAt y Resend HTTPS/local outbox | Main permite aprovechar primitives, pero no trae registro/verificación customer de QA ni nuevo registro DRIVER. Diseñar alta/confirmación mínima en esta rama sin importar CUSTOMER ni su política comercial. |
| Notificación de resultado | MailProvider sólo sendUserInvitation y sendPartnerApplicationNotice | Añadir contratos/plantillas y cola durable específica de decisión. No reutilizar invitación como decisión ni outbox B2B como correo privado. QA tampoco acredita expediente/notificación documental. |
| Idempotencia humana y recuperación de intentos | src/idempotency base orientada a integrationClientId/B2B | QA añade human-attempt.ts, customers/command-attempts y independent-attempts. Son referencia de diseño; NO importar módulos completos ni migraciones dependientes. Falta diseñar recibo/consulta/cierre propio del expediente, con actor, versión y cuerpo original. |
| Estados GPS/hitos/custodia detallada | No src/location ni src/delivery-execution; operational-tracking.ts devuelve null/LEGACY por historial | QA tiene DETAILED, GPS, devoluciones e incidencias. No son prerrequisito de validación documental. No añadir ni prometer esos endpoints en esta entrega. Preservar operación legacy de main; coordinación futura con QA debe tratarse aparte. |
| Clientes directos y aprobación Negocio | No src/customers ni src/business-approval | QA sí; fuera del alcance. Conceptos de revisión/recuperación pueden orientar diseño, pero no convertirlos en dependencia de producto. |
| Búsqueda automática cinco intentos | Migración20261010000100_automatic_dispatch_search y servicios presentes | Ya disponible en main; no traer reconciliación QA de ejecución/búsqueda. Revisión documental no cambia rondas, claim, precio, historial ni cancelación. |
| Archivos privados, revisión de identidad/unidad, purga | No módulo encontrado en inspección src para upload/attachment/S3; no modelo de expediente en propuesta implementado | Capacidad nueva en ambas bases: almacenamiento/cuarentena/autorización/snapshots/checklist/retención. Proveedor de almacenamiento y contrato pendientes; no configurar infraestructura ahora. |

Las14 migraciones adicionales de QA incluyen cambios acoplados de ejecución, clientes, GPS, reconciliación de búsqueda y Negocio. Copiarlas para obtener una utilidad aislada no es una migración válida de esta iniciativa. No se certificó audit exhaustivo de todos los triggers; se requiere antes de código.

## Ajustes que deben asumir los prompts

1. Leer la propuesta desde ESTE worktree. Rutas src mencionadas como hallazgos QA deben comprobarse de nuevo en main. Las rutas relativas ../mandaria-frontend y ../mandaria-driver de la propuesta describen checkouts históricos en C:/Users/zorgl/Documents, no hermanos del worktree.
2. Web/App deben confirmar sus propias ramas y la versión backend objetivo. Los clientes actuales observados en QA incluyen pantallas/contratos que main no proporciona: no afirmar compatibilidad integral de esas versiones contra main. Elaborar matriz por endpoint y definir base de cliente antes de implementar, sin merge automático.
3. La preservación de GPS/DETAILED en prompts significa no romper o modificar esas capacidades en clientes que las tengan; no autoriza implementarlas en este backend. Pruebas de esta rama acreditarán sólo contratos realmente presentes.
4. Verificación documental por recurso, identidad/pending/null, notificaciones y baja/purga son contratos NUEVOS a cerrar. Rutas anteriores son candidatas, no OpenAPI disponible.
5. Decisiones aún pendientes: recursos existentes, evidencia de propiedad empresarial, baja por conductor/unidad/proveedor, backups, documentos por tipo y política de vencimiento. La ampliación a flotilla está autorizada para diseño; ninguna decisión pendiente bloquea este traslado documental.

## Secuencia recomendada sin importar QA

Cerrar diseño contra main → inventario completo de guards/SQL y contratos de clientes → aprobar modelo independiente y revisiones separadas Driver/Vehicle → diseñar carga privada/retención y notificaciones → definir recuperación humana local al dominio → contrato OpenAPI candidato y pruebas planificadas → autorización explícita antes de implementar. No incrementar versión ni crear migración en esta etapa.

## Verificación de esta tarea

Fetch main/QA, inspección de refs/log/diff/tree, lectura de AGENTS/continuidad de ambos checkouts y servicios relevantes de main. Conteo32/46 migraciones. Rama creada desde1fa2cb1 y verificada; sólo diferencias documentales. Sin suites/build, Docker/PostgreSQL, servicios, documentos personales, acceso Coita/VM, commit/push ni despliegue. Evidencia funcional anterior en VERIFICATION es histórica.
## Impacto Landing — lectura 2026-10-13

Inspección de sólo lectura en C:/Users/zorgl/Documents/mandaria-landing: src/lib/api.ts envía INDIVIDUAL/FLEET a POST /api/v1/public/partner-applications; Socios.tsx muestra folio y aviso de contacto para completar registro/verificar documentos. Hero/Nav enlazan a #socios. Ese formulario de contacto ya existe en main; no es expediente ni aprobación operativa. No se verificó rama/HEAD de Landing ni se ejecutó navegador.

Recomendación: preservar solicitudes SOC y no convertirlas silenciosamente en expediente aprobado. Cuando existan contrato y rutas Web, añadir CTA por entorno para iniciar/continuar expediente autenticado y explicar identidad/unidad/aprobación SUPER_ADMIN por separado. Para flotilla, distinguir solicitud de alta del proveedor de altas de sus recursos una vez autorizado; no presentar un CTA que conceda PROVIDER_ADMIN. No recabar rostro/INE/propiedad en Landing pública. Revisar FAQ, éxito del formulario, aviso y nomenclatura; no prometer activación inmediata ni garantía de autenticidad. Ruta Web final y vínculo opcional SOC→expediente pendientes, no inventarlos.

Cuenta Negocio existente en Landing pertenece a otra iniciativa y puede depender de QA: no retirarla ni trasladar su backend para resolver este alcance. Si se pretende desplegar Landing actual contra main, requiere su propia matriz de compatibilidad. Este análisis no cambia su código ni configuración y no acredita integración real.
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
## Informe Landing recibido — 2026-10-13

Leído C:/Users/zorgl/Documents/mandaria-landing/docs/DRIVER-VERIFICATION-LANDING-COMPATIBILITY.md. Reporte estático, no pruebas HTTP: SOC compatible con main, recibe contacto sin adjuntos y no concede aprobación documental. Recomienda futura base Landing maineb104bd y configuración mínima de origen Web por entorno (main aún fija login a producción); sin importar QA/Cuenta Negocio. La configuración VITE_WEB_URL de QA es referencia, no permiso de cherry-pick.

Conservar SOC mientras faltan APIs y rutas Web reales; no confundir deduplicación comercial SOC con idempotencia de expediente ni aprobar identidad al aprobar contacto. CTA de expediente sólo después de confirmar rutas y backend compatibles. No subir INE/rostro en Landing ni publicar promesa de activación, autenticidad oficial o borrado inmediato de backups. No retirar Cuenta Negocio de QA por esta iniciativa. Ninguna base cliente recomendada se creó/implementó por recepción del informe.

Con los tres informes recibidos: backend desde main; Web main con adaptación DETAILED acotada; Landing main con origen Web por entorno; Android sigue bloqueante por protocolo operativo y requiere decisión de base/adaptación separada. El diseño documental no equivale a autorizar escrituras móviles contra main. Pendientes comerciales y técnicos de §11 del diseño backend permanecen; publicación coordinada después de contratos e integración sintética real, no por compatibilidad estática.
## Actualización de implementación — 2026-10-13

El backend local autorizado se describe en [DRIVER-VERIFICATION-IMPLEMENTATION.md](DRIVER-VERIFICATION-IMPLEMENTATION.md), con rutas efectivamente implementadas, límites y handoff. Las rutas candidatas/secciones de diseño anteriores quedan como historia; no confundirlas con el contrato final. Web/App no fueron implementados. Baja/purga, textos definitivos e integración real siguen pendientes; producción no habilitada.
