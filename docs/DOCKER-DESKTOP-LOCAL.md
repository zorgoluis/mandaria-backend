# Backend aislado en Docker Desktop

2026-10-03. Uso de Docker autorizado explícitamente por el propietario para esta PC. No es despliegue remoto. Compose independiente: `compose.desktop-local.yml`; no modificar ni usar el Compose operativo ni el `.env` habitual para este entorno.

## Conexión FRONTEND

- Origen: `http://127.0.0.1:43130`.
- API: `http://127.0.0.1:43130/api/v1`; salud: `/health`; Swagger local: `/docs` (JSON `/docs-json`).
- **VITE_API_URL=http://127.0.0.1:43130**, sin `/api/v1`: el frontend actual añade ese prefijo. Reiniciar Vite al cambiar su configuración; esta tarea no modifica frontend.
- CORS permite exactamente `http://localhost:5173`, `http://127.0.0.1:5173`, `http://localhost:4173` y `http://127.0.0.1:4173`. Usar uno de esos orígenes; no hay wildcard.
- Login humano POST `/api/v1/auth/login`, body email/password; access token Bearer. No poner contraseñas/tokens en URL, logs o documentación.
- Cuentas sintéticas: `admin@mandaria-local.test`, `admin-backup@mandaria-local.test` (SUPER_ADMIN), `provider@mandaria-local.test` (PROVIDER_ADMIN de flotilla sintética), `driver@mandaria-local.test` (DRIVER de esa flotilla).
- Las contraseñas independientes están **sólo** en `.tmp/docker-desktop-local/accounts.json`, ignorado por Git: abrir privadamente en el editor local. No publicar/copiar ese archivo al frontend ni al repositorio. Secretos de infraestructura generados de cero en `.tmp/docker-desktop-local/runtime.env`, también ignorado; no imprimir `docker compose config` ni inspeccionar/publicar todo el environment.

## Iniciar, detener y consultar

Desde la raíz del backend, PowerShell:

```powershell
docker compose --env-file .tmp/docker-desktop-local/runtime.env -f compose.desktop-local.yml up -d --wait --wait-timeout 180
docker compose --env-file .tmp/docker-desktop-local/runtime.env -f compose.desktop-local.yml ps
docker compose --env-file .tmp/docker-desktop-local/runtime.env -f compose.desktop-local.yml stop
```

`stop` conserva los volúmenes y las cuentas. Volver a `up` inicia los mismos recursos **de este entorno**. Para reconstruir tras cambios de código, añadir `--build` al `up`; las migraciones se aplican al inicio. No usar `down -v`, prune, reset ni comandos globales de eliminación. No usar otros nombres de proyecto para reutilizar estos volúmenes ni conectarlos a otro backend.

Proyecto: `mandaria-local-20261003-execution`. Volúmenes propios `mandaria-local-20261003-execution_pgdata` y `_mail_outbox`. Red propia `_isolated` con `internal: true`: sin salida externa desde los servicios. Puertos publicados sólo en loopback. PostgreSQL host `127.0.0.1:55440`, base `mandaria_desktop_local`, usuario `mandaria_local`; contraseña sólo en runtime.env. **Frontend nunca conecta a PostgreSQL**.

Docker Desktop no publicó los puertos cuando los servicios estaban únicamente en la red interna. El servicio `gateway` conecta `_ingress` e `_isolated` y publica los dos puertos; reenvía exclusivamente HTTP a `backend:3000` y TCP a `postgres:5432`. No es un proxy hacia destinos arbitrarios y no recibe secretos. Backend/PostgreSQL sólo están en `_isolated`; se verificó ausencia de ruta default del backend. Esta separación permite acceso desde Windows sin dar salida directa al proceso de aplicación.

La imagen usa Dockerfile existente, dependencias y Prisma Client Linux. El entrypoint local aplica `prisma migrate deploy` y arranca `dist/main.js`; no ejecuta seed productivo ni seeds de desarrollo preexistentes. Las imágenes y dependencias se descargan durante build; la red interna restringe ejecución, no las descargas de construcción.

## Datos y seguridad local

`DETAILED_EXECUTION_ENABLED=true` sólo en este Compose. Correo `local_outbox` (archivos privados en volumen propio); `B2B_WEBHOOK_POLL_SECONDS=0`, sin endpoints B2B configurados; routing `local_fake`, sin clave Google/Resend. Las precotizaciones/conversión/aceptación autorizada continúan deshabilitadas explícitamente. No se copian secretos ni datos productivos.

