# Ejecución detallada — contrato para Frontend y operación

2026-10-02. Implementación en QA, sin nueva versión de paquete ni activación. Diseño aprobado: [propuesta](DETAILED-EXECUTION-PROPOSAL.md). Resultados locales y límites: [verificación](DETAILED-EXECUTION-VERIFICATION.md). No se modificó Frontend.

## Lectura y permisos

Prefijo de **todas** las rutas: `/api/v1`. Bearer humano; B2B no puede escribir ejecución. PROVIDER_ADMIN usa su identidad y membership vigente; `?providerId=UUID` selecciona proveedor cuando tiene varios. No se vuelve a exigir elegibilidad comercial al custodio para continuar un servicio ya adjudicado. El receptor nuevo sí debe ser elegible al commit.

| Método + ruta | Permiso | Resultado |
|---|---|---|
| GET `/provider/dispatches/:dispatchId/execution` | Administrador del ejecutor vigente | `{execution,events}`; eventos paginados por `page/pageSize`, más reciente primero |
| GET `/driver/dispatches/:dispatchId/execution` | Independiente ejecutor vigente | Mismo contrato |
| GET `/admin/dispatches/:dispatchId/execution` | SUPER_ADMIN | Auditoría; acciones sólo reportar/resolver incidencia |
| POST `/provider/dispatches/:dispatchId/execution-events` | Administrador ejecutor | 200 ExecutionView |
| POST `/driver/dispatches/:dispatchId/execution-events` | Independiente ejecutor | 200 ExecutionView |
| POST `/provider/dispatches/:dispatchId/custody-incidents` | Administrador ejecutor | 201 `{id,execution}` |
| POST `/driver/dispatches/:dispatchId/custody-incidents` | Independiente ejecutor | 201 `{id,execution}` |
| POST `/admin/dispatches/:dispatchId/custody-incidents` | SUPER_ADMIN que recibe el aviso | 201 `{id,execution}` |
| GET `/admin/custody-incidents` | SUPER_ADMIN | Página `{items,total,page,pageSize,totalPages}`. `status=OPEN` default o `RESOLVED` |
| GET `/admin/dispatches/:dispatchId/custody-incidents/:incidentId` | SUPER_ADMIN | `{incident,resolution}`; resolución nullable, motivos y confirmaciones privados |
| GET `/admin/dispatches/:dispatchId/custody-transfer-candidates` | SUPER_ADMIN | Pares Driver/Vehicle; `mode=FLEET` default o `INDEPENDENT`, page/pageSize. No reserva recursos |
| POST `/admin/dispatches/:dispatchId/custody-incidents/:incidentId/resolve` | SUPER_ADMIN | 200 ResolutionView |

La entrega conserva POST `/provider/dispatches/:dispatchId/deliver` y `/driver/dispatches/:dispatchId/deliver`, body vacío e idempotencia existentes. SUPER_ADMIN no avanza ni entrega por el ejecutor. DRIVER de flotilla continúa reportando por teléfono: su lectura `/driver/me` muestra progreso, con acciones de ejecución vacías.

El detalle/listado operativo del proveedor y el detalle independiente agregan `execution` sólo al ejecutor vigente detallado; `/driver/me.activeDeliveryAssignment` también lo incluye. El anterior proveedor queda en SUMMARY, sin contactos/instrucciones actuales; conserva su historial propio en assignment history y la evidencia económica original. El anterior independiente deja de acceder al detalle operativo. Auditoría completa en SUPER_ADMIN. No usar las columnas históricas del claim para decidir quién ejecuta tras una transferencia.

## Comandos y recuperación

Actualización 2026-10-03: [contrato de consulta y cierre durable del intento](EXECUTION-ATTEMPT-RECONCILIATION.md). Reemplaza el bloqueo ante cuerpo perdido: GET propio no muta; POST close invalida permanentemente una clave no aplicada y se serializa con resolve. Frontend debe integrar estas rutas; no se cambió aquí. Ausencia de recibo continúa siendo incierta.

Todos los POST nuevos requieren `Idempotency-Key: UUID`. Cuerpo común: `assignmentId` vigente y `expectedRevision` de la lectura. Actor/source/fechas de registro salen del servidor; campos ajenos se rechazan.

Avance, ejemplo ficticio:

