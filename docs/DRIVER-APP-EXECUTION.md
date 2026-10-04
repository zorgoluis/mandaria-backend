# Ejecución por repartidor — contrato APP y transición WEB

Cambio solicitado por el propietario, preparado sobre QA `d440aef`. Implementación local sin publicar ni activar. Sustituye la decisión anterior de que el administrador registrara hitos telefónicos. No incluye construcción de app, GPS, notificaciones push, pruebas con Coita ni operación offline completa.

## Autoridad y compatibilidad

- DRIVER de flotilla **o** independiente registra su asignación vigente. El servidor obtiene User desde JWT y Driver desde la base; no acepta un actor enviado por el cliente. En flotilla comprueba pertenencia al proveedor de la asignación.
- PROVIDER_ADMIN conserva lectura, asignación/reasignación ordinaria antes de recogida y reporte de incidencias recibidas con identidad propia. No avanza ni entrega una ejecución detallada. SUPER_ADMIN consulta y resuelve excepciones; no suplanta al repartidor.
- No se exige de nuevo elegibilidad comercial al custodio que necesita terminar un servicio ya adjudicado. Usuario autenticado debe seguir activo y con rol DRIVER. Un receptor nuevo sí debe cumplir elegibilidad y disponibilidad bajo locks.
- Transferencia conserva fase, cadena e importe original. El receptor continúa desde ese punto; no hace TAKE, no recoge otra vez ni paga otro award. El anterior pierde escrituras nuevas, pero puede consultar/repetir **su recibo histórico** sin efectos nuevos.
- TAKE, RELEASE, listado de ofertas y vehículos independientes conservan la capacidad APPROVED existente. Tener DRIVER o recibir una transferencia de flotilla no concede esa capacidad.

**Legacy explícito:** sin `DeliveryExecution`, no se inventan hitos ni custodia. El proveedor conserva `/provider/dispatches/:id/deliver` y el independiente `/driver/dispatches/:id/deliver`, con su autorización/idempotencia natural anterior. El Driver asignado también puede cerrar legacy con el nuevo comando y `expectedRevision: 0`. Los cinco hitos y las incidencias detalladas no se admiten sobre legacy. Las nuevas asignaciones siguen la admisión `DETAILED_EXECUTION_ENABLED`; el flag no elimina reglas de ejecuciones ya detalladas.

En detallado, el antiguo POST de entrega del proveedor devuelve **403** y el del independiente **409 EXECUTION_COMMAND_REQUIRED**. La ruta antigua de hitos del proveedor devuelve **403**. Es una retirada deliberada de permisos, no un fallback de UI. No hay fecha automática de retirada del cierre legacy; mantenerla hasta agotar esos servicios y una decisión posterior explícita.

## Lecturas para la app

Base `/api/v1`, Bearer **humano**. Esquema OpenAPI completo: [openapi.json](openapi.json), no el contrato público B2B.

| Método y ruta | Uso / respuesta |
|---|---|
| GET `/driver/me` | Identidad Driver, contexto de proveedor/vehículo, capacidad `independent`; `activeDeliveryAssignment` nullable con `id`, `mode`, `dispatchId`, instrucciones económicas y ejecución cuando existe. `currentAssignment` es pairing Driver/Vehicle; no es una entrega. |
| GET `/driver/dispatches/:dispatchId` | Detalle OWNER para su asignación actual o terminal propia, flotilla/independiente: `assignment`, `service` (paradas/contactos/paquetes), `paymentContext`, instrucciones de cobro y `execution` detallada. La consulta de ofertas sigue restringida al independiente habilitado. |
| GET `/driver/dispatches/:dispatchId/execution?page=1&pageSize=20` | `{execution,events:{items,total,page,pageSize,totalPages}}`, historia por revisión descendente. Sólo ejecutor vigente o final del servicio. Legacy sin execution devuelve 404: usar las otras dos lecturas para su contrato antiguo. |

Los campos `execution.allowedActions` son orientativos y específicos del actor; la escritura revalida todo. En Driver se excluye `ORDINARY_ASSIGNMENT_OPERATIONS`; en proveedor se excluyen `ADVANCE` y `DELIVER`. Sin asignación activa, no ofrecer un comando nuevo. Una lectura tardía puede quedar obsoleta por transferencia: no sustituye la revisión esperada.

