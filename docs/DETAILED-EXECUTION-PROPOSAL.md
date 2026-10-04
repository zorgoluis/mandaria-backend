# Ejecución detallada y excepciones de custodia

> Actualización 2026-10-03: la decisión posterior del propietario asigna hitos y entrega detallada a DRIVER de flotilla/independiente. Ver [contrato APP y transición WEB](DRIVER-APP-EXECUTION.md). Se conserva el diseño histórico de custodia y el protocolo SUPER_ADMIN; la reconciliación APP añade ADVANCE/REPORT/DELIVER por asignación y no reutiliza permisos de resolución administrativa.

Actualizado: 2026-10-02. **Implementado localmente en QA; no activado.** Contrato final: [handoff](DETAILED-EXECUTION-HANDOFF.md); comprobaciones y límites: [verificación](DETAILED-EXECUTION-VERIFICATION.md). Las secciones siguientes conservan el diseño aprobado y su diagnóstico previo a la implementación; sus referencias a capacidades futuras describen ese antecedente. Sin nueva versión asignada. Sustituye la propuesta de `4f2e846` incorporando decisiones del propietario. El checkout actual es QA (`cfc8773`) y no contenía ese archivo: se recuperó su contenido de Git como antecedente, sin cambiar de rama ni trasladar código de main.

Se leyeron AGENTS, BITACORA, README y VERIFICATION. La configuración comercial post-reset está completada/probada según el propietario; no se volvió a probar aquí. Numeración: package.json 1.12.0 no representa por sí solo todas las entregas V1.13; la continuidad histórica pospuso lifecycle, por lo que este diseño no asigna otra versión.

## 1. Decisiones aprobadas y límites

- Cinco hitos obligatorios y consecutivos en nuevas asignaciones ordinarias: `TO_PICKUP → AT_PICKUP → PICKED_UP → TO_DROPOFF → AT_DROPOFF`; después, cierre DELIVERED existente. No reconstruir hitos anteriores.
- Desde PICKED_UP, prohibir cancelación, liberación y reasignación ordinarias, incluso por SUPER_ADMIN o B2B.
- Entrega imposible: incidencia, escalamiento a SUPER_ADMIN, custodia y recursos retenidos. Sólo SUPER_ADMIN resuelve excepcionalmente por **devolución física confirmada al origen** o **transferencia documentada de custodia**. Motivo, actor, fechas e historia obligatorios. No entrega ficticia ni movimientos económicos automáticos.
- PROVIDER_ADMIN registra avisos telefónicos con su identidad; independiente opera desde web; conductor de flotilla reporta por teléfono. SUPER_ADMIN audita y resuelve excepciones, no suplanta al ejecutor.
- B2B consulta el progreso. Se conserva `delivery.completed`, sin nuevos tipos de webhook en este alcance.
- Sin GPS, app móvil, foto, firma, OTP, entregas parciales, conciliación, cobros ni reembolsos de comida/envío. La devolución física autorizada aquí no es un reembolso financiero.

## 2. Contrato actual contrastado con código

Todas las rutas usan prefijo `/api/v1`.

| Capacidad actual | Fuente / comportamiento |
|---|---|
| Aceptar MQ y publicar | `src/delivery-quotes/authorized-acceptance.service.ts`, `delivery-quotes.service.ts`, `src/dispatch/dispatch-policy.ts`: aceptación y openDispatch transaccionales; candidaturas/costo congelados. Sin prueba de recogida o pago. |
| Adjudicar | `POST /provider/dispatches/:dispatchId/claim`, luego `/assignment`; independiente `POST /driver/dispatches/:dispatchId/take` crea claim y asignación juntos. |
| Liberar/reasignar | `dispatch.service.ts`, `delivery-assignments.service.ts`, `independent-dispatches.service.ts`: proveedor cancela asignación antes de release; independiente cancela y libera atómicamente. Release devuelve créditos y abre o expira despacho. Reassign conserva historial y recursos exclusivos. |
| Cancelar solicitud | `POST /delivery-requests/:publicId/cancel` y `/admin/delivery-requests/:publicId/cancel`; Request → Dispatch → asignaciones. Cierra OPEN/CLAIMED y aplica refunds existentes; no conoce custodia. |
| Entregar | `POST /provider/dispatches/:dispatchId/deliver`, equivalente `/driver/.../deliver`; `src/deliveries/delivery-completion.ts`: COMPLETED + DELIVERED + outbox, mismo commit, repetición sin duplicados. Autoriza actualmente por dueño del claim. |
| Consultar | GET provider/driver dispatches, `/driver/me`, historiales de asignaciones provider/admin; `GET /delivery-requests/:publicId/status`. B2B ASSIGNED incluye claim de flotilla aún sin conductor. |
| Dinero/instrucciones | `src/credits/service-refund.ts`, `award-boundary.ts`, `src/delivery-assignments/collection-instructions.ts`. PREPAID es comida pagada. Instrucciones no son recibo. |
| Persistencia | `prisma/schema.prisma`: estados Dispatch OPEN/CLAIMED/EXPIRED/CANCELLED/DELIVERED; Assignment ACTIVE/REASSIGNED/CANCELLED/COMPLETED. No hay incidencia/custodia detallada. |

