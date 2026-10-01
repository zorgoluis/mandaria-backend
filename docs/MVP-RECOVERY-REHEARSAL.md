# Piloto — ensayo de recuperación

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


### Clave recuperada y redirección frontend

Evidencia del propietario: frontend reiniciado una vez después del backend, Up 5 seconds health starting, GET HTTP loopback devuelve 308 (redirección, no página HTTPS final). Descifrado read-only en memoria sobre copia: checked=1, decrypted=1, failed=0, verified=true usando clave recuperada y helper existente. Acredita compatibilidad de clave con el secreto de la copia; no custodia externa independiente ni HMAC remoto/Coita. Falta HTTPS local con dominio correcto, consistencia acotada y tiempos/antigüedad exactos. Se pregunta dominio para --resolve loopback; no DNS/producción.


### Backend recuperado en clon

Propietario ejecuta override sólo en clon: compose up backend Healthy en 6.0 s; después backend Up 11 s healthy, PostgreSQL/Redis Up 11 min healthy, frontend aún Restarting (1). GET local /health devuelve status ok y database up. Recuperación parcial de aplicación acreditada con adaptación de IP y entrypoint directo; no arranque estándar ni integridad de negocio aún. Próximo: un reinicio controlado frontend ahora que existe upstream y descifrado en memoria de ciphertext del clon mediante helper existente, sin env/secretos/salidas externas.


### Diagnóstico confirmado del arranque

Causa confirmada por State.Error del clon: backend no arranca porque Docker intenta publicar 10.120.0.3:3000/tcp y esa IP no está asignada en clon (cannot assign requested address). Frontend muestra 19 ocurrencias de host not found in upstream; falta identificar upstream, compatible con backend ausente pero no confirmado aún. No defecto de producto ni corrupción demostrado. Ajuste mínimo propuesto sólo en clon: publicación loopback o IP propia según Compose real, desactivar polling automático en override de ensayo y conservar firewall; primero identificar archivos/servicio Compose sin exponer configuración completa.


### Lectura del primer arranque

Salida SSH del propietario, 2026-10-01 06:55:06 UTC: hostname mandaria-restore-test e interfaces coinciden con clon. PostgreSQL postgres:17-bookworm y Redis redis:7-alpine Up 5 minutes (healthy); backend mandaria-backend:latest Exited (255), frontend mandaria-frontend:latest Restarting (1). Recuperación de aplicación NO acreditada; causa desconocida, no atribuir a firewall/RAM/snapshot sin diagnóstico. No reinicios ni salidas autorizados en este paso. Siguiente: metadatos de estado y lectura acotada de migraciones de la copia, sin secretos.


## Avance del ensayo

Clon activo confirmado por captura del propietario: mandaria-restore-test en SFO2/sfo2-vpc-01, snapshot ubuntu-s-mandaria-1790834827410. Networking muestra firewall mandaria-restore-isolated, entrada SSH desde una sola IP y tabla de salida sin reglas visibles. Se retoma ensayo tras aceptación del coste temporal; eliminar únicamente clon al concluir, no producción/snapshot. Esto acredita configuración mostrada actual, no prueba ausencia de tráfico desde primer arranque ni recuperación PostgreSQL. Próximo paso: SSH del propietario al clon, identidad/red y listado acotado de contenedores; no abrir salidas.


VPC verificada visualmente (2026-10-01): sfo2-vpc-01, 10.120.16.0/20, sin recursos, peering, partner attachments ni NAT gateways. Candidata para clon; default-sfo2 conserva 2 recursos. Falta firewall previo a creación: preparar etiqueta exclusiva y SSH restringido, sin salidas generales; comprobar reglas efectivas y ausencia de otros firewalls permisivos. No se creó recurso. Documentación oficial confirma asignación de firewall por tag al crear Droplet; captura no acredita firewall todavía.


**Segunda captura 2026-10-01:** identifica `ubuntu-s-mandaria`, región SFO2, y snapshot listado `ubuntu-s-mandaria-1790834827410`, tamaño mostrado 15.87 GB, creado «hace 2 minutos» al capturar. Hay un snapshot candidato para ensayo; backups automáticos diarios aún indican ninguna copia disponible. El tamaño mostrado del snapshot no acredita tamaño mínimo del disco de destino. Fecha UTC exacta, ID de imagen, consistencia recuperable, destino y aislamiento previo pendientes. No se ha creado/restaurado ningún recurso por el agente. Esta evidencia supera la falta de identidad/copia candidata de la captura anterior, conservada abajo.


**Captura aportada 2026-10-01:** pantalla muestra Automated Daily Backups enabled, ventana diaria 00:00–04:00 UTC, No backups available y próximo inicio estimado dentro de 17 horas respecto al momento de la captura. No muestra identidad del Droplet, copia completada, retención ni tamaño del disco. Frecuencia diaria visible; declaración anterior de semanal/copia «hoy» no describe esta pantalla. No se infiere eliminación de copias ni cambio de plan; confirmar que corresponde a Mandaria. Aún no hay copia visible para el ensayo. RPO/RTO 24 h continúan sin acreditar; programación diaria no equivale a copia completada ni garantiza por sí sola esos objetivos.


