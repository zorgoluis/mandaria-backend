# Mandaria + Coita Eats — revisión de cierre del primer MVP

## Actualización de alcance del piloto

Participación y horario confirmados por propietario: 8 restaurantes, 1 flotilla con 4 repartidores, Ocozocoautla, Chiapas, todos los días de 08:00 a 00:00 (medianoche), hora local. Una persona técnica por correo, primera respuesta dentro de 8 horas; cómputo del plazo/cobertura y alertas efectivas aún pendientes. Se mantienen 30 días con revisión semanal, Coita Eats móvil y previsión de 100 pedidos/día, pico 5/minuto. No acredita capacidad logística/API ni autoriza lanzamiento. Recomendación pendiente: responsable que pueda pausar nuevas solicitudes críticas sin esperar la respuesta técnica.

El siguiente párrafo conserva el estado anterior de definición:

Piloto definido parcialmente por propietario: 30 días, revisión semanal, Coita Eats móvil, previsión ~100 pedidos/día y pico esperado 5/minuto. No equivale a cupo implementado ni capacidad validada. Escenarios de 1/2/3 precotizaciones por pedido consumen 200/400/600 unidades diarias bajo supuestos simples; ráfagas/concurrencia 2, renovaciones y abandonos pendientes de contrastar. No subir límites automáticamente. Participantes, zona, horario y responsable técnico preguntados; fecha de lanzamiento aún no fijada.

[Plan vigente](MVP-PILOT-PLAN.md). Limpieza del clon confirmada por propietario; restauración cerrada en alcance comprobado. Dictamen de apertura sigue pendiente de los otros cierres operativos.

## Decisión del propietario: respaldo semanal para inicio del piloto

2026-10-01. El propietario decide mantener **frecuencia semanal (7 días)** durante el inicio, por considerar que todavía no hay actividad relevante que respaldar. Es una decisión de negocio aportada por el propietario, no una conclusión del agente sobre ausencia de datos: la copia comprobada sí contenía historial técnico y económico (1 cuenta/8 movimientos).

**Sustituye el objetivo previo RPO 24 h para esta fase:** con cadencia semanal y copias utilizables, la pérdida potencial alcanza casi siete días de cambios; si una copia falla, puede ser mayor. La frecuencia semanal no garantiza por sí sola un máximo de pérdida. El RTO de 24 h (tiempo para recuperar servicio) no fue cambiado. Revisar frecuencia y retención al incorporar actividad real o aumentar volumen; no se ha programado ningún cambio automático.

**Configuración observada frente a decisión:** la última captura de DigitalOcean mostraba backups diarios habilitados, sin copias automáticas disponibles en ese momento. No se modificó ese ajuste; semanal es la decisión aprobada, no un estado remoto verificado. El snapshot se restauró satisfactoriamente con las adaptaciones documentadas; no demuestra que futuras copias automáticas se completen.

El ensayo de restauración de esa copia queda cerrado satisfactoriamente en su alcance. La discrepancia semanal/RPO 24 h deja de tratarse como bloqueo de decisión porque el propietario cambió el objetivo. No implica cierre de otros pendientes del piloto, ni nueva evidencia sobre custodia, alertas o calendario efectivo. Retirada del clon pendiente de confirmación.


## Resultado funcional del ensayo — 2026-10-01

**SATISFACTORIO en el alcance comprobado por el propietario; recuperación operativa integral aún no cerrada.** Evidencia recibida por chat, comandos ejecutados por propietario sólo en mandaria-restore-test, sin conexión remota del agente:

- PostgreSQL 17 y Redis arrancaron; 29 migraciones finalizadas, ninguna sin finalizar.
- Backend healthy y GET loopback /health: status ok/database up.
- Frontend reiniciado una vez tras recuperar backend; HTTP 308 y después **HTTPS 200**, usando mandaria.com.mx resuelto exclusivamente a 127.0.0.1, sin -k ni seguimiento de redirecciones. Prueba raíz/TLS, no todas las pantallas ni operación comercial.
- Clave recuperada descifra el único secreto almacenado: checked 1, decrypted 1, failed 0. No envío de webhook ni prueba del receptor.
- Lectura transaccional de créditos: **1 cuenta, 8 movimientos, 0 saldos negativos, 0 diferencias saldo/ledger y 0 inconsistencias en cadena**. No auditoría exhaustiva de todas las entidades ni equivalencia con datos vivos posteriores al snapshot.

**Adaptaciones documentadas:** snapshot conserva publicación de backend en IP antigua 10.120.0.3; Docker no podía enlazarla. Override sólo clon cambia a loopback, fija imagen existente, desactiva polling/seed y ejecuta node dist/main.js directamente. No migra ni recrea PostgreSQL/Redis. Por ello se demuestra recuperación con procedimiento, no arranque estándar sin intervención. Frontend dejó de fallar al recuperar backend y reiniciarlo. No reinstalación/build/pull, operaciones comerciales, DNS ni apertura de red.

