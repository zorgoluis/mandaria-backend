# Reconciliación durable de resoluciones de custodia

2026-10-03. Backend local; sin activación ni cambios frontend. Complementa [handoff](DETAILED-EXECUTION-HANDOFF.md). Se leyó `mandaria-frontend/docs/EXECUTION-RECONCILIATION.md`: el marcador mínimo existente contiene los identificadores necesarios; no necesita persistir el formulario privado.

## Contrato exacto para FRONTEND

Bearer humano SUPER_ADMIN activo. Actor siempre obtenido de la sesión, nunca del body/query. Prefijo `/api/v1`. Ambas rutas reciben `Idempotency-Key: UUID` del marcador, sin ponerlo en URL ni logs. El despacho e incidencia deben existir y corresponderse.

| Método y ruta | Efecto |
|---|---|
| GET `/admin/dispatches/:dispatchId/custody-incidents/:incidentId/resolution-attempt` | Sólo lectura consistente del intento **propio**; `Cache-Control: no-store` |
| POST `/admin/dispatches/:dispatchId/custody-incidents/:incidentId/resolution-attempt/close` | Sin body. Cierra permanentemente la clave propia si no confirmó; si confirmó, devuelve APPLIED. No resuelve incidencia ni mueve custodia |

HTTP 200, únicamente estos campos:

```json
{"state":"PENDING_OR_UNKNOWN","resolutionId":null,"canStartNewAttempt":false}
```

- `APPLIED`: el recibo de esa identidad/operación/despacho/incidencia/clave fue confirmado atómicamente; resolutionId identifica la resolución, canStartNewAttempt=false. Consultar auditoría autorizada para el resultado efectivo. No devuelve cuerpo, hash, confirmaciones ni el resultado privado guardado. Puede ser una resolución histórica cuyo receptor ya avanzó después.
- `PENDING_OR_UNKNOWN`: no se ve recibo confirmado. Puede ser petición no recibida, fallida con rollback, en vuelo o esperando locks. **No es fracaso definitivo**, ni permiso de reintentar con otra clave. No hay timeout que lo convierta en terminal.
- `CLOSED_NO_EFFECTS`: registro terminal durable; este actor/operación/despacho/incidencia/clave nunca podrá aplicar efectos. resolutionId=null. canStartNewAttempt=true sólo si la incidencia seguía abierta en esa lectura; no reserva la incidencia ni promete que otro comando será válido.

400: UUID inválido/clave ausente. 401: falta token humano válido (incluido token B2B). 403: usuario sin SUPER_ADMIN vigente. 404: incidencia inexistente o no pertenece al despacho. Timeout/5xx del cierre: estado incierto; repetir GET o el mismo cierre, nunca inferir éxito. POST `/resolve` original con clave cerrada devuelve **409 EXECUTION_ATTEMPT_CLOSED**, aunque cambie el body o la escritura llegue tarde. Replays APPLIED mantienen el contrato anterior (body idéntico; distinto → IDEMPOTENCY_KEY_REUSED). UUIDs equivalentes con mayúsculas no eluden el cierre.

### Secuencia de interfaz

1. Mantener marcador y bloqueo mientras se desconozca resultado. Sólo la misma cuenta iniciadora consulta/cierra su intento; comprobar actor local antes de llamar.
2. GET APPLIED: enlazar resolución, refrescar estado actual y retirar marcador al confirmar la lectura. No repetir la operación física.
3. GET PENDING_OR_UNKNOWN: ofrecer **Cerrar intento pendiente**, acción explícita POST separada de consultar. Explicar que sólo cancela la posibilidad de registrar esa clave, no revierte movimiento físico ni cancela el servicio.
4. Cierre APPLIED: tratar como paso 2. Cierre CLOSED_NO_EFFECTS: el intento anterior queda invalidado. Si la incidencia sigue abierta, refrescar asignación/revisión y obtener confirmaciones operativas actuales antes de preparar un nuevo formulario/clave. Nunca reconstruir automáticamente el body, repetir devolución/transferencia física ni suponer que ocurrió o no ocurrió por el estado digital.
5. Si canStartNewAttempt=false, refrescar incidencia/resolución. Puede haber resuelto otro administrador. Conservar custodia/recursos hasta resolución explícita; bloquear si la situación física es incierta.

