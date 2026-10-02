# Ejecución logística detallada — propuesta para revisión

Fecha: 2026-10-02. Sólo análisis; nada implementado ni activado. Sin versión asignada: BITACORA registra que V1.11/V1.12 cambiaron de alcance y el lifecycle se pospuso; package.json sigue en 1.12.0 aunque existen entregas V1.13. No deducir la siguiente versión de ese número.

El propietario confirma configuración comercial posterior al reset completada y probada. Es evidencia del propietario, no una prueba ejecutada en esta revisión. No se accedió a Coita ni a la VM.

## 1. Qué existe y qué falta

Rutas siguientes con prefijo `/api/v1`. Referencias relativas al repositorio backend.

| Flujo real | Fuente y contrato actual |
|---|---|
| Aceptación | `src/delivery-quotes/authorized-acceptance.service.ts` y `delivery-quotes.service.ts`: aceptar MQ y abrir Dispatch son transaccionales; la aceptación convertida exige atestación vinculada a la cotización. No acredita recogida ni cobro. |
| Publicación | `src/dispatch/dispatch-policy.ts`, `openDispatch`: congela candidaturas y créditos. `OPEN` vence para adjudicación; un `CLAIMED` no vence por esa ventana. |
| Proveedor | `POST /provider/dispatches/:dispatchId/claim`: adjudica al proveedor, sin asignar conductor. `POST .../assignment` asigna Driver/Vehicle. |
| Independiente | `POST /driver/dispatches/:dispatchId/take`: claim y asignación ACTIVE juntos. No representa salida física. |
| Reasignación | `POST /provider/dispatches/:dispatchId/assignment/reassign`: termina la anterior como REASSIGNED y crea ACTIVE; no sobrescribe historia. Independiente no tiene reasignación. |
| Liberación | Proveedor: cancelar asignación antes de `POST .../release`; independiente: `POST /driver/dispatches/:dispatchId/release` termina asignación y libera claim atómicamente. Vuelve a OPEN o EXPIRED; quien liberó no retoma. Devuelve créditos según reglas existentes. |
| Cancelación | `POST /delivery-requests/:publicId/cancel` (B2B propio) y `/admin/delivery-requests/:publicId/cancel` (SUPER_ADMIN). `delivery-requests.service.ts` bloquea solicitud; `closeDispatchesForCancelledRequest` cierra OPEN/CLAIMED y asignaciones, con refund cuando corresponde. Actualmente no conoce custodia. |
| Entrega | `POST /provider/dispatches/:dispatchId/deliver` y `/driver/dispatches/:dispatchId/deliver`. `src/deliveries/delivery-completion.ts`: asignación COMPLETED + Dispatch DELIVERED + outbox `delivery.completed`, misma transacción. Repetir por dueño legítimo devuelve éxito sin duplicar evento. |
| Consulta B2B | `GET /delivery-requests/:publicId/status`, `src/deliveries/delivery-status.ts`: REQUESTED/OPEN/ASSIGNED/DELIVERED/CANCELLED/EXPIRED. ASSIGNED incluye claim de proveedor sin conductor. Entrega tiene precedencia sobre cancelación posterior de la solicitud. |
| Consulta humana | GET `/provider/dispatches`, `/provider/dispatches/:dispatchId`, `/driver/dispatches/:dispatchId`, `/driver/me`; historial `/provider/dispatches/:dispatchId/assignments` y `/admin/dispatches/:dispatchId/assignments`. |

`prisma/schema.prisma`: DispatchStatus y DeliveryAssignmentStatus controlan adjudicación y ocupación, no las cinco fases físicas. La migración `20260923001600_delivery_completion_rules` exige cierre consistente y terminal; existen además restricciones posteriores de outbox e identidad pública. No basta con añadir un enum al frontend.