**Todavía pendiente para el objetivo de recuperación:** fecha UTC exacta del snapshot y antigüedad recuperada; tiempos de creación/inicio y fin para medir RTO; evidencia de copias periódicas utilizables compatible con RPO 24 h; custodia recuperable de configuración/clave fuera del único servidor o con mecanismo de acceso de emergencia comprobado. Clave funcional dentro de snapshot no prueba custodia independiente. RPO/RTO 24 h son objetivos aceptados, no garantías acreditadas automáticamente por este éxito.

**Limpieza:** solicitar última fecha UTC/estado y retirar únicamente el Droplet temporal mandaria-restore-test, conservando producción, snapshot y evidencia. Destrucción todavía no confirmada; mientras exista genera coste incluso apagado. Firewall/etiqueta exclusivos pueden conservarse para próximo ensayo, sin tocar reglas de producción. La pantalla inicial New sin firewall no demuestra ausencia de protección ni garantiza aislamiento desde primer arranque; captura posterior mostró regla SSH y ninguna salida visible.

Dictamen de piloto continúa **NO LISTO** por los pendientes operativos documentados. No repetir suites técnicas para cerrar este ensayo. Los registros siguientes conservan su estado histórico.


**Segunda captura 2026-10-01:** identifica `ubuntu-s-mandaria`, región SFO2, y snapshot listado `ubuntu-s-mandaria-1790834827410`, tamaño mostrado 15.87 GB, creado «hace 2 minutos» al capturar. Hay un snapshot candidato para ensayo; backups automáticos diarios aún indican ninguna copia disponible. El tamaño mostrado del snapshot no acredita tamaño mínimo del disco de destino. Fecha UTC exacta, ID de imagen, consistencia recuperable, destino y aislamiento previo pendientes. No se ha creado/restaurado ningún recurso por el agente. Esta evidencia supera la falta de identidad/copia candidata de la captura anterior, conservada abajo.


**Captura aportada 2026-10-01:** pantalla muestra Automated Daily Backups enabled, ventana diaria 00:00–04:00 UTC, No backups available y próximo inicio estimado dentro de 17 horas respecto al momento de la captura. No muestra identidad del Droplet, copia completada, retención ni tamaño del disco. Frecuencia diaria visible; declaración anterior de semanal/copia «hoy» no describe esta pantalla. No se infiere eliminación de copias ni cambio de plan; confirmar que corresponde a Mandaria. Aún no hay copia visible para el ensayo. RPO/RTO 24 h continúan sin acreditar; programación diaria no equivale a copia completada ni garantiza por sí sola esos objetivos.


## Resumen vigente de preparación para el piloto

**NO LISTO para autorizar el piloto con la evidencia disponible.** No hay un nuevo defecto de producto confirmado; faltan comprobaciones y acuerdos operativos. Fuente de esta actualización: resumen aportado por el propietario; las comprobaciones VM fueron ejecutadas por él y revisadas mediante sus salidas en el seguimiento anterior. Esta actualización es documental: no ejecuta nuevas pruebas ni accede a la VM.

### Comprobado y procedencia

- Build aprobado y archivo B2B completo: **15/15** en la verificación local anterior.
- **7/7 huellas históricas reconciliadas**, diferencias de finales de línea sin cambios de contenido; evidencia conservada en `docs/checks/mvp-closure-fingerprint-reconciliation.json`. Ya no constituyen un bloqueo.
- Checkout backend VM coincide con la revisión validada y está limpio; lock de imagen semánticamente equivalente al del repositorio. Esto no prueba identidad completa del artefacto ejecutado.
- **29/29 migraciones finalizadas**, hashes coincidentes entre PostgreSQL, imagen y SQL local normalizado, según evidencia del operador.
- Política de límites reconstruida coincide con la guardada en PostgreSQL. No equivale a inspección directa de la memoria del proceso.
- Worker habilitado: dos lecturas muestran avance del polling, cero pendientes/agotados y siete envíos registrados como entregados. No prueba procesamiento correcto ni deduplicación del receptor.
- PostgreSQL guarda datos en el **disco principal del Droplet**, según el propietario. Confirma backup automático **semanal**, con última copia realizada «hoy» al aportar el resumen; no se recibió aquí un timestamp para sustituir esa fecha relativa. La frecuencia semanal corrige cualquier declaración previa de frecuencia diaria. Restauración aún no probada.

### Pendientes que bloquean la autorización

| Área | Acción concreta | Responsable por rol |
|---|---|---|
| Recuperación | Probar restauración aislada; confirmar recuperación segura de configuración y clave maestra de webhooks; acordar pérdida de datos y tiempo de recuperación aceptables. Una copia semanal puede dejar sin recuperar cambios posteriores a la última copia, hasta casi siete días bajo cadencia regular y copias utilizables; evaluar protección adicional según prioridad del propietario. | Propietario y operación técnica |
| Límites del piloto | Definir pedidos/día, pico/minuto, duración y canales. Comparar demanda de precotizaciones, renovaciones y concurrencia con **10/min, 500/día y 2 simultáneas por cliente**, y presupuesto global MPQ **1.000 unidades routing/día**. No equiparar pedidos con precotizaciones. | Negocio y operación |
| Responsables y alertas | Designar atención técnica, respaldos y recuperación; comprobar alertas de errores, límites y webhooks. Concretar contacto y procedimiento de pagos/devoluciones del restaurante, responsable comercial indicado. | Operación, negocio y restaurante |
| Trazabilidad e integración | Completar identidad del artefacto backend ejecutado y frontend desplegado; correlacionar casos integrados con versiones; acreditar deduplicación/recuperación de Coita y pantallas del piloto; confirmar reversión compatible con esquema actual. | Mandaria operación/Frontend y Coita Backend/Web/Mobile |

