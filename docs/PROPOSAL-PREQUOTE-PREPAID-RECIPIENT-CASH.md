# Propuesta: precotización garantizada y cobro exclusivo del envío

Fecha: 2026-09-28. **Diseño para revisión; NO IMPLEMENTADO, NO APROBADO como contrato operativo.** Ningún endpoint, campo, scope, estado o código nuevo de este documento está disponible por esta tarea. Los ejemplos son sintéticos. No sustituyen `docs/openapi.json`.

## 1. Recomendación y viabilidad

Crear una entidad independiente `DeliveryPrequote`, sin DeliveryRequest ni declaración de pago, con snapshot de condiciones, routing y precio. Convertirla una sola vez, después de la confirmación del restaurante, en una DeliveryRequest PREPAID y una DeliveryQuote OFFERED dentro de la misma transacción. La Quote hereda **exactamente el vencimiento original**. Una aceptación explícita posterior abre Dispatch por el mecanismo existente.

La garantía propuesta es: Mandaria conservará importe y moneda para las mismas condiciones si acepta la cotización antes de `expiresAt`. No significa disponibilidad de repartidores, prioridad, reserva de capacidad, ETA de entrega ni garantía de que una aceptación técnicamente imposible vaya a completarse. Después de una aceptación exitosa, el precio queda congelado para ese servicio incluso si se entrega después del vencimiento original. No se recalcula al reclamar, asignar, liberar o entregar.

Viabilidad estática: DeliveryQuote ya persiste amount, currency, distancia, duración, zona, tarifa/banda, proveedor y fecha de routing; su trigger impide modificar el snapshot. `openDispatch` usa zona/servicio/distancia de esa Quote y obtiene políticas de créditos al aceptar. Por tanto, es viable insertar una Quote a partir de evidencia previamente congelada, sin volver a consultar tarifa ni routing. **Hoy no existe esa conversión**. Hay que desarrollar y probar las restricciones, aceptación protegida y persistencia descritas aquí antes de prometer garantía en producto.

Cambiar o desactivar un RatePlan después de emitir la precotización no cambia el precio garantizado. Deben conservarse sus filas referenciadas, sin borrado en cascada. La misma regla cubre cambios administrativos ordinarios de geometría o moneda de nuevas configuraciones: se usa la zona/versiones congeladas, no una resolución nueva para cobrar más. Una suspensión operativa puede impedir prestar el servicio, pero no sustituir el importe por otro. Propuesta para el nuevo flujo: validar zona aún habilitada al aceptar, con `SERVICE_UNAVAILABLE`; no condicionar a que la tarifa histórica siga ACTIVE. Este control es una extensión, no una afirmación sobre el accept actual.

Fuentes revisadas: [DTO](../src/delivery-requests/delivery-requests.dto.ts), [normalización](../src/delivery-requests/delivery-requests.service.ts), [quotes](../src/delivery-quotes/delivery-quotes.service.ts), [idempotencia](../src/idempotency/idempotency.service.ts), [apertura de despacho](../src/dispatch/dispatch-policy.ts), [snapshot SQL](../prisma/migrations/20260915000600_routing_pricing_quotes/migration.sql), [OpenAPI vigente](openapi.json). README contiene párrafos históricos superados; no se interpretan como límites de la implementación actual.

Alternativas descartadas para esta primera extensión:

- Crear PREPAID pendiente o COURIER_ADVANCE ficticio para obtener precio: contradice el contrato financiero.
- Añadir un estado pendiente y permitir editar la solicitud: puede diseñarse, pero cambia el ciclo de vida y la inmutabilidad de DeliveryRequest sin necesidad para cotizar.
- Aceptar temprano y retener despacho: separaría dos efectos hoy atómicos y ampliaría el motor logístico; reservaría un servicio antes de las confirmaciones.
- Sólo estimación no vinculante: compatible con el sistema actual, pero no cumple la preferencia de garantía solicitada.
- Token firmado sin persistencia de precotización: no resuelve por sí mismo uso único, idempotencia, auditoría ni conservación de evidencia de tarifa.
- Recalcular al convertir usando tarifa activa: rompe la garantía frente a cambios administrativos.
- Otorgar otros 15 minutos al convertir: permite prolongar el precio sin autorización temporal equivalente. Heredar expiresAt es más simple y verificable; una gracia corta sería otra política pendiente, no parte de este diseño.
- Reutilizar una MPQ consumida tras cancelación o vencimiento: complica concurrencia y permite dobles intentos bajo una misma reserva. Nuevo intento exige nueva MPQ.

## 2. Contrato nuevo propuesto

Base `/api/v1`; exclusivamente autenticación B2B vigente, IntegrationClient derivado del token. Sin credenciales en Web/Mobile. Todos los scopes indicados en una fila son necesarios. Clientes suspendidos/revocados se rechazan también en reintentos. Objetos ajenos y ausentes responden 404.

| Endpoint propuesto | Scopes propuestos/existentes | Efecto |
|---|---|---|
| POST `/delivery-prequotes` | nuevo `prequotes:create` | Routing y snapshot; 201 nueva, 200 replay |
| GET `/delivery-prequotes/:publicId` | nuevo `prequotes:read` | Estado efectivo y vínculos propios; 200 |
| POST `/delivery-prequotes/:publicId/convert` | nuevo `prequotes:convert`, existentes `deliveries:create`, `quotes:create` | Crea MDR + MQ; 201 nueva, 200 replay; nunca Dispatch |
| POST `/delivery-quotes/:publicId/accept-authorized` | existente `quotes:accept`, nuevo `quotes:accept-authorized` | Sólo Quotes de este flujo; confirmaciones, aceptación y Dispatch atómicos; 200 |

Los tres POST nuevos requieren `Idempotency-Key`, 8–255 ASCII visibles. Mantener unicidad por IntegrationClient + key, como hoy; usar claves diferentes por operación. GET no requiere key. Respuestas de POST incluyen `Idempotent-Replayed: false/true` y todas incluyen `X-Request-Id`.