Restricciones decisivas revisadas en SQL:

- `20260918001000_independent_drivers`: assignment exige dueño coherente con claim y pertenencia Driver/Vehicle.
- `20260923000200_award_integrity_boundary`: `dispatch_operational_awards` deriva adjudicaciones también de asignaciones independientes; exige cargo correspondiente. Índice `DeliveryAssignment_independent_award_key` impide reutilizar un independiente en el mismo Dispatch como nueva adjudicación.
- `20260923001600_delivery_completion_rules`: cierre requiere COMPLETED; salir de CLAIMED ordinariamente activa guard de refund; DELIVERED conserva dueño y queda terminal.
- Outbox e identidad pública tienen restricciones adicionales; `src/b2b-events/b2b-outbox.ts` serializa explícitamente el payload. Cambiar sólo controllers o añadir enums no basta.

Las garantías siguientes son **propuestas**, no capacidades disponibles. No se ejecutaron suites, SQL ni operaciones remotas.

## 3. Modelo de progreso y custodia

Persistir los cinco hitos: salida a destino no se infiere de recogida y llegada no se infiere de asignación. «Sin avance reportado» se deriva de ausencia de hitos. DELIVERED se deriva del cierre canónico, sin fecha de entrega duplicada editable.

El progreso pertenece a una **cadena de ejecución del Dispatch**, con eventos que identifican la asignación responsable en cada instante. Una reasignación ordinaria pre-recogida inicia otra cadena sin progreso; una transferencia excepcional conserva la cadena y todos los hitos, cambiando únicamente custodio/asignación. Así un receptor no finge haber recogido en el restaurante.

Estructuras previstas:

- `DeliveryExecution`: Dispatch, modo LEGACY/DETAILED, revision monotónica, cadena vigente, fase materializada y asignación vigente. Cambios de fase/puntero requieren evento en el mismo commit; restricciones diferidas comprueban coherencia. La revisión nunca reinicia al cambiar de cadena.
- `DeliveryExecutionEvent`: append-only, tipo (hito, incidencia, resolución, cambio de asignación, cierre), dispatchId, chainId, assignmentId, sequence, recordedAt servidor, actorUserId/rol al actuar, source (`PHONE_REPORT`, `SELF_REPORT`, `ADMIN_RESOLUTION`), commandId. Sin cuerpos completos ni secretos.
- `DeliveryCustodyIncident`: dispatch/chain/asignación que reportó, reasonCode, reasonDetail, reportedBy, reportedAt, estado OPEN/RESOLVED y resolutionId. Máximo una OPEN por Dispatch. La fase no se sobrescribe con «incidencia».
- `DeliveryCustodyResolution`: única por incidencia, tipo `RETURN_TO_ORIGIN` o `TRANSFER`, razón, SUPER_ADMIN, recordedAt, occurredAt declarado, confirmaciones y referencias a asignaciones origen/destino o receptor del restaurante. Inmutable.
- Idempotencia humana durable: registro de comando por actor+dispatch+operación+clave, huella canónica, respuesta/estado y correlación. No reutilizar el namespace B2B atribuyendo un User a una integración.

Custodio vigente = Driver de la única asignación ACTIVE de la cadena con PICKED_UP acreditado. Antes de recoger hay ejecutor, no custodio. No agregar otra lista mutable de custodios: tras return/deliver no hay custodio; historia permanece. Hasta el commit de transferencia, el origen sigue siendo responsable en Mandaria.

## 4. Transiciones y permisos

«Operador»: PROVIDER_ADMIN miembro vigente del proveedor ejecutor o DRIVER independiente ejecutor; no basta con ser pagador original. Usuario ACTIVE siempre; para terminar/reportar trabajo vigente no volver a exigir elegibilidad de contratación. Al receptor nuevo sí se le exige elegibilidad completa.

