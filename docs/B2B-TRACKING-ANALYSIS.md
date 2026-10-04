# Seguimiento público B2B — análisis previo a la app

> Antecedente histórico anterior al seguimiento versionado. Para integrar hoy, usar [PUBLIC-B2B-TRACKING.md](PUBLIC-B2B-TRACKING.md): las fotografías se ordenan por publicVersion de la misma solicitud, no por revision de ejecución. Las limitaciones descritas debajo corresponden a la revisión indicada.

Fecha: 2026-10-04. Revisión estática de QA `b4318ce`. No implementa ni activa capacidades. "Actual" significa presente en este checkout y su contrato generado, no verificado en producción. No se accedió a Coita ni a bases; las pruebas de continuidad son históricas.

## 1. Inventario implementado

Origen confirmado `https://mandaria.com.mx`; las rutas siguientes ya incluyen `/api/v1`. Bearer de integración salvo token. Los scopes de `x-scopes` son acumulativos (AND), no scopes OAuth inferidos del esquema Bearer. Ownership procede del principal autenticado; nunca del body. MDR/MPQ pertenecen al cliente; MQ se autoriza por su MDR. Ajeno e inexistente devuelven el mismo 404 con credenciales/scopes válidos. /me y scope-check describen exclusivamente al principal.

La tabla se extrajo del OpenAPI público existente, contrastando controladores/guards. Los códigos son los DOCUMENTADOS; más abajo se señalan omisiones frente al código. DTOs son nombres exactos enlazados al artefacto, no propuestas.

| Método y ruta | Scopes | Parámetros (además de Bearer) / body | Éxito | Errores documentados |
|---|---|---|---|---|
| POST `/api/v1/integrations/token` | Sin scope adicional | JSON IntegrationTokenDto | 200 IntegrationTokenResponse | 401, 429 |
| GET `/api/v1/integrations/me` | Sin scope adicional | Ninguno | 200 IntegrationMeResponse | 401 |
| GET `/api/v1/integrations/scope-check` | deliveries:read | Ninguno | 200 objeto inline | No declarados |
| POST `/api/v1/delivery-requests` | deliveries:create | header: Idempotency-Key (requerido); JSON CreateDeliveryRequestDto | 200 DeliveryRequestResponse; 201 DeliveryRequestResponse | 400, 401, 403, 409, 429, 500 |
| GET `/api/v1/delivery-requests` | deliveries:read | query: page (opcional); query: pageSize (opcional); query: publicId (opcional); query: externalReference (opcional); query: status (opcional); query: requestedFrom (opcional); query: requestedTo (opcional) | 200 DeliveryRequestPageResponse | 400, 401, 403, 429, 500 |
| GET `/api/v1/delivery-requests/{publicId}` | deliveries:read | path: publicId (requerido) | 200 DeliveryRequestResponse | 400, 401, 403, 404, 429, 500 |
| GET `/api/v1/delivery-requests/{publicId}/status` | deliveries:read | path: publicId (requerido) | 200 DeliveryStatusResponse | 400, 401, 403, 404, 429, 500 |
| POST `/api/v1/delivery-requests/{publicId}/cancel` | deliveries:cancel | path: publicId (requerido); JSON CancelDeliveryRequestDto | 200 DeliveryRequestResponse | 400, 401, 403, 404, 429, 500 |
| POST `/api/v1/delivery-requests/{publicId}/quotes` | quotes:create | path: publicId (requerido) | 200 DeliveryQuoteResponse; 201 DeliveryQuoteResponse | 400, 401, 403, 404, 409, 422, 429, 500, 503 |
| GET `/api/v1/delivery-requests/{publicId}/quotes` | quotes:read | path: publicId (requerido); query: page (opcional); query: pageSize (opcional) | 200 DeliveryQuotePageResponse | 400, 401, 403, 404, 429, 500 |
| GET `/api/v1/delivery-quotes/{publicId}` | quotes:read | path: publicId (requerido) | 200 DeliveryQuoteResponse | 400, 401, 403, 404, 429, 500 |
| POST `/api/v1/delivery-quotes/{publicId}/accept` | quotes:accept | path: publicId (requerido); header: Idempotency-Key (opcional); JSON AcceptDeliveryQuoteDto | 200 DeliveryQuoteResponse | 400, 401, 403, 404, 409, 422, 429, 500, 503 |
| POST `/api/v1/delivery-prequotes` | prequotes:create | header: Idempotency-Key (requerido); JSON CreatePrequoteDto | 200 PrequoteResponse; 201 PrequoteResponse | 400, 401, 403, 409, 422, 429, 503 |
| GET `/api/v1/delivery-prequotes/{publicId}` | prequotes:read | path: publicId (requerido) | 200 PrequoteResponse | 400, 401, 403, 404, 429, 500 |
| POST `/api/v1/delivery-prequotes/{publicId}/convert` | prequotes:convert, deliveries:create, quotes:create | path: publicId (requerido); header: Idempotency-Key (requerido); JSON ConvertPrequoteDto | 200 PrequoteConversionResponse; 201 PrequoteConversionResponse | 400, 401, 403, 404, 409, 429, 503 |

