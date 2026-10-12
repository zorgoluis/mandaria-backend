# Compatibilidad operativa con Mandaria Web — patches

> Nota de integración QA (2026-10-11): este documento conserva evidencia histórica del parche legacy. En el merge main→QA prevalecen el clasificador persistido y los permisos de QA, con LEGACY/DETAILED/null; no se usa el helper limitado a legacy de patches. La evidencia nueva está en VERIFICATION.md y checks/qa-main-integration-evidence.json.


Implementación y verificación local: 2026-10-11. Base `patches 33cd34e`.

## Alcance y diagnóstico

Se verificó por Git que `main 073f2e3` incluye `patches 33cd34e`; QA está en `e34bc04`, con 43 migraciones frente a las 32 de patches. No se integró QA. El checkout inicial QA tenía modificaciones previas en BITACORA y un residual `nul`: permanecen intactos. El trabajo está en el worktree `C:/Users/zorgl/.codex/worktrees/mandaria-web-contract/mandaria-backend`, vinculado a `patches`, sin commit.

Inspección de sólo lectura de Mandaria Web:

- `src/dispatch/pages.tsx` ServiceRecord bloquea el fieldset si `trackingMode === undefined`; `rules.ts` exige el campo para claim. `null` permite el flujo de servicio nunca asignado.
- `src/driver-portal/pages.tsx` bloquea TAKE ante undefined y exige `activeDeliveryAssignment.trackingMode === 'LEGACY'` en `driver/me` para cerrar el servicio independiente. Ésta era la segunda dependencia concreta: corregir únicamente el despacho no habilitaba la entrega.
- `legacyProjection` exige LEGACY explícito, OWNER/CLAIMED, assignment definido, servicio completo, deliveredAt=null y ausencia de execution/collectionActionAllowed/advanceToOriginAllowed. Esta rama ya satisface los demás campos para una asignación activa; no se añaden objetos de ejecución ni permisos ficticios.
- Las mutaciones claim/release/deliver de proveedor y take/release/deliver independiente reutilizan las mismas proyecciones de detalle. Las asignaciones tienen contrato propio y la Web invalida/refresca el despacho y el historial después de modificarlas; no requieren cambiar su respuesta.

## Clasificación persistida

`operationalTrackingSelect` obtiene exclusivamente el conteo de todas las DeliveryAssignment del despacho, sin filtrar ACTIVE. `operationalTrackingMode` devuelve null si el conteo es cero y LEGACY en caso contrario. La consulta no expone ese conteo ni los responsables históricos. Claim de proveedor sin repartidor conserva null. Release, cancelación, reasignación y entrega conservan LEGACY mientras exista historia persistida.

El modelo de ejecución de patches sólo tiene asignaciones legacy; no existen tablas/soporte de ejecución detallada. No se emite DETAILED, ni se deduce el modo del estado, un flag o el proveedor responsable. `driver/me` devuelve LEGACY exclusivamente dentro de la asignación ACTIVE realmente encontrada; sin asignación conserva `activeDeliveryAssignment: null`.

## Endpoints modificados

Todos llevan prefijo `/api/v1`:

| Superficie | Métodos/rutas | Campo añadido |
|---|---|---|
| Proveedor | GET `/provider/dispatches`, GET `/provider/dispatches/{id}` | `trackingMode: LEGACY \| null` en cada despacho |
| Proveedor, mutaciones | POST `/provider/dispatches/{id}/claim`, `/release`, `/deliver` | Igual proyección de despacho |
| Administración | GET `/admin/dispatches`, GET `/admin/dispatches/{id}` | `trackingMode: LEGACY \| null` |
| Independiente | GET `/driver/dispatches/available`, GET `/driver/dispatches/{id}` | `trackingMode: LEGACY \| null` |
| Independiente, mutaciones | POST `/driver/dispatches/{id}/take`, `/release`, `/deliver` | Igual proyección de despacho |
| Repartidor propio | GET `/driver/me` | `activeDeliveryAssignment.trackingMode: LEGACY` cuando existe asignación |

No se modifican guards, selección de audiencia ni redacción: OFFER no recibe contactos; SUMMARY de otro proveedor mantiene service/assignment=null; el independiente sólo ve su asignación. El campo no concede autoridad. OpenAPI completo declara el campo requerido y nullable donde corresponde. Contrato público B2B sin cambios semánticos y sin añadir trackingMode.

## Fragmentos de respuestas HTTP comprobados

Extractos de campos de respuestas reales de las fixtures sintéticas E2E; se omiten identificadores, contactos y el resto de la respuesta.

Claim de proveedor antes de asignar:

```json
{"status":"CLAIMED","trackingMode":null}
```

TAKE independiente activo y GET posterior (se comprobó igualdad de las respuestas completas):

```json
{"status":"CLAIMED","access":"OWNER","trackingMode":"LEGACY"}
```

Entrega de proveedor y GET posterior (igualdad completa):

```json
{"status":"DELIVERED","access":"OWNER","trackingMode":"LEGACY","assignment":null}
```

Consulta de otro proveedor tras esa entrega:

```json
{"access":"SUMMARY","trackingMode":"LEGACY","service":null,"assignment":null}
```

Liberación independiente y GET posterior (igualdad completa):

```json
{"status":"OPEN","takenByMe":false,"trackingMode":"LEGACY","assignment":null}
```

## Verificación nueva y límites

- 84 unitarias en cinco archivos completos: dispatch, independent-drivers, delivery-assignments, delivery-completion y delivery-status.
- 94 E2E en cinco archivos completos: dispatch 13, delivery-assignments 13, independent-drivers 23, delivery-completion 29 y dispatch-search 16. Cada archivo usó una base vacía distinta en un cluster PostgreSQL18 temporal, sólo loopback; 32 migraciones aplicadas normalmente. Cluster detenido al finalizar.
- Flujo claim/asignar/entregar y TAKE/entregar, liberación y permisos conservados. Aserciones nuevas sobre null sin asignación, LEGACY activo/histórico, driver/me de flotilla e independiente y coherencia de mutaciones/consultas.
- En cada una de las cinco ventanas automáticas se consultó dos veces la proyección administrativa y se compararon el Dispatch y todas sus rondas antes/después: igualdad. Archivo completo conserva pruebas de límites, carreras, cancelación, elegibilidad, historial y agotamiento. Sin cambios en implementaciones de búsqueda, claim/take, asignación, entrega, créditos/refunds, precotización ni B2B.
- Build y tipos de producto aprobados. Tipos globales: cinco errores preexistentes en invitations.spec.ts y partner-applications.spec.ts, ya documentados antes de esta tarea; no se declara verde el gate global.
- Oxlint y ESLint focalizados: exit0. OpenAPI completo generado, docs:b2b:check aprobado y 33 pruebas del exportador/HMAC aprobadas. JSON público igual semánticamente a HEAD. Sin migraciones ni versiones nuevas.
- Preparación inicial de la base temporal falló antes de pruebas por ausencia de DATABASE_URL requerida al validar Prisma. Se corrigió sólo el runner privado y se ejecutó la validación completa en otro cluster nuevo. No hubo aborto del runner Vitest ni resultados incompletos acreditados.

Pendiente: ejercicio visual de Web contra esta compilación y despliegue coordinado, no ejecutados. No se modificó frontend, configuración/.env, flags, VM o Coita Eats, ni se accedió a su código o datos. No valida las pantallas exclusivas de QA (ejecución detallada, GPS o clientes directos), que continúan fuera del alcance.