ExecutionResponse (ejemplo ficticio):

```json
{
  "trackingMode": "DETAILED",
  "revision": 4,
  "phase": "PICKED_UP",
  "activeAssignmentId": "00000000-0000-4000-8000-000000000001",
  "custodyStatus": "HELD",
  "openIncidentId": null,
  "allowedActions": ["ADVANCE", "REPORT_INCIDENT"],
  "lastRecordedAt": "2026-10-04T00:00:00.000Z"
}
```

Historial: `kind`, `phase` numérica 0–5, `revision`, `assignmentId`, `actorUserId`, `actorRole`, `source`, `recordedAt`. SELF_REPORT identifica ahora a ambos tipos de repartidor. PHONE_REPORT se conserva en incidencias recibidas por operador y en hitos históricos anteriores; no reescribir esos registros. Resoluciones y sus confirmaciones privadas siguen reservadas a SUPER_ADMIN.

## Tres comandos operativos

Todos requieren `Idempotency-Key: UUID`, persistida **antes** de enviar, y JSON. La clave se correlaciona con actor, dispatch, assignment y operación. No aceptar/rechazar asignaciones ni repetir movimientos físicos automáticamente.

| Método y ruta | Body exacto / respuesta |
|---|---|
| POST `/driver/dispatches/:dispatchId/execution-events` | `AdvanceExecutionDto`: `{assignmentId, expectedRevision, phase}` → 200 ExecutionResponse; operación `ADVANCE`. |
| POST `/driver/dispatches/:dispatchId/custody-incidents` | `ReportCustodyIncidentDto`: `{assignmentId, expectedRevision, reasonCode, reasonDetail}` → 201 `{id,execution}`; operación `REPORT`. |
| POST `/driver/dispatches/:dispatchId/execution-completion` | `ExecutionCommandDto`: `{assignmentId, expectedRevision}` → 200 `{assignmentId,status:"DELIVERED",deliveredAt}`; operación `DELIVER`. |

`assignmentId` UUID; `expectedRevision` entero >=0, de la última lectura (legacy=0). No enviar driverId/providerId, importes, actor, reloj del dispositivo ni campos adicionales. `reasonDetail` 3–500 caracteres tras trim; `reasonCode`: RECIPIENT_UNAVAILABLE, DELIVERY_REFUSED, VEHICLE_FAILURE, SAFETY_CONCERN u OTHER.

| Desde | Acción | Resultado |
|---|---|---|
| Asignación detallada sin hito | TO_PICKUP | Camino a recogida |
| TO_PICKUP | AT_PICKUP | Llegada a recogida |
| AT_PICKUP | PICKED_UP | Custodia HELD; bloquea cancelación/liberación/reasignación ordinarias |
| PICKED_UP | TO_DROPOFF | Camino a destino |
| TO_DROPOFF | AT_DROPOFF | Llegada a destino |
| AT_DROPOFF sin incidencia | DELIVER | Cierre existente DELIVERED + assignment COMPLETED + un `delivery.completed` |
| Cualquier fase >= PICKED_UP | REPORT | Incidencia abierta; conserva recursos/custodia, no permite avanzar/entregar |
| Incidencia abierta | Resolución SUPER_ADMIN existente | RETURNED terminal o transferencia atómica sin reiniciar fase |

No saltar ni retroceder hitos. La revisión aumenta también por incidencias/resoluciones, no calcularla a partir de la fase. El instante registrado es del servidor. Entrega física no acredita cobro; no se añaden recibos financieros.

## Recuperación de TODAS las escrituras de esta app

Aplica a ADVANCE, REPORT y DELIVER, incluyendo cierre legacy por el comando nuevo. Reutiliza `DeliveryExecutionCommand`, no una tabla/cola nueva. El recibo APPLIED y la mutación (incluido outbox de entrega) se confirman en la misma transacción. Un rollback no deja recibo APPLIED. PostgreSQL mantiene los recibos y los cierres inmutables.