### Entradas y respuestas: referencia exacta

[Contrato completo público](openapi-b2b.json). Cada nombre siguiente identifica `components.schemas.<nombre>` con tipos, required, enums y validaciones anidadas. Se listan campos de primer nivel; no sustituye esos esquemas.

| DTO | Campos (`*` obligatorio) |
|---|---|
| IntegrationTokenDto | clientId*, clientSecret* |
| CreateDeliveryRequestDto | serviceType, externalReference, stops*, packages*, financialContext* |
| CancelDeliveryRequestDto | reason* |
| AcceptDeliveryQuoteDto | customerAuthorization |
| CreatePrequoteDto | conditionsVersion*, serviceType*, stops*, packages* |
| ConvertPrequoteDto | conditionsVersion*, deliveryRequest*, merchantConfirmation*, deliveryCollectionInstruction* |

### Semántica complementaria del inventario

- Token: `clientId/clientSecret` → `{accessToken,tokenType,expiresIn}`; conservar credenciales sólo en servidor. `/me` devuelve id de la propia integración, name/code/status/createdAt/updatedAt/scopes. No usar ese UUID como identidad pública del ejecutor. Scope-check → `{authorized:true,scope:"deliveries:read"}`.
- MDR: identificador `MDR-` y al menos seis dígitos, normalizado a mayúsculas. MQ y MPQ tienen sus prefijos correspondientes. IDs de asignación/Dispatch no son parámetros B2B.
- Listado MDR: page=1 y pageSize=20 por defecto; máximos 100000 y 100. Filtros publicId, externalReference exacta, status **CREATED/CANCELLED** (no el estado logístico), requestedFrom/requestedTo ISO. Orden requestedAt DESC y desempate id DESC. Quotes usa la misma paginación. No hay filtro por fase, consulta masiva de progreso ni historial público.
- DeliveryRequestResponse: resumen de solicitud, fechas y estado administrativo; detalle incluye stops/packages, cancellationReason y financialContext. La lista no incluye contactos ni progreso. El detalle devuelve los contactos de la propia solicitud: no reutilizarlo como respuesta pública al comprador.
- DeliveryQuoteResponse: publicId, deliveryRequestPublicId, serviceType, serviceZone `{code,name}`, distanceMeters, durationSeconds, amount (string decimal), currency, status, createdAt/expiresAt/acceptedAt/cancelledAt/cancellationReason. No UUIDs de tarifa/proveedor/routing. Precio de envío no es valor de comida.
- Emisión MPQ y conversión: 201 inicial, 200 replay. MPQ conserva precio/TTL; conversión devuelve vínculos y estados actuales de MDR/MQ. Aceptación devuelve MQ, **no** el progreso. Ver DTO exacto en JSON para conditions, collection y atestaciones; ninguno autoriza al B2B a registrar hitos.
- Idempotency-Key de creación MDR/MPQ/conversión: 8–255 ASCII visibles, persistir por intención; no reutilizar entre intenciones. Accept convertido exige clave y autorización exacta de MQ; directo conserva body vacío y compatibilidad anterior. Cancel recibe `{reason}`, es repetible sobre la misma MDR y conserva motivo/fecha originales. No usar cancel para diagnosticar una lectura.
- GET `/status` no tiene body, filtros, cursor, `sinceRevision`, ETag ni endpoint B2B de intentos de ejecución. Los endpoints de reconciliación APP/WEB son humanos, privados; no proponer que el integrador los consuma.