| Origen | Comando y destino | Actor autorizado / efecto |
|---|---|---|
| Nueva asignación ordinaria | Sin avance → TO_PICKUP | Operador; no salida automática al asignar. |
| TO_PICKUP | AT_PICKUP | Operador. |
| AT_PICKUP | PICKED_UP | Operador; confirma custodia. |
| PICKED_UP | TO_DROPOFF | Operador; sin incidencia abierta. |
| TO_DROPOFF | AT_DROPOFF | Operador; sin incidencia abierta. |
| AT_DROPOFF | DELIVERED | Operador por deliver existente; sin incidencia; mismo cierre/outbox. |
| Antes de recoger | Cancel/release/reassign ordinarios | Roles/rutas actuales; nueva cadena sin hitos para nueva asignación. Refunds actuales intactos. |
| PICKED_UP / TO_DROPOFF / AT_DROPOFF | Reportar incidencia → OPEN | Operador; SUPER_ADMIN puede registrar escalamiento recibido, con source ADMIN_RESOLUTION y su propia identidad. Mantiene fase/recursos/custodio. |
| Incidencia OPEN | Confirmar devolución → RETURNED terminal | Sólo SUPER_ADMIN; resolución física acreditada administrativamente; libera recursos al commit. |
| Incidencia OPEN | Confirmar transferencia → RESOLVED, ejecución continúa | Sólo SUPER_ADMIN; conserva fase/hitos y cambia asignación/custodio atómicamente. |
| Incidencia OPEN | Avanzar/entregar/liberar/reasignar/cancelar | Prohibido; no «cerrar incidencia» genérico. |
| Tras transferencia | Próximo hito pendiente o deliver si AT_DROPOFF | Nuevo operador; nunca nueva recogida. |
| RETURNED / DELIVERED / CANCELLED / EXPIRED | Nuevo avance/incidencia/resolución | Prohibido; sólo lectura o replay exacto. |

El conductor de flotilla no escribe incidencias ni avances: llama al administrador, quien registra. SUPER_ADMIN no escribe hitos ni entrega. B2B no reporta/resuelve incidencias internas; sólo consulta y cancela cuando esté permitido. Receptor de transferencia recibe permisos de ejecutor exclusivamente para ese servicio, no para recursos del proveedor anterior.

Incidencias de custodia sólo se abren después de PICKED_UP en modo DETAILED. Antes se usan las salidas actuales. Motivos: `RECIPIENT_UNAVAILABLE`, `DELIVERY_REFUSED`, `VEHICLE_FAILURE`, `SAFETY_CONCERN`, `OTHER`; motivo detallado obligatorio, sin datos personales innecesarios. No crear FAILED ni ciclos de reintento de entrega. Una segunda incidencia tras otra transferencia sí es posible, con otro id y la revisión/asignación entonces vigentes.

## 5. Devolución física confirmada

1. El custodio conserva servicio y recursos mientras retorna; la incidencia OPEN impide entrega normal. No se añaden hitos de viaje de regreso en este alcance.
2. SUPER_ADMIN comprueba fuera de Mandaria que el custodio entregó al **mismo punto de recogida persistido** y que una persona responsable del comercio confirmó recepción completa. No permite elegir dirección arbitraria ni confirmar intención futura.
3. Registrar `returnedAt` declarado (ISO UTC, no futuro, no anterior a la recogida), `originContactLabel` mínimo y `originContactRole`, `custodianConfirmed=true`, `originConfirmed=true`, `confirmationMethod=PHONE`, `reason`. No se requiere crear User/IntegrationClient para el empleado del restaurante. Guardar referencia al origen persistido, no duplicar dirección ni referencias privadas B2B. RecordedAt y admin salen del servidor. La confirmación es atestación del administrador, no verificación digital del restaurante.
4. Una transacción: resolver incidencia, terminar Assignment como **RETURNED**, Dispatch como **RETURNED**, guardar returnedAt/returnedByUserId y resolución; marcar DeliveryRequest CANCELLED con motivo controlado `RETURNED_TO_ORIGIN`. MQ ACCEPTED queda histórica; no usar `closeDispatchesForCancelledRequest` genéricamente, porque produciría refund.
5. RETURNED es terminal irreversible, distinto de DELIVERED. Sin COMPLETED ni `delivery.completed`; recursos quedan libres y no puede reabrirse ni volver a CLAIM/TAKE. La cancelación repetida del MDR no debe refundar ni modificar RETURNED. No modifica comida, envío, adelantos o ledger.

Si restaurante no confirma recepción, no es devolución confirmada: continuar OPEN con custodia. No se acepta devolución parcial. Tiempos de registro y del hecho declarado permanecen diferenciados; si hay inconsistencia se rechaza, nunca se corrigen hitos automáticamente.

## 6. Transferencia documentada de custodia

### Identificación y validación

Receptor = Driver existente y Vehicle existente, con unión discriminada:

- `FLEET { providerId, driverId, vehicleId }`: proveedor ACTIVE; Driver ACTIVE/User ACTIVE; vehículo ACTIVE, ambos del proveedor; coherencia de emparejamiento vigente; cobertura activa para zona/tipo del servicio.
- `INDEPENDENT { driverId, vehicleId }`: perfil APPROVED/Driver ACTIVE/User ACTIVE, vehículo propio ACTIVE; política de ejecución admite independiente y elegibilidad territorial vigente aplicable.

Se admite mismo proveedor, otro proveedor o independiente, sin convertirlo en una nueva adjudicación económica. No exigir candidatura histórica al receptor excepcional; autorización SUPER_ADMIN + resolución documentada la sustituyen sólo para ese servicio. Mantener cobertura/recursos, nunca bypass genérico. El endpoint de candidatos es orientativo; comprobar todo otra vez bajo locks. Receptor debe ser distinto conductor; cambio sólo de vehículo no es transferencia de custodia y queda fuera de esta excepción.