Hoy proveedor administra asignaciones y confirma entrega mediante PROVIDER_ADMIN con membership; SUPER_ADMIN audita asignaciones, no asigna ni entrega. DRIVER sólo puede entregar su servicio independiente. `/driver/me` permite consultar la asignación activa de ambos modos, pero no autoriza al conductor de flotilla a usar las mutaciones independientes.

Hay comentarios históricos desactualizados: TAKE todavía dice que liberar no devuelve créditos, mientras release y servicio sí ejecutan refund; el comentario inicial de outbox dice que no hay worker, aunque existe el módulo de webhooks. Para esta propuesta prevalece el código ejecutable. Corrección editorial pendiente, no aplicada aquí.

## 2. Modelo recomendado

Conservar `Dispatch.status` y `DeliveryAssignment.status`. Añadir progreso ligado a **cada asignación**, manteniendo el Dispatch como punto de serialización. Nunca convertir CLAIMED/ACTIVE en prueba de movimiento.

| Fase propuesta | Persistencia y significado |
|---|---|
| Sin avance reportado | Derivado: asignación ACTIVE sin hitos. No llamarlo «en camino». Sin asignación: «pendiente de asignación». |
| `TO_PICKUP` | Persistir inicio reportado del trayecto a recogida. Distingue asignación de salida real. |
| `AT_PICKUP` | Persistir llegada reportada. Permite distinguir viaje y espera en comercio, sin GPS. |
| `PICKED_UP` | Persistir toma de custodia. Es la barrera operativa principal. No demuestra pago al restaurante. |
| `TO_DROPOFF` | Persistir salida reportada hacia destino. No derivarla de PICKED_UP: puede permanecer recogido esperando salir. Si negocio quiere un solo botón, tendría que aprobar renunciar a esa distinción; no fabricar dos hechos iguales. |
| `AT_DROPOFF` | Persistir llegada reportada al destino; no es entrega ni cobro. |
| `DELIVERED` | Derivar del cierre existente, con `Dispatch.deliveredAt`; no crear segundo estado terminal o fecha independiente editable. |

Las cinco fases son útiles si se pretende distinguir exactamente los momentos solicitados. «En tránsito» genérico sería redundante con TO_DROPOFF y no se agrega. Son declaraciones humanas, no localización verificada.

Propuesta mínima de persistencia futura: historial append-only `DeliveryExecutionEvent` relacionado con Dispatch y Assignment; última fase derivada del último hito de esa asignación (índice por assignment/sequence). Contador `executionRevision` monotónico por Dispatch para concurrencia; no una segunda máquina de estados económicos. La entrega puede añadir entrada de auditoría en la misma transacción, referenciada al cierre canónico, con su misma fecha; no un segundo comando de entrega.

## 3. Transiciones propuestas

Aplican a servicios que adopten seguimiento detallado, con dueño legítimo y asignación ACTIVE. Cada avance requiere la fase anterior. La columna actor remite a permisos de la sección 4.

| Origen | Acción / destino | Actor | Condiciones |
|---|---|---|---|
| Sin asignación | Asignar → sin avance | Administrador proveedor; TAKE para independiente | Reutilizar elegibilidad, ocupación y exclusividad actuales. |
| Sin avance | Salió a recogida → TO_PICKUP | Operador autorizado | No inferir salida al asignar. |
| TO_PICKUP | Llegó → AT_PICKUP | Operador autorizado | Misma asignación vigente. |
| AT_PICKUP | Recogió → PICKED_UP | Operador autorizado | Confirmación explícita de custodia en web. |
| PICKED_UP | Salió a destino → TO_DROPOFF | Operador autorizado | Mantiene responsable y recursos ocupados. |
| TO_DROPOFF | Llegó → AT_DROPOFF | Operador autorizado | No cierra ni libera recursos. |
| AT_DROPOFF | Entregar → DELIVERED | Actor actual de deliver | Reutilizar cierre atómico e idempotencia actuales; sin movimiento económico. |
| Sin avance / TO_PICKUP / AT_PICKUP | Cancelar asignación o reasignar | Administrador proveedor | Termina historial anterior; nueva asignación empieza sin avance, aunque conserve conductor. |
| Antes de PICKED_UP | Liberar servicio | Dueño según rutas actuales | Mantener diferencias proveedor/independiente y refunds actuales. |
| Antes de PICKED_UP | Cancelar solicitud | B2B dueño / SUPER_ADMIN | Misma transacción vigente, con nueva barrera común. |
| PICKED_UP / TO_DROPOFF / AT_DROPOFF | Cancelar, liberar, reasignar | Ninguno por flujo ordinario | Rechazo 409 propuesto; nada cambia, ni recursos ni ledger. Requiere decisión de incidencias. |
| DELIVERED / CANCELLED / EXPIRED | Nuevo avance | Ninguno | Terminal; no reabrir ni editar historia. |