**Errores reales y lagunas documentales:** envelope del filtro global `{statusCode,code,requestId,message,errors,timestamp,path}` y header X-Request-Id. 400 validación (VALIDATION_ERROR cuando lista de errores); 401 token humano/B2B inválido, expirado, cliente suspendido o credencial revocada; 403 scope insuficiente; 404 propio inexistente/ajeno; 429 throttling; 500 sanitizado. No inferir estado de entrega a partir de HTTP ni texto libre. GET no debe reenviarse como escritura. Token/me/scope-check no enumeran todos los errores comunes en OpenAPI. Cancel puede devolver **409 CUSTODY_OPERATION_FORBIDDEN/CUSTODY_INCIDENT_OPEN** por protección transaccional de custodia y conflictos de persistencia, aunque OpenAPI omite su 409. Una cancelación que afecta a algo ya entregado puede dejar MDR CANCELLED y `/status` DELIVERED; esta última lectura es la autoridad logística.

En cotización/aceptación: 409 conflictos de vigencia/estado/idempotencia; 422 cobertura/ruta no soportada; 503 indisponibilidad/configuración/flag según rama. MPQ documenta 409 PREQUOTE_IN_PROGRESS/otros conflictos, 429 PREQUOTE_CONSUMPTION_LIMIT, 503 de admisión/routing; conversión documenta PREQUOTE_ALREADY_CONVERTED, PREQUOTE_EXPIRED, PREQUOTE_CONDITIONS_MISMATCH, PREQUOTE_SERVICE_UNAVAILABLE y flags de conversión. El JSON conserva el catálogo por respuesta; no prometer que todo 409 sea vencimiento. Los errores de custodia se traducen por el filtro; otros errores Prisma no reconocidos quedan 500 sanitizado.

## 2. Matriz del recorrido actual

P = executionProgress; O = executionOutcome. **Omitido** significa propiedad ausente, distinto de `null`. Estas reglas pertenecen exclusivamente a GET MDR/status; no a GET MDR ni al webhook.

| Situación persistida | Respuesta B2B actual | Interpretación / etiqueta sugerida |
|---|---|---|
| Sin Dispatch, solicitud CREATED | REQUESTED; execution=null; P/O omitidos | Solicitud recibida; aún no publicada. No hay repartidor confirmado. |
| Dispatch OPEN sin asignación | OPEN; execution=null; P/O omitidos si nunca hubo ejecución detallada | Buscando servicio de reparto. |
| Proveedor hizo CLAIM, aún sin asignación | ASSIGNED; mode PROVIDER, nombre de proveedor, driver=null; P/O omitidos si no hay ejecución | Proveedor a cargo. ASSIGNED no prueba que ya exista repartidor. |
| Asignación nueva detallada sin primer hito | ASSIGNED; P `{phase:null,revision:1,registeredAt,attentionRequired:false}`; O=null | Repartidor asignado, sin inicio reportado. Revision puede ser mayor tras reasignación. |
| TO_PICKUP | ASSIGNED; P.phase=TO_PICKUP; O=null | En camino a recoger. |
| AT_PICKUP | ASSIGNED; P.phase=AT_PICKUP; O=null | En el punto de recogida. |
| PICKED_UP | ASSIGNED; P.phase=PICKED_UP; O=null | Pedido recogido. Custodia interna HELD, no un pago. |
| TO_DROPOFF | ASSIGNED; P.phase=TO_DROPOFF; O=null | En camino al destino. |
| AT_DROPOFF | ASSIGNED; P.phase=AT_DROPOFF; O=null | En el destino. Aún no entregado. |
| DELIVERED detallado | DELIVERED, deliveredAt; identidad final congelada; P=null, O=null | Entregado físicamente. No implica cobro confirmado. |
| Incidencia abierta bajo custodia | ASSIGNED, fase conservada >=PICKED_UP, revisión incrementada, attentionRequired=true; O=null | La entrega requiere atención. No mostrar causas privadas ni afirmar pérdida/devolución. |
| Transferencia de custodia | ASSIGNED, misma fase, revisión incrementada, attentionRequired=false; identidad del receptor vigente; O=null | Progreso conservado. No hay campo público que anuncie una transferencia. No afirmar una nueva recogida. |
| RETURNED_TO_ORIGIN | status=CANCELLED, deliveredAt=null, cancelledAt de registro; P=null; O `{type:RETURNED_TO_ORIGIN,occurredAt}`; execution con modo y nombres null | Devuelto al origen. No entregado al cliente, no devolución financiera. Priorizar O frente a etiqueta genérica CANCELLED. |
| Cancelación anterior a custodia | CANCELLED, cancelledAt; P/O omitidos sin ejecución detallada o ambos null si existe | Cancelado. execution puede conservar modo, con nombres null. |
| Vence ventana de Dispatch OPEN | EXPIRED, execution=null, deliveredAt/cancelledAt=null; P/O omitidos o null según historia detallada | Venció disponibilidad sin adjudicación vigente. GET calcula vencimiento sin escribir. |
| Vence MQ/MPQ antes de aceptar | `/status` puede seguir REQUESTED, P/O omitidos | No es EXPIRED logístico; consultar la MQ/MPQ para vigencia. |
| Legacy asignado/entregado | ASSIGNED/DELIVERED e identidad según contrato; P/O omitidos, sin hitos fabricados | Seguimiento sin detalle / entregado, respectivamente. Ausencia por sí sola no certifica LEGACY. |
| Release previo a recogida | OPEN o EXPIRED, execution=null; P/O null si hay ejecución detallada | Esperando nueva adjudicación o vencido; el historial no se publica. |
| Se retira asignación antes de recogida pero proveedor conserva CLAIM | ASSIGNED; driver puede ser null, P puede conservar último hito registrado | No hay activeAssignment público: el hito no prueba asignación vigente. Evitar promesa de movimiento actual. |

