# Acoplamiento de precotización al backend existente

2026-09-28. Análisis estático; no implementación. Complementa y precisa la propuesta de precotización. Las decisiones siguientes son recomendaciones técnicas para revisar antes de la etapa A.

## Conclusión

Es posible reutilizar infraestructura y reglas sin cambiar el comportamiento observable de las integraciones actuales. No equivale a cero cambios internos: requiere una extracción controlada de cálculo y una extensión de idempotencia. No conviene construir otro motor de tarifas, otro proveedor de routing, otro registro de claves ni otro motor de despacho.

Una precotización sí es un recurso de negocio nuevo: puede existir sin pedido logístico, contactos ni declaración financiera. Persistirla no duplica una solicitud de reparto. La meta es eliminar autoridades y lógica duplicadas, no reducir tablas a costa de romper invariantes.

## Evidencia y mapa de reutilización

| Pieza actual | Hallazgo | Ajuste recomendado |
|---|---|---|
| RoutingModule / ROUTING_PROVIDER | Ya abstrae Google y fake; RouteResult normalizado | Reutilizar exactamente el proveedor y contrato. No segundo cliente de Google ni configuración paralela. |
| ServiceZonesService.resolveActive | Resuelve cobertura y acepta cliente transaccional | Compartir resolución; no nuevo catálogo ni geometría propia de precotización. |
| RatePlansService.findActive; findBand/validateBands | Tarifas versionadas y cálculo por bandas ya disponibles | Compartir selección/validación/cálculo; no copiar reglas a otro módulo. |
| DeliveryQuotesService.quote | Mezcla solicitud, locks, cálculo, llamada externa y persistencia; routing ocurre dentro de la transacción | Extraer funciones de preparación de tarifa y cálculo sobre ruta/snapshot, sin cambiar el orden transaccional legacy en esta etapa. La orquestación nueva usa transacciones cortas y routing fuera de ellas. |
| ApiIdempotencyRecord | UNIQUE(integrationClientId,key); operation incluida en fingerprint; resourceId obligatorio | Mantener una sola autoridad de claves. Ampliar para operaciones durables, no crear otra tabla con un namespace independiente. |
| IdempotencyService.execute | Callback en transacción; replay supone recurso creado al existir registro | Conservar execute legacy. Añadir protocolo de reserva/lease/publicación; distinguir registro en progreso antes de intentar cargar recurso. Preservar hashes y conflictos legacy. |
| ThrottlerModule | Limitación HTTP en memoria; no se encontró presupuesto global durable de routing en los componentes revisados | Mantener protección HTTP; añadir contadores/permisos compartidos de consumo para el nuevo flujo. Son función faltante, no reemplazo de autenticación ni segundo motor de precios. |
| Leases de webhooks | Hay patrón durable, pero ligado a eventos/transporte | Reutilizar criterio de diseño y pruebas pertinentes; no guardar precotizaciones en el outbox ni acoplar ejecución a workers de webhook. |
| Public IDs, configuración, errores, scopes, Prisma | Infraestructura común ya existe | Extender registro de prefijos/scopes/configuración; no replicar servicios transversales. |
| paymentContext, accept/openDispatch, créditos, completion | Son la ejecución existente | Reutilización en etapas posteriores; nada de eso se duplica ni se ejecuta en etapa A. |

Fuentes: src/delivery-quotes/delivery-quotes.service.ts, src/routing/routing.types.ts, src/routing/routing.module.ts, src/idempotency/idempotency.service.ts, src/common/public-id.ts, src/app.module.ts y prisma/schema.prisma. Revisión de continuidad en BITACORA, README y VERIFICATION; resultados históricos no reejecutados.

## Comparación de persistencia

1. **Usar DeliveryQuote sin DeliveryRequest:** no recomendado para esta etapa. deliveryRequestId es obligatorio, ownership B2B deriva de la solicitud, serializadores acceden a esa relación, los índices regulan cotizaciones por solicitud y el trigger congela deliveryRequestId. Convertir luego una Quote huérfana obliga a permitir una mutación hoy prohibida y revisar lectura, cancelación, aceptación y guardas. Menos tablas no implica menor complejidad o riesgo. Además contradice el alcance acordado de no crear DeliveryQuote durante precotización.
2. **Crear DeliveryRequest provisional:** descartado. Exige datos y contexto financiero que todavía no existen; implica solicitud ficticia o ampliar el ciclo de vida de la solicitud.
3. **Crear una entidad universal de precio y migrar todas las Quotes:** posible como refactor mayor, pero introduce migración histórica y nuevas relaciones a numerosos lectores sólo para evitar repetir unas columnas. No justificado ahora.
4. **DeliveryPrequote independiente + servicios comunes:** recomendado. Una nueva evidencia temporal de precio, sin entidad logística ficticia; Quote actual intacta. En conversión futura se crea la Quote necesaria para el flujo existente, con el mismo snapshot y vencimiento, sin routing ni cálculo adicional.