Preparación inicial realizada por `scripts/seed-desktop-local.cjs`: recibe credenciales por stdin, valida desarrollo/host/base exactos, crea cuentas y membership/perfil sintéticos sin imprimir contraseñas. En el volumen de correo nuevo se asigna propiedad uid/gid 1000 para el usuario node de la imagen. No se modifica propiedad de volúmenes ajenos.

La preparación inicial no incluía operación. La ampliación del 2026-10-03 descrita abajo añade fixtures operativos exclusivamente sintéticos mediante APIs. No se habilita producción.

Resultados de arranque y verificaciones nuevas: VERIFICATION.md. Los ensayos PostgreSQL/E2E anteriores son históricos, no pruebas ejecutadas en Docker.

## Recorridos operativos sintéticos — 2026-10-03

Desde la raíz, con el entorno iniciado, Node local y Docker Desktop accesible:

```powershell
node scripts/prepare-desktop-execution-fixtures.mjs
```

El preparador comprueba etiquetas del proyecto, contenedores, base/usuario/host, volumen, red interna, publicación loopback y flags antes de escribir. Todas las altas/configuraciones y operaciones se realizan por API: invitaciones y activación leyendo exclusivamente el buzón simulado, zona, tarifa, cobertura, políticas, recarga, solicitudes, cotizaciones, aceptación, claim, asignación, hitos e incidencias. No escribe SQL, no fuerza ledger/custodia ni relaja restricciones. No requiere reconstruir la imagen para ejecutar el script desde Windows.

**Ejecutarlo sin otros operadores usando este entorno.** Para crear por primera vez el caso legacy, recrea sólo backend con una sobreescritura temporal de admisión `DETAILED_EXECUTION_ENABLED=false`, asigna por API y restaura `true` en `finally`. Eso utiliza la compatibilidad legacy real; no borra historial ni desactiva constraints. Produce una breve interrupción local. El caso sigue pagando los 7 créditos normales; legacy aquí significa ejecución sin hitos, no exención económica. Si el proceso se mata en esa ventana, ejecutar el `up` habitual de arriba (sólo Compose base) para restaurar true antes de continuar. Las ejecuciones posteriores completas no recrean backend.

### Datos disponibles

- Flotilla `DESKTOP_SYNTHETIC`, ACTIVE, límites 5 Drivers/5 Vehicles; administrador OWNER existente.
- Zona `DESKTOP_EXECUTION`, ACTIVE, geometría ficticia; routing `local_fake`. No realizar viajes a las coordenadas de estos ejemplos.
- Tarifa LOCAL_DELIVERY: 55.00 MXN, banda 0–100000 metros, cotización 60 minutos.
- Políticas FLAT activas: 7 créditos para PROVIDER y 7 para INDEPENDENT_DRIVER; la segunda permite construir ambos snapshots, sin crear independientes para estos recorridos.
- Recarga ficticia única +1000 (`OTHER`, referencia `DESKTOP-EXECUTION-INITIAL`), cuatro adjudicaciones API de -7: saldo inicial de ensayo **972**. No dinero real.
- Cliente B2B `DESKTOP_EXECUTION`, completamente sintético; scopes deliveries:create/read y quotes:create/read/accept. Sin endpoints webhook; worker apagado.
- Cinco Drivers activos y cinco motos activas emparejadas; cuatro asignaciones de entrega ACTIVE y una pareja receptora libre.
- Solicitudes directas PREPAID, mercancía ficticia 100.00 MXN, envío cotizado 55.00 MXN. No son conversiones V1.13 ni una prueba de Coita. PREPAID describe comida, no confirma cobro del envío.

### Qué abrir y con qué cuenta

| Recorrido | Solicitud / cotización | Estado preparado | Operador web / siguiente paso |
| --- | --- | --- | --- |
| Cinco hitos y entrega | MDR-000001 / MQ-000001 | Asignada, detallada, sin primer hito, revisión 1 | `provider@mandaria-local.test`: camino a recogida → llegada a recogida → recogido → camino a destino → llegada a destino → entrega existente. Moto LOCAL-NORMAL. |
| Incidencia y devolución | MDR-000002 / MQ-000002 | PICKED_UP, HELD, incidencia OPEN, revisión 5 | `admin@mandaria-local.test` (SUPER_ADMIN): resolución RETURN_TO_ORIGIN, motivo y confirmaciones físicas **simuladas** del custodio/origen; resultado esperado RETURNED, nunca DELIVERED. Moto LOCAL-RETURN. |
| Transferencia | MDR-000003 / MQ-000003 | PICKED_UP, HELD, incidencia OPEN, revisión 5 | SUPER_ADMIN: elegir receptor Sintetico recipient / LOCAL-RECIPIENT de la misma flotilla y documentar confirmaciones simuladas. Después PROVIDER_ADMIN continúa TO_DROPOFF → AT_DROPOFF → entrega, sin fingir otra recogida. |
| Consulta legacy | MDR-000004 / MQ-000004 | Asignada sin proyección execution ni hitos inventados | PROVIDER_ADMIN consulta su servicio/historial (LOCAL-LEGACY); SUPER_ADMIN audita. No consumir este caso entregándolo si sólo se quiere consultar. |