La última fila deriva de la consulta de DeliveryExecution sin verificar asignación ACTIVE y del evento ENDED que conserva fase. No se ejecutó reproducción nueva. Conviene incluirla en la prueba del futuro contrato para decidir una representación explícita de asignación vigente. Un nombre de Driver null también puede significar nombre público no configurado: no sirve como discriminante.

## 3. Alcance de progreso, revisión y resultado

### Presencia y conservación

El servicio devuelve primero la fotografía logística. Si no hay Dispatch o no hay DeliveryExecution, retorna sin P/O. Si existe DeliveryExecution, añade **ambas** propiedades: P sólo es objeto cuando status=ASSIGNED; en los demás estados es null. O sólo es objeto si existe resolución RETURN_TO_ORIGIN; en los demás casos es null. No hay P.phase=DELIVERED ni RETURNED_TO_ORIGIN: son resultados distintos de los cinco hitos.

El `trackingMode` añadido a vistas de proveedor/Driver/admin **no está en DeliveryStatusResponse ni en OpenAPI público**. P objeto acredita una ejecución detallada, pero P ausente también ocurre sin asignación, en legacy y ante versiones antiguas; P=null no informa su revisión terminal. El schema marca varios campos opcionales aunque el servicio actual emite execution/deliveredAt/cancelledAt siempre. El consumidor debe tolerar contratos anteriores sin convertir ausencia en progreso ficticio.

### Revisión y tiempos

- revision pertenece a **DeliveryExecution del Dispatch**, no al pedido externo ni a la versión global de toda la respuesta. Inicialización registra ASSIGNED y deja revision=1. Cada evento persistido incrementa, incluidos hitos, incidente, transferencia y cierre; no calcular `fase+1`.
- Transferencia conserva chainId/fase y aumenta revision. Reasignación ordinaria anterior a recogida inicia cadena/asignación con fase0, pero **no reinicia** la revisión del Dispatch. Un retroceso de fase con revisión mayor puede ser legítimo; no imponer orden de fase en el cliente.
- registeredAt es `DeliveryExecution.recordedAt`, copiado por trigger desde el último evento registrado en servidor. No es hora del GET, del dispositivo, ni necesariamente de ocurrencia física; puede corresponder a incidente/transferencia, no al hito visible. El timestamp no sustituye revisión ni es un reloj monotónico garantizado.
- O.occurredAt es la fecha física declarada y validada de la devolución; cancelledAt es fecha de registro. No tienen por qué coincidir. deliveredAt identifica el cierre físico registrado, no un comprobante de dinero.
- `/status` usa transacción RepeatableRead: los SELECT de una respuesta ven una fotografía coherente. No garantiza que siga vigente al recibirla ni orden de respuestas distintas.

### Respuestas atrasadas y terminales

Dentro de una misma MDR con P objeto, descartar una revisión menor que la guardada. Igual revisión no prueba igualdad de toda la respuesta: nombres públicos pueden cambiar sin evento logístico. No comparar revisiones entre MDR distintas; externalReference no es única.

Hoy no hay revisión pública global para terminales/OPEN/legacy ni fecha de observación. No se puede ordenar rigurosamente toda fotografía con el campo disponible. Mitigación compatible: un único GET en vuelo por MDR desde backend del integrador; secuencia local de consultas, descartar respuestas de consultas anteriores, evitar caché intermedia, y no degradar DELIVERED/CANCELLED/EXPIRED confirmado por una respuesta vieja ASSIGNED. Cualquier contradicción exige nueva consulta serial, no una operación logística automática. Dos consumidores independientes necesitan coordinación local; `registeredAt` no soluciona ese problema.

