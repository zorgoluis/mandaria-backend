# Investigación B2B accept 409 — MDR-000002

## Resultado y alcance

**Causa del incidente remoto no confirmada.** Se confirmaron y corrigieron carencias locales de observabilidad y documentación, sin modificar reglas de aceptación, atomicidad ni idempotencia.

Base inspeccionada: rama `QA`, HEAD `1c29f370e3afe5a256c73d98b9f14ce39b61102c`, paquete `1.12.0`. La revisión desplegada en la VM no está comprobada. Investigación del 28 de septiembre de 2026 UTC (27 de septiembre local).

No se invocó accept real ni se accedió a Coita Eats o a la VM. No se crearon solicitudes persistidas, ejecutaron migraciones ni alteraron datos, configuración, créditos o credenciales. Sin commit, push ni despliegue.

## Evidencia aportada

Integración `fd9312fc-500a-44bb-912f-5d69e5efed91`, solicitud `MDR-000002`. MQ-000004 se creó a las 04:48:50.924 UTC por 25.00 MXN y vencía a las 05:03:50.501. Los accept de 04:48:51.060 y 04:50:00.515 devolvieron 409. MQ-000003 estaba vencida y fue reemplazada. Los registros no identifican la cotización enviada ni el código del rechazo.

Ambos intentos están dentro de la ventana de MQ-000004; **esto no prueba que esa fuera la cotización enviada**. Autenticar una credencial no acredita el scope exacto `quotes:accept`. El registro con `//accept` tampoco prueba que esa fuera la URL efectiva: la ruta literal vacía devuelve 404 en la reproducción local.

## Flujo comprobado en código

1. `DeliveryQuotesService.accept` abre una transacción, encuentra la cotización perteneciente a la integración, bloquea la solicitud con `FOR UPDATE` y relee la cotización.
2. Si ya está ACCEPTED, devuelve éxito idempotente antes de abrir otro despacho o consultar políticas.
3. Rechaza estados incompatibles o vencimiento. Cuando detecta vencimiento por reloj, persiste EXPIRED y devuelve el 409 después de confirmar esa transición.
4. Cambia la cotización a ACCEPTED y llama a `openDispatch` dentro de la misma transacción.
5. `openDispatch` obtiene proveedores elegibles, crea el Dispatch OPEN, crea snapshots de créditos y candidatos. Cero candidatos es válido.
6. Para LOCAL_DELIVERY se requieren políticas ACTIVE tanto de PROVIDER como de INDEPENDENT_DRIVER, incluso sin candidatos. Se usan bloqueos compartidos de política y el motor de cálculo; snapshots y despacho se confirman junto con la aceptación.
7. Un fallo revierte aceptación, despacho y snapshots parciales. Los eventos de éxito se emiten después de confirmar.

No se consultan saldos ni se debitan créditos durante accept. Tampoco se llama a routing. La tarifa monetaria RatePlan que produjo 25 MXN es independiente de CreditPolicy.

## Ramas de error

| HTTP / código | Condición local |
|---|---|
| 409 `QUOTE_EXPIRED` | Cotización EXPIRED o vencimiento detectado por reloj |
| 409 `QUOTE_NOT_ACCEPTABLE` | Cotización CANCELLED o solicitud incompatible con aceptación |
| 409 `CREDIT_POLICY_UNAVAILABLE` | Falta política ACTIVE de algún actor o configuración/rangos no permiten resolver el costo |
| 422 `CREDIT_COST_OUT_OF_RANGE` / `CREDIT_DISTANCE_INVALID` | Cálculo del snapshot fuera de límites o distancia inválida |
| 401 / 403 | Autenticación inválida / falta de `quotes:accept`; no se traducen a 409 |
| 404 | Cotización inexistente/no perteneciente a la integración, o ruta literal sin identificador |
| 500 `HTTP_500` | Error de persistencia sin traducción de dominio |

No hay un traductor global de Prisma a 409 en esta revisión. Se inyectaron P2002, P2003, P2010, P2034 y P2028: todos resultaron en 500 sanitizado. Los conflictos de CLAIM/TAKE y las validaciones administrativas de políticas no pertenecen a este flujo. Estos resultados no descartan diferencias en la versión remota o en intermediarios.

## Persistencia y coherencia

- DeliveryQuote tiene publicId único y unicidad parcial por solicitud para OFFERED y ACCEPTED. Una cotización EXPIRED anterior no ocupa esas restricciones.
- Dispatch tiene deliveryQuoteId único; DispatchCandidate tiene unicidad por despacho/proveedor.
- Triggers exigen un despacho OPEN asociado a una cotización ACCEPTED de la misma solicitud y verifican las transiciones y referencias de cotización.
- DispatchCreditSnapshot es único por despacho/actor; sus guardas verifican política, versión y evidencia del cálculo. Una restricción diferida exige los snapshots correspondientes al confirmar el despacho.
- La recotización bloquea la solicitud y reemplaza la OFFERED anterior transaccionalmente. No basta el log de creación para conocer qué ID conservó el consumidor.
- Los controles de adjudicación económica y outbox de entrega no exigen débito o evento de entrega para este nuevo despacho OPEN.

