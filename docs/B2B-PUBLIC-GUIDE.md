# Mandaria — guía pública B2B

## V1.17 — pagador del envío (implementación local, no activada)

La integración conserva RECIPIENT por defecto. Sólo SUPER_ADMIN puede configurar REQUESTER; no hay override B2B por solicitud. shippingTerms se congela al emitir/crear y al convertir: REQUESTER requiere payerContact (name, phone, capacity REQUESTER o AUTHORIZED_REPRESENTATIVE) en la creación o en el envelope de conversión. El hash final proviene de la MDR convertida, no de MPQ si se añadió contacto. Modificación de política antes de convertir produce409 SHIPPING_POLICY_CHANGED; replays comprometidos mantienen términos originales.

REQUESTER paga efectivo en recogida, personalmente o mediante representante presente. Aceptar exige customerAuthorization.version=2, shippingTermsVersion=1 y shippingTermsHash exacto junto con MQ/importe/moneda/vencimiento, incluso para solicitudes sin MPQ. RECIPIENT mantiene el contrato previo. La instrucción en conversión es eco validado, no permiso de cambiar política. El nuevo status.shippingPayment es null para historia sin términos o resume payer/method/dueAt/component/termsVersion/termsHash, importe/moneda de MQ aceptada, instructionStatus, evidenceStatus, declaredAt y collectShipping. No expone el contacto de pago. HISTORICAL y collectShipping=false tras cierre; DECLARED significa declaración humana, no comprobación bancaria. No ordenar por revision: comparar publicVersion por MDR.

Directos CUSTOMER usan rutas y tokens humanos separados, excluidos de este contrato público. No hay nuevo webhook: delivery.completed conserva su payload y consulta reconcilia. No se automatiza devolución monetaria ni liquidación entre ejecutores.


Contrato descargable: [openapi-b2b.json](openapi-b2b.json). Ejemplos ficticios; no representan una cuenta, precio garantizado o servicio disponible. Integración exclusivamente servidor a servidor: nunca guardar clientSecret ni el secreto de webhook en la app móvil o JavaScript público.

## Direcciones confirmadas

El propietario confirmó la web https://mandaria.com.mx y la API https://mandaria.com.mx/api/v1. En OpenAPI, `servers.url` es **https://mandaria.com.mx**: todas las rutas ya comienzan con `/api/v1`. Ejemplo: `POST https://mandaria.com.mx/api/v1/integrations/token`. No concatenar la base terminada en `/api/v1` con otra ruta que ya contenga ese prefijo.

El contrato conserva el origen absoluto aunque el portal de documentación se aloje en otro dominio. La confirmación del propietario no constituye una prueba nueva de disponibilidad HTTP/TLS. Los cuerpos, IDs, fechas y credenciales ilustrativas siguen siendo ficticios; no ejecutar ejemplos automáticamente contra producción.

## Autenticación y permisos

Administración provisiona clientId/clientSecret. POST `/api/v1/integrations/token` recibe ambos y responde `accessToken`, `tokenType: Bearer`, `expiresIn`. Usar `Authorization: Bearer <token>` en peticiones posteriores. Pedir otro token cuando expire; no existe refresh token B2B. La revocación de credencial o suspensión del cliente impide acceso aunque el JWT aún tenga firma válida. El secreto de firma de webhooks es independiente.

| Operación | Scopes necesarios |
|---|---|
| POST `/delivery-prequotes` | `prequotes:create` |
| GET `/delivery-prequotes/{publicId}` | `prequotes:read` |
| POST `/delivery-prequotes/{publicId}/convert` | **todos**: `prequotes:convert`, `deliveries:create`, `quotes:create` |
| POST `/delivery-quotes/{publicId}/accept` | `quotes:accept` |
| Consultar cotizaciones | `quotes:read` |
| Consultar/listar MDR y `/status` | `deliveries:read` |
| Cancelar MDR | `deliveries:cancel` |

Las rutas abreviadas de esta guía llevan prefijo `/api/v1`. Los permisos no se conceden automáticamente. La disponibilidad de emisión, conversión y aceptación autorizada se habilita por separado en cada entorno; documentación publicada no equivale a habilitación.

## Flujo vigente de comida prepagada