DELIVERED, CANCELLED (incluida devolución) y EXPIRED son finales para seguimiento operativo habitual de esa MDR; detener sondeo continuo tras confirmación. EXPIRED puede recibir después una cancelación administrativa sin reabrir servicio. Un nuevo envío se sigue por otra MDR. REQUESTED con MQ vencida requiere decisión comercial explícita; no sondearlo para siempre como si fuera reparto en curso. Error HTTP, timeout o ausencia de P **nunca** son terminales de negocio.

Al finalizar quedan resultado, fechas y, para DELIVERED, identidad final congelada; desaparecen último hito/revisión/atención de P. No puede reconstruirse una línea de tiempo completa desde la respuesta final. Si el integrador guardó observaciones, son observaciones parciales, no el historial certificado: puede haberse perdido cualquiera de los hitos entre consultas.

### Identidad tras transferencia

`deliveryStatusSelect` selecciona asignación ACTIVE/COMPLETED/RETURNED; si tiene custodyResolutionId, el modo/proveedor/Driver se toman de ese receptor, no del pagador original. Sólo displayName público. Al entregar se usa snapshot inmutable. Para RETURNED no se conservan nombres en la proyección pública. No existe ID público estable de ejecutor ni evento público de transferencia; dos receptores con el mismo nombre no se distinguen. No deducir una transferencia del cambio de nombre ni facturar al receptor.

## 4. Privacidad y aislamiento

La proyección `/status` se construye campo a campo: MDR, referencia propia, estado, nombres públicos, tiempos, cinco fases, revisión, booleano de atención y resultado de devolución. No expone Dispatch/assignment/chain/incident IDs, actores administrativos, motivos, confirmaciones, teléfonos, vehículo, ledger ni clave de intentos. Las consultas de ejecución se hacen **después** de encontrar MDR con integrationClientId del token, en la misma transacción. Falta de scope devuelve 403 antes de consultar; con scope, ajeno/inexistente comparten 404. No se promete indistinguibilidad temporal de toda infraestructura.

Guard comprueba firma/tipo JWT y estado actual de cliente/credencial; scopes efectivos son intersección de token y credencial. Un token humano no sirve. DTOs no permiten seleccionar otro integrationClientId. MQ/MPQ también filtran ownership; errores de autenticación no revelan empresa/credencial. Errores 500 no devuelven SQL; requestId es correlación técnica, no ID de negocio. `path` puede contener el publicId enviado por el propio solicitante, no un ID ajeno descubierto.

**Delimitación:** GET detalle MDR sí incluye contactos/instrucciones de su solicitud y cancellationReason; `/me` incluye UUID del propio IntegrationClient. Eso existe y no equivale a fuga de custodios. Ninguno debería trasladarse indiscriminadamente a una pantalla pública de tracking. La seguridad de nombres depende también de configurar displayName apropiado y del nombre comercial del proveedor. No hay sanitización editorial que garantice que alguien no escriba un teléfono en un nombre público.

**Deuda documental confirmada:** el OpenAPI público conserva en ejemplos de errores `path:/api/v1/admin/providers` y una validación `maxDrivers`. Es contaminación editorial del schema común, no una ruta habilitada ni un dato real filtrado. Proponer corregir el exportador/prosa y regenerar en otra tarea; no se editó el JSON aquí.

La inspección respalda aislamiento y selección de campos; no es una nueva prueba de penetración ni ejecución multicliente. Pruebas propuestas: ajeno/inexistente en cada hito, incidente, transferencia y terminal; cuentas revocadas, scopes insuficientes; ausencia recursiva de datos privados en GET/error/evento.

## 5. Actualización: consulta frente a webhooks

### A. Consulta existente — recomendación inicial

Usar GET MDR/status desde el **backend del integrador**, con deliveries:read; compartir esa fotografía con sus propias pantallas autenticadas. No incluir clientSecret/token server-to-server en web o móvil. Cachear por integración+MDR, nunca solamente por referencia externa.

Límite real de código: ThrottlerModule 100/60000ms, guard por defecto en memoria. La clave de la dependencia instalada combina controlador/manejador/IP: todos los publicId del manejador status comparten bucket, no 100 por MDR. No hay storage distribuido configurado; reinicios/instancias/proxy pueden cambiar su alcance efectivo. No se configura trust proxy en bootstrap inspeccionado: la IP vista por Nest puede ser la del proxy. No se comprobó nginx productivo y no se promete una cuota por integrador. Token tiene 10/min e ingreso directo MDR 60/min. Límites de emisión MPQ y presupuesto routing **no son** el límite de GET/status.