Prohibidos: saltos, retrocesos, avance sobre asignación anterior, falsificar actor/fecha, avanzar sin dueño o tras liberar; entregar desde fase incompleta en modo detallado. Repetir una intención ya aplicada no es un salto ni un nuevo hito. Cancelación posterior a DELIVERED conserva comportamiento existente de la solicitud y proyección DELIVERED; jamás revierte entrega ni produce un refund nuevo por este diseño.

El orden estricto necesita aprobación: registrar cinco avisos impone carga al operador. Una llamada tardía puede reportar varios hechos, pero no se deben completar automáticamente los omitidos. Registrar cada hecho confirmado y mostrar que la hora es de registro, no inventar horas físicas.

## 4. Permisos y operación inicial

| Identidad | Avances propuestos | Entregar | Alcance |
|---|---|---|---|
| PROVIDER_ADMIN | Sí, por cuenta del conductor asignado | Sí, existente | Membership vigente y proveedor dueño; OWNER/ADMIN según acceso actual. Registrar User real y origen PHONE_REPORT. |
| DRIVER de flotilla | No en primera etapa | No, como hoy | Reporta por teléfono. Su lectura propia sigue disponible. Acceso directo futuro exigiría permiso explícito sobre asignación FLEET y decisión del propietario, no reutilizar TAKE. |
| DRIVER independiente | Sí | Sí, existente | Exclusivamente asignación INDEPENDENT propia; identidad desde JWT, nunca driverId libre. Puede usar web existente. |
| SUPER_ADMIN | Lectura/auditoría | No, como hoy | No suplantación ni bypass de custodia. Conserva cancelación administrativa sólo bajo barreras propuestas. |
| IntegrationClient | Ninguno | Ninguno | Consulta pública propia y cancelación según contrato; ningún scope B2B otorga ejecución humana. |

Para trabajos ya adjudicados, recomendar no volver a exigir APPROVED/eligibilidad de contratación en cada hito: suspensión posterior no debería impedir registrar la custodia o terminar. Siempre exigir cuenta humana ACTIVE, propiedad/asignación y autorización actuales. Si se revoca la cuenta o la última membership operadora, hace falta procedimiento de soporte; no resolver con privilegio implícito de SUPER_ADMIN.

## 5. Historia, reintentos y concurrencia

