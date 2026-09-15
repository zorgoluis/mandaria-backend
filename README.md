# Mandaria — V1.0 Core Backend

Plataforma independiente de logística y entregas. Coita Eats será un consumidor externo mediante API; Mandaria no importa su código, entidades ni comparte su PostgreSQL.

## Estado de verificación

La implementación del Core está disponible. **No declarar V1.0 terminada hasta verificar todos los puntos de `VERIFICATION.md`.** Por indicación del propietario, el desarrollo y las pruebas actuales se realizan localmente. Los archivos Docker están preparados para uso posterior.

## Stack y arquitectura

Node.js 24, TypeScript estricto, NestJS 11, Prisma 6, PostgreSQL, JWT, Argon2id y OpenAPI. Se eligió NestJS 11 para mantener compatibilidad con Throttler 6; no se forzaron peer dependencies incompatibles.

- `auth/`: login, sesiones, guards y roles.
- `users/`: consultas de usuarios con selección explícita de campos públicos.
- `integrations/`: clientes externos y credenciales revocables.
- `health/`: disponibilidad y consulta real a PostgreSQL.
- `common/`: hashing y filtro global de errores.
- `config/`: validación centralizada del entorno.
- `prisma/`: conexión, reintentos y cierre ordenado.
- `prisma/schema.prisma`, `prisma/migrations/`, `prisma/seed.ts`: modelo, SQL versionado y bootstrap.
- `test/`: pruebas de servicios y E2E con PostgreSQL real.
- `scripts/`: inicialización local, migraciones de pruebas y arranque Docker.

UsersModule exporta el servicio de usuarios. AuthModule registra también el controller administrativo de usuarios para usar los guards sin crear una dependencia circular.

## Requisitos locales

- Node.js 24 y npm 11.
- PostgreSQL 17 o 18 instalado y activo.
- Cliente `psql` en PATH. En Windows normalmente: `C:\Program Files\PostgreSQL\18\bin\psql.exe`.
- Bases independientes `mandaria` y `mandaria_test` (esta última sólo para pruebas).

## Instalación y configuración

Desde la raíz del proyecto:

```powershell
npm ci
node scripts/init-local.mjs
npm run prisma:generate
```

El script crea `.env` con secretos aleatorios y no sobrescribe un archivo existente. También puede copiarse `.env.example` y completarse manualmente. No compartir ni versionar `.env`.

Ajustar `DATABASE_URL` con el usuario, contraseña y puerto de PostgreSQL local. Codificar caracteres especiales de usuario/contraseña como URL. Los secretos JWT deben ser diferentes y tener al menos 32 caracteres. Las duraciones se expresan en **segundos**; access: 60–3600, refresh: 3600–2592000.

`CORS_ORIGINS` contiene orígenes exactos separados por comas, sin rutas ni barra final. Vacío deshabilita acceso cross-origin desde navegadores. Se rechaza `*` en todos los entornos.

### Crear rol y bases locales

Con una cuenta administradora de PostgreSQL, ejecutar interactivamente:

```powershell
& 'C:\Program Files\PostgreSQL\18\bin\psql.exe' -h localhost -p 5432 -U postgres -d postgres
```

Dentro de psql:

```sql
CREATE ROLE mandaria LOGIN;
\password mandaria
CREATE DATABASE mandaria OWNER mandaria;
CREATE DATABASE mandaria_test OWNER mandaria;
\q
```

Usar para el rol la contraseña guardada en `.env` o actualizar `DATABASE_URL`. Estos comandos iniciales se ejecutan una sola vez; no eliminan bases existentes. Si el usuario/base ya existen, utilizarlos tras confirmar que corresponden a Mandaria.

### Migraciones, administrador y backend

Configurar `BOOTSTRAP_ADMIN_EMAIL` y `BOOTSTRAP_ADMIN_PASSWORD` en `.env`. El inicializador ya genera valores locales; leer la contraseña directamente en el archivo. Mínimo 16 y máximo 128 caracteres.