SUPER_ADMIN documenta confirmación del custodio saliente, del receptor y, si receptor FLEET, del administrador del proveedor receptor (User existente con membership vigente), vía llamada. Driver receptor queda identificado por UUID, no sólo nombre. Campo actor no enviado por cliente. No OTP, firma ni suplantación: son declaraciones administrativas con auditoría, no prueba criptográfica. El admin receptor no tiene que ser quien resuelve; son roles distintos.

### Commit y continuidad

Validar receptor disponible; ningún otro ACTIVE para Driver/Vehicle globalmente. No reservar físicamente al receptor mediante un cambio parcial de estado; si ya no es elegible al confirmar, responder 409 y conservar custodia origen. Operación debe coordinar confirmación inmediata del traspaso; si falla el registro tras el hecho físico, mantener incidencia abierta, no realizar otro traspaso, consultar/reintentar el mismo comando y reconciliar con SUPER_ADMIN. La DB no puede hacer atómica una entrega física telefónica.

En un solo commit: crear resolución, terminar asignación saliente como **TRANSFERRED**, crear ACTIVE receptora con `custodyResolutionId`, actualizar puntero de ejecución, registrar evento/fecha y resolver incidencia. Liberar recursos salientes y ocupar entrantes; si vehículo es legalmente compartido dentro del mismo proveedor, termina y vuelve a ocupar en ese commit. Conductor distinto siempre. Los índices únicos ACTIVE siguen vigentes; falla cualquier paso → rollback completo. No cambiar titularidad de Driver/Vehicle.

Preservar fase y cadena. En PICKED_UP, el receptor continúa con TO_DROPOFF; en TO_DROPOFF continúa hasta AT_DROPOFF; en AT_DROPOFF puede confirmar entrega tras recepción documentada en ese destino. La confirmación de transferencia debe declarar `atCurrentStageLocation=true`: mantiene el contexto físico de la fase, no permite usar llegada anterior si el pedido se trasladó fuera del destino. Si eso no puede confirmarse, no ejecutar esta transferencia; permanece incidencia, con devolución como otra resolución disponible. Historial muestra quién registró cada hito y quién heredó custodia, sin copiar hitos al receptor.

### Separación indispensable entre pagador y ejecutor

Conservar `claimedByProviderId/claimedByIndependentDriverId`, claimedAt y evidencia de award originales como **adjudicación económica histórica**. El ejecutor vigente pasa a resolverse desde la asignación receptora enlazada a una resolución válida, no desde esas columnas. Sin transferencias, comportamiento actual idéntico.

Esto exige cambios futuros coordinados, no funciona con guards actuales:

- `delivery_assignment_guard` permite discrepancia ejecutor/claim sólo con resolución TRANSFER válida en misma cadena, predecesora y Dispatch, y origen de custodia probado; FK/constraints diferidas verifican el enlace bidireccional al commit.
- `dispatch_operational_awards` debe excluir **sólo** asignaciones receptoras autenticadas por esa resolución; excluir por un booleano o FK nullable aislado sería una puerta a servicios gratuitos. Raíz conserva exactamente su award o exención histórica explícita. Índice independiente de adjudicación se restringe a asignaciones ordinarias; transferencias tienen unicidad por resolución. Esto permite retornar posteriormente a un conductor con otra resolución, sin nuevo TAKE ni doble cargo.
- No cambiar claim/candidaturas ni llamar a claim/take/release/reassign ordinarios. No debitar al receptor ni refundar al origen; la integridad económica sigue anclada al award original. No hay remuneración entre ejecutores en este alcance.
- `completeDelivery`, guards de consulta/acciones, selects y snapshot público deben usar ejecutor vigente de la cadena transferida. El antiguo dueño pierde controles de ejecución/contactos operativos; conserva su historia y evidencia económica. Nuevo dueño obtiene sólo acceso necesario al servicio aunque no fuese candidato. Lecturas y cierre para independiente deben resolver el resultado por ejecutor, no volver a exigir ser dueño económico.
- Snapshot DELIVERED refleja receptor que realmente entregó, no pagador. Adecuar restricciones de identidad/outbox para ese caso conservando su formato y atomicidad. No modificar eventos previos.
- Guard de refund admite RETURNED sin devolución de créditos **sólo con resolución de retorno consistente y estado terminal**. No añadir excepción amplia para cualquier CANCELLED. Release/cancel previos a recogida mantienen reglas existentes.

Los guards actuales que vuelven a comprobar APPROVED del dueño independiente al actualizar Dispatch deben distinguir admisión de cierre: una suspensión del pagador original no puede impedir retorno/transferencia acreditados. No relajar admisión de nuevos TAKE ni elegibilidad del receptor. Validar la adjudicación histórica por su evidencia, no por el estado actual del antiguo perfil.