Propuesta, no SLA: 15–30 segundos por MDR ASSIGNED visible; 60 segundos OPEN/REQUESTED; refrescar al abrir pantalla. Programador central con jitter, sin solapamiento y presupuesto agregado conservador de 60 GET/status por minuto por salida, reservando margen. Fórmula `60 × servicios_activos / intervalo_segundos`; 4 servicios a15s=16/min, 100 a15s=400/min y excede el límite. Ajustar intervalo/cupo con el número simultáneo real y otras integraciones tras el proxy; los100 pedidos/día no determinan concurrencia. No se ejecutó carga.

429: respetar Retry-After si llega, backoff con jitter; red/5xx: aumentar 15→30→60→120s hasta recuperación, mostrar última actualización y estado desconocido cuando esté obsoleto. 401: renovar token de forma coordinada una vez; si sigue fallando detener y escalar credenciales. 403/404: no martillar ni inventar cancelación; revisar scopes/MDR propia. Suspender sondeo frecuente al salir de pantalla; mantener reconciliación de servicios activos según operación. Detener continuo en terminal confirmado; una incidencia NO detiene seguimiento. Consultas no renuevan TTL ni reservan capacidad.

El endpoint no declara Cache-Control no-store/ETag específico; no asumir protección contra cachés configuradas externamente. Proponer política explícita de caché/orden si se endurece el contrato.

### B. Webhooks de progreso + GET — propuesta futura, no implementada

Hoy sólo `delivery.completed`: outbox durable en la transacción de entrega; payload congelado y allowlist. No hay webhook de hitos, incidente, transferencia, cancelación o RETURNED. Su payload usa `b2bEventPayload(deliveryStatusView(...))`, no el enriquecimiento P/O del servicio GET: **omite P/O incluso cuando GET terminal los envía null**. Los comentarios antiguos de igualdad exacta no describen esa diferencia aditiva actual.

Para añadir progreso haría falta:

1. Aprobar catálogo y esquema/versionado: eventos de progreso y resultado/atención, con snapshot público, revisión ordenable por MDR y sin detalles privados. Decidir granularidad; no anunciar cada evento interno al comprador.
2. Ampliar enum/tipos y restricciones SQL de outbox (incluido el índice parcial actual que permite un DELIVERY_COMPLETED por Dispatch), permitiendo varios eventos de progreso diferenciados por revisión. Revisar guards SQL que hoy especializan DELIVERY_COMPLETED; insertar atómicamente con cada transición y tratar lazy expiry sin fabricar hechos desde GET.
3. Extender selección/serialización y worker/admin observabilidad, probar rutas nuevas y consumidores viejos; no alterar el contrato ni la unicidad de delivery.completed. Versionado/opt-in de eventos para clientes que hoy sólo aceptan completed.
4. Reusar firma real: X-Mandaria-Event-Id/Type/Timestamp/Signature, HMAC-SHA256 de `timestamp + '.' + cuerpo crudo`, comparación constante en receptor, HTTPS y rotación inmediata sin convivencia administrada. No reutilizar clientSecret B2B.
5. Deduplicación durable por eventId y actualización por revisión; no prometer orden de llegada, ausencia de huecos ni exactamente una vez. Retry de un evento viejo puede llegar después del nuevo. Reconciliar con GET ante huecos/reinicio; eso requiere resolver antes la falta de revisión pública terminal/global.
6. Conservar semántica actual: hasta5 intentos, esperas1/5/15/60min; 408/425/429/5xx/red/timeout reintentables, otros incluidos409 terminales. 2xx acredita recepción, no procesamiento comercial. No inventar entrega garantizada.

No recomendar B sólo por preferencia tecnológica: comparar coste operativo y simultaneidad. A permite el MVP; B requiere más producto, migración y pruebas coordinadas. [Guía vigente de webhook](B2B-WEBHOOKS.md).

## 6. ¿Fotografía o línea de tiempo?

Para mostrar **situación actual y resultado**, la fotografía existente sirve con los límites descritos. No hace falta publicar el historial interno ni un endpoint nuevo para el MVP. Una UI puede mostrar el hito actual sin asignar horas imaginarias a los anteriores.

