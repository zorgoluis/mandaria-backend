# Búsqueda automática de ejecutor — implementación y handoff

2026-10-10 · rama `patches` · capacidad deshabilitada por defecto. No se activó ni desplegó. No cambia la versión del paquete.

## Comportamiento

Hasta **5 rondas totales (inicial + 4)** exclusivamente para Dispatches nuevos de solicitudes B2B PREPAID convertidas desde precotización, aceptadas con `AuthorizedQuoteAcceptance`. Requiere flag global e integración con opt-in. Los flujos directos, CASH/COURIER_ADVANCE e históricos conservan una sola ventana y no reciben `search`.

Cada ronda dura `DISPATCH_TTL_MINUTES` (10 por defecto). Se congelan máximo y segundos al abrir el Dispatch. Cambiar configuración/opt-in después no reinicia ni modifica esa búsqueda. Se conservan MDR, MQ, Dispatch, atestación, precio, moneda, vencimiento de MQ y snapshots de créditos. Sólo avanza la ventana **logística** de Dispatch. No se hacen nuevas llamadas de routing ni cotizaciones. No se registra otro pago de comida ni se autoriza aumento del envío.

Sólo se reintenta un OPEN vencido que nunca fue tomado. Primera toma, cancelación o agotamiento detienen el mecanismo. Una liberación posterior conserva la conducta existente dentro de la ventana restante, pero nunca reactiva reintentos. `EXECUTOR_FOUND` recuerda que la búsqueda inicial terminó; consultar también el estado logístico para saber si sigue asignado.

Worker con polling, máximo 50 filas por ciclo, persistencia PostgreSQL y locks request→dispatch. Cada renovación y alta de candidatos queda en una transacción junto a una ronda inmutable. Revalida estado y reloj DB después de locks; SQL rechaza adelantar rondas, alterar política/ventanas o reescribir historia. Un fallo revierte todo y la siguiente ejecución puede repetir sin consumir otro intento. Workers duplicados o reconstruidos no duplican rondas. Un retraso abre **una sola ventana completa desde el reloj DB actual**; no simula rondas pasadas. Por ello no se promete un plazo exacto de 50 minutos.

Se recapturan proveedores ACTIVE con cobertura ACTIVE de la zona/tipo en cada ronda; se agregan candidatos nuevos sin borrar candidatos previos. Los independientes conservan elegibilidad dinámica, disponibilidad y exclusión de asignaciones de su flujo actual. No se duplicó ese motor. Créditos se cobran sólo al adjudicar conforme al snapshot; refunds existentes permanecen intactos. Si la integración o la zona dejan de estar activas al renovar, se detiene con causa explícita. No se consulta una tarifa nueva.

## Contrato para clientes B2B

Consultar `GET /api/v1/delivery-requests/{publicId}/status`, con token B2B propio y `deliveries:read`. Se agrega `search` opcional, ausente para legacy. Ejemplo de respuesta con valores ilustrativos y campos exactos:

```json
{
  "publicId": "MDR-000001",
  "externalReference": "pedido-123",
  "status": "OPEN",
  "execution": null,
  "requestedAt": "2026-10-10T18:00:00.000Z",
  "deliveredAt": null,
  "cancelledAt": null,
  "search": {
    "state": "RETRY_PENDING",
    "attempt": 1,
    "maxAttempts": 5,
    "windowExpiresAt": "2026-10-10T18:10:00.000Z",
    "stoppedReason": null
  }
}
```

| `search.state` | Semántica |
|---|---|
| SEARCHING | Ventana abierta; número de ronda realmente iniciada |
| RETRY_PENDING | Ventana vencida y quedan rondas; `status` sigue OPEN. No se admite claim/take hasta renovar |
| EXECUTOR_FOUND | Hubo toma; no habrá reintentos de esta búsqueda, aun si después libera |
| CANCELLED | Cancelación detuvo la búsqueda |
| EXHAUSTED | Última ventana vencida sin toma; `status=EXPIRED`, `stoppedReason=EXHAUSTED` |
| STOPPED | Detención por `SERVICE_UNAVAILABLE` o `INTEGRATION_UNAVAILABLE`; estado logístico EXPIRED |

Las otras razones posibles son `EXECUTOR_FOUND` y `REQUEST_CANCELLED`. En la última ventana vencida, la consulta ya informa agotamiento aunque el worker aún no haya persistido EXPIRED (expiración efectiva existente). Cancelar en una ventana ya vencida puede conservar estado logístico EXPIRED con `search.state=CANCELLED`; verificar también la MDR cancelada. No confundir `search` con estado financiero ni con evidencia de entrega/cobro.

Mientras SEARCHING/RETRY_PENDING, **seguir consultando la misma MDR y no crear reemplazos**. El countdown local no decide el resultado: volver a consultar al vencer y durante la espera, con backoff y manejo de 429. Un error de red tampoco autoriza reemplazar. EXHAUSTED/STOPPED requieren resolución comercial; no crean otra solicitud, cancelación comercial ni reembolso. Si se decide reemplazar, usar el procedimiento existente: cancelar, confirmar estado definitivo sin entrega y obtener nueva autorización para una nueva cotización. Mandaria no devuelve automáticamente el pago al restaurante; la devolución comercial sigue entre cliente, restaurante e integrador.