El archivo pendiente y la reconciliación de huellas de C4 están subsanados. La causa de abortos antiguos sigue sin demostrarse; resultados históricos **no son una nueva ejecución de toda la suite**. El verificador A3 sigue aparcado. No se autoriza cambio operativo, restauración sobre principal ni aceptación de riesgos. Los diagnósticos históricos que siguen deben interpretarse con este resumen vigente.


## Registro de revisión y seguimientos anteriores


Fecha local: **2026-09-30** (evidencia nueva registrada el 2026-10-01 UTC). **Veredicto: NO LISTO para autorizar un piloto de producción con la evidencia disponible.** No se reprodujo un defecto de producto nuevo. El bloqueo es de acreditación local pendiente y preparación del entorno: no se confirma revisión/configuración desplegada, capacidad acordada ni recuperación operativa. Esta conclusión no ordena modificar QA ni apagar servicios remotos.

## Estado real y procedencia

**Worker VM observado:** dos GET administrativos aportados muestran lastPollAt 2026-10-01T05:28:49.846Z → 05:29:04.849Z (15.003 s), workerEnabled true, pollSeconds 15 y leaseSeconds 60. En ambos: pending/exhausted/leased 0, delivered 7 y oldestPendingDueAt null. Polling real y ausencia de atraso observables para la instancia que responde; sin POST ni envío provocado. El conteo delivered acredita estado del transporte, no procesamiento/deduplicación del receptor. Respaldos/restauración, alertas/responsables y dimensionamiento permanecen pendientes.

**Política VM comprobada por operador:** fingerprint reconstruido y singleton SQL coinciden (`ffee83a8318f91abd1bf3ab22665c44252960cd58c5531e3c2c3bd1701a6c4ca`). Tres flags PREQUOTE true; 10/min, 500/día y 2 concurrentes por cliente; 1000 unidades globales MPQ/día; Google 5000 ms y 1 retry. Validez 15 min, lease 90 s y reserva 30 s. Webhooks configurados poll 15 s, lease 60 s, timeout 5 s y destinos inseguros false. Lectura de entorno inicial/archivo actual, no memoria de proceso; worker efectivo y adecuación a demanda siguen sin comprobar. No confundir precotizaciones/renovaciones con pedidos ni presupuesto MPQ con factura total Google.

**Lock de imagen cerrado:** comparación semántica del operador entre checkout backend y contenedor: 522 entradas en ambos, cero agregadas/eliminadas/modificadas y cero cambios en campos superiores. SHA distinto por representación JSON, sin diferencia semántica de dependencias declaradas. No acredita por sí solo los módulos instalados o el bundle completo ni prueba que npm prune causó el formato.

**Seguimiento Git VM:** operador confirma backend checkout `7d988d351d87fabd519ffe21251950ec64828636` limpio y lock `555b613acc7eda10316b19beb18e3d2b6050b7cf6d779d83fb3361a117f9f970`, igual al local LF. Imagen `72f450f…` creada 2026-09-29T18:52:21.211598018Z sin etiqueta de revisión; lock interno diferente pendiente de comparación semántica. El Dockerfile realiza `npm prune --omit=dev`, pero no se atribuye la diferencia a ese paso sin evidencia. Checkout confirmado no acredita imagen completa.

**Seguimiento VM por Bitvise:** 29 migraciones finalizadas sin rollback; checksums registrados iguales a los archivos de la imagen y al SQL local normalizado a LF (29/29), sin migraciones de imagen pendientes. Evidencia: [lectura del operador y comparación local](checks/mvp-vm-migrations-operator.json). Esto cierra la comparación de historial/checksums de esa instancia; no es un escaneo de drift del esquema vivo. Frontend checkout `901441ea8504ef49c7d9db6b69baeda6054c4643` limpio en archivos tracked; bundle ejecutado no acreditado. Imagen backend identificada previamente; main.js/environment.js coinciden localmente, lock difiere, y falta salida de SHA/status/lock del checkout backend. Configuración, workers, recuperación y dimensionamiento siguen pendientes.

**Seguimiento de cierre (2026-09-30): siete de siete huellas reconciliadas, cero pendientes locales de esa procedencia.** `node scripts/reconcile-mvp-fingerprints.mjs` reconstruye desde Git los bytes históricos y exige el SHA-256 original: `public-id.ts` tenía CRLF salvo la línea 13 (LF); las cinco migraciones y el script de carga tenían LF salvo su última línea (CRLF). Las cinco copias de migraciones conservadas en `.tmp/c4/upgrade` coinciden además con los hashes del baseline. Ningún cambio de contenido ni edición de migraciones fue necesario. La evidencia autocontenida no depende de conservar `.tmp`: [reconciliación](checks/mvp-closure-fingerprint-reconciliation.json). El índice mantiene el diagnóstico inicial en `baselineByteUnresolved` y publica `remainingBaselineByteUnresolved: []` tras verificar la reconstrucción. Esta comprobación documental no ejecuta pruebas funcionales ni demuestra checksums remotos o la causa de abortos anteriores.