## 7. Concurrencia, reintentos y garantías

Mutaciones con `Idempotency-Key` (UUID), `expectedRevision` entero >=0 y `assignmentId` UUID. Guardar resultado durable del comando dentro de la transacción. Actor, timestamps de registro y source se resuelven del contexto/ruta, no se pueden falsificar en body. Payload de resolución distingue fechas declaradas físicas de fechas del sistema.

- Misma clave/actor/operación/dispatch y mismo body → respuesta original, aunque ya cambió revision; no repetir efectos. Misma clave distinto body → 409 `IDEMPOTENCY_KEY_REUSED`. Revalidar acceso para lectura del recibo sin exigir que la asignación siga ACTIVE. Quien participó legítimamente puede recuperar su propio recibo sanitizado sin recuperar control del servicio.
- Sin recibo: revision/asignación obsoletas → 409 `EXECUTION_CONFLICT`. Incidencia ya resuelta con otra clave → 409 `INCIDENT_ALREADY_RESOLVED`; no segunda devolución/transferencia. Incidencia abierta ya existente → 409 `INCIDENT_ALREADY_OPEN` con referencia sólo si autorizado. No fusionar dos relatos silenciosamente.
- Todos los comandos que puedan terminar/cambiar custodia bloquean Request → Dispatch → Execution/Incident → Assignment → recursos. Ampliar de forma coherente los caminos que hoy toman sólo Dispatch, evitando invertir el orden. Recursos origen/receptor ordenados por tipo e id para carreras entre transferencias; locks también protegen cambios de estado/membership que afectan admisión. Recuperar deadlock/conflicto transitorio con reintento acotado de misma clave, nunca repetir efectos externos.
- Revalidar rol SUPER_ADMIN ACTIVE, incidente OPEN, cadena, custodio, fase y receptor bajo transacción. Dos admins: un ganador; otro replay o 409. Incidencia vs deliver: si deliver gana no abre incidencia; si incidencia gana deliver bloqueado. Recogida vs cancel: gana uno y otro falla sin cambios económicos.
- Toda mutación de progreso/asignación/incidencia incrementa revision y agrega evento. Historial y resoluciones sin UPDATE/DELETE ordinario. FKs same-dispatch/chain, unique resolution(incidentId), índice parcial una OPEN por Dispatch y una ACTIVE por Dispatch/Driver/Vehicle; resolución receptora y predecesora únicas; cadena acíclica con secuencia creciente. Retorno exige cero ACTIVE y cero custodios al commit; transferencia exactamente una ACTIVE receptora y un custodio. No basta con «a lo sumo una».
- Unicidad de cada hito por cadena, no por asignación receptora: el historial debe demostrar las cinco fases previas al deliver aunque sus actores/asignaciones hayan cambiado. Los recibos de comandos y resoluciones se conservan junto con la historia operativa; no usar un TTL corto que permita repetir una resolución borrada.
- SQL directo debe rechazar avances saltados, destinatarios cruzados, resolución huérfana, custodia doble, cierre sin resolución y omisión de award por supuesta transferencia. DB garantiza integridad relacional; autorización JWT queda en servicio, sin presentar PostgreSQL como verificador del actor HTTP.

## 8. Endpoints y DTOs propuestos

**No existen aún.** Conservar prefijo `/api/v1`, guards humanos, errores DomainException y envoltorio global vigente. Listados con page/pageSize existentes. IDs UUID. Campos extra rechazados.

| Método y ruta propuesta | Rol / entrada | Respuesta |
|---|---|---|
| POST `/provider/dispatches/:dispatchId/execution-events` | PROVIDER_ADMIN ejecutor; scope providerId habitual; `{assignmentId, expectedRevision, phase}` | 200 ExecutionView |
| POST `/driver/dispatches/:dispatchId/execution-events` | Independiente ejecutor; mismo DTO | 200 ExecutionView |
| POST `/provider/dispatches/:dispatchId/custody-incidents` | PROVIDER_ADMIN ejecutor; `{assignmentId, expectedRevision, reasonCode, reasonDetail}` | 201 IncidentView |
| POST `/driver/dispatches/:dispatchId/custody-incidents` | Independiente ejecutor; mismo DTO | 201 IncidentView |
| POST `/admin/dispatches/:dispatchId/custody-incidents` | SUPER_ADMIN registra aviso/escalamiento; mismo DTO, no avance | 201 IncidentView |
| GET `/admin/custody-incidents?status=OPEN&page=1&pageSize=20` | SUPER_ADMIN, cola de atención | 200 página |
| GET `/admin/dispatches/:dispatchId/custody-incidents/:incidentId` | SUPER_ADMIN; incidente e historia propia | 200 IncidentDetail |
| GET `/admin/dispatches/:dispatchId/custody-transfer-candidates?mode=FLEET&page=1&pageSize=20` | SUPER_ADMIN; candidatos operacionales, sin saldos/secretos | 200 página de Driver/Vehicle/owner autorizados |
| POST `/admin/dispatches/:dispatchId/custody-incidents/:incidentId/resolve` | SUPER_ADMIN; unión de DTOs siguientes | 200 ResolutionView + ExecutionView |

