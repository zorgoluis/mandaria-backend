# Actualización y revisión de cuentas Negocio

Preparado el 2026-10-13. Procedimiento para ejecución posterior autorizada; no acredita despliegue ni inventario de la VM. Backend de referencia QA `9ad39b9`, Web local `2e59504`, Landing local `7ba3a36`. El propietario informa publicada la etapa 2.

## Evidencia nueva

- Trece comprobaciones integradas completas: aceptación desde Web de un servicio comprometido antes de revocación; seguimiento y términos preservados; bloqueo de nueva precotización; aprobación deshabilitada con servicio abierto y rechazo HTTP409 al intentar saltarla; registro y confirmación mediante enlace real de buzón local; aislamiento de un intento al cambiar de cliente, conservación tras logout y cierre por el titular al regresar.
- HTTP, PostgreSQL y Web reales en entorno aislado. Routing y presupuesto fueron sustituidos para fixtures; no acredita Google, Resend ni recepción en bandeja externa. El registro no fue una inserción directa: formulario, challenge y consumo de token reales con local_outbox.
- Migración limpia46 y actualización45→46 reconstruida en copia sintética: tres cuentas comprobadas, once tablas operativas/económicas idénticas, ninguna solicitud/grant fabricado; nueva demanda bloqueada y aceptación comprometida HTTP200.
- Respaldo custom y restauración en una base nueva: cantidades y huellas idénticas de66 tablas. Es un ensayo sintético, no un respaldo de producción.
- Inventario Docker local:46 migraciones, seis cuentas Personal/NONE y cero lifecycle abiertos. La migración comercial ya está aplicada allí; no hay cuentas BUSINESS heredadas locales que revisar. No extrapolar a la VM.

Evidencia: [informe estructurado](checks/business-approval-stage1-rollout.json). Las29 comprobaciones de la tarea anterior se conservan como evidencia separada; no sumarlas como una única suite.

## Preparación de producción

1. Registrar versiones exactas de backend, Web, Landing y esquema del entorno destino. Confirmar que Web usa el contrato comercial y que Landing compila con el origen correcto. Identificar SUPER_ADMIN responsable, contacto operativo, ventana de intervención y comunicación a los clientes existentes.
2. Inventariar en sólo lectura tipos de cuenta, servicios abiertos, conversiones comprometidas, migraciones aplicadas/fallidas y procesos escritores. No exportar correos, tokens ni notas a documentación pública. Conservar un inventario privado de IDs/revisiones y compromisos para comparar después.
3. Si falta la migración comercial, confirmar toda la cadena previa; este ensayo cubre45→46. Un entorno en otra versión necesita validar sus migraciones intermedias antes de intervenir. Si ya está aplicada, no repetir SQL ni volver a poner cuentas aprobadas en revisión.
4. Crear un respaldo del destino con la herramienta/credenciales habituales del operador, fuera del repositorio, y restaurarlo en un destino aislado autorizado. Registrar integridad, tamaño, tiempos y restauración real. El ensayo sintético no sustituye este paso ni define RPO/RTO del servidor.
5. Preparar artefactos compatibles antes de la ventana. Retirar procesos backend antiguos y escritores/consumidores que puedan publicar cambios durante el corte; coordinar la pausa de ingreso y el impacto en GPS/operación. No ofrecer una promesa de cero interrupción. No usar un flag global de admisión como sustituto permanente de revisión comercial: puede afectar aceptación de servicios existentes.

Consultas orientativas, sólo lectura, para un esquema45 o46:

```sql
BEGIN TRANSACTION READ ONLY;
SELECT migration_name, finished_at, rolled_back_at
FROM "_prisma_migrations" ORDER BY started_at;
SELECT type, count(*) FROM "CustomerAccount" GROUP BY type;
SELECT c.type, count(*) AS open_lifecycles
FROM "DirectRequestLifecycle" l
JOIN "CustomerAccount" c ON c.id=l."customerAccountId"
WHERE l."closedAt" IS NULL GROUP BY c.type;
SELECT count(*) AS business_committed_before_cutover
FROM "CustomerAccount" c
JOIN "DirectRequestLifecycle" l ON l."customerAccountId"=c.id
JOIN "PrequoteConversion" pc ON pc."deliveryRequestId"=l."deliveryRequestId"
WHERE c.type='BUSINESS' AND l."closedAt" IS NULL;
COMMIT;
```