```json
{"assignmentId":"00000000-0000-4000-8000-000000000001","expectedRevision":1,"phase":"TO_PICKUP"}
```

Fases consecutivas: `null → TO_PICKUP → AT_PICKUP → PICKED_UP → TO_DROPOFF → AT_DROPOFF → deliver`. Ningún salto, retroceso o hito inferido. Reassign ordinario antes de recoger inicia otra cadena desde cero; transferencia conserva la cadena. `revision` no reinicia.

Incidencia añade `reasonCode` (`RECIPIENT_UNAVAILABLE`, `DELIVERY_REFUSED`, `VEHICLE_FAILURE`, `SAFETY_CONCERN`, `OTHER`) y `reasonDetail` de 3–500 caracteres. Sólo después de PICKED_UP, una abierta por servicio. Mantiene recursos/custodia, bloquea avances/entrega y se atiende en la cola persistente; no hay correo automático nuevo.

Devolución, cuerpo ficticio completo:

```json
{
  "assignmentId":"00000000-0000-4000-8000-000000000001",
  "expectedRevision":5,
  "type":"RETURN_TO_ORIGIN",
  "reason":"Restaurante confirma recepción completa del pedido",
  "occurredAt":"2026-10-02T19:00:00.000Z",
  "confirmationMethod":"PHONE",
  "custodianConfirmed":true,
  "originConfirmed":true,
  "originContactLabel":"Encargado de turno",
  "originContactRole":"Responsable del restaurante"
}
```

Etiquetas/rol del restaurante: 1–100 caracteres; no solicitar teléfonos ni documentos en este formulario. La fecha física no puede ser futura ni anterior al último hito de custodia registrado/transferencia confirmada. El servidor conserva `recordedAt` por separado. La confirmación telefónica es una atestación de SUPER_ADMIN, no una prueba criptográfica.

TRANSFER usa los campos comunes de resolución (`assignmentId`, `expectedRevision`, `type`, `reason`, `occurredAt`, `confirmationMethod`) y:

```json
{
  "recipient": {
    "mode":"FLEET",
    "providerId":"00000000-0000-4000-8000-000000000002",
    "driverId":"00000000-0000-4000-8000-000000000003",
    "vehicleId":"00000000-0000-4000-8000-000000000004"
  },
  "releasingCustodianConfirmed":true,
  "receivingCustodianConfirmed":true,
  "atCurrentStageLocation":true,
  "recipientProviderAdminUserId":"00000000-0000-4000-8000-000000000005",
  "recipientProviderAdminConfirmed":true
}
```

Para INDEPENDENT, omitir providerId y los dos campos de administrador receptor. No mezclar campos de retorno/transferencia. Seleccionar un conductor distinto y vehículo elegible/libre; FLEET exige proveedor ACTIVE, cobertura y pairing compatibles, más membership activo del administrador confirmado (consultable por la administración de members existente). INDEPENDENT exige perfil APPROVED y vehículo propio. La disponibilidad del listado es orientativa; el POST revalida bajo locks e índices únicos.

ResolutionView: `{id,type,occurredAt,recordedAt,fromAssignmentId,toAssignmentId,execution}`. Retorno: destino null, Dispatch/asignación RETURNED, MDR CANCELLED con motivo RETURNED_TO_ORIGIN, cero asignaciones ACTIVE, sin DELIVERED/outbox de entrega ni refund. Transferencia: anterior TRANSFERRED, nueva ACTIVE, misma fase, una sola custodia; no otro TAKE/CLAIM ni débito.

ExecutionView, ejemplo ficticio:

```json
{
  "trackingMode":"DETAILED","revision":4,"phase":"PICKED_UP",
  "activeAssignmentId":"00000000-0000-4000-8000-000000000001",
  "custodyStatus":"HELD","openIncidentId":null,
  "allowedActions":["ADVANCE","REPORT_INCIDENT"],
  "lastRecordedAt":"2026-10-02T18:00:00.000Z"
}
```

`custodyStatus`: NOT_COLLECTED / HELD / RETURNED / DELIVERED. Acciones ordinarias sólo antes de recoger; con incidencia, el operador no avanza y SUPER_ADMIN recibe RESOLVE_INCIDENT. El timeline contiene kind, phase numérica (0–5), revision, assignmentId, actorUserId/actorRole históricos, source y recordedAt. PHONE_REPORT identifica al administrador que recibió la llamada; SELF_REPORT al independiente. Cierres ordinarios B2B/sistema sin User se registran ENDED/SYSTEM_CANCELLATION con actor null, sin inventar identidad humana.