Si se exige mostrar cada hito con fecha recuperable tras reinicio, el GET actual **no basta**: comprime eventos, registeredAt no es fecha de cada fase y al terminar P es null. Guardar sondeos no recupera hitos saltados. Sólo para ese requisito propondría una línea de tiempo pública paginada por MDR/revisión, derivada del registro persistido con allowlist y ownership; nunca reutilizar el endpoint humano que expone actores/asignaciones. Eventos legacy no se reconstruirían. Transferencia podría conservarse como continuidad neutral sin motivo/receptor privado. No añadir ese endpoint hasta aprobar necesidad y retención; no requiere publicar todo el historial de auditoría.

## 7. Ejemplos ficticios ACTUALES

Respuesta detallada tras recogida (ejemplo basado en las claves reales, no salida de VM):

```json
{
  "publicId": "MDR-000123",
  "externalReference": "DEMO-123",
  "status": "ASSIGNED",
  "execution": {
    "mode": "PROVIDER",
    "provider": {"displayName": "Reparto Demo"},
    "driver": {"displayName": "Alex Demo"}
  },
  "requestedAt": "2026-10-04T14:00:00.000Z",
  "deliveredAt": null,
  "cancelledAt": null,
  "executionProgress": {
    "phase": "PICKED_UP",
    "revision": 4,
    "registeredAt": "2026-10-04T14:15:00.000Z",
    "attentionRequired": false
  },
  "executionOutcome": null
}
```

Una incidencia posterior puede mostrar misma fase/revision5/attentionRequired=true. Transferencia confirmada puede mostrar misma fase/revision6/false e identidad nueva; sin campo `transferred` ni nueva recogida. Una posterior entrega devuelve DELIVERED, deliveredAt y P/O null; no incluir revisión6 como si fuera la revisión terminal.

Devolución confirmada:

```json
{
  "publicId": "MDR-000123",
  "externalReference": "DEMO-123",
  "status": "CANCELLED",
  "execution": {"mode":"PROVIDER","provider":null,"driver":null},
  "requestedAt": "2026-10-04T14:00:00.000Z",
  "deliveredAt": null,
  "cancelledAt": "2026-10-04T15:05:00.000Z",
  "executionProgress": null,
  "executionOutcome": {
    "type": "RETURNED_TO_ORIGIN",
    "occurredAt": "2026-10-04T15:00:00.000Z"
  }
}
```

Legacy entregado (P/O omitidos, identidades pueden ser null):

```json
{
  "publicId":"MDR-000099",
  "externalReference":"DEMO-99",
  "status":"DELIVERED",
  "execution":{"mode":"PROVIDER","provider":null,"driver":null},
  "requestedAt":"2026-10-01T14:00:00.000Z",
  "deliveredAt":"2026-10-01T14:30:00.000Z",
  "cancelledAt":null
}
```

**Propuesta futura, no campos actuales:** discriminante público LEGACY/DETAILED/null, indicador de asignación vigente y versión de fotografía también terminal. No se incluye JSON ficticio que pudiera confundirse con un DTO implementado. La tabla del recorrido contiene las etiquetas sugeridas; attentionRequired añade aviso y RETURNED_TO_ORIGIN prevalece sobre CANCELLED. Nunca mostrar "pagado" por PREPAID/DELIVERED ni "recogido otra vez" tras transferencia.

## 8. Conclusión, alcance y handoff

**Integrable desde el contrato de hoy:** crear/consultar MDR/MPQ/MQ propias, aceptar con atestación según origen, consultar estado, nombres públicos, cinco hitos cuando existen, atención genérica y devolución física; recibir completed opcionalmente. No GPS, ETA en vivo, evidencia de cobro, historial completo, teléfono o motivo de incidencia. La duración estimada de una cotización no es ETA actual del repartidor. La integración desplegada/Coita no se acredita en esta revisión.

**Brechas concretas:** clasificación legacy ambigua en B2B; no indicador de asignación vigente; revisión limitada al progreso ASSIGNED; pérdida de última revisión/hito al terminar; cambios de identidad sin revisión de fotografía; sin timeline recuperable ni webhooks de progreso/otros terminales; omisión409 de cancel y ejemplos internos en OpenAPI. No interpretar esas limitaciones como un nuevo fallo financiero o de custodia.

**Recomendación inicial:** polling centralizado + completed existente como señal para consultar, UI de fotografía actual y última consulta. Antes de prometer seguimiento robusto entre varios consumidores, proponer un endurecimiento aditivo del mismo `/status`: clasificación persistida, asignación vigente, revisión que cubra toda fotografía/terminal y política de caché definida. Diseñar esa versión sin prometer que la revisión interna actual cubre nombres/legacy/expiry. Conservar compatibilidad de status, execution, P/O y completed; no reutilizar IDs internos. No bloquear el desarrollo base de app por una plataforma de eventos nueva.

