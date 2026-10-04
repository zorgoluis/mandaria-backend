# Seguimiento público B2B — fotografía versionada

Implementación sobre QA b4318ce, 2026-10-04. Disponible en el checkout con los cambios de esta tarea; no acredita publicación Git, despliegue ni activación. Sustituye las brechas correspondientes del [análisis previo](B2B-TRACKING-ANALYSIS.md), que se conserva como evidencia histórica.

## Endpoint y permiso

`GET https://mandaria.com.mx/api/v1/delivery-requests/{publicId}/status`

Integration Bearer + `deliveries:read`. Sólo la MDR propia del principal. Ajeno e inexistente:404. JWT humano:401. Scope insuficiente:403. Header de respuesta `Cache-Control: private, no-store`. No body ni parámetro de integración/ejecutor. Esta capacidad no añade endpoints, timeline ni eventos.

La consulta puede materializar un registro interno de fotografía y la observación de vencimiento; **no** modifica estados operativos, asignaciones, créditos, TTL, resoluciones ni outbox. Polling repetido estable no escribe. No llamar rutas privadas Driver/Provider/Admin para completar información.

## Campos aditivos exactos

| Campo | Tipo / interpretación |
|---|---|
| publicVersion | string decimal positivo (`^[1-9][0-9]*$`), durable y monotónico por MDR. Comparar con BigInt, no lexicográficamente ni como float. Versiones iguales representan la misma fotografía JSON, independientemente del orden de claves. Puede saltar valores. |
| trackingMode | `DETAILED`: existe ejecución detallada persistida; `LEGACY`: tuvo asignación sin ejecución detallada; `null`: nunca tuvo asignación. Permanece clasificado al terminar. No depende del flag de nuevas asignaciones ni del modo de pago. |
| assignmentState | `NONE`: nunca asignado. `ACTIVE`: asignación vigente y servicio ASSIGNED. `ENDED`: existió asignación y ya no hay una vigente. No publica identificadores internos. |
| terminalOutcome | `null` mientras no hay resultado terminal; en terminal `{type,occurredAt}`. type=`DELIVERED`, `RETURNED_TO_ORIGIN`, `CANCELLED` o `EXPIRED`. occurredAt es ISO8601 de la evidencia persistida; nullable para ausencia de evidencia histórica. No acredita dinero. |

Los campos anteriores `publicId`, `externalReference`, `status`, `execution`, `requestedAt`, `deliveredAt`, `cancelledAt`, `executionProgress`, `executionOutcome` conservan su forma y significado. En concreto:

- Sin ejecución detallada se siguen omitiendo executionProgress/executionOutcome. No fabricar hitos legacy.
- Detallado ASSIGNED conserva executionProgress con phase, revision interna, registeredAt y attentionRequired. Al terminar, executionProgress=null. **publicVersion** sigue disponible y cubre toda la fotografía; no usar la revisión interna para ordenar respuestas completas.
- executionOutcome sigue siendo sólo RETURNED_TO_ORIGIN o null cuando se incluye. El campo aditivo terminalOutcome cubre los cuatro finales.
- RETURNED_TO_ORIGIN mantiene status=CANCELLED, deliveredAt=null. La etiqueta específica prevalece sobre "Cancelado". occurredAt expresa devolución física declarada; cancelledAt expresa registro de cancelación y puede ser posterior.
- EXPIRED corresponde al vencimiento de Dispatch OPEN, no al vencimiento de MPQ/MQ. CLAIMED no vence por terminar la ventana de adjudicación. Una cancelación posterior de un EXPIRED puede cambiar el resultado público a CANCELLED con versión mayor, sin reabrir el reparto.
- ASSIGNED puede ser proveedor que hizo CLAIM sin Driver: trackingMode=null y assignmentState=NONE. Un Driver sin nombre público también devuelve driver=null; sólo assignmentState informa si hay asignación.
- Retirar/reasignar antes de recogida conserva la historia. executionProgress puede mostrar último hito registrado mientras assignmentState=ENDED; la UI no debe presentarlo como desplazamiento de un repartidor vigente. La nueva asignación reinicia fase, pero no publicVersion.

## Identidad y privacidad

execution sigue exponiendo únicamente mode y provider/driver con displayName autorizado o null. Durante ASSIGNED representa ejecutor vigente; después de transferencia toma la asignación receptora, aunque el cargo original pertenezca a otro actor. No inferir otro cargo, recogida ni identidad única a partir del nombre.

Tras quitar asignación se retira identidad del Driver de la vista vigente; puede permanecer proveedor a cargo. Después de release execution=null. DELIVERED conserva la identidad pública congelada al cerrar: renombrar perfiles después no cambia el comprobante logístico. CANCELLED/RETURNED ocultan nombres y pueden conservar modo; OPEN/EXPIRED no presentan ejecutor. No se añaden IDs internos, teléfono, vehículo, actor administrativo, motivo de incidencia, confirmación privada o recibos financieros.