- Guardar id del evento, dispatchId, assignmentId, fase, sequence/revision, recordedAt UTC del servidor, actorUserId y rol/contexto al registrar, origen PHONE_REPORT o SELF_REPORT e identificador de correlación. Conductor responsable proviene de la asignación, distinto del operador que escribe. No guardar teléfonos, conversaciones, consentimiento ni cuerpos completos.
- En primera etapa no admitir fechas retroactivas: recordedAt es «registrado a las…», no prueba de hora real. Si se necesitan tiempos físicos para SLA, decidir protocolo de occurredAt declarado separado antes de añadirlo.
- Proponer comando autenticado con `assignmentId`, `phase`, `expectedRevision`, `idempotencyKey`; los nombres son diseño, no DTO existente. Clave durable única por actor+dispatch+operación; hash del intento y resultado. Misma clave/cuerpo devuelve resultado original sin repetir hechos; clave/cuerpo distinto → 409. Verificar autorización antes de revelar recibo histórico.
- Sin recibo previo: misma fase actual de misma asignación devuelve estado sin nuevo evento; fase anterior con clave nueva → conflicto, sin retroceder. Ante timeout: consultar detalle y reintentar exactamente la clave original. No generar otra intención hasta resolver la anterior.
- Bloqueo Dispatch → Assignment (y recursos sólo si corresponden), compatible con cierre/release actuales. Cancelación sigue Request → Dispatch → Assignment; los avances no deben adquirir Request después de Dispatch. Revalidar bajo bloqueo y comparar revision/asignación. Un cambio de asignación o de dueño incrementa revision.
- Carrera recogida/cancelación: quien gana el bloqueo define el resultado; cancelación primero impide recoger, recogida primero impide cancelar y refund. Mismo criterio para release/reassign. Carrera deliver/avance: terminal e historial coherentes; outbox/cierre/hito fallan juntos.
- Reforzar en PostgreSQL historia inmutable, relación evento/asignación/dispatch, unicidad de hito por asignación, transiciones y prohibición postcustodia en todas las rutas, no sólo botones. Revisar triggers existentes de asignaciones, cierre, créditos y outbox; no reemplazarlos a ciegas.

## 6. Custodia, fallos y dinero

Antes de recoger se mantiene liberación/reasignación existente. Nueva asignación reinicia progreso; el anterior queda histórico y no se atribuye al nuevo conductor. Después de recoger, bloquear también cancelar la asignación como atajo para release, incluso cambiando sólo el vehículo.

**Decisión bloqueante:** qué hacer si tras recoger hay avería, destinatario ausente o entrega imposible. Recomendación acotada: conservar fase y asignación, escalar a responsable operativo; no marcar entregado/cancelado para liberar recursos. Esto puede mantener conductor/vehículo ocupados y no resuelve definitivamente la incidencia. Antes de activar debe acordarse quién decide y qué procedimiento aprobado resuelve la custodia; si requiere una nueva capacidad, diseñarla aparte. No agregar FAILED, devolución, transferencia de custodia, entrega parcial ni bypass administrativo silencioso.

Los avances no cobran, no calculan rutas y no generan ledger. Refunds existentes siguen en operaciones permitidas; una operación rechazada no devuelve créditos. PREPAID significa comida pagada; CASH/COURIER_ADVANCE y el contexto monetario no cambian. `collection-instructions.ts` sigue siendo fuente de instrucciones (OFFER/CURRENT/HISTORICAL); llegada o DELIVERED no acreditan cobro. Cancelado/entregado debe mostrar instrucciones históricas, nunca botón de cobro implícito. Aceptación de MQ, recepción física y confirmación financiera son hechos distintos.

## 7. Compatibilidad y contrato B2B

Proponer marcador inmutable por Dispatch `executionTrackingMode=LEGACY|DETAILED`, independiente de creditMode. Migración asigna LEGACY a existentes; nuevos servicios sólo DETAILED tras habilitación coordinada explícita. No fabricar hitos de históricos ni obligar trabajos en curso a reconstruirlos. Los LEGACY conservan cierre directo actual; prohibir registrar hitos nuevos sobre ellos evita una recogida conocida con reglas antiguas de liberación. Mostrar «sin seguimiento detallado» claramente. Esto mantiene transitoriamente la limitación de custodia de los servicios legacy; operación debe conocerla.

Cambiar requisito de deliver/cancel en DETAILED es cambio conductual real, aunque el JSON sea aditivo: coordinar web e integraciones, documentar nuevos 409 antes de habilitar. No cambiar TTL de MQ/dispatch ni idempotencia C2.