La copia futura de amount/distancia/tarifa desde MPQ a MQ es evidencia en dos momentos contractuales, no dos precios calculados ni dos cobros. Debe hacerse una sola vez y comprobar igualdad. La MQ aceptada sigue siendo la fuente operacional de tarifa/cobro; MPQ conserva procedencia y garantía original. No se permite editar ninguna para hacerlas divergir.

No crear de antemano tablas de conversión, consentimiento o snapshot universal. En etapa B puede bastar una relación única nullable desde DeliveryQuote a DeliveryPrequote; MDR se obtiene de la Quote y los campos de conversión se derivan. Añadir tabla separada sólo si tiene hechos propios que esa relación no puede representar. Mantener los campos públicos futuros null durante etapa A, sin fingir vínculos persistidos.

## Idempotencia sin segundo registro de claves

Opción preferida para detallar en implementación: ApiIdempotencyRecord sigue reservando la key y el UUID del recurso futuro. Una extensión de ejecución, por columnas opcionales o una tabla 1:1 subordinada por PK/FK al registro, guarda lease, versión, intentos y resultado/error. No contiene otra autoridad independiente de key/hash/resourceId.

La reserva y su metadata de ejecución se crean atómicamente. Sin metadata significa operación legacy completada como hoy; con metadata se consulta estado antes del replay. El UUID reservado no demuestra que el recurso exista. La publicación del recurso y la marca de éxito son atómicas y condicionadas al lease vigente. No copiar cuerpos sensibles al ledger de idempotencia.

Las peticiones legacy con key ocupada por una operación nueva siguen recibiendo conflicto por fingerprint/resourceType antes de intentar cargar un recurso ajeno. Hay que probarlo también con una instancia antigua. Activación sólo tras actualizar lectores del nuevo protocolo. Evitar modificar la serialización canónica legacy para introducir normalización de paquetes nueva: normalizar el DTO de MPQ y después usar el fingerprint existente.

## Ajuste del plan de implementación

Antes de endpoints nuevos, un subpaso técnico dentro de A: caracterizar cálculo/errores legacy, extraer preparación y evaluación de tarifa en piezas comunes y comprobar regresión. No mover ahora la llamada externa del flujo legacy fuera de su transacción: eso cambia su sincronización con cancelación y necesita otra revisión. Compartir funciones no obliga a compartir la orquestación ni sus tiempos.

Luego incorporar MPQ con reserva durable, controles compartidos y publicación. La preparación nueva captura una configuración coherente; tras routing revalida la versión/estado relevante en una transacción corta y publica o falla/reintenta acotadamente. Un cambio posterior a publicación no altera el snapshot. La vigencia nueva comienza al emitir, mientras el comportamiento temporal legacy se conserva. No heredar por accidente su inicio de vigencia anterior a routing.

Los límites nuevos no deben bloquear de forma sorpresiva las Quotes existentes: usar un presupuesto compartido entre instancias para emisiones MPQ. Si se requiere un techo total de todas las llamadas Google, incluir las Quotes legacy cambiaría sus posibilidades de error y debe tratarse como decisión separada. Documentar que presupuesto global de MPQ no es un límite global de toda la cuenta Google.

No prometer exactamente una llamada externa ante crash; garantizar un solo recurso y reintentos acotados. No recomputar ruta ni consultar precios al convertir en etapas posteriores. No ampliar etapa A a controles de pago, autorización del envío o interfaces.

## Verificaciones futuras necesarias

- Resultados y errores de cálculo legacy iguales antes/después de extracción, incluidos bordes de bandas y zona ambigua.
- Fingerprints/replays antiguos intactos y conflictos cruzados entre operaciones nuevas y antiguas.
- Cálculo compartido sobre misma ruta/configuración devuelve mismo precio en ambos caminos.
- Routing nuevo fuera de transacción; exclusión de cancelación legacy intacta.
- Una MPQ por intención idempotente; sin MDR/MQ/Dispatch/ledger financiero generado en etapa A.
- Concurrencia, cuotas, leases, expiración y cambios administrativos conforme a la matriz de la propuesta.
- En etapa B: una conversión única, igualdad de snapshots, sin segundo routing ni vencimiento extendido.

Sólo inspección de código y documentación realizada. No pruebas, llamadas externas, datos, configuración, migraciones, versión, commit, push o despliegue modificados por este análisis.