Restricciones inspeccionadas en migraciones incrementales de cotizaciones, dispatch, snapshots e integridad económica, incluida la actualización de reglas de cierre. No se ejecutaron migraciones ni se reprodujeron estas restricciones mediante escrituras PostgreSQL en esta tarea.

## Hipótesis pendientes de la VM

1. Se aceptó MQ-000003 u otra cotización, no MQ-000004.
2. La cotización o solicitud tenía un estado incompatible al intentar aceptar.
3. Faltaba o era inválida una política de créditos requerida. **Reproducido localmente con una cotización vigente; no comprobado en la VM.**
4. La versión desplegada o la interpretación de errores del consumidor/intermediario difiere de la revisión local.

No hay evidencia para atribuir el 409 a saldo, disponibilidad de proveedores o permisos. Un estado actual de política/credencial no prueba por sí solo su estado histórico.

## Contrato y cambios

El JSON de error ya exponía `statusCode` y `code`; Coita Eats puede conservar esos campos. Su `REMOTE_ERROR` no permite determinar si descartó el código, si recibió otra respuesta o si sólo lo resume. No se inspeccionó su implementación.

Cambios locales:

- `src/setup.ts`: identificador de petición generado por el servidor, cabecera `X-Request-Id`, correlación del log HTTP y exposición CORS. No se confía en un identificador suministrado por el cliente.
- `src/common/http-exception.filter.ts`: evento `DELIVERY_QUOTE_ACCEPT_FAILED` con HTTP status, código e identificadores validados de petición/cotización/integración. Sin mensajes de excepciones, SQL, tokens, secretos, cabeceras ni cuerpos completos. JSON de error incorpora `requestId`.
- `src/common/api-errors.decorator.ts` y controlador de cotizaciones: documentan correlación, 409 por política y 422 del cálculo; explican atomicidad/idempotencia. OpenAPI y matriz de acceso regenerados.
- `test/quote-accept-diagnostics.spec.ts`: regresión HTTP con Nest y lógica real sobre un doble transaccional en memoria.
- `scripts/diagnose-mdr-000002-readonly.sql`: inspección acotada de datos y metadatos.

La observabilidad nueva no está desplegada y no recupera retroactivamente los campos ausentes en logs históricos.

## Verificaciones de esta tarea

| Verificación | Resultado |
|---|---|
| Nuevos casos HTTP con doble transaccional | 15/15 |
| Suite unitaria completa, pool threads | 303/303 |
| Nest build / TypeScript sin emitir | PASS |
| Oxlint / ESLint | PASS |
| Generación OpenAPI / matriz de acceso / docs:check | PASS |
| Script SQL contra PostgreSQL local, transacción READ ONLY | PASS |

Los casos cubren ambas políticas ausentes, rollback parcial y al confirmar, éxito sin candidatos, reintento idempotente sin política, cotización anterior vencida frente a nueva vigente, vencimiento exacto, estados incompatibles, cinco fallos Prisma, scope, ruta vacía y ausencia de secretos en logs. Se usaron reloj fijo y principal de integración simulado; no validan la credencial real ni el comportamiento transaccional de PostgreSQL remoto.

El primer arranque de Vitest falló por `spawn EPERM` del entorno; la ejecución autorizada con pool threads pasó. No se ejecutaron E2E que escriben en la base, ni un accept real, por las restricciones de esta investigación. Los CHECK históricos del repositorio no son evidencia nueva de esta tarea.

## Siguiente paso operativo: sólo lectura

1. Identificar la revisión realmente desplegada. Si corresponde al checkout de despliegue, `git rev-parse HEAD`; contrastarla con el artefacto activo. `date -u` permite registrar el reloj observado. No imprimir variables de entorno ni inspecciones completas de contenedores.
2. Transferir únicamente el SQL adjunto y ejecutarlo usando una conexión PostgreSQL autorizada ya configurada, sin poner contraseñas o URLs de conexión en la línea de comandos:

   ```sh
   psql -X --set=ON_ERROR_STOP=1 --file=scripts/diagnose-mdr-000002-readonly.sql
   ```

   El script usa READ ONLY, timeout de sentencia de 5 segundos y de bloqueo de 1 segundo; finaliza con ROLLBACK. Limita el caso por integración y MDR-000002. Devuelve estados, IDs, tiempos, configuración numérica de políticas, conteos de credenciales sin identificadores secretos y metadatos de restricciones. No devuelve contactos, direcciones, referencias comerciales, hashes ni tokens. Si falla por esquema diferente, conservar sólo el diagnóstico sanitizado; no reparar ni migrar para hacerlo pasar.
3. Buscar en evidencia **ya capturada** de los dos intentos únicamente el publicId efectivamente enviado, HTTP status, `code` y un ID de correlación si existiera. No compartir Authorization, cuerpos completos o logs sin filtrar. Si esos datos no fueron conservados, declararlos no disponibles; no repetir accept para reconstruirlos.
4. Contrastar resultados con las tres ramas 409 y la revisión remota. Las ventanas históricas de políticas ayudan, pero no sustituyen evidencia del estado durante el intento. No activar políticas, cambiar scopes ni forzar estados hasta confirmar la causa y autorizar una intervención separada.

El incidente permanece abierto hasta obtener esa evidencia. No se propone una reparación operacional basada en una hipótesis.