1. Emitir MPQ con `conditionsVersion: 1`, `LOCAL_DELIVERY`, dos stops PICKUP/1 y DROPOFF/2, paquetes FOOD. No enviar direcciones/contactos ni datos de pago a la precotización. Usar una Idempotency-Key estable para esta intención.
2. Leer importe decimal, moneda y expiresAt. El precio sólo corresponde al envío. La MPQ no reserva capacidad; la duración de ruta no es una promesa de llegada.
3. Con ingreso de comida y pedido confirmados por el restaurante, convertir MPQ vigente con otra key estable. Enviar solicitud definitiva PREPAID/MXN/FOOD, condiciones físicas coincidentes y referencias opacas de confirmación. No enviar comprobantes ni datos bancarios. Mandaria recibe declaraciones; no verifica el banco.
4. Conversión crea **una MDR y una MQ OFFERED**, atómicamente. Conserva precio y vencimiento originales: no obtiene quince minutos adicionales ni calcula otro precio. Una MPQ consumida no se libera al cancelar.
5. Obtener consentimiento del cliente sobre la **MQ exacta después de la conversión**. El integrador conserva evidencia y atestigua MQ, importe, moneda, vencimiento y fecha de autorización; Mandaria no verifica directamente ese consentimiento.
6. Aceptar MQ antes de expiresAt, con key propia de aceptación y `customerAuthorization`. Publicación del servicio y aceptación son atómicas. No asegura que ya exista repartidor ni confirma cobro.
7. Consultar MDR `/status`; procesar `delivery.completed` conforme a la [guía de webhooks](B2B-WEBHOOKS.md).

PREPAID significa comida pagada al restaurante. No adelantar ni volver a cobrar comida. La instrucción persistida es cobrar **sólo envío**, al destinatario, en efectivo, al entregar. Aceptación, entrega física y confirmación financiera de cobro son hechos distintos. Mandaria no ofrece aquí recibos, conciliación ni reembolsos de comida/envío.

Cuerpos completos ficticios: [b2b-flow.json](examples/b2b-flow.json). Las condiciones físicas de emisión y conversión coinciden; los textos/contactos se agregan sólo en conversión. Usar keys distintas como `prequote-demo-order-101-v1`, `convert-demo-order-101-v1` y `accept-demo-order-101-v1`.

### Ejemplo de aceptación (datos ficticios)

Supone MQ-000101 creada a las 12:00Z, vigente hasta las 12:15Z y consentimiento a las 12:01Z; esas fechas ilustran el contrato y no deben reutilizarse para una petición real. Copiar amount/currency/expiresAt de la MQ real, sin redondearlos ni reconstruirlos.

```http
POST /api/v1/delivery-quotes/MQ-000101/accept
Host: mandaria.com.mx
Authorization: Bearer <token-temporal>
Idempotency-Key: accept-demo-order-101-v1
Content-Type: application/json
```

```json
{
  "customerAuthorization": {
    "version": 1,
    "status": "AUTHORIZED_BY_CUSTOMER",
    "reference": "consent-demo-101",
    "authorizedAt": "2026-10-01T12:01:00Z",
    "quotePublicId": "MQ-000101",
    "amount": "25.00",
    "currency": "MXN",
    "expiresAt": "2026-10-01T12:15:00Z"
  }
}
```

El JSON descargable contiene cuerpos y restricciones de emisión/conversión y ejemplos sintéticos. En conversión `merchantConfirmation` exige `goodsPaymentStatus=CONFIRMED_BY_MERCHANT`, `goodsPaymentReference`, `goodsPaymentConfirmedAt`, `orderAcceptanceStatus=ACCEPTED_BY_MERCHANT`, `orderAcceptanceReference`, `orderAcceptedAt`. La instrucción es:

```json
{"payer":"RECIPIENT","method":"CASH","dueAt":"DELIVERY","components":["DELIVERY_FEE"]}
```

## Vencimiento y nueva secuencia

Si vence después de convertir, no recotizar esa MDR ni modificar precio/expiry. Cancelar la MDR anterior y confirmar **MDR CANCELLED con cancelledAt**, después **status CANCELLED/EXPIRED con deliveredAt null**. El 200 de cancelación no basta: una entrega física previa puede conservar estado público DELIVERED. Ante carrera cancelación/aceptación, consultar el resultado definitivo; no iniciar sucesor si el resultado es incierto o DELIVERED.

Sólo entonces iniciar nueva MPQ → conversión → consentimiento sobre nueva MQ → aceptación. El integrador serializa por pedido y comprueba que siga vigente con el restaurante. `externalReference` NO es única y no impide por sí sola dos envíos. Reiniciar envío no exige otra transferencia de comida ni implica reembolso; la confirmación del restaurante y las devoluciones comerciales se gestionan fuera de Mandaria. No hay sustitución enlazada y atómica.

## Idempotencia y respuestas inciertas

Persistir en el backend cliente la key y el cuerpo de cada intención antes de enviar. Emisión, conversión y aceptación son intenciones diferentes: usar keys distintas entre operaciones. El namespace de creación directa/emisión/conversión es compartido; no reutilizar una key para otra operación. Keys visibles ASCII de 8 a 255 caracteres según contrato.