El indicador autoriza reemplazar **ese intento conocido y cerrado**, no demuestra ausencia global de otros intentos. La unicidad de resolución y expectedRevision siguen siendo la autoridad. El marcador no debe eliminarse al cambiar de usuario ni trasladarse a otra cuenta.

## Otro SUPER_ADMIN

Puede auditar la incidencia y una resolución confirmada mediante rutas existentes. No puede consultar/cerrar el recibo de otro actor ni suplantarlo: la misma clave bajo otra cuenta pertenece a un espacio distinto y no afecta al iniciador. Puede registrar su propia resolución con confirmaciones físicas verificadas y revisión vigente; compite bajo las mismas restricciones y sólo una resolución puede confirmar. Esto no permite declarar fallido el intento ajeno ni repetir acciones físicas. Si necesita asegurar el reemplazo del intento ajeno aún incierto, debe coordinar su cierre con el iniciador; no hay toma de control administrativa ni listado de claves en esta entrega.

## Garantía, durabilidad y migración

Se reutiliza `DeliveryExecutionCommand`: columna state por migración incremental `20261003000100_execution_attempt_closure`. Filas anteriores son APPLIED por default. Cierre guarda state=CLOSED_NO_EFFECTS, hash vacío y response `{}`; sin formulario. Los guards existentes de inmutabilidad/DELETE/TRUNCATE protegen ambos tipos de recibo. No se expiran ni purgan tombstones en operación normal.

POST resolve y close toman Request → Dispatch → User en el mismo orden. El primero consulta recibo **antes** de mutar; el segundo espera ese mismo lock y vuelve a leer bajo READ COMMITTED. Si resolve confirma primero, close ve APPLIED. Si close confirma primero, resolve recibe 409 sin efectos. Si resolve rollback, close puede insertar el cierre. Ni GET ni cierre provocan hitos, reasignaciones, cargo/refund o confirmaciones físicas. Se mantienen intactas unicidad de resolución y custodia, y la transacción de la resolución existente.

No se registra un estado PENDING separado: todo lo no acreditado permanece PENDING_OR_UNKNOWN; evita leases/expiraciones inseguros. La correlación usa actor autenticado + despacho + `RESOLVE:<incidentId>` + UUID de clave. Consulta case-insensitive de operación para incluir recibos históricos con UUID en mayúsculas.

Despliegue futuro: migrar antes del nuevo backend, coordinar escritores y actualizar Frontend para este contrato. Mantener función deshabilitada; no ejecutar migraciones/reset aquí sobre producción. No eliminar columna/recibos ni implementar limpieza TTL. El backend anterior lee un tombstone como hash distinto y rechaza replay, pero no ofrece la semántica de reconciliación: no acreditar despliegue mixto como experiencia compatible. No nuevas tablas, webhooks o servicios externos.

## Verificación de esta entrega

Resultados y comandos definitivos en VERIFICATION.md; evidencia sanitizada en `docs/checks/execution-reconciliation.json`. Siete escenarios nuevos dentro del archivo completo `delivery-execution.e2e-spec.ts`: respuesta perdida, fallo al insertar recibo después de mutaciones con rollback, original retrasada tras cierre, close/resolve concurrentes, repetición cerrada (incluye mayúsculas), permisos/aislamiento entre dos SUPER_ADMIN y lectura durable desde proceso Node nuevo tras cerrar la aplicación. Sin cambios de configuración operativa ni frontend. Los nueve casos anteriores se ejecutan como regresión del mismo archivo.

La prueba de pérdida de respuesta descarta la respuesta HTTP exitosa; no simula una partición física de red. Reinicio usa un proceso Node nuevo para consultar PostgreSQL con el servicio y reabre la app para rechazar replay; no reinicia la VM. Un único escenario concurrente no constituye prueba de carga. No hay verificación visual ni integración frontend ejecutada.