El bloqueo local descrito originalmente abajo queda **subsanado por este seguimiento**, tanto en el archivo B2B como en las siete huellas. El dictamen global sigue **NO LISTO** por evidencia operativa pendiente. Operador utilizará Bitvise para ejecutar lecturas de VM; no se dispone aquí de acceso remoto confirmado. Incidencias comerciales/pagos/devoluciones: restaurante, según respuesta del propietario; faltan contacto/procedimiento, límites numéricos del piloto y responsables de alertas técnicas y respaldos.

- Checkout actual: rama `QA`, `7d988d351d87fabd519ffe21251950ec64828636`, paquete 1.12.0. Incluye los merges posteriores a `44557b7`; no confundir HEAD local con revisión desplegada.
- **Declaración del operador:** Mandaria está desplegado y los tres flags PREQUOTE están en true. Coita completó #85/#86 (efectivo, despacho, asignación y webhook), #89 (transferencia simulada QA, vencimiento/renovación/nuevo consentimiento y webhook) y #90 (transferencia simulada, consentimiento vigente y webhook). Instrucciones financieras mostradas correctamente. Esto supera la afirmación histórica de «sin activar» como descripción reportada de ese entorno, pero **no acredita dinero real, todos los canales UI ni configuración de cada instancia**. No se accedió a Coita/VM ni se recibieron SHA/logs correlacionados de esas pruebas.
- C4 original se ejecutó sobre baseline `69f757b...` y se publicó en `2e1a82a`; seguimiento en `9785ee1`. D se probó sobre `9785ee1` más cambios publicados en `f722f50`. Git confirma contenido actual idéntico a D para producto, pruebas, migraciones, dependencias y configuración de compilación/runner. Las diferencias de D frente a C4 son selects/proyecciones/DTOs aditivos y pruebas asociadas; D reejecutó los archivos afectados.
- Revisión nueva de reportes: exit 0 + reporte exitoso + **cada caso passed**; se reemplaza evidencia anterior del mismo archivo por la de D, sin sumar repeticiones. **403 unitarias/35 archivos y 743 E2E/33 archivos son evidencia histórica combinada**, no una suite nueva ni integral de HEAD. Se añaden **15 casos nuevos completos** de `delivery-requests-b2b.e2e-spec.ts`: consolidado de **758 E2E/34 archivos**, sin sumar abortos ni repeticiones. No es una ejecución nueva de toda la suite.
- **Límite de huellas:** de 348 entradas del baseline C4, 92 hashes brutos difieren: 72 se explican por CRLF/LF, 12 por cambios D/documentación y uno es caché `.tsbuildinfo`. Siete quedan sin reconciliar con bytes del commit registrado: `src/common/public-id.ts`, cinco migraciones A3/A5/B/C y `scripts/check-prequote-a6-load.mjs` (rutas exactas en el índice). Git no muestra cambio de contenido publicado posterior para esos archivos, pero **no se acredita igualdad byte a byte con aquel working tree**. No se atribuye la diferencia a finales de línea sin prueba ni se infiere un defecto SQL. Comparar checksums aplicados con los artefactos de despliegue antes del piloto; no editar migraciones para hacerlos coincidir.

Evidencia nueva: [procedencia por archivo y hash de reporte](checks/mvp-closure-provenance.json), [comandos/exits locales](checks/mvp-closure-local.json). Se conservan íntegros los informes anteriores: [A6](CHECK-V1.13-A6-PREQUOTES.md), [C4](CHECK-V1.13-C4-AUTHORIZED-ACCEPTANCE.md), [D](V1.13-D-EXECUTOR-COLLECTION-INSTRUCTIONS.md), [readiness](V1.13-ACTIVATION-READINESS.md).

## Garantías y preparación: evidencia frente a pendiente