No ampliar implícitamente los scopes de credenciales existentes. Habilitar comercialmente este flujo por integración sólo después de que los consumidores estén preparados.

### 2.1 Datos de precotización y condiciones

Entrada mínima: `serviceType`, dos puntos PICKUP/DROPOFF ordenados y perfil físico de los paquetes. Sin dirección textual, nombres, teléfonos, referencias bancarias, productos, precios de comida, instrucciones libres ni financialContext. Coordenadas son datos sensibles de ubicación aunque no incluyan contactos: no registrar cuerpo ni coordenadas en logs y limitar acceso/retención.

Propuesta inicial admite sólo LOCAL_DELIVERY inmediato, FOOD y MXN para este producto; otros servicios/monedas se rechazan explícitamente, sin restringir el contrato legacy. Precio sólo de envío. `goodsValue` no interviene en routing/precio ni debe exigirse antes de confirmar el pago.

`conditionsVersion: 1` define canonización y qué se garantiza: servicio, coordenadas exactas normalizadas a seis decimales (rechazar precisión extra en este nuevo contrato), secuencia y perfil completo de paquetes: categoría, cantidad, peso, dimensiones, fragilidad. Orden de paquetes irrelevante: ordenar tuplas canónicas, conservar multiplicidad; cantidades deben coincidir. Null representa medida no declarada y sólo coincide con null. Las medidas no declaradas no garantizan capacidad física: el proveedor todavía evalúa la carga. No inventar límites físicos universales sin política aprobada; reutilizar validadores actuales y después acordar límites operativos.

Aunque hoy la tarifa usa distancia/banda, congelar perfil físico evita prometer que una futura regla o cambio de carga está cubierto. Cambiar un componente exige nueva precotización y consentimiento. Contactos e instrucciones ordinarias no afectan el precio, pero Coita debe exigir nueva precotización si un cambio de dirección textual implica realmente otro acceso/punto o si las instrucciones agregan paradas, esperas u otro servicio. Mandaria no puede detectar semánticamente una dirección falsa con las mismas coordenadas. No se garantiza un servicio adicional oculto en texto libre.

Respuesta lleva condiciones canónicas completas y versión; hash de condiciones interno, no prueba de autenticidad ni sustituto de compararlas. `externalReference` se conserva en la solicitud definitiva; no se necesita para cotizar.

### 2.2 Ejemplo completo: emisión y consulta (PROPUESTA)

`POST /api/v1/delivery-prequotes`, `Idempotency-Key: ce-order1842-prequote-01`:

```json
{
  "serviceType": "LOCAL_DELIVERY",
  "stops": [
    {"type": "PICKUP", "sequence": 1, "latitude": 16.753554, "longitude": -93.115983},
    {"type": "DROPOFF", "sequence": 2, "latitude": 16.758, "longitude": -93.11}
  ],
  "packages": [
    {"category": "FOOD", "quantity": 1, "weightKg": null, "lengthCm": null, "widthCm": null, "heightCm": null, "isFragile": false}
  ]
}
```

201, o GET posterior 200 con este mismo esquema público completo:

```json
{
  "publicId": "MPQ-000123",
  "status": "OFFERED",
  "conditionsVersion": 1,
  "conditions": {
    "serviceType": "LOCAL_DELIVERY",
    "stops": [
      {"type": "PICKUP", "sequence": 1, "latitude": 16.753554, "longitude": -93.115983},
      {"type": "DROPOFF", "sequence": 2, "latitude": 16.758, "longitude": -93.11}
    ],
    "packages": [
      {"category": "FOOD", "quantity": 1, "weightKg": null, "lengthCm": null, "widthCm": null, "heightCm": null, "isFragile": false}
    ]
  },
  "serviceZone": {"code": "CENTRO", "name": "Zona Centro"},
  "distanceMeters": 3200,
  "durationSeconds": 600,
  "amount": "60.00",
  "currency": "MXN",
  "createdAt": "2026-09-28T18:00:00.000Z",
  "expiresAt": "2026-09-28T18:15:00.000Z",
  "convertedAt": null,
  "deliveryRequestPublicId": null,
  "deliveryQuotePublicId": null,
  "priceGuarantee": "UNTIL_ACCEPTANCE_DEADLINE",
  "availabilityGuaranteed": false
}
```

`durationSeconds` es duración de ruta calculada, no tiempo prometido de llegada/preparación. Tras convertir, GET devuelve `status: CONVERTED`, `convertedAt` y ambos IDs; no vuelve a OFFERED ni queda reutilizable aunque se cancele la solicitud. Si vence sin convertir, GET devuelve EXPIRED. Una MPQ convertida permanece CONVERTED aunque su MQ venza: el vencimiento de MQ se consulta con GET de Quote existente.

### 2.3 Ejemplo completo: conversión (PROPUESTA)

Sólo después de que el restaurante haya aceptado el pedido y confirmado el ingreso. El comprobante del cliente no satisface estas condiciones. Se registran referencias opacas al registro auditado de Coita, sin comprobantes bancarios, identidad privada del verificador ni cuentas bancarias en Mandaria.

`POST /api/v1/delivery-prequotes/MPQ-000123/convert`, `Idempotency-Key: ce-order1842-convert-01`:

```json
{
  "deliveryRequest": {
    "serviceType": "LOCAL_DELIVERY",
    "externalReference": "ORDER-1842",
    "stops": [
      {"type": "PICKUP", "sequence": 1, "address": "Restaurante de ejemplo, Centro", "latitude": 16.753554, "longitude": -93.115983, "contactName": "Restaurante de ejemplo", "contactPhone": "+52 961 000 0000", "instructions": null},
      {"type": "DROPOFF", "sequence": 2, "address": "Destino de ejemplo, Centro", "latitude": 16.758, "longitude": -93.11, "contactName": "Cliente de ejemplo", "contactPhone": "+52 961 000 0001", "instructions": null}
    ],
    "packages": [
      {"category": "FOOD", "description": "Pedido preparado de restaurante", "quantity": 1, "weightKg": null, "lengthCm": null, "widthCm": null, "heightCm": null, "isFragile": false, "handlingInstructions": null}
    ],
    "financialContext": {"goodsValue": "450.00", "goodsPaymentMode": "PREPAID", "currency": "MXN"}
  },
  "deliveryCollectionInstruction": {"payer": "RECIPIENT", "method": "CASH", "dueAt": "DELIVERY", "components": ["DELIVERY_FEE"]},
  "merchantConfirmation": {
    "reference": "ce-confirmation-1842-01",
    "goodsPaymentStatus": "CONFIRMED_BY_MERCHANT",
    "goodsPaymentConfirmedAt": "2026-09-28T18:08:00.000Z",
    "orderAcceptanceStatus": "ACCEPTED_BY_MERCHANT",
    "orderAcceptedAt": "2026-09-28T18:07:00.000Z"
  }
}
```

No `amount` de cobro en el cuerpo. `goodsValue` opcional positivo o null conserva PREPAID vigente; aquí se muestra 450.00. No admite COURIER_ADVANCE en **este endpoint**. Enviar importes de envío, IDs internos, integrationClientId o campos desconocidos devuelve 400. Fechas no futuras; confirmación debe ser anterior o igual a conversión. Mandaria valida la declaración estructurada del integrador, no verifica el banco ni autentica directamente al restaurante.

201 con envoltorio nuevo completo (MDR se consulta por el GET existente para contactos/paquetes; no se duplican aquí):

```json
{
  "prequotePublicId": "MPQ-000123",
  "convertedAt": "2026-09-28T18:09:00.000Z",
  "deliveryRequestPublicId": "MDR-000321",
  "externalReference": "ORDER-1842",
  "deliveryCollectionInstruction": {"payer": "RECIPIENT", "method": "CASH", "dueAt": "DELIVERY", "components": ["DELIVERY_FEE"]},
  "quote": {
    "publicId": "MQ-000456",
    "deliveryRequestPublicId": "MDR-000321",
    "serviceType": "LOCAL_DELIVERY",
    "serviceZone": {"code": "CENTRO", "name": "Zona Centro"},
    "distanceMeters": 3200,
    "durationSeconds": 600,
    "amount": "60.00",
    "currency": "MXN",
    "status": "OFFERED",
    "createdAt": "2026-09-28T18:09:00.000Z",
    "expiresAt": "2026-09-28T18:15:00.000Z",
    "acceptedAt": null,
    "cancelledAt": null,
    "cancellationReason": null
  }
}
```

El replay devuelve los mismos vínculos y el estado vigente de MQ, no promete reproducir byte a byte un estado OFFERED ya superado. Si MQ ya fue aceptada/cancelada/venció, se informa ese estado. El cliente no debe confundir replay con una nueva reserva.

### 2.4 Ejemplo completo: aceptación autorizada (PROPUESTA)

Coita guarda la autorización explícita del envío y puede obtenerla antes de la transferencia para la MPQ exacta. Al convertir, esa autorización sólo se puede trasladar a la MQ derivada de esa misma MPQ, con condiciones, importe y moneda idénticos y sin renovar vencimiento. Se exige que el consentimiento incluya quién paga y efectivo al entregar. Alternativamente, pedir autorización después de convertir. No copiar consentimiento a una nueva MPQ más cara ni extender su plazo.

`POST /api/v1/delivery-quotes/MQ-000456/accept-authorized`, `Idempotency-Key: ce-order1842-accept-01`:

```json
{
  "merchantConfirmationReference": "ce-confirmation-1842-01",
  "authorization": {
    "reference": "ce-shipping-consent-1842-01",
    "prequotePublicId": "MPQ-000123",
    "expectedAmount": "60.00",
    "currency": "MXN",
    "payer": "RECIPIENT",
    "method": "CASH",
    "dueAt": "DELIVERY",
    "authorizedAt": "2026-09-28T18:02:00.000Z",
    "validUntil": "2026-09-28T18:15:00.000Z"
  }
}
```

`expectedAmount` sólo es una precondición de igualdad, nunca fuente del precio o del cobro. Validar pertenencia y vínculo MPQ–MDR–MQ, moneda, modalidad, confirmación persistida, fechas y `now < min(authorization.validUntil, quote.expiresAt)`. `authorizedAt` no futura y no anterior a emisión de MPQ; validUntil posterior a authorizedAt y no superior a expiresAt. No almacenar información del cliente final en reference. Coita garantiza que el consentimiento sigue vigente y no fue revocado, que el restaurante sigue aceptando y que no se canceló el pedido. Mandaria no puede comprobar hechos externos sólo porque recibe referencias.

200, respuesta completa de este nuevo endpoint:

```json
{
  "quote": {
    "publicId": "MQ-000456",
    "deliveryRequestPublicId": "MDR-000321",
    "serviceType": "LOCAL_DELIVERY",
    "serviceZone": {"code": "CENTRO", "name": "Zona Centro"},
    "distanceMeters": 3200,
    "durationSeconds": 600,
    "amount": "60.00",
    "currency": "MXN",
    "status": "ACCEPTED",
    "createdAt": "2026-09-28T18:09:00.000Z",
    "expiresAt": "2026-09-28T18:15:00.000Z",
    "acceptedAt": "2026-09-28T18:10:00.000Z",
    "cancelledAt": null,
    "cancellationReason": null
  },
  "authorizationReference": "ce-shipping-consent-1842-01",
  "recipientCollectionInstruction": {
    "payer": "RECIPIENT",
    "method": "CASH",
    "dueAt": "DELIVERY",
    "components": ["DELIVERY_FEE"],
    "amount": "60.00",
    "currency": "MXN",
    "sourceQuotePublicId": "MQ-000456"
  }
}
```

`recipientCollectionInstruction` es intención, no recibo, deuda contable ni estado de pago. No introducir `paid`, `collectedAt`, total cobrado o un ledger de efectivo en esta extensión.

### 2.5 Errores propuestos

Formato de error existente, nuevos códigos donde se indica. Ejemplo completo:

```json
{
  "statusCode": 409,
  "code": "PREQUOTE_EXPIRED",
  "requestId": "d83354ef-1c90-4f58-9edb-a6b78c5f3210",
  "message": "Prequote has expired; request a new prequote",
  "errors": [],
  "timestamp": "2026-09-28T18:15:00.000Z",
  "path": "/api/v1/delivery-prequotes/MPQ-000123/convert"
}
```

| HTTP | Código/causa | Efecto y actuación |
|---|---|---|
| 400 | VALIDATION_ERROR | Campos/fechas/modo inválidos; nada creado |
| 401/403 | Autenticación/scope | Sin operación; no renovar permisos automáticamente |
| 404 | Recurso ausente o ajeno | Indistinguibles; sin revelar estado/precio |
| 409 | nuevo PREQUOTE_EXPIRED | No convertir; nueva MPQ requiere nueva evaluación de consentimiento |
| 409 | nuevo PREQUOTE_CONDITIONS_MISMATCH | Nada consumido/creado; nueva precotización |
| 409 | nuevo PREQUOTE_ALREADY_CONVERTED | Distinta key pretende convertir de nuevo; GET propio permite recuperar vínculos |
| 409 | nuevo IDEMPOTENCY_CONFLICT en endpoints nuevos | Misma key con payload/operación distinta; legacy conserva error actual |
| 409 | nuevo AUTHORIZATION_MISMATCH / AUTHORIZATION_EXPIRED / MERCHANT_CONFIRMATION_MISMATCH | No aceptar ni despachar |
| 409 | nuevo AUTHORIZED_ACCEPT_REQUIRED | `/accept` legacy usado con Quote del nuevo flujo |
| 409 | nuevo PREQUOTE_REPLACEMENT_REQUIRED | Intento de generar otra Quote después de vencer la derivada |
| 409 | nuevo QUOTE_ORIGIN_NOT_SUPPORTED | accept-authorized sobre una Quote legacy |
| 409 | QUOTE_EXPIRED / QUOTE_NOT_ACCEPTABLE | Reglas existentes; nunca sustituir silenciosamente la Quote |
| 409 | CREDIT_POLICY_UNAVAILABLE | Rollback completo de accept; no alterar el precio ni inventar créditos |
| 422 | OUT_OF_SERVICE_AREA / CROSS_ZONE_NOT_SUPPORTED / ROUTE_NOT_FOUND / DISTANCE_NOT_SUPPORTED | Emisión sin precotización válida |
| 422 | CREDIT_COST_OUT_OF_RANGE / CREDIT_DISTANCE_INVALID | Aceptación revertida; diagnóstico de configuración |
| 503 | ROUTING_UNAVAILABLE / RATE_CONFIGURATION_UNAVAILABLE / RATE_CONFIGURATION_INVALID / SERVICE_ZONE_AMBIGUOUS | Emisión falla; sin precio aproximado presentado como garantía |
| 503 | nuevo SERVICE_UNAVAILABLE | Suspensión operativa al aceptar; no cambiar precio, no despachar |
| 429 | nuevo PREQUOTE_QUOTA_EXCEEDED | Retry-After; sin routing por esa petición |
| 503 | nuevo OPERATION_IN_PROGRESS | Retry-After tras espera acotada por otra operación con la misma key; reintentar misma key |

## 3. Estados, transacciones e invariantes

MPQ: OFFERED → CONVERTED o EXPIRED. CONVERTED y EXPIRED terminales. Estado efectivo expira cuando `now >= expiresAt`, aunque la persistencia sea perezosa. No endpoint de renovación. Regenerar requiere una MPQ nueva y key nueva; jamás devolver una MPQ vencida como vigente.

Conversión: verificar ownership antes de revelar información; normalizar/fingerprint; bloquear MPQ; volver a comprobar reloj después de adquirir locks; comparar condiciones; validar PREPAID/confirmación/modalidad; crear MDR + contexto inmutable + evidencia del integrador + MQ; consumir MPQ y persistir resultado idempotente. Todo o nada. No routing, Dispatch, reserva de ejecutor ni movimiento de créditos. Usar hora de servidor/DB obtenida después de la espera, no hora del cliente ni inicio antiguo de transacción.

La garantía vence a las 18:15 en el ejemplo aunque se convierta a las 18:14:59. La aceptación debe pasar su comprobación protegida antes de las 18:15. El instante contractual es el `acceptedAt` obtenido en la sección crítica, condicionado a que la transacción confirme; respuesta HTTP posterior no prolonga ni invalida por sí misma ese instante. Acotar timeout transaccional para evitar locks indefinidos. No se garantiza éxito si la petición llega justo al límite.

Aceptación: lock de MDR compartido con cancelación, verificar nueva política y evidencia, crear registro de autorización inmutable, actualizar MQ y abrir Dispatch/snapshots de créditos **en una transacción**. Mantener orden de locks consistente; conversión bloquea MPQ y crea MDR nueva, aceptación sólo bloquea MDR existente, sin tomar MPQ después en orden inverso. Restricciones SQL diferidas deben impedir ACCEPTED/Dispatch de este flujo sin autorización coincidente, incluso si una instancia antigua intenta escribir por `/accept`.

Repetir accept autorizado con misma key/payload devuelve el resultado comprometido, incluso después de expiresAt; no vuelve a verificar el plazo para ejecutar una operación ya realizada. Con key distinta y misma autorización ya usada por esa MQ, devolver el resultado existente sin crear otro registro/Dispatch. Con autorización distinta sobre MQ ya aceptada: 409 AUTHORIZATION_MISMATCH, sin sobrescribir historia. Validar autenticación/ownership siempre. Consultar `/status` para saber si el Dispatch fue cancelado, liberado o entregado: Quote ACCEPTED sólo prueba aceptación histórica.

Invariantes verificables:

