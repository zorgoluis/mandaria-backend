# Reinicio de la base Mandaria utilizada como QA

**2026-10-01 — PREPARADO, NO EJECUTADO.** Procedimiento para un operador autorizado en la VM. Ejecutar por etapas supervisadas, no pegándolo entero. No es un despliegue ni una restauración ya acreditada. No acceder a Coita desde estos comandos.

## Hallazgos del repositorio

- **29 migraciones**, hasta `20260929000100_authorized_quote_acceptance`: incluyen triggers/constraints de inmutabilidad, créditos, snapshots, outbox, precotizaciones y aceptación. No truncar tablas ni usar excepciones de purga de tests. Se perderá también la auditoría: respaldo obligatorio.
- `scripts/docker-entrypoint.sh` ejecuta `npx prisma migrate deploy`, reintenta hasta diez veces, opcionalmente bootstrap si `RUN_DB_SEED=true` y luego inicia la API. Para mantenimiento se debe sustituir el entrypoint y ejecutar migraciones explícitamente, sin reintentos que oculten un fallo.
- `prisma/seed.ts` sólo provisiona SUPER_ADMIN; `src/bootstrap-admin.ts` ofrece la variante compilada `dist/bootstrap-admin.js`. Validan email, contraseña de 16–128 caracteres y guardan Argon2id. Un admin activo existente queda intacto: **no recuperan ni cambian su contraseña**. Rechazan email de cuenta inactiva/no administradora. Este bootstrap es apropiado con credenciales reales nuevas y la imagen revisada.
- `db:seed:local` y `seed-local-{provider-admins,driver-users,pricing,credit-policies}` son **LOCAL/TEST ONLY**. No ejecutar, no retirar guardas ni trasladar usuarios/contraseñas/tarifas de ejemplo a producción. No existe un seed comercial completo de producción aprobado.
- Dockerfile conserva Prisma CLI y copia `dist` y `prisma/migrations`, pero elimina devDependencies y no copia `prisma.config.ts`. No asumir disponibilidad de tsx ni ejecutar `prisma db seed` dentro de esa imagen; usar el bootstrap compilado.
- Compose del checkout sólo declara postgres/backend; defaults incluyen **development/local_outbox**. La VM histórica tenía frontend/redis y proyecto `mandaria-prod` en `/opt/mandaria`. **Verificar el Compose efectivo**, no sustituirlo por el del checkout.
- Worker webhook reside en cada backend. `B2B_WEBHOOK_POLL_SECONDS=0` desactiva timer, pero **no** nudges ni envío manual. Detener todas las instancias y cerrar ingreso es necesario. Shutdown espera hasta lease; timeout de parada debe superar lease efectivo más timeout de envío y margen.
- No cliente Redis/Bull encontrado en src/dependencias. Colas/outbox, leases, idempotencia y presupuesto MPQ están en PostgreSQL. Redis de la VM no se borra ni se vacía sin evidencia de uso y propiedad de claves.
- MDR/MQ/MPQ usan secuencias que vuelven a 1 tras migrar. Se recomienda **preservar sólo los máximos de numeración**, no las filas QA, para evitar reutilizar referencias conocidas por clientes. Si se exige resetear también los números, detenerse hasta acordar un protocolo que evite confusiones externas. `externalReference` no garantiza unicidad.

Fuentes: `prisma/schema.prisma`, `prisma/migrations`, `prisma/seed.ts`, `src/bootstrap-admin.ts`, `src/config/environment.ts`, `src/b2b-webhooks/b2b-webhooks.service.ts`, `src/mail/mail.module.ts`, Dockerfile, Compose y entrypoint.

## 0. Gates obligatorios

Coordinar ventana y detener nuevos pedidos/reintentos del lado de integradores mediante el propietario, sin entrar a sus sistemas. Resolver pedidos/envíos/pagos abiertos: reiniciar Mandaria no cancela pedidos externos ni reembolsa dinero. Inventariar todas las réplicas, workers, cron y automatizaciones; impedir reinicios/despliegues concurrentes.

**Parar** por identidad incierta, escritores desconocidos, sesiones/transacciones preparadas sin explicar, respaldo no restaurado, claves no recuperables, falta de disco, migraciones/imagen desconocidas o negocio real pendiente sin reconciliar.

No usar `compose down`, `down -v`, `volume rm`, `system prune`, FLUSHALL/FLUSHDB, `prisma migrate reset`, `migrate dev`, `db push` ni purgas de ledger. No eliminar roles, volúmenes, servicios o bases ajenos.