Fecha: 2026-10-01. **PREPARACIÓN; restauración no ejecutada.** El usuario solicita cerrar el pendiente de recuperación. No autoriza restaurar sobre principal ni habilitar servicios externos. Modalidad confirmada: backup de Droplet en DigitalOcean, pasos ejecutados por el propietario. Copia exacta/destino por identificar. Objetivos confirmados por el propietario: pérdida máxima de datos (RPO) de 24 horas y tiempo máximo para recuperar servicio (RTO) de 24 horas. Son objetivos, no resultados acreditados.

## Primer paso y dependencias

Confirmar modalidad disponible: backup de Droplet en cuenta del propietario o copia PostgreSQL local. Registrar ID/nombre del respaldo, fecha/hora UTC exacta, estado completado y versión PostgreSQL; no copiar credenciales, datos personales ni `.env` en este informe. La VM reportada utiliza PostgreSQL 17; no abrir su directorio físico con PostgreSQL 18. Una restauración lógica requiere herramientas compatibles con el formato y versiones, verificadas antes de ejecutarla.

El propietario confirmó RPO de 24 horas y RTO de 24 horas. Medir recuperación hasta servicio utilizable, no sólo hasta arranque de PostgreSQL. Una cadencia semanal no garantiza un RPO de 24 horas; el ensayo mide recuperabilidad de la copia elegida, no asegura futuras copias.

## Destino seguro antes de restaurar

- Usar destino nuevo y diferenciado, nunca Restore sobre el Droplet principal. Crear desde backup tiene coste de infraestructura que debe quedar concreto antes de aprovisionar.
- Aislar entrada pública y salida a Coita, correo, Google y demás servicios **antes del primer arranque**. Una imagen puede reiniciar backend/workers automáticamente; detenerlos después no evita una primera salida. No basta quitar DNS ni cerrar sólo puertos de entrada. Verificar también acceso a redes privadas/producción.
- No emitir aquí comando de creación hasta conocer destino y mecanismo de aislamiento previo. Si no se puede acreditar, escoger otro mecanismo de recuperación aislada.
- Sin Docker local. Para imagen de Droplet, el propietario operará su cuenta con procedimiento específico posterior. No modificar firewall/DNS/servicios del original.
- Copia restaurada tratada como sensible: acceso restringido, sin commits/uploads al repositorio y retención/eliminación acordada al finalizar.

## Comprobaciones del ensayo (pendientes de ejecución)

1. Registrar inicio, identidad del destino y copia elegida. Recuperar datos sin migraciones, reset ni seed; verificar que PostgreSQL arranca y permite lectura.
2. Comparar migraciones/checksums con la **revisión correspondiente a esa copia**, no exigir migraciones posteriores a su fecha. Registrar conteos y comprobaciones de consistencia acordadas sin exportar filas personales. La consistencia económica requiere más que SELECT 1; verificar ledger/cuentas y vínculos operacionales con consultas de lectura acotadas sobre la copia.
3. Recuperar configuración desde su custodia autorizada. Inventario de disponibilidad, no valores: conexión al destino aislado, JWT_ACCESS_SECRET, JWT_REFRESH_SECRET, INTEGRATION_JWT_SECRET, B2B_WEBHOOK_SECRET_KEY; parámetros operativos y credenciales de terceros según proveedores usados. No sustituir claves silenciosamente ni activar proveedores externos para probarlas.
4. Probar en memoria y sin AppModule que la clave recuperada permite descifrar los `B2bWebhookEndpoint.secretCiphertext` de la copia. Reutilizar `masterKey`/`decryptSecret` de `src/b2b-webhooks/webhook-secret.ts`; emitir sólo total comprobado/éxitos/fallos, nunca secretos, ciphertext, firmas o cuerpos. Con cero secretos almacenados la compatibilidad de la clave queda no comprobada; una prueba sintética no la sustituye. No rotar ni enviar webhooks.
5. Comprobar servicio aislado con emisores deshabilitados y bloqueo de red mantenido, sólo después de revisar el procedimiento concreto. No aceptar/cancelar/entregar servicios reales. `B2B_WEBHOOK_POLL_SECONDS=0` desactiva el bucle automático según código; no sustituye bloqueo de red ni evita por sí solo envíos manuales. Los overrides del ensayo no son cambios operativos en el original.
6. Registrar fin, tiempo de recuperación, fecha efectiva de datos recuperados, limitaciones y diferencias respecto a objetivos aprobados. Un backend accesible sin configuración/clave recuperables no completa el ensayo.
7. Detener destino y acordar conservación o eliminación segura. No borrar la única copia de recuperación ni publicar evidencia sensible.

## Evidencia mínima para cerrar