Para cada intento guardar marcador mínimo `{actorUserId,dispatchId,assignmentId,operation,key}`. No guardar JWT/secreto/cuerpo de incidencia en el marcador. Si se conserva un body para replay, debe ser exactamente el validado original y custodiarse por separado; si se pierde, consultar/cerrar la clave en vez de reconstruir a ciegas. Separar marcadores por usuario y mantenerlos al salir o recargar; una cuenta diferente no puede consultarlos/cerrarlos.

| Método y ruta | Headers / resultado |
|---|---|
| GET `/driver/dispatches/:dispatchId/assignments/:assignmentId/attempt?operation=ADVANCE` | Bearer del actor + misma Idempotency-Key; 200 DriverAttemptResponse, `Cache-Control: no-store`. `operation` obligatorio: ADVANCE, REPORT o DELIVER. **No escribe.** |
| POST `/driver/dispatches/:dispatchId/assignments/:assignmentId/attempt/close?operation=ADVANCE` | Mismos headers/query, sin body requerido; 200 mismo DTO. Escritura explícita, con confirmación del usuario en la app. |

```json
{
  "state": "CLOSED_NO_EFFECTS",
  "assignmentId": "00000000-0000-4000-8000-000000000001",
  "operation": "ADVANCE",
  "canStartNewAttempt": true
}
```

- **APPLIED:** refrescar servicio, ejecución/historia y `/driver/me`; retirar marcador al confirmar estado coherente. Si una transferencia posterior quitó acceso al servicio, el recibo propio APPLIED sigue siendo prueba del comando anterior; no intentar operar sobre el nuevo custodio.
- **PENDING_OR_UNKNOWN:** conservar bloqueo de esa intención y ofrecer consulta. Ausencia no distingue rollback, red, petición retrasada o transacción en curso. No afirmar fracaso ni crear automáticamente otra clave.
- **CLOSED_NO_EFFECTS:** la clave no podrá aplicar efectos posteriormente. Sólo entonces se puede preparar una intención nueva, tras refrescar elegibilidad/revisión y confirmar con la persona. `canStartNewAttempt` indica asignación aún ACTIVE, **no** garantiza que la transición concreta esté permitida.
- El POST de cierre y el comando original comparten locks Request→Dispatch→User. Si original confirma primero, cierre devuelve APPLIED. Si cierre gana, original/replays responden 409 EXECUTION_ATTEMPT_CLOSED. Si el cierre pierde su respuesta, conservar marcador y GET; nunca asumir éxito.
- Cerrar intento técnico **no deshace recogida, traslado ni entrega física**. Si ya ocurrió un hecho físico pero el comando quedó cerrado, confirmar la situación y preparar expresamente el registro correcto con revisión actual; no repetir el hecho físico.
- Otro Driver, PROVIDER_ADMIN o SUPER_ADMIN no cierra/lee intentos de ese Driver. SUPER_ADMIN mantiene las resoluciones excepcionales de custodia, con su reconciliación independiente; no puede avanzar ni entregar en su nombre. Si el iniciador no puede volver a autenticarse, es una incidencia operativa, no una excusa para suplantarlo. Una resolución excepcional/cambio de asignación invalida escrituras operativas nuevas del anterior; su marcador no se borra fingiendo un cierre técnico.

Respuestas de error: 400 validación; 401 autenticación; 403 rol/cuenta no autorizados; 404 asignación/ejecución ajena o inexistente; 409 `EXECUTION_CONFLICT`, `EXECUTION_TRANSITION_INVALID`, `CUSTODY_INCIDENT_OPEN`, `CUSTODY_INCIDENT_REQUIRED`, `INCIDENT_ALREADY_OPEN`, `IDEMPOTENCY_KEY_REUSED`, `EXECUTION_ATTEMPT_CLOSED`, `NO_ACTIVE_ASSIGNMENT` según ruta; 429 límite. Un timeout/5xx no es resultado definitivo: consultar el recibo. Ni nueva clave ni nueva revisión automática tras conflicto. Usar `code`, `statusCode` y `X-Request-Id`, no mensajes libres para decidir.

## Instrucciones económicas