Detalle actual provider/driver y `/driver/me` agregan ExecutionView y resumen de incidente autorizado; lectura de timeline en detalle o historial existente, paginada si crece. No es necesario duplicar endpoints de entrega: `/deliver` conserva su body vacío y repetición actuales; en DETAILED revalida AT_DROPOFF/sin incidencia/custodio vigente bajo lock. No añadir requisito de nuevo body al contrato legacy.

DTO común resolve: `{ assignmentId, expectedRevision, type, reason, occurredAt, confirmationMethod: "PHONE" }`, Idempotency-Key en cabecera.

- RETURN_TO_ORIGIN añade `custodianConfirmed: true`, `originConfirmed: true`, `originContactLabel`, `originContactRole`. Origen y custodio salen de datos persistidos. `occurredAt` se proyecta internamente como returnedAt.
- TRANSFER añade `recipient: {mode:"FLEET",providerId,driverId,vehicleId}` o `{mode:"INDEPENDENT",driverId,vehicleId}`, `releasingCustodianConfirmed:true`, `receivingCustodianConfirmed:true`, `atCurrentStageLocation:true`; para FLEET añade `recipientProviderAdminUserId` y `recipientProviderAdminConfirmed:true`. El servidor comprueba membership, no acepta que sólo enviar el UUID pruebe la llamada. Atestación expresa del SUPER_ADMIN.
- Motivos 3–500 caracteres; etiquetas/rol del receptor del comercio 1–100. Nada de teléfonos, documentos, archivos o texto libre público. Fecha válida no futura y posterior/igual al último hecho físico de custodia confirmado; no posterior a recordedAt. Validar tiempos reportados con recordedAt de recogida como límite conservador. Datos privados sólo en auditoría autorizada.

ExecutionView interno: `{trackingMode, revision, phase, activeAssignmentId, custodyStatus, openIncidentId, allowedActions, lastRecordedAt}`. `custodyStatus=NOT_COLLECTED|HELD|RETURNED|DELIVERED`, derivado de hechos; incidencia no equivale a pérdida de custodia. ResolutionView: id, tipo, incidente, from/toAssignmentId, occurredAt, recordedAt, actor permitido. Idempotencia devuelve status HTTP y body originales, no 201 nuevo en cada replay.

Errores: 400 VALIDATION_ERROR; 401 sin humano activo; 403 rol/membership sin permiso; 404 recurso ajeno/inexistente según aislamiento actual; 409 `EXECUTION_CONFLICT`, `EXECUTION_TRANSITION_INVALID`, `CUSTODY_INCIDENT_REQUIRED`, `CUSTODY_INCIDENT_OPEN`, `CUSTODY_OPERATION_FORBIDDEN`, `INCIDENT_ALREADY_OPEN`, `INCIDENT_ALREADY_RESOLVED`, `CUSTODY_RECIPIENT_NOT_ELIGIBLE`, `IDEMPOTENCY_KEY_REUSED`. Reutilizar DRIVER_BUSY/VEHICLE_BUSY si aplican; 429 límites existentes; 5xx sanitizados y rollback. Un 409 nunca representa éxito parcial.

## 9. Proyección B2B, créditos y cierre

Conservar REQUESTED/OPEN/ASSIGNED/DELIVERED/CANCELLED/EXPIRED. Añadir a GET status `executionProgress` nullable y `executionOutcome` nullable, con allowlist:

```json
{
  "status": "ASSIGNED",
  "executionProgress": {
    "phase": "TO_DROPOFF",
    "revision": 8,
    "registeredAt": "2026-10-02T15:30:00.000Z",
    "attentionRequired": true
  },
  "executionOutcome": null
}
```

Incidencia conserva ASSIGNED y fase, attentionRequired=true; transferencia conserva fase, incrementa revisión, attentionRequired=false y `execution` identifica al nuevo ejecutor mediante nombres públicos autorizados. No difundir admin, teléfonos, motivo, receptor restaurante, ids internos ni id de incidencia.

RETURNED interno → B2B CANCELLED, `executionProgress=null`, `executionOutcome={"type":"RETURNED_TO_ORIGIN","occurredAt":"…"}`, deliveredAt=null, cancelledAt=fecha de registro del cierre, execution con modo histórico y nombres null como cancelación existente. Permite distinguir cancelación ordinaria de devolución física sin ampliar enum status. DELIVERED sigue DELIVERED; nuevas transferencias exigen snapshot desde asignación final; históricos inmutables sin rellenar huecos. No confundir retorno de comida con devolución de dinero.