1. Una MPQ pertenece a una integración; una conversión como máximo. UNIQUE por MPQ, MDR y MQ en vínculo de conversión; FKs/guardas garantizan mismo dueño y misma solicitud de la Quote.
2. Snapshot de condiciones y precio inmutable. MQ derivada copia exactamente amount/currency/distancia/duración/routing/zonas/tarifa/banda; su expiresAt igual al de MPQ. No consultar tarifas activas durante conversión.
3. Sólo PREPAID en este flujo, sin cambiar el enum legacy; importe positivo opcional. Confirmación del restaurante obligatoria al convertir, no antes al precotizar.
4. MDR financiera, instrucciones de cobro y confirmación de este flujo no editables. Sin borrado que permita reutilizar MPQ; cancelar conserva vínculo y evidencia.
5. Importe de instrucción al destinatario = acceptedQuote.amount, moneda = acceptedQuote.currency; componentes exactamente DELIVERY_FEE. Nunca sumar goodsValue ni creditCost. Antes de aceptar, no exponer esa cantidad como un cobro ya autorizado.
6. ACCEPTED nuevo exige autorización vigente al aceptar; un solo Dispatch por Quote, conservando restricciones existentes. Ningún cargo de créditos al precotizar, convertir o aceptar; cargo al CLAIM/TAKE según reglas actuales.
7. Pedido externo, MDR y MQ son identidades distintas. externalReference permanece no única, nunca sustituye Idempotency-Key.
8. Garantía de uso único por MPQ no evita que un integrador cree dos MPQ para el mismo pedido. Coita debe serializar su intención de envío por pedido/intento y conservar claves estables; no prometer deduplicación global que Mandaria no tiene.
9. Timeouts ambiguos no justifican cambiar key. Recuperar con mismo POST o GET propio; commit perdido en red sigue siendo éxito durable. Error con rollback permite reintentar, sujeto al vencimiento.
10. Para MDR originada por MPQ, POST quotes existente sólo reutiliza su MQ vigente/aceptada. Después del vencimiento devuelve PREQUOTE_REPLACEMENT_REQUIRED; no crea otra MQ en esa MDR. Cancelar y obtener nueva MPQ/MDR con nueva autorización. Esto evita extender garantías o abrir varios despachos por recotización del mismo intento.

## 4. Persistencia y protección de routing

Tablas propuestas, sin DDL ejecutado:

- `DeliveryPrequote`: UUID interno, publicId MPQ, integrationClientId, conditionsVersion, condiciones canónicas/hash, snapshot de zona (identidad, code/name, moneda, geometría o versión/hash recuperable), ratePlanId/version y rateBandId con límites/importe/currency congelados, cálculo y versión de algoritmo, routingProvider/version de adaptador, routeCalculatedAt, distanceMeters, durationSeconds, amount NUMERIC(14,2), currency, createdAt/expiresAt, estado/vínculos de conversión. No almacenar respuesta cruda de routing con PII o credenciales. Conservar evidencia suficiente para auditar decisión de banda, no hace falta una polyline para cobrar.
- `DeliveryPrequoteConversion`: vínculos únicos, instrucciones de cobro, confirmación declarada del restaurante y convertedAt. Puede integrarse físicamente con columnas/tabla de contexto nuevo; revisar normalización en implementación. Guardas de pertenencia, igualdad y terminalidad, sin tocar filas legacy.
- `DeliveryQuoteAuthorization`: única por MQ, referencia del integrador y campos de consentimiento normalizados, receivedAt/acceptedAt, dueño, referencia de confirmación. Sólo se consolida si accept compromete. No permite reutilizar una referencia para otra MQ; scope de referencia por integración.
- `PrequoteIdempotencyOperation`: reserva durable para emisión antes de llamada externa, owner/key/hash, PROCESSING/SUCCEEDED/RETRYABLE_FAILED, lease/version, recurso/resultados. Debe coordinarse con la unicidad de keys global existente; diseñar un único registro común o reserva común, no dos tablas que acepten la misma key para operaciones diferentes. Conversión/accept se pueden resolver íntegramente en transacción sin routing.

El helper idempotente actual recibe callback dentro de transacción; **no proporciona single-flight durable antes de routing ni leases**. No asumir que basta envolver una llamada externa en ese helper. Reservar key y cuota en transacción corta; routing fuera de locks largos; persistir snapshot con compare-and-set del lease. Duplicados esperan de forma acotada o reciben OPERATION_IN_PROGRESS. Crash después de consumir routing y antes de guardar puede producir una segunda llamada tras recuperar lease: no prometer exactamente una llamada al proveedor; sí una sola MPQ exitosa y presupuesto de reintentos limitado. Worker antiguo con lease vencido no puede publicar ni sobrescribir resultado.

Recomendación no aprobada: vigencia 15 minutos desde emisión exitosa del snapshot; datos de ruta no más antiguos de 30 segundos al emitir. Snapshot de tarifa/condiciones capturado coherentemente y revalidado al persistir si hubo cambio concurrente; nunca combinar banda de una versión con importe de otra. Una vez emitida, cambios administrativos no la reprecian.

Límites iniciales propuestos: 10 emisiones/minuto y 500/día por integración, máximo 2 routing en vuelo por integración, además de protección por IP y presupuesto global de coste con circuit breaker. Contadores/leases compartidos en PostgreSQL o infraestructura acordada, no sólo memoria por instancia. Replays/GET no consumen cuota de routing pero sí límite HTTP. Los fallos que ya consumieron routing cuentan para presupuesto. Límites ajustables por acuerdo sin permitir al token elegirlos. Reusar resultado para misma key; no aplicar caché entre integraciones. TTL/limpieza de operaciones no debe eliminar protección contra reutilización: conservar tombstone key/hash/vínculo al menos tanto como vida contractual del recurso. Retención de ubicaciones y evidencia comercial por definir; no borrado masivo como parte de esta tarea.

## 5. Dinero e interfaces operativas

Conservar `financialContext` y `paymentContext` actuales sin cambiar forma, nullability ni significado. Propuesta aditiva: `recipientCollectionInstruction`, disponible a ejecutores después de accept y congelada por vínculo a MQ. Para legacy: null/ausente según política de compatibilidad final, **nunca asumir que un campo ausente significa efectivo al destinatario**. No inferir cobro a partir de goodsValue.