El integrador consulta desde su servidor y comparte sólo esta proyección con sus pantallas autorizadas. No difundir el detalle MDR con contactos ni enviar clientSecret/JWT B2B al navegador/app del cliente. Una incidencia sólo muestra attentionRequired=true; no exponer su causa privada.

## Cómo funciona publicVersion

Nueva tabla técnica `PublicDeliveryTracking`, una fila por DeliveryRequest, version bigint, snapshot JSONB seguro y expiryObserved. La migración inicializa versión1 sin reconstruir cronología ni hitos anteriores. No es un ledger financiero ni un historial de eventos público.

Triggers transaccionales invalidan snapshot y aumentan versión ante escrituras de DeliveryRequest, Dispatch, DispatchCandidate, DeliveryAssignment, DeliveryExecution, DeliveryCustodyIncident y DeliveryCustodyResolution. Cambios de Driver.displayName y DeliveryProvider.name invalidan solicitudes CLAIMED relacionadas. Cubren hitos, atención, asignación, transferencia, nombres y cierres incluso cuando cambian dos veces entre consultas. La invalidación es conservadora: puede subir versión por una escritura que finalmente no cambie la proyección. No exigir incrementos de exactamente uno.

GET construye la fotografía en RepeatableRead, después del filtro de ownership. La compara por JSONB y publica snapshot/version de forma atómica. Si un escritor o lector concurrente invalida/publica durante la operación, PostgreSQL impide sobrescribir la revisión más reciente y se reintenta de forma acotada (cinco intentos). Agotamiento:503; no devolver una versión inventada. Las lecturas ya estables no actualizan la fila. No hay timestamp de consulta dentro de la representación versionada.

Vencimiento por reloj: la primera observación efectiva EXPIRED queda persistida, con expiresAt como fecha del resultado y versión nueva si antes se publicó otra fotografía. expiryObserved impide retroceder a OPEN por corrección regresiva del reloj. No ejecuta expiración operacional ni invalida cobros. Los demás finales provienen de estados/fechas/resoluciones ya persistidos; snapshot conserva el resultado para consulta y los triggers permiten reconstruirlo coherentemente si cambia algún campo público.

Invariante: para la misma MDR, una versión ya publicada no identifica dos fotografías distintas. PublicVersion no es comparable entre MDR distintas ni entre restauraciones de base con pérdida de historia. Un restore que retrocede datos requiere reconciliación operativa; el cliente no debe aplicar silenciosamente versiones menores. No es un identificador de evento ni de intento de comando.

## Consulta periódica y orden

1. Backend del integrador persiste pedido↔MDR y la última fotografía/version. externalReference no es única. Una sola petición en vuelo por MDR; repartir actualizaciones a sus pantallas.
2. Objetivo propuesto: **15s** para entregas activas observadas. REQUESTED/OPEN o segundo plano pueden usar60s. Jitter y programación agregada; no una conexión por cada pantalla.
3. Límite implementado:100 consultas/minuto por manejador/IP, almacenamiento local de Throttler. Todos los publicId de status comparten bucket; IP efectiva puede ser proxy y varias integraciones pueden compartirla. No es capacidad garantizada ni cuota distribuida por cliente. A15s, `4 × MDR activas/minuto`:4 activas=16/min;25=100 sin margen;100=400 y excede. Presupuesto recomendado inicial60/min, ajustando frecuencia/concurrencia según tráfico real; no se ejecutó benchmark.
4. Recibir versión menor: descartar como atrasada; igual: misma fotografía, no repetir efectos; mayor: reemplazar fotografía. Una fase puede reiniciarse por reasignación legítima con versión mayor. No ordenar por etiqueta, fecha de recepción ni revision de executionProgress. Comparar BigInt sin convertir a Number.
5. 429: respetar Retry-After cuando llegue. Red/5xx: backoff15→30→60→120s con jitter; mostrar última actualización y falta de frescura. 401: renovación coordinada de token una vez, luego escalar;403/404: revisar autorización/MDR sin interpretar cancelación. No reenviar operaciones físicas.
6. TerminalOutcome no-null confirmado: detener consultas periódicas de ese servicio; conservar versión/resultado. Se permite consulta explícita posterior. No parar por incidencia, timeout o respuesta incompleta de un servidor antiguo.
7. `delivery.completed` conserva su sobre/firma/payload congelado anterior y **no incluye los cuatro campos nuevos**. Deduplique eventId duraderamente y consulte /status para reconciliar; no compare directamente eventId ni el reloj del webhook con publicVersion. Un evento viejo no debe degradar la fotografía. No hay nuevos webhooks.