| Requisito | Evidencia revisada | Resultado | Limitación / acción pendiente | Responsable |
|---|---|---|---|---|
| Snapshot, condiciones y expiry original | C4: persistence 24, HTTP 40, A6 36; B2/B3/B4, constraints e inmutabilidad | Acreditado históricamente local | Sin renovación TTL en conversión; no acredita la revisión instalada ni los checksums remotos | Backend/operación Mandaria |
| Conversión única/atómica | C4 B2 39 + B3/B4 completos: rollback, concurrencia, manifest recíproco | Acreditado históricamente local | No garantiza un único envío por externalReference/pedido | Backend Mandaria / Coita Backend |
| Consentimiento exacto y bypass | C4 C2 35, C3 62: tuple MQ/importe/moneda/expiry, fecha posterior, SQL inválido y auth durante locks | Acreditado históricamente local | Mandaria valida atestación; evidencia humana y custodia reales pertenecen a Coita | Coita Backend y Web/Mobile |
| Idempotencia, respuesta perdida, leases | C4 A6/A3/A5 y C3: fencing, locks, dos apps, respuesta perdida/replay | Acreditado históricamente local | Simulación local, no garantía de exactamente una llamada externa; recuperación con mismas keys, sin fabricar nuevo intento comercial | Backend Mandaria / Coita Backend |
| Cancelación vs accept/entrega | C3 ambos órdenes; C4 recovery 2 casos precio igual/menor; D cancelación tardía | Acreditado históricamente local; #89 reportado integrado | cancel200 no basta: MDR CANCELLED + cancelledAt, luego status CANCELLED/EXPIRED y deliveredAt null. Resultado incierto o DELIVERED bloquea sucesor | Coita Backend / soporte |
| Legacy CASH/COURIER_ADVANCE/PREPAID | C4 quotes/dispatch/independent/completion, D regresión completa de cuatro superficies | Archivo pendiente acreditado 15/15 nuevo | Consolidado con evidencia histórica; límites de huellas descritos arriba | Backend Mandaria |
| Créditos separados de comida/envío | C4 credits 24, consumption 36, snapshots 14, refunds 22; D conserva refunds | Acreditado históricamente local | Accept no cobra créditos; claim/take sí. Cobro monetario real, recibos y conciliación no acreditados | Backend / operación / negocio |
| Outbox, HMAC, retries e identidad final | C4 outbox 17, webhooks 54 completos exit 0, status 21, completion 29; payload estable/identidad congelada/reintentos firmados | Acreditado históricamente local; cierres #85–90 reportados | At-least-once: Coita debe validar firma/raw body y deduplicar por eventId. Sus carreras de duplicados no están acreditadas por recibir un webhook | Mandaria operación / Coita Backend |
| Instrucción de cobro en tres superficies | D: cinco E2E + diez unitarias nuevas; provider, independiente y driver/me de flotilla | Backend acreditado; UI correcta según operador | Precisar qué pantallas fueron comprobadas; retirar cobro en HISTORY/cancelación y refrescar ownership. ACCEPTED/DELIVERED no prueban pago | Mandaria Frontend |
| Aislamiento B2B/scopes/privacidad | C4 B2B/C3 y D checks de respuestas; logs sanitizados en evidencia histórica | Acreditado localmente dentro del alcance | Sin auditoría de logs remotos. .env estuvo versionado antes de 44557b7: retirada no sanea historia; confirmar gestión/rotación si hubo secretos reales, sin compartirlos | Operación/seguridad Mandaria y Coita |
| Capacidad/routing compartida | A6: 600 admisiones, dos Nest, mutex global, degradación 88–102 a 6,5–6,9 ciclos/s; p95 mayor 1.144 ms | Medición local histórica, **no dimensionamiento de piloto** | Faltan pico/minuto, volumen/24h, concurrencia/renovaciones, margen y latencia objetivo. No convertir ciclos admit+finish sin Google en RPS HTTP productivos | Negocio + operación |
| Configuración coordinada | A5 fingerprint durable de siete parámetros, límites/Retry-After y fail closed | Código probado; entorno **no verificado** | Ver valores efectivos por instancia, singleton y consumo. Flags true no prueban concordancia ni scopes; no reiniciar cuotas | Operación Mandaria |
| Migraciones/instancias/jobs | Históricos C4 limpia/upgrade sin reset; C3 pre-C lee/cancela pero rechaza accept/replay C | Compatibilidad actual local; remoto **no verificado** | Obtener SHA/artefacto y checksums aplicados en cada instancia/job. Mezcla pre-C/actual no acreditada | Operación Mandaria |
| Salud/recuperación/alertas | GET health; health administrativo de webhooks con lastPollAt por instancia, cola durable; recuperación perezosa A3/A5 | Capacidades existentes; operación **no verificada** | Confirmar polls/colas, alertas 5xx/429/presupuesto y dueño del incidente. Ver respuesta a agotamiento e incertidumbre | Operación Mandaria / soporte Coita |
| Respaldo/restauración/reversión | Runbook documental, sin ensayo del entorno recibido | **Pendiente bloqueante** | Evidencia de backup recuperable, recuperación ensayada y artefacto compatible C/D; preservar master key por canal seguro | Operación Mandaria |
| Política de atención y evidencia | Responsabilidades descritas en C1/readiness; ningún acuerdo aportado aquí | **Pendiente de negocio** | Custodio, retención, soporte y devoluciones de comida externas a Mandaria; no inventar otra transferencia o reembolso al reiniciar | Negocio / Coita / restaurante |

Los números por fila referencian archivos del índice, **no se suman entre filas**.

## Verificación nueva y situación C4