`delivery.completed` sólo en cierre real, exactamente una vez y con su formato vigente. No nuevos webhooks para progreso, incidencia, retorno o transferencia; polling de GET es necesario para verlos. Actualizar OpenAPI/exportador/documentación públicos de forma aditiva cuando se implemente; no reescribir payloads guardados. Consumidores deben tolerar campos nuevos y usar revisión para no retroceder ante respuestas fuera de orden.

No ledger en reportar/resolver/avanzar/entregar. Award original conserva monto, cuenta y snapshot; transferencias no heredan deuda a otra cuenta ni necesitan saldo para cargo inexistente. RETURNED conserva créditos consumidos y puede requerir atención comercial externa, sin automatizar ajuste. CASH/COURIER_ADVANCE conservan datos/cálculos; un adelanto ya hecho no desaparece por transferencia/retorno. No duplicar instrucción de adelantar al restaurante en el receptor de custodia: es trabajo posterior a recogida, con valores históricos y ninguna orden de repetir adelanto. Requiere proyección explícita, no modificar importe original.

Instrucciones V1.13: en incidente abierto suspender acciones de cobro mostradas, mantener instrucción pactada como referencia; agregar indicador operativo `collectionActionAllowed=false` separado de evidencia de pago. Tras transferencia cerrada, nuevo ejecutor recibe instrucción vigente exclusiva de envío; anterior sólo historia. En retorno/entrega, HISTORY y sin acción de cobro. La lógica actual CURRENT basada sólo en CLAIMED debe extenderse: no basta con mantenerla intacta para excepciones nuevas. Ninguna fase confirma recepción de efectivo.

## 10. Compatibilidad y migración prevista

No modificar ni ejecutar migraciones en esta tarea. Futuro: migraciones incrementales, sin reset ni edición de SQL histórico.

1. Agregar tablas execution/event/incident/resolution/recibos y enums de fases/resolución, estados Dispatch RETURNED y Assignment RETURNED/TRANSFERRED. Separar incorporación de valores enum de su uso si la versión PostgreSQL exige commit intermedio. Agregar fechas/referencias de retorno y transferencia, FKs same-dispatch/chain y restricciones diferidas; mantener índices ACTIVE.
2. Asignaciones existentes quedan LEGACY sin hitos ni inferir custodia. Las nuevas asignaciones ordinarias posteriores al corte son DETAILED, incluso si el despacho existía sin asignación. Reassign pre-recogida crea nueva cadena DETAILED; transferencia conserva cadena detallada. No convertir automáticamente una ACTIVE legacy ni permitirle registrar hitos/incidencias como si su recogida fuera conocida. Terminar esos servicios con contrato actual; desplegar en ventana sin trabajo legacy si operación requiere cobertura universal inmediata.
3. Actualizar vista de adjudicaciones, unicidad independiente y guards de assignment/dispatch/refund/completion/identidad/outbox para casos excepcionales probados. Raíces ordinarias conservan garantías. No borrar/recalcular créditos, snapshots, eventos o identidades históricas.
4. Actualizar todas las instancias escritoras y consumidores administrativos coordinadamente antes de admitir DETAILED. Versiones antiguas no saben RETURNED ni separación pagador/ejecutor: despliegue mixto no es seguro por defecto. Desactivar nuevos detallados no desactiva barreras de trabajos existentes; rollback debe mantener código compatible o detener escritores, nunca downgrade que ignore custodia. Conservación de tablas/eventos para auditoría.

## 11. Handoff frontend

Usar superficies existentes de servicio/asignación en `src/dispatch/`, `src/delivery-assignments/`, `src/driver-portal/` y auditoría `src/dispatch/admin.tsx` del frontend (rutas de archivos identificadas en revisión anterior; no modificación/build/inspección visual en esta tarea).

- Timeline con cinco pasos obligatorios, aviso telefónico y nombre del **usuario registrador**, separado del conductor. Mostrar fechas «registrado» frente a «hecho declarado». Sin completar pasos automáticamente.
- Recogida desactiva cancel/release/reassign ordinarios. Botón «Reportar incidencia» para operador; motivo y confirmación de que pedido sigue bajo custodia. No botón de incidencia para DRIVER de flotilla ni B2B.
- Incidencia abierta: banner, recursos retenidos, avances/deliver deshabilitados; mostrar escalado a SUPER_ADMIN. Backend crea cola persistente, no prometer correo que no se implementó. Operación debe vigilar esa cola.
- SUPER_ADMIN: lista OPEN, detalle/timeline, formularios «Confirmar devolución recibida» y «Confirmar transferencia». Selección de receptor por registros elegibles y verificación explícita de confirmaciones telefónicas; sin botón «marcar entregado». Resumen final incluye que no habrá cargo ni refund automático.
- Resolver exige confirmación final y conserva Idempotency-Key/body hasta resultado definitivo. Timeout → lectura y mismo replay; 409 → refrescar, no cambiar clave para insistir a ciegas. allowedActions es guía UI, no autoridad. No mostrar resolución exitosa optimista.
- Transferencia muestra «custodia recibida», hitos anteriores con actores originales y siguiente paso pendiente. Retorno muestra «Devuelto al origen — cerrado», nunca «Entregado». Antigua asignación sólo histórica. Asegurar acceso nuevo dueño y retirada del anterior tras transferencias entre modos/proveedores.
- Bloque financiero separado, con instrucciones suspendidas/históricas según estado; no «pagado» al entregar/retornar. Frontend deberá sincronizar OpenAPI y tipos nuevos cuando exista implementación; hoy este documento es el contrato propuesto.