Ejemplo completo del nuevo bloque financiero operativo (fragmento de respuesta, no respuesta completa de Dispatch):

```json
{
  "paymentContext": {
    "deliveryFee": {"amount": "60.00", "currency": "MXN"},
    "goodsValue": {"amount": "450.00", "currency": "MXN"},
    "goodsPaymentMode": "PREPAID",
    "driverAdvancesGoods": false,
    "driverAdvanceAmount": null
  },
  "recipientCollectionInstruction": {
    "payer": "RECIPIENT",
    "method": "CASH",
    "dueAt": "DELIVERY",
    "components": ["DELIVERY_FEE"],
    "amount": "60.00",
    "currency": "MXN",
    "sourceQuotePublicId": "MQ-000456"
  }
}
```

Mostrar: «Comida pagada al restaurante. No adelantar dinero. No cobrar comida. Cobrar al destinatario 60.00 MXN en efectivo al entregar». `goodsValue: 450.00` se etiqueta valor declarado, no cantidad por cobrar. No hay botón «pagado» ni registro automático de cobro en esta fase. `delivery.completed` conserva sólo significado logístico, sin agregar un estado de pago implícito.

| Actor | Superficie existente comprobada en backend | Extensión/dependencia |
|---|---|---|
| PROVIDER_ADMIN | GET provider/dispatches y detalle: service.deliveryFee + service.goods; assignment devuelve paymentContext | Añadir instrucción estructurada a OFFER/OWNER y respuesta de asignación sin cambiar formas existentes. Mandaria Web debe mostrarla antes de claim y al asignar. SUMMARY conserva privacidad. |
| Independiente | GET driver/dispatches/available, detalle y TAKE; JWT humano DRIVER y habilitación independiente | Añadir instrucción al nivel superior junto a paymentContext, tanto OFFER como OWNER; misma cantidad antes/después de TAKE. Web usada por independiente debe verificar soporte. |
| Repartidor de flotilla | GET driver/me ya devuelve activeDeliveryAssignment con id, mode y dispatchId, pero no contexto financiero ni instrucción de cobro; no hay una Driver App de ejecución acreditada | Primer alcance: proveedor comunica la ficha de asignación por su canal operativo y responde de hacerlo. Para visualización autónoma, ampliar lectura de asignación propia (por ejemplo driver/me) y su UI; es dependencia bloqueante si el canal manual no basta. No dar acceso provider ni reutilizar TAKE independiente. |

No se inspeccionó el repositorio Web ni dispositivos; disponibilidad de pantallas queda pendiente. El proveedor de flotilla sigue siendo el actor que cierra la entrega vía API actual; no atribuir esa capacidad al repartidor de flotilla. Ninguna UI puede acreditarse sólo porque exista un DTO backend.

Créditos Mandaria: enteros sin moneda, cobrados al ejecutor por adjudicación. Se calculan/congelan al aceptar con políticas entonces vigentes, desde distancia congelada; no se garantizan con MPQ ni se suman a 60.00. La garantía de precio al destinatario no congela políticas comerciales de créditos del ejecutor. SERVICE_REFUND sigue revirtiendo créditos cuando corresponda, sin relación con comida o efectivo de envío.

## 6. Secuencia y excepciones

1. Coita crea intención local de envío y key estable; pide MPQ sin declarar pago. Cliente ve comida por transferir, envío en efectivo separado, vencimiento absoluto y advertencia de disponibilidad no reservada.
2. Cliente autoriza envío de esa MPQ y modalidad; Coita persiste evidencia. Cliente transfiere exclusivamente comida al restaurante.
3. Restaurante verifica ingreso real y acepta pedido en Coita; Backend conserva actor/fecha/evidencia en su dominio. Un comprobante subido sólo inicia revisión, nunca confirma automáticamente.
4. Coita comprueba MPQ vigente y pedido/condiciones actuales. Convierte una vez con PREPAID y confirmación. No hay despacho todavía.
5. Bajo serialización local por pedido, Coita comprueba nuevamente aceptación del restaurante, comida pagada y autorización no revocada; acepta MQ mediante accept-authorized. No mantener un lock DB local indefinidamente durante red: usar intención/outbox y transiciones serializadas para resolver cancelación concurrente.
6. Mandaria confirma aceptación y abre Dispatch atómicamente. Coita recupera respuestas ambiguas con misma key y consulta status; no crea otro intento hasta conocer/cancelar el anterior.
7. Ejecutores ven instrucción de cobro, reclaman/toman/asignan mediante flujos vigentes. Completion y webhook actualizan entrega únicamente. Coita consume webhooks con firma/deduplicación por eventId y usa GET status para estados sin evento actual.

| Excepción | Tratamiento recomendado |
|---|---|
| Transferencia pendiente y MPQ vence | No convertir/aceptar. Mostrar precio vencido. No declarar impago definitivo sólo por timeout: ingreso puede llegar después. |
| Restaurante confirma después del vencimiento | Nueva MPQ, nueva presentación de precio; después nueva conversión. Confirmación real de comida puede seguir válida para el mismo pedido, sujeto a revisión del restaurante. |
| Cambia dirección/carga/servicio | Nueva MPQ. Si ya había MDR sin despacho, cancelarla antes de reemplazar; nunca mutar financialContext o trasladar MQ. |
| Precio nuevo mayor | Autorización explícita antes de dispatch, sin excepción automática por diferencia pequeña. Recomendación: pedir nuevo consentimiento ante cualquier MPQ nueva, incluso mismo precio o menor, para simplificar trazabilidad. |
| Cliente rechaza nuevo precio después de transferir | No aceptar. Coita/restaurante resuelven retiro, alternativa o cancelación/devolución según política. Mandaria no devuelve dinero. |
| Restaurante rechaza | No convertir si aún no existe MDR; cancelar MDR existente si corresponde. Restaurante receptor devuelve comida mediante gestión de Coita; sólo afirmar devuelto con evidencia externa. |
| Cero ejecutores al aceptar | OPEN puede quedar sin asignación y vencer; garantía económica no es garantía de oferta. No cobrar comida/envío de nuevo por ello. |
| Release | Reglas actuales: puede reabrir en ventana o vencer; precio aceptado no cambia. Revertir créditos cuando corresponda, no efectivo. |
| Cancelación concurrente con accept | Mandaria serializa en MDR: si cancel gana, accept falla; si accept gana, cancel posterior cierra servicio operativo. No prometer que nunca se publique brevemente si la cancelación llega después del accept. Coita debe resolver estado incierto y notificar al restaurante/cliente. |
| Dispatch vence tras accept | No reactivar repitiendo accept. Cancelar intento/revisar nueva MPQ y nuevo consentimiento para otro servicio; MPQ consumida nunca se libera. |
| Entrega ya completada y cancelación posterior | Conservar DELIVERED operacional; no inferir devolución ni impago ni cobro. Resolver disputa fuera del estado logístico. |