1. Lectura de continuidad, Git y reportes completos; consolidación focalizada reproducible: `node scripts/review-mvp-evidence.mjs`. Exit final 0. Dos iteraciones del verificador documental detectaron (a) hashes no reconciliados y (b) caché fuera de Git; se registran esas limitaciones, no se ocultan como producto aprobado.
2. Primer preflight de `review-mvp-local.mjs build` no inició compilación/E2E: `.env` ausente (ENOENT). Se corrigió el runner auxiliar para permitir compilación sin DB y exigir conexión local sólo al probar. No se recrearon credenciales ni se recuperaron de Git.
3. `node scripts/review-mvp-local.mjs build`: **exit 0**; Nest build completo, sin iniciar API ni DB. Node 24.15.0 y versiones de dependencias en el índice.
4. **E2E nuevo: 15/15, exit 0**, archivo completo `delivery-requests-b2b.e2e-spec.ts`, pool threads/un worker, 04:53:29–04:53:44 UTC. Sin errores no manejados; casos/aserciones y configuración compartida intactos. Ningún aborto nativo nuevo. La intermitencia histórica no se considera resuelta.
5. El usuario autorizó elegir entorno al faltar `.env`: PostgreSQL 18.6 desechable en `127.0.0.1:55439`, rol sintético y base nueva `mandaria_mvp_20261001_test`. Migraciones actuales aplicadas **una vez con éxito** mediante configuración estándar y URL de proceso explícitamente aislada. No prueba upgrade ni repite el verificador A3. Clúster detenido al terminar (exit 0), datos sintéticos conservados bajo `.tmp/mvp/pg-isolated`; servicio instalado en 5432 y principal intactos. Trust limitado a loopback mientras estuvo encendido; no reutilizar este clúster como entorno operativo.
6. Fallos de preparación conservados en [índice PostgreSQL](checks/mvp-closure-postgres.json): captura por pipes del arranque no devolvió control hasta detener el clúster; corregida usando descriptores de archivo. Primer migrate rechazó falta de DATABASE_URL; segundo, igualdad con TEST_DATABASE_URL exigida por protección del helper. Ambos previos a SQL. Se usó configuración estándar sólo para migrar el destino aislado. Dos arranques Vitest también rechazaron esa igualdad **antes de cargar pruebas**; se retiró DATABASE_URL del entorno de Vitest, conservando TEST_DATABASE_URL. No son abortos nativos ni casos ejecutados. No se modificó la protección compartida ni se descartó evidencia.
7. Consolidación final exit 0; un intento intermedio no pudo iniciar Git por EPERM del sandbox y se repitió con permiso de lectura de procesos. Oxlint focalizado en los tres scripts auxiliares exit 0; `git diff --check` exit 0. No se reejecutaron tipos, linters de producto ni suites ajenas: producto intacto y resultados históricos identificados.

**C4:** el bloqueo específico del archivo incompleto queda subsanado. No se afirma resolución de causa nativa ni PASS integral incondicional: se conserva **PARTIAL por procedencia histórica limitada**, con siete huellas del baseline aún no reconciliadas. Los reportes completos y la continuidad Git permiten reutilizar evidencia funcional, pero no afirmar identidad exacta de aquel working tree. Esto no justifica repetir suites indiscriminadamente. Ver rutas y hashes en el índice; resolver esa procedencia por artefactos/manifest antes de elevar el dictamen. A3 antiguo permanece aparcado.

Sin cambios de producto, pruebas, SQL, `.env`, banderas operativas, versión/CHANGELOG o Coita. Los tres scripts nuevos son auxiliares de revisión, no importados por el backend. **Esta revisión no requiere reconstruir/desplegar producto**; build local fue verificación. No se accedió a VM ni a servicios externos. Intentos fallidos excluidos del conteo.

## Bloqueos concretos antes de autorizar piloto

Los cuatro pendientes vigentes son recuperación, límites del piloto, responsables/alertas y trazabilidad/integración, detallados al comienzo. Huellas, checkout, lock semántico, migraciones, política reconstruida y polling ya tienen evidencia aportada: no solicitar repetir esas lecturas sin un cambio que lo justifique. Aún faltan identificación completa de artefactos, integración y reversión.

**Posterior al MVP, si la necesidad aparece:** optimizar mutex/índices por demanda demostrada, automatizar cambio de fingerprint/alertas si el procedimiento manual no cumple objetivos, reparar verificador A3 y ampliar escala/fault testing. Recibos, conciliación, nuevas modalidades de pago y devoluciones monetarias son alcance separado, no funcionalidades a agregar para forzar este cierre.

## Referencia de lecturas VM (histórica; pendientes según resumen vigente)

**No ejecutadas por este agente.** Varias ya fueron aportadas por el operador; conservar como referencia, no como orden de repetición. Ejemplos para VM Linux; si usa otro SO/supervisor, adaptar con operación. Ejecutar desde el directorio real de cada release y repetir por todas las instancias/jobs. No usar `printenv`, `cat .env`, `pm2 env/jlist`, dumps de proceso ni logs completos. No pasar passwords/tokens en argumentos ni devolver URLs privadas.

### 1. Identidad del artefacto y proceso

```sh
git rev-parse HEAD
git status --porcelain --untracked-files=no
node --version
node -p "JSON.stringify({package:require('./package.json').version,prisma:require('./node_modules/prisma/package.json').version})"
sha256sum package-lock.json dist/main.js dist/config/environment.js
# PID real entregado por el supervisor; sólo metadatos, sin command line ni entorno:
ps -p "$MANDARIA_PID" -o pid=,lstart=,comm=
```