Conservar los seis `status` B2B y `execution` de identidad. Añadir campo opcional/nullable separado, p. ej. `executionProgress`, sólo fase pública, registeredAt y revisión monotónica. Sin IDs internos, actor, canal telefónico ni historial privado. Mientras está en ejecución status sigue ASSIGNED. Sin asignación vigente o legacy: null. Cancelación: progreso vigente null; último hito sólo histórico interno. DELIVERED procede del cierre canónico, aun si es legacy sin fases intermedias.

Primera entrega recomendada: GET `/delivery-requests/:publicId/status` con proyección aditiva y consulta periódica; **no hace falta webhook nuevo para operar la web**. Mantener `delivery.completed`, su payload histórico, firma, eventId e idempotencia intactos; no volver a serializar eventos ya guardados. Hoy `b2bEventPayload` enumera campos, lo que permite no propagar automáticamente el nuevo campo al evento.

Si negocio necesita avisos inmediatos al consumidor, proponer después `delivery.execution.updated`, con evento por revisión, payload seguro congelado y outbox en la misma transacción. Requiere ampliar enum/constraints/filtros y publicación por suscripción o capacidad aprobada; no enviar tipos desconocidos a receptores actuales automáticamente. Consumidor deduplica persistentemente por eventId y descarta progreso anterior por revisión, porque no debe asumir orden de recepción. Nunca reutilizar delivery.completed para cada paso. Portal público/OpenAPI/exportador y pruebas de privacidad necesitan actualización; aquí no se generaron contratos.

## 8. Handoff frontend (propuesto, no implementado)

Superficies leídas en checkout hermano: `src/dispatch/service.ts`, `src/dispatch/pages.tsx` y familia `types/queries/rules/components`; `src/delivery-assignments/panel.tsx`; `src/driver-portal/service.ts` y familia `pages/types/queries`; auditoría `src/dispatch/admin.tsx`. Los archivos de UI se localizaron; no hubo build ni inspección visual.

- Detalle del servicio del proveedor: fase visible, conductor asignado, hora de registro y timeline por asignación. Separar bloques «progreso» e «instrucciones financieras».
- Botón único de próximo paso: «Registrar salida a recogida», «Registrar llegada a recogida», «Confirmar pedido recogido», «Registrar salida a destino», «Registrar llegada a destino», «Confirmar entrega». Confirmación de custodia y cierre explícitas; texto «Aviso recibido del repartidor por teléfono». No atribuir el registro al conductor.
- Independiente: misma secuencia en web, origen SELF_REPORT. Flotilla: sin nuevos botones para DRIVER en primera etapa. SUPER_ADMIN: timeline sólo lectura.
- Consumir proyección en detalles existentes; mutaciones propuestas `POST /provider/dispatches/:dispatchId/execution-events` y `/driver/dispatches/:dispatchId/execution-events`, restringiendo esta última a independiente. Reutilizar `/deliver` para cierre; no enviar DELIVERED al endpoint nuevo. Contratos definitivos pendientes de implementación backend.
- Backend debe entregar fase, trackingMode, revision, assignment vigente y acciones permitidas. Botones derivan de ello, pero la seguridad reside en servidor. Ante 409 refrescar; ante respuesta incierta conservar clave y consultar; evitar doble clic sin sustituir idempotencia durable.
- Reasignación inicia timeline nuevo, conserva anterior como histórico. Tras PICKED_UP ocultar mutaciones incompatibles y mostrar contacto de soporte acordado. Servicios legacy conservan controles existentes y aviso de seguimiento no disponible.
- Probar dos operadores con pestañas abiertas, llamada tardía, timeout tras commit, cambio de conductor y cancelación recibida mientras el formulario estaba abierto. No actualizaciones optimistas que muestren recogida/entrega antes del éxito.

## 9. Implementación y verificación por etapas (sin numeración de versión)