Mandaria registra cancelación/motivo y trazas del despacho, no aceptación comercial/reembolso bancario del restaurante como hechos verificados. Las confirmaciones nuevas son declaraciones auditables del IntegrationClient.

## 7. Compatibilidad, migraciones propuestas y despliegue futuro

Existente: PREPAID/COURIER_ADVANCE, idempotencia create, snapshot MQ, accept+Dispatch atómico, créditos y completion/status/webhook. Nuevo: MPQ, conversión, consentimiento, modalidad estructurada de cobro, cuotas compartidas y guardas para origen nuevo. `CASH` propuesto pertenece al método de cobro de envío; no cambiar ni reutilizar el enum de recargas de créditos, ni reinterpretar el CASH del dominio de Coita.

POST delivery-requests legacy conserva DTO, fingerprint y semántica. No añadir campos obligatorios al body de accept legacy. Sólo las MDR/MQ nacidas por conversión llevan origen protegido y restricciones nuevas. Para ellas `/accept` devuelve AUTHORIZED_ACCEPT_REQUIRED y recotizar no extiende la vida. Quotes anteriores siguen funcionando igual. Campos nuevos de lectura deben negociarse/verificarse contra clientes estrictos antes de activarlos; aditivo no implica compatibilidad automática con todos los deserializadores.

Migraciones futuras incrementales: nuevas tablas/índices/FKs/checks/guardas; referencias nullable a origen si se elige ese diseño, sin backfill de intención de pago o consentimiento. No cambiar snapshots, saldos, ledger, estados ni historial previos; no recalcular montos. Datos económicos nuevos usan decimales exactos. Guardas SQL aplican sólo a origen nuevo y exigen autorización consistente al abrir Dispatch. Conservar evidencia e idempotencia de por vida contractual, sin cascade que permita reutilizar una MPQ. Exportar OpenAPI nuevo sólo cuando se implemente; este documento no lo modifica.

Orden recomendado: aprobar semántica → revisar migraciones en bases locales aisladas → desplegar expansión deshabilitada → actualizar todas las instancias y jobs que aceptan/cancelan antes de permitir conversiones → verificar legacy y escritores antiguos contra guardas → actualizar Mandaria Web/canal de flotilla → integrar Coita Backend → Web/Mobile KMP → habilitación gradual por integración. La garantía no se anuncia antes de completar controles de concurrencia y persistencia. Si una instancia vieja recibe un recurso nuevo, debe fallar seguro, nunca despachar sin consentimiento.

Rollback de aplicación: deshabilitar nuevas emisiones/conversiones y conservar lectores/escritores compatibles para intentos ya creados. No eliminar tablas, vínculos ni evidencia. No volver a un binario que ignore instrucciones de cobro mientras haya servicios nuevos activos. Retirada coordinada, no downgrade destructivo.

Responsabilidades Coita Backend: credenciales sólo servidor, verificación por restaurante, serialización de intentos, persistencia de claves y IDs, autorización/revocación local, recuperación de timeout, reemplazos y gestión de devolución. Web y Mobile KMP: estados separados de comida, envío autorizado y entrega; aviso de vencimiento usando reloj servidor, reconsentimiento y manejo de reconexión/doble toque sin claves nuevas. Backend es autoridad de despacho aunque Mobile esté desconectado. Mandaria no accede a la base de Coita ni a sus comprobantes.

## 8. Decisiones de negocio pendientes

Recomendaciones para aprobación, no valores efectivos:

| Decisión | Recomendación inicial |
|---|---|
| Vigencia | 15 min absolutos, sin extensión al convertir. Medir tiempo real de verificación bancaria antes de cambiarla. |
| Margen UX | Si restan menos de 60 s, ofrecer renovar precio antes de continuar; no aceptar silenciosamente ni prometer tiempo mínimo nuevo. |
| Consentimiento de reemplazo | Renovarlo para cada MPQ nueva, obligatorio siempre ante aumento. |
| Coste de garantizar tarifa | Mandaria/proveedor respetan tarifa congelada; definir quién asume diferencia de costes internos sin trasladarla automáticamente al cliente. |
| Suspensión extraordinaria | Puede impedir servicio con razón operativa; jamás aumentar precio unilateralmente. Acordar alcance comercial de garantía bajo contingencia. |
| Falta de ejecutor/comida preparada | Definir espera, retiro y compensaciones entre Coita/restaurante; no prometer indemnización desde Mandaria. |
| Devolución de comida | Restaurante receptor ejecuta devolución; Coita gestiona caso, plazo, evidencia y comunicación. Definir descuentos/cancelaciones según acuerdo comercial, sin automatización monetaria aquí. |
| Efectivo/changing/no pago | Acordar cambio, billetes y conducta ante negativa. Esta fase no certifica cobro ni condiciona completion a pago; incidencias por soporte. |
| Flotilla | Lanzar sólo con canal operativo que entregue la instrucción o bloquear hasta contar con lectura/UI propia. Confirmar cuál usa realmente cada proveedor. |
| Cuotas/retención | Revisar 10/min, 500/día, 2 en vuelo; acordar retención de coordenadas/consentimiento y presupuesto de routing. |
| Comida/servicio no previsto | Limitar lanzamiento a FOOD, MXN e inmediato; otras modalidades mediante diseño explícito, sin afectar legacy. |