## Corte y comprobación

1. Con escritores detenidos, ejecutar el mecanismo normal de despliegue de migraciones del artefacto aprobado. No ejecutar reset, seed de producción ni SQL manual de aprobación. La migración comercial es transaccional y toma locks exclusivos: medir la duración en el ensayo representativo, no inferirla de estas bases pequeñas.
2. Antes de reabrir tráfico, comprobar migración completada y comparar con el inventario anterior: BUSINESS existentes→REVIEW_REQUIRED y revisión+1; Personal conserva tipo/revisión; cero grants o solicitudes creadas por la migración; evidencia PRE_REVIEW_COMMITMENT para los lifecycle abiertos con conversión que calificaban antes del corte. Si el corte ya se ejecutó, las decisiones posteriores pueden haber cambiado esos estados: usar el snapshot inicial, no exigir REVIEW_REQUIRED indiscriminadamente.
3. Comparar historiales, términos, cotizaciones, conversiones, aceptaciones, créditos/ledger, outbox e idempotencia. Conservar TTL original; no extender cotizaciones para superar la intervención. No concluir que una cotización vencida cancela un servicio ni libera su cupo.
4. Publicar backend y Web compatibles sin escritores antiguos; publicar Landing con VITE_WEB_URL correcto. Las variables VITE se incorporan al compilar. Verificar origen API, CORS, login, perfil y acceso comercial con una cuenta controlada; no realizar operaciones reales de entrega sólo para obtener una prueba.
5. Confirmar que revisión comercial bloquea nuevas MPQ/conversiones pero no oculta historial, tracking, recuperación ni autorización vigente de un compromiso anterior. Si no existe una cuenta de ensayo segura, programar una prueba controlada: no escoger arbitrariamente un envío de un cliente.

## Operación manual por SUPER_ADMIN

- Informar a los titulares BUSINESS heredados que deben presentar solicitud desde `/customer/business`. El corte no crea solicitudes pendientes por ellos: una bandeja vacía no demuestra que todas las cuentas hayan sido revisadas. Usar el inventario privado para seguimiento.
- Revisar formulario y decidir desde Web. Sólo SUPER_ADMIN puede aprobar/rechazar; aprobar requiere cero lifecycle abiertos, incluidos convertidos aún sin aceptar. No cancelar servicios para forzar una aprobación.
- Con servicios abiertos, esperar su cierre normal. No queda una aprobación parcial programada ni se activa automáticamente después.
- Rechazo requiere motivo público; nota interna no debe llegar al cliente. El rechazo no convierte automáticamente la cuenta heredada a Personal. Descenso exige acción explícita y cero abiertas.
- Tras rechazo/retiro, el titular puede presentar una nueva solicitud, respetando rate limit. Tras revocación administrativa se requiere habilitación SUPER_ADMIN, incluso si ya descendió a Personal. Esa habilitación permite solicitar, no reactiva Negocio.
- Ante respuesta perdida, recuperar el intento original y estado vigente. No cambiar de clave a ciegas ni editar recibos/grants por SQL.
- Revisar diariamente pendientes y cuentas heredadas sin solicitud durante el periodo de transición; responsable y plazo de atención deben acordarse antes de comunicar una fecha. No prometer SLA aún no definido.

## Incidentes y reversión

Si falla antes de completarse la transacción, mantener cerrado el ingreso de escritores, inspeccionar el registro de migración y preparar reparación. No marcarla aplicada ni usar migrate resolve sin revisar la causa.

Si la migración terminó, no volver al backend que permite autoascenso ni eliminar tablas/historia comercial. Favorecer corrección hacia delante con una versión compatible. Una restauración del respaldo sólo puede hacerse tras autorización, con escritores detenidos y reconciliación de cambios posteriores; perdería datos aceptados después del respaldo y no es un rollback automático.

## Pendientes externos

- Inventario, respaldo/restauración representativa y actualización real de la VM.
- Responsables, ventana, comunicación y seguimiento de revisión manual.
- Entrega real de correo mediante Resend, si se quiere acreditarla, con destinatario controlado y autorización específica; local_outbox sólo demuestra el flujo funcional del enlace.
- GPS y aplicaciones Driver, capacidad y publicación del piloto siguen sus etapas; este trabajo no las declara terminadas.

No se ejecutaron comandos de producción ni se activaron flags. No commit, push ni despliegue en esta tarea.