## 12. Pruebas y etapas

**No ejecutadas ahora.** Matriz mínima futura:

| Área | Pruebas obligatorias |
|---|---|
| Secuencia | Cinco hitos, saltos/retrocesos rechazados, DELIVERED canónico, legacy sin hitos ficticios, nueva asignación ordinaria inicia cero, transferencia hereda cadena. |
| Acceso | Admin proveedor propio/ajeno, independiente propio, flotilla sin escritura, SUPER_ADMIN sólo incidencias/resoluciones, B2B sin mutaciones humanas; old/new owner después de transferir. |
| Reporte | Sólo postrecogida, máximo una OPEN, doble reporte/replay, actor/fecha no falsificables; cola visible sin envío externo. |
| Retorno | Confirmación completa, origen fijo, tiempos válidos, terminal sin ACTIVE, cero deliveredAt/outbox completed, ledger idéntico, cancel repetido sin refund. |
| Transferencia | Misma flotilla, entre flotillas, FLEET↔INDEPENDENT, independiente↔independiente; receptor suspendido/ocupado/ajeno/incompatible; mismo conductor rechazado; tercero no puede resolver. |
| Integridad | Cadena cíclica, resolución huérfana o cruzada, segunda resolución, dos custodios, cero custodios tras transferencia, FK simulada para eludir cargo, raíces sin award: todos rechazados, también por SQL. |
| Carreras | Dos admins return vs transfer; transfer vs deliver/incidente/cancel/reassign; receptor ocupado concurrentemente; timeout tras commit y replay exacto; roles/membership revocados concurrentemente. |
| Rollback | Fallo tras terminar origen, crear receptor, evento, resolución o cierre: todo restaurado; sin recursos perdidos, ledger intacto, sin señal pública falsa. |
| Financiero | Award original único para cadena, cambio de modo sin precio nuevo; refunds ordinarios preservados; retorno sin refund; CASH/COURIER_ADVANCE/PREPAID, sin repetir adelantos ni acreditar cobro. |
| Público | Seis estados existentes, retorno CANCELLED+outcome, progreso por consulta, privacidad, snapshot del ejecutor final, delivery.completed único y sin nuevos webhooks. |
| Migración/UI | Limpia y upgrade con servicios activos/históricos, historial conservado, ambas apps web/pantallas por rol, tipos/lint/build/OpenAPI/exportador y regresión de módulos afectados. |

Etapas recomendadas, sin asignar versión:

1. **Persistencia y dominio:** esquema/guards/recibos, progreso, incidente, retorno y transferencia con atomicidad e invariantes económicas. Probar PostgreSQL aislado y regresiones de assignments, dispatch, independent, completion, credits/refunds/outbox. No activar un subconjunto que deje sin resolución a una custodia nueva.
2. **API, proyecciones y web:** DTOs, permisos, lectura B2B, instrucciones, cola/formularios administrativos y consumidores de ejecutor nuevo. Pruebas completas de archivos afectados, contrato y visuales. Sin integración externa ni nuevo webhook.
3. **Verificación y habilitación coordinada posterior:** migración/upgrade, carreras adversariales, recuperación de respuesta incierta y simulación con operadores; habilitar sólo con todos los escritores compatibles y responsable de cola definido. No se autoriza ejecutar esta etapa ahora.

## 13. Pendientes reales y resultado

Las decisiones de producto de esta solicitud quedan incorporadas; no se vuelve a pedir aprobación de los cinco hitos, bloqueos, roles, devolución/transferencia o polling B2B. Los detalles técnicos de esta propuesta no exigen otra decisión de negocio para implementar.

Antes de operar hace falta **designar quién cubre SUPER_ADMIN y el tiempo de atención de incidentes con custodia retenida**, incluido suplente. Es un acuerdo operativo: el sistema no liberará recursos por timeout. No se infiere que el SLA técnico previo de ocho horas sea aceptable para comida bajo custodia. Fuera del alcance permanecen acuerdos comerciales de comida, adelantos y remuneración entre ejecutores; no se automatizan ni se convierten en condición oculta del comando de custodia.

**DISEÑO TÉCNICO CERRADO PARA IMPLEMENTACIÓN; NO IMPLEMENTADO.** Restricciones económicas actuales requieren las migraciones/guards descritos; no afirmar que return/transfer ya funcionan. Sin pruebas nuevas de producto, migraciones ejecutadas, GPS, apps móviles, Coita, Docker, commit, push ni despliegue.