Reutilizar `paymentContext`, `goods` e instrucciones persistidas de `/driver/dispatches/:id`; `/driver/me.activeDeliveryAssignment` también incluye instrucciones aplicables. `collectionActionAllowed` y `advanceToOriginAllowed` acotan la acción vigente en detallado. PREPAID significa comida pagada, no envío pagado. En convertidos, el envío es el importe/moneda de la MQ aceptada: destinatario, efectivo y al entregar, según instrucción persistida. Ningún avance, entrega ni resolución confirma cobro o genera otro débito/refund. CASH/COURIER_ADVANCE conservan cálculo e historia; transferencia no autoriza adelantar de nuevo. `creditCost` de la vista Driver es null para asignación FLEET: no cobrar al repartidor el award del proveedor.

## Handoff WEB

1. Retirar los botones/formularios de hitos y entrega **detallada** para PROVIDER_ADMIN; convertir timeline en lectura. No intentar otra ruta al recibir 403.
2. Conservar gestión de asignaciones según `allowedActions` y reporte de incidencias PHONE_REPORT. No cambiar pantalla SUPER_ADMIN de resolución ni su protocolo de reconciliación.
3. Cierre legacy del proveedor sólo con trackingMode=LEGACY explícito y asignación ACTIVE propia; etiquetarlo como servicio anterior. Ausencia de campo, null o errores HTTP nunca autorizan cierre.
4. Driver de flotilla e independiente usarán el contrato APP anterior. Hasta construir/verificar ese cliente, no habilitar servicios detallados nuevos. Web no se modificó en esta tarea.

## Despliegue coordinado, no ejecutado

1. Acreditar app del repartidor, cambios WEB y soporte: responsable, suplente y tiempo de resolución SUPER_ADMIN. Pendientes operativos, sin aceptación de riesgo implícita.
2. Inventariar asignaciones detalladas activas. No cortar el único cliente capaz de terminarlas: completar antes de la ventana con la versión aún vigente, o proporcionar el cliente Driver compatible al cambio. Flag false sólo detiene admisión, **no** libera servicios detallados existentes.
3. Backup verificado y mantenimiento; detener todos los escritores. Aplicar migración incremental `20261004000100_driver_execution_authority`, después arrancar exclusivamente el nuevo backend y clientes coordinados. Sin mezcla de escritores viejos/nuevos.
4. La migración cambia el guard SQL de actores y admite tombstones APP; agrega alias de recibos ADVANCE/REPORT de Drivers históricos en el namespace por asignación. No altera los recibos originales ni los hitos del administrador. Una respuesta incierta anterior sigue siendo consultable como APPLIED.
5. No seeds/reset ni migraciones históricas editadas. Mantener flag sin activar hasta autorización. Verificar servicios detallados y legacy, roles y recuperación con cuentas sintéticas del entorno autorizado.
6. Reversión: detener escritores y usar artefacto compatible con nueva autoridad/recibos; no reinstalar escritor antiguo que ignore tombstones o intente avance por administrador. Desactivar flag no revierte migración ni contrato. Recuperar backup sólo mediante procedimiento aprobado y evaluación de historia posterior.

Evidencia ejecutada y límites: [verificación Driver](DRIVER-APP-EXECUTION-VERIFICATION.md). El contrato público B2B conserva lectura y `delivery.completed`, sin rutas Driver ni webhooks nuevos.

## Cierre de limitaciones WEB — 2026-10-04

### Identificación explícita

Las vistas de despacho de proveedor (detalle/listado), Driver (detalle/listado autorizado), administración (detalle/listado) y `/driver/me.activeDeliveryAssignment` incorporan **trackingMode** al mismo nivel que id:

- `DETAILED`: existe DeliveryExecution persistida, incluso si terminó la asignación, hay incidencia o el flag de admisión está apagado.
- `LEGACY`: existe al menos una asignación histórica del despacho, pero no DeliveryExecution. No crea hitos ni interpreta PREPAID/créditos como modo de ejecución.
- `null`: el despacho nunca tuvo una asignación; puede estar OPEN o CLAIMED esperando asignación. No es legacy. Si `/driver/me` no tiene asignación activa, `activeDeliveryAssignment=null` como antes, sin subobjeto ficticio.