```powershell
npm run db:migrate
npm run db:seed
npm run start:dev
```

El seed se puede repetir: no duplica usuarios ni cambia contraseñas existentes. Rechaza elevar un usuario existente que no sea SUPER_ADMIN o esté inactivo. Eliminar las variables de bootstrap del entorno de despliegue tras aprovisionar al administrador.

Para ejecutar la compilación:

```powershell
npm run build
npm run start:prod
```

- Health: [localhost:3000/health](http://localhost:3000/health)
- Swagger: [localhost:3000/docs](http://localhost:3000/docs)
- OpenAPI JSON: [localhost:3000/docs-json](http://localhost:3000/docs-json)

Una configuración inválida impide arrancar y nombra las variables inválidas sin mostrar sus valores. La conexión inicial reintenta diez veces con intervalos de dos segundos.

## Endpoints

Salvo health y documentación, el prefijo es `/api/v1`.

| Método | Ruta | Autenticación |
|---|---|---|
| POST | /api/v1/auth/login | Pública; email y password |
| POST | /api/v1/auth/refresh | Refresh JWT en body |
| POST | /api/v1/auth/logout | Refresh JWT en body; 204 |
| GET | /api/v1/auth/me | Bearer access JWT |
| GET | /api/v1/users | SUPER_ADMIN; hasta 100 usuarios |
| GET | /api/v1/integrations | SUPER_ADMIN; hasta 100 clientes |
| POST | /api/v1/integrations | SUPER_ADMIN; name y code |
| PATCH | /api/v1/integrations/:id | SUPER_ADMIN; status ACTIVE/INACTIVE |
| POST | /api/v1/integrations/:id/credentials | SUPER_ADMIN; entrega API key una sola vez |
| DELETE | /api/v1/integrations/:id/credentials/:credentialId | SUPER_ADMIN; revoca credencial |
| GET | /api/v1/integrations/me | x-api-key |
| GET | /health | Pública; 200 o 503 |
| GET | /docs | Swagger |
| GET | /docs-json | OpenAPI |

Login y refresh responden `accessToken`, `refreshToken`, `tokenType` y `expiresIn`. Refresh/logout reciben `{ "refreshToken": "..." }`. No existe registro público.

### Sesiones y seguridad

- Contraseñas con Argon2id; no se registran passwords, headers de autorización, bodies ni tokens.
- Access y refresh usan claves, audiencias y tipos diferentes, HS256 e issuer `mandaria`.
- Cada refresh tiene UUID y hash SHA-256; una transacción consume el anterior y crea el siguiente. Sólo una solicitud concurrente puede consumirlo.
- SHA-256 es apropiado para tokens criptográficamente impredecibles y secretos aleatorios de 256 bits; las contraseñas humanas usan Argon2id.
- Logout revoca el refresh correspondiente. El access JWT ya emitido conserva vigencia hasta expirar; el estado activo y rol del usuario se consultan en cada petición protegida.
- El consumidor debe serializar refresh y reemplazar ambos tokens de forma atómica. Reutilizar un refresh consumido devuelve 401.
- Roles iniciales: SUPER_ADMIN, PROVIDER_ADMIN, DRIVER. No existe CUSTOMER.
- Helmet, body de 16 KiB, DTOs estrictos, errores uniformes y respuestas no almacenables en caché.
- Límite por IP: 100 peticiones/minuto; login 5/minuto; refresh 20/minuto. Health está exento.
- Limitador en memoria, adecuado para una instancia inicial. Antes de múltiples réplicas usar almacenamiento compartido y configurar explícitamente proxies confiables; actualmente no se confía en X-Forwarded-For.
- Logging JSON en ejecución normal: inicio, solicitudes sin query strings ni cuerpos, fallos genéricos, login, logout, refresh y cambios de integración con actorId.
- En despliegues públicos usar HTTPS y restringir /docs según el entorno. CORS no sustituye autenticación.
- La base contiene `emailVerifiedAt`; recuperación/restablecimiento/verificación requieren futuros casos de uso, tokens de un solo uso y un adaptador de correo. No hay infraestructura de email en V1.

### Sistemas externos

Crear un cliente con `name=Coita Eats`, `code=COITA_EATS` usando el endpoint administrativo. No se crea automáticamente ni comparte credenciales de usuarios.

La API key tiene formato `credentialUUID.secretoAleatorio`; sólo se guarda el hash del secreto. Enviar en `x-api-key`. Para rotar: generar otra credencial, actualizar al consumidor, comprobar `integrations/me` y revocar la anterior. Las dos pueden convivir durante la transición. Desactivar el cliente invalida todas sus credenciales.

## Pruebas y calidad

```powershell
npm run build
npm run lint
npm test
```

Las pruebas unitarias usan dobles de PostgreSQL, JWT real y Argon2 real. **No sustituyen la verificación E2E.**

Con `mandaria_test` ya creada y accesible al mismo usuario de `DATABASE_URL`:

```powershell
node scripts/create-test-db.mjs
node scripts/test-db.mjs
```

create-test-db crea la base sólo si falta; necesita permiso CREATEDB y psql accesible (o PSQL_PATH). test-db cambia únicamente el nombre de la base a `mandaria_test`, aplica las migraciones versionadas y ejecuta E2E. No usa `db push`, no borra la base ni ejecuta reset. Las pruebas crean registros con identificadores únicos y eliminan solamente sus registros. Para demostrar migraciones desde cero, crear primero una base `mandaria_test` vacía.

Alternativamente definir `TEST_DATABASE_URL` apuntando a una base cuyo nombre termine en `_test`, migrarla y ejecutar `npm run test:e2e`. La suite falla explícitamente si falta esta variable.

E2E comprueba health y Swagger, login correcto/incorrecto, campos públicos, roles, usuario inactivo, refresh concurrente, reutilización, logout, separación de credenciales, rotación/revocación de integración, errores sanitizados, body y rate limiting.

## Docker (preparado para uso posterior)

**No es necesario para el desarrollo local actual. Verificación de ejecución pospuesta por indicación del propietario.**

`docker-compose.yml` incluye postgres con volumen persistente y healthcheck, y backend con usuario no root, init, healthcheck y migraciones con reintentos. Las publicaciones de puertos son locales.

Para uso futuro, configurar las variables de `.env`; `POSTGRES_PASSWORD` debe ser hexadecimal para la interpolación segura de la URL de Compose:

```powershell
docker compose config --quiet
docker compose up -d --build
docker compose ps
```

Si PostgreSQL local ocupa 5432, cambiar `POSTGRES_PORT` a 5433 y usar ese puerto en la URL de conexión desde el host. Backend dentro de Compose usa el servicio `postgres:5432`. Para bootstrap, ejecutar `npm run db:seed` desde el host con la URL que corresponde al puerto publicado.

No usar `docker compose down -v` salvo que se quiera eliminar deliberadamente la base. En producción, coordinar migraciones como paso de despliegue y usar un gestor de secretos.

## Fuera de V1.0 / pendiente V1.1+

Proveedores, flotillas, repartidores, vehículos, deliveries, tarifas, despacho, wallet/créditos, realtime, aplicación de repartidores, mandados, paquetería y fletes. Tampoco hay endpoints de entregas ni webhooks de Coita Eats.

Los créditos futuros pertenecen al proveedor; los vehículos son recursos operativos y los repartidores realizan entregas. Los futuros módulos se agregarán sin acoplar Auth a esas entidades. Email y auditoría persistente se incorporarán cuando corresponda.


## Verificación HTTP local adicional

Con el backend activo y las credenciales de bootstrap en .env, ejecutar node scripts/verify-local.mjs. Comprueba login, perfil, roles, refresh, logout, health y Swagger sin imprimir secretos.

## Dependencias transitivas

Se fijan overrides de multer (^2.3.0) y deepmerge-ts (^8.0.0) para corregir avisos de seguridad. Las migraciones y E2E fueron repetidas con esas versiones. El detalle de resultados está en VERIFICATION.md.