Adjuntar identificación de instancia/rol, manifiesto de release y fecha de inicio. Un SHA del checkout no demuestra que el proceso cargó ese artefacto: operación debe confirmar que el directorio no cambió tras arrancar. Si el despliegue no contiene Git, aportar manifiesto CI con SHA y hashes del bundle. No inferir igualdad de dist entre plataformas sin comparar manifiestos.

### 2. Parámetros reconstruidos seguros (no prueba absoluta de memoria del proceso)

Con permisos locales apropiados, desde el mismo release; sólo importa la validación, **no AppModule**. Lee en privado el entorno inicial y archivo del proceso; publica únicamente lista permitida. Cualquier inyección/hot reload posterior debe confirmarla operación; `/proc/environ` y el archivo actual no prueban por sí solos qué leyó ConfigService al arrancar.

```sh
node --input-type=module - "$MANDARIA_PID" <<'NODE'
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {parse} from 'dotenv';
import {validateEnvironment} from './dist/config/environment.js';
try {
  const pid=process.argv[2]; if(!/^\d+$/.test(pid)) throw Error();
  const cwd=fs.readlinkSync(`/proc/${pid}/cwd`);
  if(fs.realpathSync('.')!==fs.realpathSync(cwd)) throw Error();
  const raw=fs.readFileSync(`/proc/${pid}/environ`,'utf8').split('\0').filter(Boolean);
  const initial=Object.fromEntries(raw.map(s=>[s.slice(0,s.indexOf('=')),s.slice(s.indexOf('=')+1)]));
  const file=fs.existsSync('.env')?parse(fs.readFileSync('.env')):{};
  const cfg=validateEnvironment({...file,...initial});
  const keys=['NODE_ENV','PREQUOTE_ENABLED','PREQUOTE_CONVERSION_ENABLED','PREQUOTE_AUTHORIZED_ACCEPT_ENABLED','PREQUOTE_VALIDITY_MS','PREQUOTE_LEASE_MS','PREQUOTE_MAX_ATTEMPTS','PREQUOTE_PER_MINUTE','PREQUOTE_PER_DAY','PREQUOTE_MAX_CONCURRENT','PREQUOTE_PERMIT_RESERVE_MS','PREQUOTE_GLOBAL_DAILY_ROUTING_UNITS','GOOGLE_ROUTES_TIMEOUT_MS','GOOGLE_ROUTES_MAX_RETRIES','ROUTING_PROVIDER','GOOGLE_ROUTES_TRAVEL_MODE','MAIL_PROVIDER','B2B_WEBHOOK_POLL_SECONDS','B2B_WEBHOOK_LEASE_SECONDS','B2B_WEBHOOK_TIMEOUT_MS','B2B_WEBHOOK_ALLOW_INSECURE_TARGETS'];
  const policy={minute:cfg.PREQUOTE_PER_MINUTE,day:cfg.PREQUOTE_PER_DAY,concurrent:cfg.PREQUOTE_MAX_CONCURRENT,globalUnits:cfg.PREQUOTE_GLOBAL_DAILY_ROUTING_UNITS,reserveMs:cfg.PREQUOTE_PERMIT_RESERVE_MS,retries:cfg.GOOGLE_ROUTES_MAX_RETRIES,timeoutMs:cfg.GOOGLE_ROUTES_TIMEOUT_MS};
  console.log(JSON.stringify({configurationSource:'reconstructed; operator must attest runtime',parameters:Object.fromEntries(keys.map(k=>[k,cfg[k]??null])),policyFingerprint:createHash('sha256').update(JSON.stringify(policy)).digest('hex')},null,2));
} catch { console.error('Safe configuration check failed; inspect privately, do not paste environment or exception details.'); process.exitCode=1; }
NODE
```

Presupuesto MPQ debe ser explícito, suficiente para retries y demanda acordada; no cubre Google legacy ni equivale a factura. Comparar fingerprint entre procesos y singleton. Dependencias: PostgreSQL, Google Routes (cuenta/cuota/facturación/red y secreto por canal seguro), zona/tarifa/políticas ACTIVE, ejecutores y créditos; endpoint Coita HTTPS, clave HMAC y master key preservada, reloj sincronizado. No comunicar valores de ninguna clave.

### 3. Migraciones y consumo, conexión PostgreSQL de sólo lectura

Usar conexión ya administrada por operación (servicio libpq/.pgpass con permisos restringidos o sesión DBA), **sin URI/password en salida**. Los nombres de migración/checksums son seguros; no seleccionar `logs` de Prisma. Abrir sesión `psql -X -v ON_ERROR_STOP=1 service=mandaria_readonly` sólo si ese servicio existe; sustituir por el mecanismo de lectura ya autorizado, no crearlo aquí.