1. **Acordar contrato y custodia:** resolver decisiones siguientes; definir DTOs/errores/proyección, compatibilidad y activación. No iniciar implementación asumiendo aprobación de recomendaciones.
2. **Backend:** migración incremental para marcador/revisión/historia/idempotencia; servicio común de avances, guards y barreras en cancel/release/reassign/deliver. Extender proyecciones humanas/B2B y OpenAPI. Invariantes DB y atomicidad antes de UI; no nueva semántica financiera.
3. **Web y puesta en servicio coordinada:** implementar pantallas, recorridos reales con operador y pruebas de contrato. Migrar con modo legacy por defecto, actualizar todas las instancias escritoras y frontend antes de nuevos DETAILED. Deshabilitar nuevos detallados no degrada los que están en curso. Rollback no puede arrancar código antiguo que ignore custodia; conservar esquema/historia y código capaz de cerrar los detallados. Si no hay compatibilidad demostrada, detener escrituras, no mezclar instancias.

Pruebas necesarias, **no ejecutadas en esta revisión**:

| Área | Casos mínimos |
|---|---|
| Máquina | Cada transición; saltos/retrocesos; sin asignación; terminales; secuencia estricta sin hechos inventados. |
| Roles | Provider ajeno, membership retirada, flotilla denegada, independiente propio/ajeno, SUPER_ADMIN sin escritura, JWT B2B rechazado. |
| Historia | Actor operador distinto del conductor; timestamps del servidor; inmutabilidad; reasignación antes de recogida reinicia; no datos privados B2B. |
| Carreras | Dos operadores misma/distinta fase; recogida vs cancelar/release/reassign; respuesta perdida y misma clave; asignación obsoleta; entrega repetida con un solo outbox. |
| Custodia | Rechazo postrecogida por todas las rutas incluyendo cancel B2B/admin y cancel assignment; sin refund ni recursos liberados; rollback forzado de evento/outbox. |
| Compatibilidad | Legacy en curso/entregado, PREPAID convertido, CASH/COURIER_ADVANCE, misma MQ/precio/TTL, créditos y refunds exactos; cero cobros por avances. |
| Migración | Base limpia y actualización con historia/servicios en curso; SQL directo no elude invariantes; protocolo de despliegue y reversión con DETAILED existente. |
| UI/contrato | Archivos completos afectados; proyecciones proveedor/independiente/driver-self/admin; exportador público, tipos, lint/build y pruebas visuales web. |

Reutilizar y ampliar tests `delivery-completion`, `delivery-assignments`, `dispatch`, `independent-drivers`, `credit-refunds`, `delivery-status`, `b2b-delivery-status`, `b2b-outbox`, aceptación autorizada e instrucciones de cobro. El alcance exacto de regresión dependerá de archivos modificados. No reutilizar resultados históricos como pruebas nuevas.

## 10. Decisiones del propietario

1. **Cinco avisos obligatorios o simplificación:** recomiendo conservar cinco si la distinción pedida es requisito, con horas de registro y sin retroactividad inicial. Confirmar que el operador puede registrar cada aviso.
2. **Custodia e intentos fallidos (bloqueante para activación):** aprobar bloqueo de cancelación/liberación/reasignación tras recogida, incluido SUPER_ADMIN/B2B, y definir responsable/procedimiento cuando no se puede entregar. Sin esa decisión no queda resuelto el ciclo operativo completo.
3. **Quién opera:** recomiendo primera etapa PROVIDER_ADMIN por teléfono e independiente por web, flotilla sin mutaciones directas y SUPER_ADMIN sólo auditoría de progreso. Confirmar si se necesita ampliar alguno; no viene concedido por su rol actual.
4. **Notificaciones externas:** recomiendo consulta B2B aditiva primero. Confirmar si Coita necesita avisos inmediatos para incluir el nuevo evento y su coordinación externa en el alcance inicial.

Resultado: propuesta lista para revisión del propietario; no implementación autorizada ni funcionalidades activadas. La configuración comercial completada no resuelve estas decisiones nuevas de operación.