## 9. Matriz de pruebas futuras (NO EJECUTADAS)

| Grupo | Caso | Resultado exigido |
|---|---|---|
| Emisión | Misma key/cuerpo secuencial y concurrente | Una MPQ, replay mismo ID; single-flight salvo recuperación documentada de crash |
| Emisión | Misma key/cuerpo distinto u otra operación | 409, sin routing extra ni mutación |
| Emisión | Crash antes/después de routing; lease vencido; worker viejo termina | Un snapshot ganador; presupuesto de retries; worker viejo no publica |
| Cuotas | Varias instancias y keys distintas; IP compartida; 429 | Cuota por integración/global consistente, Retry-After, sin routing excedente |
| Condiciones | Orden de paquetes, precisión, null, cambio de coordenada/carga | Canonización determinista; cambios relevantes bloquean conversión |
| Conversión | 20 concurrentes misma key | Una MDR/MQ, mismo resultado |
| Conversión | Misma MPQ con keys distintas | Un ganador, restantes PREQUOTE_ALREADY_CONVERTED |
| Conversión | Payload/merchant ref diferente en replay | 409 sin cambiar evidencia original |
| Atomicidad | Fallo en insertar MDR/MQ/vínculo/idempotencia | Cero recursos parciales; MPQ no consumida |
| Tiempo | Justo antes/igual/después de expiresAt, espera de lock y reloj cliente falso | Límite exclusivo de servidor; conversión no prolonga vigencia |
| Garantía | Cambiar tarifa/banda/zona durante emisión y después | Snapshot consistente al emitir; precio ya emitido idéntico al convertir/aceptar |
| Disponibilidad | Zona suspendida; cero candidatos; créditos no configurados | Bloqueo operativo explícito o OPEN sin candidatos según caso; sin repricing ni garantías de asignación |
| Autorización | Comprobante cliente sin confirmación restaurante | Conversión rechazada/Coita no la solicita; no PREPAID ficticio |
| Autorización | Importe/moneda/modalidad/ref/MPQ incorrectos; consentimiento vencido | Sin accept, Dispatch, autorización consolidada ni créditos |
| Bypass | accept viejo/POST quotes/SQL forjado sobre origen nuevo | Bloqueo; no garantía renovada ni Dispatch sin consentimiento |
| Accept | Concurrentes misma/distinta key, misma/distinta autorización | Un Dispatch; replays válidos; no sobrescritura de consentimiento |
| Timeout | Commit accept con respuesta perdida; retry después de expiresAt | Recupera aceptación original sin nuevo despacho |
| Carreras | Cancel vs accept, replace vs retry, release vs cancel/completion | Estados consistentes; ningún despacho duplicado por intento |
| Aislamiento | Integración B usa MPQ/MDR/MQ/key de A, token suspendido, scopes faltantes | 404/401/403; ningún dato ni side effect |
| Cobro | PREPAID goods 450, fee 60, créditos 7 | Instrucción exactamente 60 MXN, adelanto false/null; ningún 510/517 ni conversión de créditos |
| API/UI | OFFER/OWNER/SUMMARY, proveedor/independiente/flotilla | Instrucción visible donde corresponde, privacidad conservada; flotilla sólo asignación propia si se implementa acceso |
| Legacy | CASH/COURIER_ADVANCE, PREPAID previo, omitidos/null, fingerprints previos | Mismo comportamiento y formas antiguas; no instrucciones inventadas |
| Finanzas | CLAIM/TAKE/release/cancel/completion | Ledger y refunds de créditos iguales; completion no certifica efectivo |
| Migración | Base limpia/upgrade con filas legacy y origen nuevo; binario antiguo | Sin reescritura histórica; guardas rechazan bypass; rollback no destruye evidencia |
| Coita KMP/Web | Doble toque, desconexión, incremento de precio, revocación, ingreso tardío | Consentimiento explícito, claves estables y recuperación; sin despachos desde estado local obsoleto |

## 10. Plan por etapas revisables

1. Aprobar garantía, plazos, condiciones, suspensión, consentimiento y responsabilidades. Confirmar interfaces reales de ejecutores. Entregable: decisiones cerradas y contrato propuesto revisado.
2. Implementar MPQ y evidencia de routing, cuotas e idempotencia durable. Gate: emisión/abuso/concurrencia/aislamiento; todavía sin conversiones habilitadas.
3. Implementar conversión atómica y guardas SQL/API, expiración heredada y recuperación. Gate: ninguna MDR parcial ni reutilización; no aceptación nueva habilitada.
4. Implementar aceptación autorizada y bloqueo de rutas alternativas; preservar créditos/cancelación/completion. Gate: matriz económica, carreras y regresión CASH/COURIER_ADVANCE completa.
5. Exponer instrucción de cobro e integrar Mandaria Web y canal de flotilla. Gate: ejecutor efectivo recibe importe exacto sin mezclar comida/créditos; ningún recibo ficticio.
6. Integrar Coita Backend, Web y KMP en sus propios repositorios, sin compartir DB/modelos. Gate: restaurante verifica ingreso, autorización explícita, reintentos y devoluciones gestionadas fuera de Mandaria.
7. Migración/despliegue gradual coordinados en tarea posterior autorizada; métricas de errores, coste de routing y conversión antes del plazo. Gate: piloto sin aumentos automáticos ni duplicados.

Validación realizada en esta tarea: inspección estática de archivos citados, compatibilidad conceptual con snapshot/locks/idempotencia vigentes y revisión documental. **No se ejecutaron pruebas de producto, routing, HTTP, consultas de DB, migraciones ni operaciones reales.** La matriz anterior es trabajo futuro, no evidencia de implementación.