| Dato | Estado |
|---|---|
| Copia exacta y fecha UTC | Pendiente |
| Destino y aislamiento previo al arranque | Pendiente |
| Objetivos de pérdida de datos / tiempo | RPO 24 h y RTO 24 h confirmados; cumplimiento no acreditado |
| Restauración PostgreSQL y consistencia | No ejecutadas |
| Configuración recuperable y custodio | Pendiente |
| Descifrado de secretos existentes | No ejecutado |
| Recuperación de aplicación aislada | No ejecutada |
| Tiempo y antigüedad medidos frente a objetivos | No medidos |
| Limpieza/retención del destino | No creado |

Comprobar este ensayo no autoriza piloto: quedan los otros pendientes operativos del informe de cierre.

## Base de esta preparación

Inspección estática: `src/config/environment.ts` exige clave maestra en producción; `src/b2b-webhooks/webhook-secret.ts` utiliza AES-256-GCM con clave de 32 bytes representada en hex/base64; Prisma conserva ciphertext, no la clave maestra. Sin nuevas pruebas, lecturas DB ni acceso a `.env`.

Documentación oficial consultada el 2026-10-01: [crear un Droplet desde un backup](https://docs.digitalocean.com/products/backups/how-to/create-and-restore/) permite destino nuevo y exige disco al menos del tamaño de origen; Restore sobre existente reemplaza sus datos. [Reglas de firewall](https://docs.digitalocean.com/products/networking/firewalls/how-to/configure-rules/) como referencia para diseñar aislamiento; no se ha acreditado ni aplicado una configuración concreta.

### Siguiente acción del propietario (sólo lectura)

En DigitalOcean, abrir Droplet → Backups y anotar fecha/hora de última copia completada, frecuencia configurada, retención visible y tamaño de disco original. No pulsar Restore ni Create Droplet aún: falta concretar aislamiento desde primer arranque y coste/destino. Aportar sólo esos metadatos, sin claves o configuración privada. Una frecuencia semanal no cumple por sí sola un límite de 24 h de pérdida de datos; protección adicional o cambio de frecuencia requiere decisión y autorización separadas.

## Crear etiqueta sin doctl (preparado, no ejecutado)

Firewall mandaria-restore-isolated creado por propietario: captura muestra 1 regla y 0 Droplets. Selector no permite crear etiqueta; doctl no disponible. Preparado scripts/create-restore-tag.ps1 para ejecución manual: token oculto, scopes tag:read/tag:create, GET etiqueta y POST sólo si falta, sin asignaciones ni operaciones de Droplet/firewall. Sintaxis PowerShell aprobada; API no ejecutada por agente. Falta crear/verificar etiqueta sin recursos y asociar firewall antes del clon.

Ejecutar manualmente desde PowerShell el archivo `scripts/create-restore-tag.ps1`. Usar token temporal con `tag:read` y `tag:create`; introducirlo sólo en el prompt oculto, nunca en argumentos/chat/archivos. Revocarlo al terminar. El script no garantiza borrado absoluto de strings administrados en memoria; no serializa credenciales ni imprime errores HTTP completos. Verificar que etiqueta no tiene recursos antes de seleccionarla en firewall.

Referencias: [scopes tag:create](https://docs.digitalocean.com/reference/api/scopes/tag/create/), [API tags](https://docs.digitalocean.com/reference/api/reference/tags/).

## Migraciones y contenedores — salida aportada

Lecturas del propietario en clon: _prisma_migrations total 29, finalizadas 29, sin finalizar 0. Backend exit 255, OOMKilled=false, restartCount=0, policy unless-stopped; StartedAt 2026-09-30T15:28:01.787381109Z (anterior al clon), FinishedAt 2026-10-01T06:49:43.400392051Z. No acredita intento nuevo de aplicación al restaurar. Frontend restartCount=14, exit 1, OOMKilled=false, policy unless-stopped. Falta State.Error/causa de fallo; no inferir RAM, firewall, corrupción o defecto de producto. La lectura de migraciones no prueba integridad completa ni descifrado de clave.

## Adaptación mínima propuesta para arranque de aplicación

Metadatos Compose aportados: proyecto mandaria-prod, directorio /opt/mandaria, archivo /opt/mandaria/docker-compose.yml, servicios backend/frontend; Compose 5.5.1. Se propone override exclusivo /opt/mandaria/compose.restore-test.yml: fijar imagen al ID del backend existente, reemplazar puertos (!override) por 127.0.0.1:3000:3000, entrypoint node dist/main.js y command vacio para no correr migraciones/seed, B2B_WEBHOOK_POLL_SECONDS=0. El entrypoint del repositorio ejecuta migrate deploy y seed opcional; se evita deliberadamente en ensayo. Esto acredita recuperación con adaptación de red/arranque si pasa, no arranque original intacto. Crear sólo backend con --no-deps --no-build --pull never; DB/Redis no recreados. Procedimiento preparado para propietario, no ejecutado todavía.

Referencias: [merge Compose](https://docs.docker.com/reference/compose-file/merge/), [compose up](https://docs.docker.com/reference/cli/docker/compose/up/). Se conserva aislamiento y no se autorizan operaciones comerciales reales.