`execution.trackingMode=DETAILED` se conserva por compatibilidad, pero el discriminante para clasificar todos los casos es el campo superior. Si faltase el campo por backend/artefacto antiguo, tratar como desconocido y bloquear el cierre legacy. No convertir un 404/403/5xx de lectura en permiso de entrega. Incluso con LEGACY, exigir asignación ACTIVE propia, estado CLAIMED y permisos del flujo; backend vuelve a validarlos. Una historia legacy sin asignación vigente no autoriza cerrar.

### Avances históricos del administrador

Sí existieron: d440aef aceptaba PROVIDER_ADMIN y guardaba recibos APPLIED con operación ADVANCE, actor, despacho y clave. La migración anterior conservó esos recibos originales. La retirada de permiso no prueba que una solicitud previa no hubiese confirmado.

Rutas nuevas (prefijo /api/v1, Bearer humano PROVIDER_ADMIN, Idempotency-Key UUID original):

| Método/ruta | Resultado |
|---|---|
| GET `/provider/dispatches/:dispatchId/execution-attempt` | 200 `{state,appliedRevision,canStartNewAttempt:false}`; sólo lectura, no-store. |
| POST `/provider/dispatches/:dispatchId/execution-attempt/close` | 200 mismo DTO; confirmación explícita en Web, sin body requerido. |

Query opcional `providerId=UUID`, obligatorio si hay varias memberships. Se exige identidad original activa, rol PROVIDER_ADMIN y membership vigente. Se comprueba asignación histórica del proveedor y, para APPLIED, la asignación referida por el recibo. Puede consultar después de transferencia sin recuperar acceso a datos operativos actuales. Otro actor no obtiene el recibo aunque use la misma clave; SUPER_ADMIN/DRIVER no usan estas rutas. No se revelan body, hash, contactos ni respuesta completa guardada.

- APPLIED: acreditar el hito histórico en appliedRevision (entero), refrescar vistas autorizadas y retirar marcador. No reenviar el comando ni realizar otra operación física.
- PENDING_OR_UNKNOWN: no hay prueba definitiva; conservar marcador y ofrecer consultar o cerrar explícitamente. appliedRevision=null. GET no crea tombstones.
- CLOSED_NO_EFFECTS: existe tombstone durable en **el namespace original ADVANCE**. Retirar el bloqueo técnico del marcador; **nunca** habilitar otro avance del proveedor. canStartNewAttempt es false en los tres estados.
- Cierre y comando histórico comparten locks Request→Dispatch→User y el mismo recibo. Si ya confirmó, gana APPLIED. Si el cierre confirma primero, el comando histórico encuentra CLOSED_NO_EFFECTS; el backend actual rechaza cualquier avance del proveedor con 403 aun con otra clave. No se restaura permiso de escritura.
- Si se pierde la respuesta del cierre, conservar marcador y GET. Cerrar un intento no cancela, revierte ni registra movimiento físico. Si la cuenta/membership ya no está autorizada, mantener el marcador como pendiente de revisión de acceso; otro administrador no puede hacerse pasar por el iniciador.

Errores: 400 clave/UUID inválido, 401 autenticación, 403 rol/cuenta/membership, 404 sin asignación histórica autorizada, 409 conflicto concurrente, 429 límite. La ruta sólo reconcilia ADVANCE; no asumir que sirve para REPORT/DELIVER/resoluciones.

### Migración y coordinación

Aplicar incremental `20261004000200_provider_historical_attempts` antes del nuevo código, con escritores detenidos como en el procedimiento anterior. Sólo amplía la constraint para tombstones ADVANCE; no modifica recibos, tablas financieras ni historia. No admite despliegue mixto: la prueba de una petición tardía de d440aef acredita su protocolo de locks/recibos, no autoriza mantener ese servidor escribiendo. No hacer rollback a versiones que ignoren estos cierres. La UI del proveedor consulta/cierra intentos históricos y conserva el avance detallado exclusivamente en Driver.

Evidencia y límites: [verificación de estas dos limitaciones](PROVIDER-HISTORICAL-ATTEMPTS-VERIFICATION.md).