La variante siguiente presupone PG17, base dedicada, locale libc, tablespace pg_default, ACL de base por defecto, sin settings específicos por base/rol, extensiones adicionales ni replicación lógica. Se comprueba antes. Si no se cumple, **adaptación DBA obligatoria** para conservar esas propiedades; no descartarlas silenciosamente.

## 1. Identificar VM, contenedores y base sin secretos

Comandos futuros en **Bash de la VM**. Nombres históricos candidatos, sujetos a comprobación. No ejecutar desde Windows.

```bash
set -euo pipefail
set +x
umask 077
BK=mandaria-backend
PG=mandaria-postgres
FE=mandaria-frontend
RUN="/root/mandaria-reset-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -m 700 "$RUN"
hostname
date -u
docker inspect "$BK" "$PG" "$FE" --format '{{.Name}} id={{.Id}} image={{.Image}} project={{index .Config.Labels "com.docker.compose.project"}} service={{index .Config.Labels "com.docker.compose.service"}} directory={{index .Config.Labels "com.docker.compose.project.working_dir"}} files={{index .Config.Labels "com.docker.compose.project.config_files"}}'
docker inspect "$PG" --format '{{range .Mounts}}type={{.Type}} name={{.Name}} destination={{.Destination}}{{println}}{{end}}'
pgsql() {
  local db="$1"; shift
  docker exec -i "$PG" sh -c '
    db=$1; shift
    exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$db" "$@"
  ' sh "$db" "$@"
}
docker exec -i "$BK" node > "$RUN/app-identity.json" <<'JS'
const {PrismaClient}=require('@prisma/client');
const db=new PrismaClient({log:[]});
(async()=>{
 try {
  const u=new URL(process.env.DATABASE_URL);
  const [r]=await db.$queryRawUnsafe(`SELECT current_database() AS database,
   current_user AS role, (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid,
   (SELECT system_identifier::text FROM pg_control_system()) AS system_id`);
  console.log(JSON.stringify({...r,host:u.hostname,port:u.port||'5432',schema:u.searchParams.get('schema')||'public'}));
 } catch {console.error('Identity verification failed; stop.');process.exitCode=1;}
 finally {await db.$disconnect();}
})();
JS
cat "$RUN/app-identity.json"
read -r -p 'Base Mandaria exacta confirmada: ' TARGET
[[ "$TARGET" =~ ^[A-Za-z][A-Za-z0-9_]*$ ]]
[[ "$TARGET" != postgres && "$TARGET" != template0 && "$TARGET" != template1 ]]
export TARGET RUN
python3 - <<'PY'
import json,os
x=json.load(open(os.environ['RUN']+'/app-identity.json'))
assert x['database']==os.environ['TARGET'] and x['schema']=='public'
PY
EXPECTED_OID=$(python3 -c 'import json,os; print(json.load(open(os.environ["RUN"]+"/app-identity.json"))["oid"])')
EXPECTED_SYS=$(python3 -c 'import json,os; print(json.load(open(os.environ["RUN"]+"/app-identity.json"))["system_id"])')
PG_ID=$(docker inspect -f '{{.Id}}' "$PG")
IMAGE=$(docker inspect -f '{{.Image}}' "$BK")
pgsql postgres -v target="$TARGET" -v oid="$EXPECTED_OID" -v sys="$EXPECTED_SYS" <<'SQL'
SELECT 1 / CASE WHEN EXISTS (
 SELECT 1 FROM pg_database WHERE datname=:'target' AND oid::text=:'oid' AND NOT datistemplate
) AND (SELECT system_identifier::text FROM pg_control_system())=:'sys'
THEN 1 ELSE 0 END AS identity_verified;
SELECT datname,oid,pg_get_userbyid(datdba) AS owner,datlocprovider,datcollate,datctype
FROM pg_database WHERE datname=:'target';
SELECT 1 / CASE WHEN EXISTS (
 SELECT 1 FROM pg_database d JOIN pg_tablespace t ON t.oid=d.dattablespace
 WHERE d.datname=:'target' AND d.datlocprovider='c' AND t.spcname='pg_default'
 AND d.datacl IS NULL AND d.datallowconn AND NOT d.datistemplate
) AND NOT EXISTS (SELECT 1 FROM pg_db_role_setting WHERE setdatabase=:'oid'::oid)
THEN 1 ELSE 0 END AS supported_metadata;
SHOW server_version;
SQL
```

Comparar VM/IP en panel, contenedores/volumen/proyecto, host/puerto de app con red PG y **system_id + OID + nombre**. No derivar objetivo sólo de POSTGRES_DB: podría estar obsoleto. Si identidad/privilegios/autenticación falla, detenerse; no ampliar privilegios ni cambiar pg_hba automáticamente. Esta variante usa el rol de mantenimiento local POSTGRES_USER: verificar que puede leer/restaurar/crear/eliminar esa base. No imprimir DATABASE_URL, .env, variables completas, queries de sesiones o Compose expandido.

```bash
pgsql "$TARGET" <<'SQL'
SELECT 1 / CASE WHEN NOT EXISTS (
 SELECT 1 FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname NOT IN ('public','information_schema')
) AND NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname <> 'plpgsql')
AND NOT EXISTS (SELECT 1 FROM pg_subscription)
AND NOT EXISTS (SELECT 1 FROM pg_publication)
THEN 1 ELSE 0 END AS supported_contents;
SELECT count(*) AS migrations,
 count(*) FILTER(WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) AS finished,
 count(*) FILTER(WHERE finished_at IS NULL AND rolled_back_at IS NULL) AS unfinished
FROM "_prisma_migrations";
SQL
pgsql postgres -At -v target="$TARGET" > "$RUN/create-target.sql" <<'SQL'
SELECT format('CREATE DATABASE %I WITH TEMPLATE template0 OWNER %I ENCODING %L LC_COLLATE %L LC_CTYPE %L LOCALE_PROVIDER libc CONNECTION LIMIT %s;',
 datname,pg_get_userbyid(datdba),pg_encoding_to_char(encoding),datcollate,datctype,datconnlimit)
FROM pg_database WHERE datname=:'target';
SQL
test -s "$RUN/create-target.sql"
docker cp "$BK:/app/prisma/migrations" "$RUN/migrations"
docker cp "$BK:/app/scripts/docker-entrypoint.sh" "$RUN/image-entrypoint.sh"
pgsql "$TARGET" -At > "$RUN/db-migration-hashes.txt" <<'SQL'
SELECT checksum || '  ./' || migration_name || '/migration.sql'
FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
ORDER BY migration_name;
SQL
(cd "$RUN/migrations" && find . -name migration.sql -print0 | sort -z | xargs -0 sha256sum) > "$RUN/image-migration-hashes.txt"
cmp "$RUN/db-migration-hashes.txt" "$RUN/image-migration-hashes.txt"
```

Contrastar archivos/checksums exactos de la imagen con `_prisma_migrations` y manifiesto aprobado. Las 29 migraciones del checkout son referencia, no prueba de la VM. Parar por incompletas, diferencias de historia, drift conocido o imagen desconocida. Conservar imagen por ID y artefacto recuperable; no construir/actualizar dependencias durante intervención.

## 2. Preparar invocaciones de mantenimiento

Definir PROJECT/COMPOSE_FILE según etiquetas comprobadas. Si hay varios Compose/overrides, reconstruir **toda** la lista `-f`; no usar este ejemplo de fichero único omitiendo alguno. Verificar que las claves de servicios son backend/frontend/postgres según inventario.

```bash
read -r -p 'Proyecto Compose verificado: ' PROJECT
read -r -p 'Ruta absoluta Compose efectivo verificado: ' COMPOSE_FILE
[[ "$COMPOSE_FILE" = /* && -f "$COMPOSE_FILE" ]]
cd "$(dirname "$COMPOSE_FILE")"
cat > "$RUN/maintenance.yml" <<YAML
services:
  backend:
    image: "$IMAGE"
    entrypoint: ["node", "dist/main.js"]
    command: []
    environment:
      RUN_DB_SEED: "false"
      B2B_WEBHOOK_POLL_SECONDS: "0"
      PREQUOTE_ENABLED: "false"
      PREQUOTE_CONVERSION_ENABLED: "false"
      PREQUOTE_AUTHORIZED_ACCEPT_ENABLED: "false"
YAML
DC=(docker compose -p "$PROJECT" -f "$COMPOSE_FILE" -f "$RUN/maintenance.yml")
"${DC[@]}" config --quiet
"${DC[@]}" run --rm --no-deps --pull never --entrypoint sh backend -c '
 test "$NODE_ENV" = production && test -x ./node_modules/.bin/prisma &&
 test -f dist/bootstrap-admin.js && test -f prisma/schema.prisma'
```

No inicia aplicación ni entrypoint. **Verificar también identidad del one-off** ejecutando el mismo bloque Node anterior con `"${DC[@]}" run --rm -T --no-deps --pull never --entrypoint node backend` en lugar de `docker exec -i "$BK" node`. Guardar en otro archivo, comparar database/OID/system_id con app-identity; podría haber cambiado DATABASE_URL del Compose desde el arranque. Parar si difieren.

Validar configuración de producción con `validateEnvironment` compilado en ese one-off, sólo resultado booleano, sin imprimir configuración:

```bash
"${DC[@]}" run --rm -T --no-deps --pull never --entrypoint node backend -e '
try { require("./dist/config/environment.js").validateEnvironment(process.env); console.log("production config OK"); }
catch { console.error("Invalid production config; stop"); process.exit(1); }'
```

Producción exige Google routing, Resend, web HTTPS y clave maestra webhook válida. No cambiar a local_fake/local_outbox para arrancar. Conservar `B2B_WEBHOOK_SECRET_KEY` original para recuperación; no rotarla aquí.

## 3. Parar escrituras y trabajadores

Retirar ingreso a **todas** las réplicas, incluidos accesos directos/privados; coordinar pausa de clientes/reintentos. Detener frontend sólo cierra tráfico si es realmente el único proxy. Inventariar y suspender jobs Mandaria y automatismos de reinicio; no servicios ajenos. No imprimir cron si contiene secretos.

```bash
docker stop -t 30 "$FE"  # Sólo frontend Mandaria previamente verificado.
read -r -p 'Timeout de parada superior a lease + timeout + margen: ' STOP_SECONDS
[[ "$STOP_SECONDS" =~ ^[0-9]+$ ]]
docker stop -t "$STOP_SECONDS" "$BK"
# Repetir para cada réplica/worker Mandaria inventariado; no postgres/redis/Coita.
pgsql postgres -v target="$TARGET" <<'SQL'
SELECT count(*) AS sessions FROM pg_stat_activity WHERE datname=:'target';
SELECT count(*) AS prepared_transactions FROM pg_prepared_xacts WHERE database=:'target';
SQL
```

Exigir cero sesiones y transacciones preparadas, procesos detenidos y reinicios suspendidos. Identificar cualquier sesión por metadatos sin query ni secretos; detener su dueño controladamente. No terminar conexiones ajenas para forzar DROP. Capturar hora UTC del corte.

## 4. Backup, custodia y restauración de ensayo

Dump completo, preservando owners/ACL/triggers. Espacio para dump, cifrado, descifrado, base temporal y base nueva. Los backups contienen datos privados y credenciales cifradas/hashes: no mostrarlos, adjuntarlos ni versionarlos.

```bash
df -h "$RUN"
docker exec "$PG" df -h /var/lib/postgresql/data
docker exec "$PG" sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$1" -Fc' sh "$TARGET" > "$RUN/mandaria.dump" 2> "$RUN/dump.PRIVATE.log"
test -s "$RUN/mandaria.dump"
docker exec -i "$PG" pg_restore --list < "$RUN/mandaria.dump" > "$RUN/restore-list.PRIVATE.txt"
(cd "$RUN" && sha256sum mandaria.dump > mandaria.dump.sha256)
cat > "$RUN/counts.sql" <<'SQL'
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT format('SELECT %L AS relation, count(*) FROM %I.%I;',schemaname||'.'||tablename,schemaname,tablename)
FROM pg_tables WHERE schemaname='public' ORDER BY tablename
\gexec
SELECT migration_name,checksum,finished_at IS NOT NULL,rolled_back_at IS NOT NULL
FROM "_prisma_migrations" ORDER BY migration_name,id;
COMMIT;
SQL
pgsql "$TARGET" -At < "$RUN/counts.sql" > "$RUN/before.counts"
pgsql "$TARGET" -At > "$RUN/sequence-highwater.sql" <<'SQL'
SELECT format('SELECT setval(%L::regclass, %s, true);','public."DeliveryRequest_publicId_seq"',last_value) FROM "DeliveryRequest_publicId_seq";
SELECT format('SELECT setval(%L::regclass, %s, true);','public."DeliveryQuote_publicId_seq"',last_value) FROM "DeliveryQuote_publicId_seq";
SELECT format('SELECT setval(%L::regclass, %s, true);','public."DeliveryPrequote_publicId_seq"',last_value) FROM "DeliveryPrequote_publicId_seq";
SQL
```

Si hubo IDs manuales/reinicio previo, verificar que máximo numérico MDR/MQ/MPQ no supera last_value; si supera, parar y determinar máximo histórico seguro. Una secuencia aún no usada dejará un hueco inocuo al preservar su valor.

Respaldar también Compose/overrides efectivos, nginx y fuente privada de secretos. Si sólo están en entorno del contenedor, capturar `docker inspect "$BK" > "$RUN/backend.PRIVATE.json"` **a fichero privado 0600**, jamás a consola. Recuperar especialmente clave maestra webhook, JWT y claves de proveedores; no publicar sus valores. Proteger también archivos de bootstrap anteriores sin reutilizarlos.

Ejemplo de cifrado mediante GPG ya disponible, contraseña por prompt (sin argumentos/env):

```bash
command -v gpg
# Incluir primero archivos de configuración privados e inventario de imagen en RUN.
tar -C "$RUN" -cf "${RUN}.private.tar" .
gpg --symmetric --cipher-algo AES256 --output "${RUN}.private.tar.gpg" "${RUN}.private.tar"
sha256sum "${RUN}.private.tar.gpg"
```

No sobrescribir archivos existentes. Transferir cifrado al almacenamiento externo privado aprobado; descargar, comparar hash y probar descifrado con clave custodiada fuera de la VM. Comprobar dump recuperado contra mandaria.dump.sha256. No basta copia local, checksum o `pg_restore --list`. Si no hay herramienta/custodia aprobada, parar; no instalar ni contratar automáticamente. Retener temporales privados durante ventana y aplicar después política de retención, sin limpiezas amplias.

### Ensayo obligatorio antes del DROP

Base temporal aislada en mismo cluster comprobado, sin aplicación/clientes. Si no hay capacidad, realizar ensayo en otro PG aislado compatible, con roles necesarios; no saltarlo. Usar dump recuperado del archivo externo, comprobado idéntico al original. No `--create` (podría usar nombre archivado), `--clean` ni omitir owners/ACL para ocultar fallos.

```bash
RESTORE_DB="mandaria_restorecheck_$(date -u +%Y%m%d%H%M%S)"
[[ "$RESTORE_DB" != "$TARGET" ]]
pgsql postgres -v target="$TARGET" -v checkdb="$RESTORE_DB" <<'SQL'
SELECT 1 / CASE WHEN NOT EXISTS (SELECT 1 FROM pg_database WHERE datname=:'checkdb') THEN 1 ELSE 0 END AS fresh_name;
SELECT format('CREATE DATABASE %I WITH TEMPLATE template0 OWNER %I ENCODING %L LC_COLLATE %L LC_CTYPE %L LOCALE_PROVIDER libc;',
 :'checkdb',pg_get_userbyid(datdba),pg_encoding_to_char(encoding),datcollate,datctype)
FROM pg_database WHERE datname=:'target'
\gexec
SQL
docker exec -i "$PG" sh -c 'exec pg_restore --exit-on-error --single-transaction -U "$POSTGRES_USER" -d "$1"' sh "$RESTORE_DB" < "$RUN/mandaria.dump" > "$RUN/restore-check.PRIVATE.log" 2>&1
pgsql "$RESTORE_DB" -At < "$RUN/counts.sql" > "$RUN/restored.counts"
cmp "$RUN/before.counts" "$RUN/restored.counts"
```

Exigir exit 0 y correspondencia de conteos/migraciones. Logs de restore privados: pueden incluir datos de filas al fallar; no pegarlos completos. Comprobar además saldos contra ledger y cadena, esperando cero incidencias:

```bash
pgsql "$RESTORE_DB" <<'SQL'
BEGIN READ ONLY;
SELECT count(*) AS negative_balances FROM "CreditAccount" WHERE balance < 0;
SELECT count(*) AS ledger_mismatches FROM "CreditAccount" a
WHERE a.balance <> COALESCE((SELECT sum(e.amount) FROM "CreditLedgerEntry" e WHERE e."creditAccountId"=a.id),0);
WITH chain AS (
 SELECT "balanceBefore","balanceAfter",amount,
 lag("balanceAfter",1,0) OVER(PARTITION BY "creditAccountId" ORDER BY sequence) AS previous
 FROM "CreditLedgerEntry"
)
SELECT count(*) AS broken_chain FROM chain
WHERE "balanceBefore"<>previous OR "balanceAfter"<>"balanceBefore"+amount;
COMMIT;
SQL
export RESTORE_DB
"${DC[@]}" run --rm -T --no-deps --pull never -e RESTORE_DB --entrypoint node backend <<'JS'
const {PrismaClient}=require('@prisma/client');
const {masterKey,decryptSecret}=require('./dist/b2b-webhooks/webhook-secret.js');
const u=new URL(process.env.DATABASE_URL);
if (!/^mandaria_restorecheck_\d+$/.test(process.env.RESTORE_DB || '')) process.exit(1);
u.pathname='/'+process.env.RESTORE_DB;
const db=new PrismaClient({datasources:{db:{url:u.toString()}},log:[]});
(async()=>{ let key;
 try {
  key=masterKey(process.env.B2B_WEBHOOK_SECRET_KEY);
  const rows=await db.$transaction(async tx=>{
   await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
   const [identity]=await tx.$queryRawUnsafe('SELECT current_database() AS name');
   if(identity.name!==process.env.RESTORE_DB) throw Error('Wrong database');
   return tx.b2bWebhookEndpoint.findMany({where:{secretCiphertext:{not:null}},select:{secretCiphertext:true}});
  });
  let failed=0;
  for(const row of rows) {try {decryptSecret(row.secretCiphertext,key);} catch {failed++;}}
  console.log(JSON.stringify({checked:rows.length,failed,verified:rows.length>0&&failed===0}));
  if(failed)process.exitCode=1;
 } catch {console.error('Private recovery check failed; stop.');process.exitCode=1;}
 finally {if(key)key.fill(0);await db.$disconnect();}
})();
JS
```

El one-off usa el host/cluster ya comprobado y cambia sólo la base a RESTORE_DB, sin AppModule/worker. Exigir clave recuperada desde custodia equivalente a la operativa, no sólo que aún exista en la VM. Cero ciphertexts significa que no hay secretos de endpoint que probar, **no** que se acreditó descifrado; documentarlo. No arrancar aplicación ni enviar webhooks contra la copia. Cualquier inconsistencia/clave irrecuperable bloquea borrado. Conservar evidencia privada y copia aislada:

```bash
pgsql postgres -v checkdb="$RESTORE_DB" <<'SQL'
SELECT format('ALTER DATABASE %I ALLOW_CONNECTIONS false', :'checkdb')
\gexec
SQL
```

No se elimina base de ensayo en este procedimiento. Registrar su nombre y retención.

## 5. DROP de la base exacta y recreación — DESTRUCTIVO, NO EJECUTADO

Gate: backup externo recuperado y restaurado, invariantes/clave comprobados, writers cero, misma VM/PG y aprobación operativa de pasar a este bloque. Nunca FORCE. Sólo TARGET; no roles, volumen, cluster ni otra base.

```bash
[[ "$(docker inspect -f '{{.Id}}' "$PG")" = "$PG_ID" ]]
read -r -p "Escriba REINICIAR $TARGET para continuar: " CONFIRM
[[ "$CONFIRM" = "REINICIAR $TARGET" ]]
pgsql postgres -v target="$TARGET" -v oid="$EXPECTED_OID" -v sys="$EXPECTED_SYS" <<'SQL'
SELECT 1 / CASE WHEN EXISTS (
 SELECT 1 FROM pg_database WHERE datname=:'target' AND oid::text=:'oid'
 AND NOT datistemplate AND datname NOT IN ('postgres','template0','template1')
) AND (SELECT system_identifier::text FROM pg_control_system())=:'sys'
AND NOT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=:'target')
AND NOT EXISTS (SELECT 1 FROM pg_prepared_xacts WHERE database=:'target')
THEN 1 ELSE 0 END AS final_guard;
SELECT format('ALTER DATABASE %I ALLOW_CONNECTIONS false', :'target')
\gexec
SELECT format('DROP DATABASE %I', :'target')
\gexec
SQL
pgsql postgres < "$RUN/create-target.sql"
```

Si falla DROP, parar: original podría seguir intacta pero con conexiones deshabilitadas. No repetir a ciegas ni migrar. Tras crear, OID cambia: registrar nuevo, no usar antiguo para operaciones posteriores.

## 6. Migraciones explícitas y único bootstrap admitido

```bash
"${DC[@]}" run --rm -T --no-deps --pull never --entrypoint sh backend -c \
 'exec ./node_modules/.bin/prisma migrate deploy --schema prisma/schema.prisma'
"${DC[@]}" run --rm -T --no-deps --pull never --entrypoint sh backend -c \
 'exec ./node_modules/.bin/prisma migrate status --schema prisma/schema.prisma'
pgsql "$TARGET" <<'SQL'
SELECT count(*) AS migrations,
 count(*) FILTER(WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) AS finished,
 count(*) FILTER(WHERE finished_at IS NULL AND rolled_back_at IS NULL) AS unfinished
FROM "_prisma_migrations";
SELECT count(*) AS users FROM "User";
SELECT count(*) AS integrations FROM "IntegrationClient";
SELECT count(*) AS requests FROM "DeliveryRequest";
SELECT count(*) AS ledger FROM "CreditLedgerEntry";
SQL
pgsql "$TARGET" < "$RUN/sequence-highwater.sql"
```

Esperado: manifiesto de 29 migraciones revisadas finalizadas, cero incompletas y negocio vacío. Otra versión exige su propio manifiesto aprobado; no forzar 29. Ante fallo conservar log privado y parar: no editar SQL/migrate resolve, ni repetir arranques hasta verde.

Crear SUPER_ADMIN real con contraseña nueva en sesión privada sin grabación. No pasar valores como argumentos ni guardar en documentación:

```bash
read -r -s -p 'Email real SUPER_ADMIN: ' BOOTSTRAP_ADMIN_EMAIL; printf '\n'
read -r -s -p 'Contraseña nueva (16–128 caracteres): ' BOOTSTRAP_ADMIN_PASSWORD; printf '\n'
export BOOTSTRAP_ADMIN_EMAIL BOOTSTRAP_ADMIN_PASSWORD
if "${DC[@]}" run --rm -T --no-deps --pull never \
 -e BOOTSTRAP_ADMIN_EMAIL -e BOOTSTRAP_ADMIN_PASSWORD \
 --entrypoint node backend dist/bootstrap-admin.js; then
 unset BOOTSTRAP_ADMIN_EMAIL BOOTSTRAP_ADMIN_PASSWORD
else
 unset BOOTSTRAP_ADMIN_EMAIL BOOTSTRAP_ADMIN_PASSWORD
 printf '%s\n' 'Bootstrap falló; detenerse.' >&2
 exit 1
fi
pgsql "$TARGET" <<'SQL'
SELECT count(*) AS active_super_admins FROM "User"
WHERE role='SUPER_ADMIN' AND active AND "passwordHash" IS NOT NULL;
SQL
```

Esperado exactamente uno. Respuesta incierta: comprobar antes de repetir. Si ya existe y no se conoce contraseña, este script no la recupera: parar para procedimiento de recuperación revisado, no actualizar hashes arbitrariamente. Restaurar backup recupera la contraseña antigua, no la nueva del reset.

## 7. Cachés y arranque restringido

No FLUSH Redis: uso no acreditado. Reinicio de procesos limpia memoria/throttling; base nueva elimina outbox/idempotencia/leases/presupuesto antiguos. No borrar correo local en archivos ni reenviar invitaciones QA; local_outbox está prohibido en producción. Operadores deben cerrar sesión/limpiar estado sólo de Mandaria en sus clientes. Usuarios/credenciales antiguas ya no existen; no hace falta rotar todos los JWT secrets para este reset.

Arranque con ingreso aún cerrado, workers/flags de mantenimiento y entrada directa que no hace seed/migraciones:

```bash
"${DC[@]}" up -d --no-deps --no-build --pull never backend
docker inspect "$BK" --format 'status={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{end}}'
docker exec "$BK" node -e "fetch('http://127.0.0.1:3000/health').then(async r=>{const b=await r.json();if(!r.ok||b.status!=='ok'||b.database!=='up')process.exit(1);console.log('health/database OK')}).catch(()=>process.exit(1))"
```

Exigir healthy sostenido y sin errores, no sólo proceso running. Login y permisos SUPER_ADMIN por acceso privado/túnel, sin imprimir tokens. Para usar UI, restringir ingreso a operadores **antes** de arrancar frontend. No hacer pedidos, routing, correos ni webhooks reales como healthcheck. No copiar logs completos no revisados.

### Configuración que se pierde y deberá recrearse

- IntegrationClient, códigos/scopes, credenciales B2B; destinos webhook y nuevos secretos de firma. Coordinar receptor antes de habilitar.
- Usuarios/invitaciones/memberships, proveedores, repartidores/vehículos, disponibilidad y cobertura.
- Zonas, tarifas/bandas, políticas de créditos, límites y recargas justificadas: sin tarifas/saldos ficticios QA. Cuentas se crean por triggers/servicios, no balances SQL manuales.
- Se pierde toda historia de solicitudes/cotizaciones/precotizaciones, ejecución, autorizaciones, ledger/refunds, eventos/intententos, sesiones, idempotencia y consumos. El respaldo conserva esa historia, no la base nueva.

Archivos/secretos/flags operativos no recrean filas comerciales. Aprovisionar por APIs SUPER_ADMIN con valores aprobados. El propietario debe coordinar Coita para nuevas credenciales, consentimiento y reconciliación de referencias/intenciones QA; no reintentar automáticamente operaciones antiguas ni reutilizar keys. No se accede a Coita aquí.

### Reapertura separada

Sólo tras aprobación operativa, configuración comercial recreada y coordinación externa. Restaurar flags/polling del Compose efectivo aprobado con imagen pinneada y RUN_DB_SEED=false. No levantar todo el proyecto. No mezclar maintenance.yml con resume.yml:

```bash
cat > "$RUN/resume.yml" <<YAML
services:
  backend:
    image: "$IMAGE"
    environment:
      RUN_DB_SEED: "false"
YAML
docker compose -p "$PROJECT" -f "$COMPOSE_FILE" -f "$RUN/resume.yml" config --quiet
docker compose -p "$PROJECT" -f "$COMPOSE_FILE" -f "$RUN/resume.yml" \
 up -d --no-deps --no-build --pull never backend
# Sólo tras comprobar healthy y salud/cadencia worker con API admin privada:
docker start "$FE"
```

Incluir todos los Compose efectivos si había varios. Entry point normal migrará una base ya completa, con bootstrap apagado: exigir status limpio antes. Comprobar API/health, Swagger bloqueado y frontend; cola vacía no demuestra salud worker. Reabrir clientes coordinadamente. **Tras nuevas escrituras, no volver a backup viejo sin reconciliación**, porque se perderían datos y podrían repetirse efectos externos.

## 8. Recuperación ante fallo

Cerrar/mantener ingreso y detener todas las instancias nuevas igual que etapa 3. Conservar errores privados, backup y configuración/clave maestra original. Confirmar PG_ID, system_id y TARGET de nuevo. No borrar volumen ni ejecutar migraciones nuevas sobre backup.

**Caso A: DROP no ocurrió y OID sigue siendo EXPECTED_OID.** No restaurar encima. Si sólo quedaron conexiones deshabilitadas, después del guard de identidad original ejecutar desde postgres:

```sql
SELECT format('ALTER DATABASE %I ALLOW_CONNECTIONS true', :'target')
\gexec
```

**Caso B: original eliminada, base ausente o base nueva fallida.** Si hay datos nuevos, respaldarlos y reconciliar antes; no sobreescribir negocio nuevo. Confirmar OID actual manualmente. Si no existe base, saltar DROP e ir a crear. Si existe, siguiente bloque requiere confirmación exacta, sin FORCE:

```bash
[[ "$(docker inspect -f '{{.Id}}' "$PG")" = "$PG_ID" ]]
pgsql postgres -v target="$TARGET" -v sys="$EXPECTED_SYS" <<'SQL'
SELECT 1 / CASE WHEN (SELECT system_identifier::text FROM pg_control_system())=:'sys' THEN 1 ELSE 0 END AS same_cluster;
SELECT datname,oid,datallowconn FROM pg_database WHERE datname=:'target';
SQL
read -r -p 'OID actual confirmado de la base fallida, sólo si existe: ' FAILED_OID
[[ "$FAILED_OID" =~ ^[0-9]+$ ]]
read -r -p "Escriba RESTAURAR $TARGET: " CONFIRM
[[ "$CONFIRM" = "RESTAURAR $TARGET" ]]
pgsql postgres -v target="$TARGET" -v oid="$FAILED_OID" <<'SQL'
SELECT 1 / CASE WHEN EXISTS (
 SELECT 1 FROM pg_database WHERE datname=:'target' AND oid::text=:'oid'
 AND NOT datistemplate AND datname NOT IN ('postgres','template0','template1')
) AND NOT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=:'target')
AND NOT EXISTS (SELECT 1 FROM pg_prepared_xacts WHERE database=:'target')
THEN 1 ELSE 0 END AS recovery_guard;
SELECT format('ALTER DATABASE %I ALLOW_CONNECTIONS false', :'target')
\gexec
SELECT format('DROP DATABASE %I', :'target')
\gexec
SQL
pgsql postgres < "$RUN/create-target.sql"
(cd "$RUN" && sha256sum -c mandaria.dump.sha256)
docker exec -i "$PG" sh -c 'exec pg_restore --exit-on-error --single-transaction -U "$POSTGRES_USER" -d "$1"' sh "$TARGET" < "$RUN/mandaria.dump" > "$RUN/recovery.PRIVATE.log" 2>&1
pgsql "$TARGET" -At < "$RUN/counts.sql" > "$RUN/recovery.counts"
cmp "$RUN/before.counts" "$RUN/recovery.counts"
```

No aplicar migraciones antes de pg_restore. Exigir restore íntegro, conteos/migraciones, invariantes ledger, descifrado y login antiguo. No aplicar sequence-highwater de reset: dump ya contiene secuencias originales. Arrancar imagen original con mantenimiento sin entrypoint migrador/seed/polling e ingreso restringido; no bootstrap para cambiar contraseña.

Outbox, leases e idempotencia vuelven al corte. Un receptor pudo recibir una petición antes de la parada: coordinar deduplicación/reconciliación antes de reactivar. Polling apagado no basta si se permiten envíos manuales o completar entregas: mantener aislamiento.

Si falla restore, mantener parada y escalar con backup intacto. No improvisar cambios a constraints. Reapertura exige aprobación operativa. Retención/eliminación posterior de backups y base de ensayo se acuerda aparte, sin comandos amplios de limpieza.

## Evidencia de esta preparación

Sólo lectura estática del checkout y documentación histórica aportada. No se ejecutaron Docker, SQL, backup, restore, reset, comandos remotos, accesos externos, commit, push ni despliegue. Los bloques requieren los gates e inventario real antes de ejecución; no son una prueba acreditada en la VM.