```sql
BEGIN READ ONLY;
SET LOCAL statement_timeout = '5s';
SELECT version();
SELECT migration_name, checksum, finished_at IS NOT NULL AS finished,
       rolled_back_at IS NOT NULL AS rolled_back
FROM "_prisma_migrations" ORDER BY started_at DESC LIMIT 100;
SELECT id, fingerprint FROM "PrequoteConsumptionPolicy" WHERE id=1;
SELECT state, count(*) AS permits, COALESCE(sum(units),0) AS potential_units
FROM "PrequoteConsumptionPermit"
WHERE "startedAt" >= now() - interval '24 hours'
   OR (state='RESERVED' AND "reserveExpiresAt" > now())
GROUP BY state;
SELECT state, count(*) AS executions, min("leaseExpiresAt") AS oldest_lease
FROM "ApiIdempotencyExecution"
WHERE state='PROCESSING' AND "leaseExpiresAt" < now()
GROUP BY state;
COMMIT;
```

Consumo es fotografía, no permiso de admisión ni diagnóstico completo de límites individuales. La última consulta cuenta leases expirados, **no permite forzarlos**; A3/A5 recuperan por su protocolo. Si timeout, no ampliar a barridos sin revisión. Comparar cada checksum con `sha256sum prisma/migrations/*/migration.sql` del artefacto candidato, incluidos los cinco archivos con huella histórica no reconciliada. Falta/sobrante/fallida o checksum distinto: detener autorización, no hacer reset, `resolve`, DDL ni borrar historia. No ejecutamos `migrate deploy` ni `generate` para diagnosticar VM.

### 4. Salud HTTP, worker y cola

```sh
# Sustituir puerto local del proceso; GET únicamente, sin aceptar/cancelar/entregar:
curl --fail --silent --show-error http://127.0.0.1:3000/health
```

Con sesión SUPER_ADMIN existente en herramienta privada, realizar **GET `/api/v1/admin/webhooks/health`** en cada instancia (ruta contrastada con controller). Entregar sólo pending/exhausted/delivered/leased/oldestPendingDueAt y thisInstance (workerEnabled/pollSeconds/leaseSeconds/lastPollAt), sin token/headers. Repetir una vez tras el intervalo configurado: lastPollAt debe avanzar y el atraso de cola tener explicación. HTTP health sólo acredita proceso/SELECT 1, no entrega webhook ni workers de otras instancias. Consultar resumen existente del cliente si hace falta acotar cola; ningún POST de rescate/redelivery en este diagnóstico.

Operación entrega conteos sanitizados por code/status de una ventana corta acordada (5xx, `PREQUOTE_CONSUMPTION_UNAVAILABLE`, `PREQUOTE_CONSUMPTION_LIMIT`, `DELIVERY_QUOTE_ACCEPT_FAILED`, fallos webhook), requestId y IDs públicos de los casos #85/#86/#89/#90 cuando estén disponibles. No cuerpos, contactos, consentimientos ni referencias bancarias. Demostrar alertas y responsable; no basta ausencia de logs.

### 5. Recuperación y decisiones (evidencia, no comandos destructivos)

Entregar fecha/resultado del último respaldo y ensayo de restauración aislada, manifiesto compatible de rollback, recuperación segura de master key y responsable. Confirmar estrategia de deduplicación y generación por pedido de Coita, retención del consentimiento y política comercial de atención/cancelaciones/devoluciones. No realizar restauración en QA/producción para completar esta revisión.

## Condiciones del piloto y reversión

Sólo reclasificar a LISTO PARA PILOTO cuando se satisfagan los bloqueos anteriores o una autoridad identifique explícitamente qué riesgo acepta y por qué; este informe **no acepta ninguno**. Definir volumen, duración, canales/ejecutores habilitados, latencia/margen, presupuesto y responsable de parada; no inventar cifras operativas.

Ante permisos 401/403: corregir acceso mediante responsable, sin crear sucesores ni retry ciego; 404 no confirma cancelación. Configuración 503: intervención, sin repetir en bucle ni cambiar keys. 429: Retry-After con backoff acotado/jitter, sin asumir que habrá cuota. Respuesta perdida/5xx incierto: misma key/intención, consulta del recurso y reconciliación; nunca doble envío como recuperación. Consentimiento nuevo tras renovación aunque precio igual o menor.

Plan de suspensión **para ejecución futura autorizada**: frenar nuevas generaciones en Coita; detener entrada de creaciones y poner flags pertinentes false en todas las instancias, drenar trabajo iniciado y evitar emisores viejos. Flags por proceso no revocan transacciones comprometidas. Conservar lecturas/replay autenticado, cancelaciones y tratamiento de servicios abiertos; no bloquear recuperación con una regla indiscriminada de POST. Mantener polling de webhooks necesario para cierre, salvo incidente específico con plan alterno. No borrar cuotas, ledger, MPQ, atestaciones ni Outbox. Cambiar/revertir fingerprint A5 requiere protocolo coordinado bajo lock, no sólo editar variables.

Reversión de aplicación: artefacto compatible con C/D y esquema conservado; no binario pre-C ni triggers B absolutos. Aceptación, entrega física y cobro efectivo siguen separados. Devoluciones de comida/envío se atienden por el acuerdo comercial externo, sin alterar refunds de créditos existentes ni prometer dinero devuelto por cancelar MDR.