Misma clave + actor + operación + despacho + body devuelve el resultado original incluso después del cierre/transferencia. Clave repetida con contenido diferente: 409 IDEMPOTENCY_KEY_REUSED. Conservar clave/body hasta resultado definitivo; ante timeout consultar y repetir exactamente. No cambiar de clave para insistir a ciegas. No mostrar éxito optimista: una entrega física por teléfono no puede hacerse atómica con PostgreSQL; ante incertidumbre conservar incidencia y reconciliar con SUPER_ADMIN.

Errores: 400 validación; 401 token humano requerido; 403 rol/membership; 404 ajeno/inexistente; 409 EXECUTION_CONFLICT, EXECUTION_TRANSITION_INVALID, CUSTODY_OPERATION_FORBIDDEN, CUSTODY_INCIDENT_REQUIRED, CUSTODY_INCIDENT_OPEN, INCIDENT_ALREADY_OPEN, INCIDENT_ALREADY_RESOLVED, CUSTODY_RECIPIENT_NOT_ELIGIBLE, IDEMPOTENCY_KEY_REUSED. Revisión obsoleta no permite escribir. Resoluciones con otra clave después del cierre no se repiten. Un fallo de persistencia revierte toda la transacción.

## Dinero y B2B

En vistas detalladas autorizadas: `collectionActionAllowed` sólo true en AT_DROPOFF vigente y sin incidencia; `advanceToOriginAllowed=false` desde PICKED_UP, también para el receptor. Los importes históricos de COURIER_ADVANCE no se borran ni se vuelven a adelantar. Frontend debe usar estos indicadores sobre las instrucciones contractuales de referencia. PREPAID sigue significando comida pagada, no envío pagado. Ningún hito, entrega, transferencia ni retorno confirma cobro. El award original se conserva y estas excepciones no llaman al ledger ni generan refunds.

GET B2B `/delivery-requests/:publicId/status` añade opcionalmente `executionProgress={phase,revision,registeredAt,attentionRequired}` en ASSIGNED; sin IDs internos ni motivos/actores. Tras retorno: CANCELLED, deliveredAt null, `executionProgress=null`, `executionOutcome={type:"RETURNED_TO_ORIGIN",occurredAt}`. Legacy conserva respuesta sin estos campos. `delivery.completed` sólo al cierre real; mismo formato, snapshot del ejecutor final. No nuevos webhooks: consultar periódicamente y descartar revisiones atrasadas.

OpenAPI completo: `docs/openapi.json`; público: `docs/openapi-b2b.json`. Sincronizar ambos consumidores correspondientes después de generar con `npm run docs:b2b`; comprobar con `npm run docs:b2b:check` y `npm run test:public-b2b`.

## Despliegue futuro y reversión — no ejecutados

1. Designar responsable, suplente y tiempo de atención SUPER_ADMIN; preparar Frontend y procedimiento de confirmación/incertidumbre. Mantener `DETAILED_EXECUTION_ENABLED=false` hasta autorización expresa.
2. Verificar backup/restauración y ventana de mantenimiento. Detener todas las instancias escritoras y workers operativos; sin despliegue mixto. No ejecutar seeds/reset ni borrar volúmenes/historia.
3. Con conexión objetivo previamente identificada por operación, `npm ci`, `npm run db:generate`, `npm run db:deploy`, `npm run build`. Las dos migraciones nuevas separan incorporación de enums de su uso; no modificar migraciones históricas. Reiniciar todas las instancias con el mismo artefacto compatible y flag false.
4. Verificar salud, migraciones, accesos y servicios legacy. Activación posterior y coordinada sólo cuando Frontend/operación estén listos: nuevas asignaciones ordinarias crean historial detallado; ACTIVE anteriores siguen legacy sin hitos inventados. No activar gradualmente con escritores antiguos.
5. Desactivar admisión (`false`) conserva reglas y endpoints de las ejecuciones detalladas existentes. No bajar a una versión que ignore custodia/RETURNED/TRANSFERRED. Si falla, detener escritores y restaurar servicio con artefacto compatible; restauración de backup requiere procedimiento de recuperación y evaluación de cambios posteriores, no rollback SQL destructivo automático.