## Cancelación bajo custodia:409

POST `/api/v1/delivery-requests/{publicId}/cancel`, scope deliveries:cancel, puede devolver409 CUSTODY_OPERATION_FORBIDDEN o CUSTODY_INCIDENT_OPEN. No libera custodia ni genera un reemplazo permitido. Conservar MDR, consultar status y escalar al operador por los canales acordados. El integrador no resuelve custodia ni suplanta a SUPER_ADMIN.

Timeout o resultado incierto: GET de esa misma MDR/status y, cuando corresponda, detalle de solicitud; no inventar éxito ni crear otra solicitud. Una MDR CANCELLED administrativa no prueba ausencia de entrega si status continúa DELIVERED. Antes de reiniciar envío aplicar el protocolo de cancelación definitivo del flujo convertido; no implica devolución de comida/envío ni otro cargo de comida.

## Ejemplo ficticio actual

```json
{
  "publicId":"MDR-000123",
  "externalReference":"DEMO-123",
  "status":"ASSIGNED",
  "execution":{"mode":"PROVIDER","provider":{"displayName":"Reparto Demo"},"driver":{"displayName":"Alex Demo"}},
  "requestedAt":"2026-10-04T14:00:00.000Z",
  "deliveredAt":null,
  "cancelledAt":null,
  "executionProgress":{"phase":"PICKED_UP","revision":4,"registeredAt":"2026-10-04T14:15:00.000Z","attentionRequired":false},
  "executionOutcome":null,
  "trackingMode":"DETAILED",
  "assignmentState":"ACTIVE",
  "terminalOutcome":null,
  "publicVersion":"18"
}
```

Al devolver: status=CANCELLED; executionProgress=null; executionOutcome y terminalOutcome contienen RETURNED_TO_ORIGIN/occurredAt; assignmentState=ENDED, trackingMode=DETAILED; publicVersion mayor. Al entregar: status=DELIVERED, deliveredAt y terminalOutcome DELIVERED; executionProgress/executionOutcome=null; identidad final congelada. Legacy no añade P/O, pero sí trackingMode=LEGACY, assignmentState y publicVersion/terminalOutcome.

## Handoff FRONTEND del portal e integradores

Sin cambios de frontend en esta tarea. Sincronizar `docs/openapi-b2b.json` y esta guía cuando se publique el backend. Portal debe documentar los nuevos campos, comparación decimal,401/403/404/409/429/503, objetivo15s sin SLA y completed+GET; conservar secciones de firma y deduplicación actuales.

Etiquetas: REQUESTED "Solicitud recibida"; OPEN "Buscando reparto"; ASSIGNED sin ACTIVE "Proveedor a cargo / esperando repartidor"; TO_PICKUP "En camino a recoger"; AT_PICKUP "En recogida"; PICKED_UP "Pedido recogido"; TO_DROPOFF "En camino al destino"; AT_DROPOFF "En destino"; DELIVERED "Entregado"; RETURNED_TO_ORIGIN "Devuelto al origen"; CANCELLED "Cancelado"; EXPIRED "Servicio vencido". Atención agrega "Requiere atención operativa". La ausencia de seguimiento detallado no autoriza a fabricar horas/hitos. Nada de esto significa "cobrado".

No dibujar una línea de tiempo con fechas inventadas. No mostrar al receptor anterior como vigente tras transferencia ni publicar motivos privados. No usar errores HTTP o ausencia de campos para decidir legacy. Con servidor antiguo sin publicVersion, indicar que el contrato versionado no está disponible y refrescar tras actualización coordinada, sin avanzar una versión local ficticia.

## Migración, despliegue y reversión (no ejecutados remotamente)

Migración incremental `20261004000300_public_delivery_tracking`, después de las existentes; no modificar migraciones históricas ni resetear. Una fila por solicitud anterior; conserva datos e historia de negocio. No cambia flags, precios, TTL ni seeds. Respaldar y aplicar con procedimiento operativo autorizado, actualizar todos los lectores/escritores compatibles y comprobar que todos sirven campos nuevos. No prometer el contrato nuevo durante mezcla de instancias antiguas y actuales; permanecen las restricciones coordinadas de autoridad DRIVER/custodia.

Rollback de aplicación sólo a artefacto compatible con las migraciones de autoridad previas; conservar tabla/triggers e historia. No borrar versiones ni restaurar un backup antiguo sin reconciliar integradores. Deshabilitar DETAILED_EXECUTION_ENABLED únicamente detiene admisiones futuras y no retira seguimiento existente. No hay activación automática ni cambios de configuración en esta tarea.

Verificación nueva y límites: [informe local](PUBLIC-B2B-TRACKING-VERIFICATION.md). PostgreSQL local sintético; ningún acceso a Coita o producción.