`GET /api/v1/integrations/me` agrega `automaticDispatchSearch` (política de admisión, no prueba de que una MDR concreta tenga cinco rondas). No hay scopes nuevos ni grants automáticos. No se agregaron webhooks: el evento B2B existente es `delivery.completed`; no notifica cada ronda ni agotamiento. Usar `/status`.

## Mandaria Web

`search` también se incorpora a las respuestas existentes de:

- Proveedor: GET `/api/v1/provider/dispatches`, GET `/{dispatchId}` y POST `/{dispatchId}/claim`, `/release`, `/deliver` bajo ese recurso.
- Independiente: GET `/api/v1/driver/dispatches/available`, GET `/api/v1/driver/dispatches/{dispatchId}` y POST `/{dispatchId}/take`, `/release`, `/deliver`.
- Administración: GET `/api/v1/admin/dispatches` y GET `/api/v1/admin/dispatches/{dispatchId}`.

Mostrar «Buscando ejecutor — intento 2 de 5» y el vencimiento del servidor. En RETRY_PENDING mostrar espera y refrescar; no disparar un POST de reintento. Las listas AVAILABLE omiten ventanas vencidas; el detalle/estado permite ver la espera. Claim/take pueden responder **409 `DISPATCH_RETRY_PENDING`**: refrescar, no tratarlo como cancelación definitiva. La UI legacy se mantiene si `search` falta. Conservar reglas OFFER/OWNER y `collectionInstructions`; no convertir entrega en cobro confirmado. No se modificaron Web, `/driver/me` ni asignaciones para añadir el contador: la búsqueda ya termina al adjudicar.

Habilitación por integración para SUPER_ADMIN humano:

```http
PATCH /api/v1/admin/integrations/11111111-1111-4111-8111-111111111111/dispatch-search-policy
Content-Type: application/json
Authorization: Bearer <token humano>
```

```json
{"automaticDispatchSearch": true}
```

200, `IntegrationResponse` completo (`id`, `name`, `code`, `status`, `automaticDispatchSearch`, `createdAt`, `updatedAt`). `false` deshabilita nuevas búsquedas automáticas para esa integración. Booleano JSON obligatorio; texto `"false"` da 400. Sin token 401; otro rol humano 403. Alias administrativo heredado `/api/v1/integrations/{id}/dispatch-search-policy` conserva los mismos guards. No usar un token B2B para administrar esta política.

## Configuración y despliegue futuro

```dotenv
AUTOMATIC_DISPATCH_SEARCH_ENABLED=false
DISPATCH_SEARCH_POLL_SECONDS=5
DISPATCH_TTL_MINUTES=10
```

El máximo es fijo, 5; no se agregó otra variable ni un precio editable. Poll admite 0..300 segundos; 0 pausa el worker de esa instancia. **No usar 0 para deshabilitar sólo nuevas búsquedas**: deja pendientes las existentes. Usar el flag global false o el opt-in false para cerrar admisión; mantener al menos un worker compatible procesando las búsquedas en curso. Cancelación explícita es el mecanismo para detener una búsqueda individual.

Migración incremental `20261010000100_automatic_dispatch_search`: columnas con defaults legacy y tabla `DispatchSearchRound` (PK Dispatch+attempt, timestamps y proveedor elegible por ronda). No backfill, reapertura ni cambios de importe. La migración modifica la función de inmutabilidad de Dispatch únicamente para permitir la ventana logística gobernada por el nuevo guard; conserva las demás reglas y fronteras económicas.

Antes de activar: migración por el procedimiento habitual con respaldo; actualizar **todas** las instancias escritoras/lectoras y Web/consumidores que deban entender el nuevo estado; después flag y opt-in acordado. No se acredita despliegue mixto: un binario anterior puede interpretar un vencimiento intermedio como final. Mantener relojes sincronizados: consultas/presentación usan reloj de aplicación, escrituras críticas y renovaciones usan PostgreSQL.

Rollback operativo: cerrar admisión y conservar binarios compatibles hasta resolver/cancelar las búsquedas abiertas. No eliminar columnas/historia ni volver a un binario anterior mientras queden búsquedas automáticas en curso. Alertar `DISPATCH_SEARCH_WORKER_FAILED`/`DISPATCH_SEARCH_ROUND_FAILED`; revisar OPEN con política 5, sin causa de cierre y expiresAt pasado. La latencia/capacidad a escala no se midió; polling no es SLA.

## Validación y límites

Resultados y fallos de preparación se registran en [VERIFICATION](../VERIFICATION.md). Verificación focalizada local, sin suite completa ni nueva etapa CHECK. Migraciones ejecutadas sólo en bases temporales PostgreSQL; no `.env`, base principal, Docker, red de routing real, activación, versión, commit, push ni despliegue.

Pendientes de entrega: actualizar Mandaria Web y consumidores B2B usando este contrato; configurar/activar mediante autorización operativa posterior. Los pagos de comida y envío siguen separados de los créditos Mandaria. Esta tarea no verifica ni recauda transferencias y no implementa reembolsos comerciales.
