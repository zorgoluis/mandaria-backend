# Mandaria — webhook saliente B2B

Configurado por SUPER_ADMIN para cada IntegrationClient. No es una API pública para que el cliente cambie su destino. Un destino HTTPS por integración, validado contra destinos internos y redirecciones. El secreto de firma es distinto del clientSecret que obtiene tokens B2B.

## Evento y sobre

Actualmente se emite **delivery.completed** al completar físicamente una entrega. No se prometen eventos para cada transición. `data` es la instantánea pública congelada al completar, con los campos históricos de `DeliveryStatusResponse`; no se reconstruye al reintentar. Ejemplo ficticio:

```json
{
  "eventId": "00000000-0000-4000-8000-000000000101",
  "type": "delivery.completed",
  "occurredAt": "2026-10-01T12:30:00.000Z",
  "data": {
    "publicId": "MDR-000101",
    "externalReference": "DEMO-ORDER-101",
    "status": "DELIVERED",
    "execution": {"mode":"PROVIDER","provider":{"displayName":"Flotilla Demo"},"driver":{"displayName":"Repartidor Demo"}},
    "requestedAt": "2026-10-01T12:00:00.000Z",
    "deliveredAt": "2026-10-01T12:30:00.000Z",
    "cancelledAt": null
  }
}
```

Los nombres son de presentación, no identificadores únicos; identidades pueden ser null si no existe evidencia pública. `DELIVERED` no confirma dinero cobrado.

## Cabeceras y firma exacta

POST con `Content-Type: application/json` y:

- `X-Mandaria-Event-Id`: eventId estable.
- `X-Mandaria-Event-Type`: `delivery.completed`.
- `X-Mandaria-Timestamp`: segundos Unix del **intento**, no occurredAt.
- `X-Mandaria-Signature`: `v1=` seguido del HMAC-SHA256 hexadecimal en minúsculas.

Mensaje firmado: bytes UTF-8 de `timestamp + "."`, seguidos de los **bytes exactos del cuerpo**. La clave HMAC es el string del secreto entregado por Mandaria; no decodificar ese string como base64 antes de usarlo. No reserializar JSON ni alterar espacios para verificar.

Ejemplo ejecutable, sin servidor ni dependencias: [verify-mandaria-webhook.mjs](examples/verify-mandaria-webhook.mjs).

```js
// rawBody debe ser Buffer capturado antes del parser JSON.
const valid = verifyMandariaWebhook({
  rawBody,
  timestamp: headers['x-mandaria-timestamp'],
  signature: headers['x-mandaria-signature'],
  secret: signingSecretFromPrivateConfiguration
});
if (!valid) { /* rechazar sin registrar cuerpo, firma ni secreto */ }
// Sólo después: JSON.parse(rawBody.toString('utf8')), validar sobre/esquema
// y concordancia de cabeceras event-id/type con el cuerpo firmado.
```

El helper verifica formato, ventana temporal y compara buffers mediante `timingSafeEqual` después de comprobar longitud. La ventana de 300 s es una **elección del ejemplo receptor**, no una exigencia del emisor; ajustar según reloj/operación. Usar el timestamp del intento evita rechazar eventos antiguos reenviados legítimamente. Cabeceras duplicadas/malformadas deben rechazarse en el adaptador HTTP. El helper no sustituye validación de esquema, autorización del destino ni deduplicación.

## Deduplicación persistente

Pueden llegar duplicados; los reintentos son limitados y no garantizan recepción final. Persistir eventId con restricción única en la base receptora, no en memoria. En una sola transacción del receptor: insertar registro de recepción y aplicar efectos locales, o guardar el evento en una bandeja durable que otro worker procese idempotentemente. Ante duplicado concurrente, la restricción decide; si el primero hizo rollback, permitir recuperación. No marcar procesado antes de asegurar los efectos ni responder 2xx antes de asegurar recepción durable.

Si hay efectos externos, emplear una salida durable e idempotencia del receptor externo; no prometer exactamente una vez entre sistemas. Un duplicado ya aceptado duraderamente puede responder 2xx sin repetir efectos. Comparar también identidad/contenido del evento repetido; una colisión inconsistente requiere diagnóstico, no sobrescritura silenciosa. Retener deduplicación conforme al periodo de posibles reenvíos manuales, que no tiene aquí un límite automático documentado.

**2xx acredita recepción para Mandaria, no procesamiento comercial.** Si el receptor usa 202 y trabaja después, es responsable de conservar y completar ese trabajo. Un timeout puede ocurrir después de que el receptor haya confirmado su transacción: por eso los reintentos deben ser seguros.

## Política real de entrega

- Éxito: cualquier 2xx.
- Reintentables: timeout, error de red, HTTP 408/425/429 y 5xx.
- Terminales: los demás estados, incluidos **409**, 3xx y destino inválido. No se siguen redirects.
- Hasta 5 intentos automáticos: primero inmediato al recoger trabajo; esperas posteriores 1 min, 5 min, 15 min y 1 h. Son esperas mínimas del calendario; polling, caídas o deshabilitación pueden demorar más. No hay garantía de llegada en 81 minutos.
- No interpretar Retry-After del receptor como sustitución de esta curva fija.
- **409 no es “ocupado, reintenta”**: termina en EXHAUSTED. Para un duplicado ya procesado, preferir 2xx sin repetir efecto; para fallo temporal, responder según su semántica (p. ej. 503).
- El historial de intentos se conserva. La primera configuración establece deliverFrom: no incorpora automáticamente todo el pasado. Deshabilitar conserva estado; reactivar permite continuar. Una petición ya tomada/en vuelo puede completarse después de deshabilitar.

## Secreto y rotación

Mandaria genera el secreto y lo muestra una sola vez por respuesta administrativa. Después sólo expone si está configurado y la fecha; conserva cifrado para firmar. No hay GET para recuperar el secreto. La clave maestra de Mandaria nunca se entrega al receptor.

Rotación reemplaza inmediatamente el secreto anterior, sin convivencia administrada de dos secretos. Cada intento usa el secreto leído para ese intento; una petición en vuelo puede haber sido firmada con el anterior. Coordinar actualización del receptor y la ventana operativa; no prometer rotación sin interrupción. Un fallo de red durante generación puede dejar secreto cambiado sin que el administrador lo reciba: consultar metadata y coordinar nueva rotación explícita, nunca reintentar automáticamente esa acción. No confundir esto con rotación de clientId/clientSecret B2B.

Fuentes de contrato del emisor: `webhook-transport.ts`, `webhook-secret.ts`, `webhook-retry-policy.ts` y `b2b-webhooks.service.ts`. Esta guía no acredita la implementación de ningún receptor externo.


### Consulta versionada y compatibilidad

El GET status añade publicVersion/trackingMode/assignmentState/terminalOutcome; delivery.completed conserva su payload previo, sin esos campos y sin executionProgress/executionOutcome. Deduplicar eventId y consultar GET para reconciliar la fotografía versionada; no ordenar por fecha de recepción ni sobrescribir una versión más reciente con payload de webhook. No se añadieron eventos de progreso, atención, transferencia o devolución. [Seguimiento público](PUBLIC-B2B-TRACKING.md).