| Situación | Acción |
|---|---|
| Timeout/red sin respuesta en emisión o conversión | Repetir misma key y mismo cuerpo; no inventar otra intención. Consultar recurso si ya se conoce el ID |
| Aceptación convertida incierta | Repetir key y atestación exactas; consultar MQ y estado MDR. No cambiar authorizedAt al reintentar |
| Replay emisión/conversión | 200 en vez de 201; mismos vínculos/vigencia, no capacidad nueva |
| Replay aceptación convertida | 200, `Idempotent-Replayed: true`; no reabre aun tras vencimiento/cancelación o deshabilitación; credencial B2B y scopes vigentes requeridos (no un consentimiento nuevo) |
| Cancelación incierta | Reintentar sobre misma MDR; conserva fecha/razón si ya estaba cancelada. Confirmar además estado público antes de reemplazar |
| 409 | Leer `code`, no asumir vencimiento. Key incompatible, intención en curso y conflicto de autorización requieren respuestas diferentes |
| 429 o `PREQUOTE_IN_PROGRESS` | Respetar `Retry-After` cuando exista; no garantiza éxito al vencer la espera |
| 503 transitorio | Reintento acotado de la misma intención, sin plazo inventado; no bucle infinito |
| Intención terminal (`ATTEMPTS_EXHAUSTED`, errores de condiciones/ruta) | Reconciliar estado y corregir causa; no tratarla como timeout que deba repetirse indefinidamente |

Conservar `statusCode`, `code`, `requestId` y cabecera `X-Request-Id` para soporte. No reducir todos los errores a REMOTE_ERROR ni registrar tokens o cuerpos completos. No todo 409 es transitorio. Un replay puede devolver estados actuales vencidos/cancelados: 200 no ordena reiniciar la operación comercial.

## Flujo directo existente

POST MDR → POST cotización → accept sin atestación sigue disponible para el flujo directo permitido. Atestación de aceptación convertida enviada al origen directo se rechaza. CASH/COURIER_ADVANCE conservan sus reglas; no aplicar la instrucción de comida prepagada a todos los pedidos. Las guías no habilitan nuevas capacidades ni modifican sus cálculos.

## Progreso logístico detallado (aditivo, sin activación)

GET `/api/v1/delivery-requests/{publicId}/status` conserva sus estados existentes. Para asignaciones detalladas en estado ASSIGNED puede incluir `executionProgress` con `phase`, `revision`, `registeredAt` y `attentionRequired`. Fases: TO_PICKUP, AT_PICKUP, PICKED_UP, TO_DROPOFF, AT_DROPOFF; phase puede ser null antes del primer hito. Consultar periódicamente y comparar publicVersion como entero decimal, no la revision interna del progreso. Los servicios legacy no reciben hitos inventados.

Después de recogida, una cancelación ordinaria responde 409 `CUSTODY_OPERATION_FORBIDDEN`: corresponde atención operativa, no comenzar otro envío a ciegas. Una incidencia mantiene custodia; sus motivos, actores y confirmaciones son privados. La devolución física confirmada termina en CANCELLED, con `executionProgress=null` y `executionOutcome={"type":"RETURNED_TO_ORIGIN","occurredAt":"2026-10-02T18:00:00.000Z"}` (fecha ficticia). No se notifica como entrega.

No se añaden webhooks. `delivery.completed` conserva contrato y sólo corresponde a cierre DELIVERED real. Avance, aceptación, entrega o retorno no confirman cobro ni reembolso de comida/envío. Contrato descargable actualizado: [openapi-b2b.json](openapi-b2b.json). Capacidad backend local no acredita activación ni integración del consumidor.


## Fotografía pública versionada — disponible en checkout QA, no desplegada

GET status añade publicVersion (string decimal durable), trackingMode (LEGACY/DETAILED/null), assignmentState (NONE/ACTIVE/ENDED) y terminalOutcome (DELIVERED/RETURNED_TO_ORIGIN/CANCELLED/EXPIRED o null). Los campos anteriores se conservan. [Contrato, ejemplos, recuperación y límites](PUBLIC-B2B-TRACKING.md).

Sondeo recomendado desde el backend integrador, compartiendo resultados: objetivo15s para entregas activas observadas, sin garantía de capacidad. A15s,4 solicitudes/min por MDR; límite actual100/min por IP/manejador, compartido y en memoria. Aplicar presupuesto agregado, jitter,429/Retry-After y backoff; detener sondeo continuo en terminal confirmado. No inferir legacy de campo ausente ni cobro de entrega física. delivery.completed mantiene su payload anterior; consultar status para obtener versión y reconciliar.