**Decisiones del propietario:**

1. Aprobar fotografía actual para primera entrega o exigir historial de cada hito con fecha. Recomiendo fotografía inicial y explicitar que no es timeline certificado.
2. Aprobar objetivo de frescura (propuesta15–30s activos) y cupo simultáneo; si necesita casi tiempo real o carga no cabe en cuotas, evaluar B después de medir, no asumir necesidad.
3. Aprobar alcance aditivo anterior y texto público neutro de atención/devolución; decidir si una transferencia debe anunciarse como tal. Recomiendo continuidad sin detalles privados.

Detalles de locks, scopes, revisión y proyección son decisiones técnicas; no se solicitan aprobaciones por cada fila. La habilitación de detallado y soporte SUPER_ADMIN siguen pendientes operativos separados. No se cambia la numeración del proyecto.

**Handoff externo:** servidor integrador autentica, persiste vínculo pedido↔MDR y serializa por MDR; externalReference no impone unicidad. Consumir /status, no detalle MDR para pantalla de tracking. Separar cuatro conceptos: estado logístico, fase reportada, atención/custodia e información de dinero. Tolerar ausencia/null y extensiones aditivas; terminal confirmado manda sobre respuesta atrasada. El comprador nunca llama rutas APP/SUPER_ADMIN ni reconcilia intentos privados. Webhook se verifica/deduplica duraderamente y dispara lectura autorizada, sin repetir operación física.

**Portal futuro:** sección de seguimiento con matriz/etiquetas, ejemplos detallado/legacy/devolución y pagador vs ejecutor; tutorial polling/backoff y privacidad; aclarar payload GET vs completed, TTL de cotización vs despacho, scopes y errores409. Si se aprueba endurecimiento, sincronizar JSON/SDK/portal tras implementación y pruebas. Ningún cambio de portal/OpenAPI se hizo aquí.

## 9. Evidencia y verificaciones

Fuentes inspeccionadas: [servicio de solicitudes](../src/delivery-requests/delivery-requests.service.ts) (`deliveryStatus`, `cancel`), [controlador B2B](../src/delivery-requests/delivery-requests.controller.ts), [proyección logística](../src/deliveries/delivery-status.ts), [DTO status](../src/delivery-requests/delivery-status.responses.ts), [select seguro MDR](../src/delivery-requests/delivery-request.select.ts), [servicio MQ](../src/delivery-quotes/delivery-quotes.service.ts), controladores MPQ/conversión, [guard B2B](../src/integrations/integration.guard.ts) y auth/scopes; [persistencia ejecución](../src/delivery-execution/execution.persistence.ts), [resoluciones](../src/delivery-execution/execution.service.ts), [trigger de revisión](../prisma/migrations/20261004000100_driver_execution_authority/migration.sql), [outbox](../src/b2b-events/b2b-outbox.ts), [reintentos](../src/b2b-webhooks/webhook-retry-policy.ts), [filtro global](../src/common/http-exception.filter.ts), [AppModule](../src/app.module.ts) y ThrottlerGuard instalado. Contratos: [APP](DRIVER-APP-EXECUTION.md), [OpenAPI público](openapi-b2b.json), [guía B2B](B2B-PUBLIC-GUIDE.md).

En esta tarea: lectura estática, extracción Node de15 operaciones y sus schemas, contraste de claves P/O y ownership; comprobación de referencias locales y git diff --check al finalizar. No nuevas pruebas unitarias/E2E, DB, carga, build, regeneración OpenAPI, Docker, acceso remoto, commit/push ni activación. Las86 E2E/403 unitarias/34 públicas del cierre anterior son históricas y no acreditan por sí solas toda esta matriz B2B.

Pruebas necesarias si se implementa la propuesta: matriz completa mediante API/PostgreSQL aislado; clasificación nunca asignado/legacy/detallado terminado; retiro/reasignación vs progreso; transferencia repetida preservando revisión/fase y cambiando identidad; final sin pérdida de versión; respuestas fuera de orden y lazy expiry; aislamiento multicliente/errores; compatibilidad OpenAPI/SDK y completed sin nuevos campos obligatorios; carga acotada sólo tras definir concurrencia. Para B, además: atomicidad evento/estado, duplicados, huecos, reordenamiento, rollback, firma/rotación y clientes antiguos. No cuentan como pruebas ejecutadas.