Los casos de incidencia ya están reportados por el PROVIDER_ADMIN con identidad propia y origen PHONE_REPORT. El operador puede consultar las incidencias pero no resolverlas; la resolución excepcional corresponde a SUPER_ADMIN. `admin-backup@mandaria-local.test` puede usarse como segundo administrador conforme a las restricciones del contrato de reconciliación; no puede consultar intentos privados ajenos. Las confirmaciones en estos ejercicios son simulación, no evidencia de operación física real ni de pago.

Repartidores: `driver@mandaria-local.test`, `driver-return@mandaria-local.test`, `driver-transfer@mandaria-local.test`, `driver-legacy@mandaria-local.test`, `driver-recipient@mandaria-local.test`. Son DRIVER de flotilla: reportan al operador; **no usar sus cuentas para registrar hitos**. Las cuatro cuentas adicionales se activaron por invitación/API, sin insertar usuarios por SQL en esta ampliación. Contraseñas nuevas sólo en el archivo privado `accounts.json` ya indicado; no publicarlas.

IDs de despacho para localizar los detalles desde los listados/API:

| Caso | Dispatch.id |
| --- | --- |
| Normal | `5aeb0458-b2e2-4a57-b5a0-fd9798bf9b6b` |
| Devolución | `f8b1e09b-0ec2-483d-b6ac-d36a1afd25a1` |
| Transferencia | `33d86e94-a345-4742-83ce-1d982e950051` |
| Legacy | `00ca21f2-4e3c-4f2b-bed0-10c552cefebc` |

Receptor libre: Driver `7acd6bfd-3197-48fe-bee4-5816dad93339`, Vehicle `4059a859-d6e3-4f62-9e92-58dcec34e25c`, provider `315161b6-f4b2-4c47-a14e-06975d0ef52a`. Consultar candidatos otra vez antes de confirmar: la elegibilidad puede cambiar al usar la web. Obtener membership/identidad del administrador receptor mediante APIs; no suplantar actores. Contratos completos en [handoff ejecución](DETAILED-EXECUTION-HANDOFF.md) y [reconciliación](EXECUTION-ATTEMPT-RECONCILIATION.md).

### Repetición y límites

Conservar `.tmp/docker-desktop-local/operational-fixtures.json`: referencias, avance de preparación y claves estables de idempotencia. `fixture-credential.json` es privado (Client Secret sólo local). No borrar estos archivos para volver a ejecutar. El preparador usa búsquedas por identidades sintéticas, guarda avances y no recrea casos listos ni rebobina el progreso realizado desde web. Usa un lock local para impedir dos preparadores concurrentes. Si hubo terminación abrupta, comprobar que no queda proceso antes de retirar únicamente ese lock. Si falta el manifiesto pero existe la integración, se detiene en vez de duplicar solicitudes. Un resultado incierto al crear una credencial requiere revisión privada, no genera otra automáticamente.

Respeta throttling: espera Retry-After una sola vez cuando el servidor lo proporciona; si persiste, se detiene. Ante timeout no idempotente, revisar el manifiesto y las consultas antes de reintentar; no resetear ni borrar recursos. Tras consumir los cuatro escenarios, repetir **no** fabrica pedidos nuevos: preparar un conjunto nuevo sería otra solicitud explícita.

Verificado por API/lecturas PostgreSQL: cuatro servicios distintos, tres ejecuciones detalladas, dos incidencias pendientes, receptor elegible, historial económico y repetición sin duplicados. Los cierres se dejaron pendientes deliberadamente para practicar desde Web. No se realizó prueba visual frontend ni se acredita aquí la resolución/entrega completa. Evidencia resumida: [fixtures locales](checks/desktop-execution-fixtures.json).
