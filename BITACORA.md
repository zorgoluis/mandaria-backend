# Bitácora de Mandaria

Documento de continuidad para el propietario y los agentes que trabajen en este repositorio. Actualizar el estado actual y agregar una entrada al historial al finalizar cada tarea.

## Estado actual

- **Versión del paquete:** 1.1.0.
- **Rama activa de V1.1:** `v1-cliente_b2b_integracion_api` (nombre encontrado al iniciar la tarea; se respetó).
- **Repositorio remoto:** https://github.com/zorgoluis/mandaria-backend.git, rama `main`, con seguimiento de `origin/main`.
- **Objetivo actual:** V1.1 Clientes B2B e Integraciones API sobre el Core V1.0.
- **Estado funcional V1.1:** implementado y verificado localmente el 2026-09-15; 18 pruebas unitarias/HTTP y 21 E2E correctos.
- **Definition of Done:** requisitos críticos V1.1 verificados. La verificación Docker/Compose heredada de V1.0 sigue pospuesta por el propietario y no se declara realizada.
- **Modalidad vigente:** Node.js y PostgreSQL locales; no levantar contenedores.
- **Base local configurada:** `mandaria_db`; base separada para E2E: `mandaria_test`.
- **Configuración:** `.env` local, ignorado por Git. El propietario corrigió el acceso y las verificaciones posteriores pasaron. No copiar sus valores a esta bitácora.
- **Servidor:** se inició en el puerto 3000 durante la implementación. Comprobar si sigue activo antes de iniciar otra instancia; no asumir que los procesos sobreviven entre sesiones.

## Arquitectura y decisiones vigentes

- Node.js 24, TypeScript estricto, NestJS 11, Prisma 6 y PostgreSQL 18 local.
- Módulos: `auth`, `users`, `integrations`, `health`, `common`, `config` y `prisma`.
- API bajo `/api/v1`; health en `/health`; Swagger en `/docs` y OpenAPI en `/docs-json`.
- Entidades: User, RefreshToken, IntegrationClient e IntegrationCredential, con UUID y timestamps.
- Roles: SUPER_ADMIN, PROVIDER_ADMIN y DRIVER. No existe CUSTOMER ni registro público.
- Contraseñas con Argon2id. Access y refresh JWT tienen secretos, audiencias y tipos separados.
- Refresh almacenado como hash SHA-256, rotación transaccional de un solo uso y revocación en logout.
- Logout revoca refresh; access conserva vigencia hasta expirar. Los guards consultan el rol y estado activo actuales en PostgreSQL.
- Integraciones externas usan clientId/clientSecret para obtener JWT B2B temporal; `x-api-key` ya no autentica peticiones. clientId público identifica la credencial, no la entidad IntegrationClient.
- Estados IntegrationClient: ACTIVE, SUSPENDED y REVOKED; revocación terminal. Credenciales: ACTIVE/REVOKED, scopes, expiresAt opcional y lastUsedAt.
- Rotación genera nueva credencial con mismos scopes/vencimiento y mantiene la anterior hasta revocarla explícitamente. El guard verifica estado de cliente/credencial en cada request y aplica revocación/suspensión también a tokens emitidos.
- INTEGRATION_JWT_SECRET separado de los dos secretos humanos; INTEGRATION_ACCESS_TOKEN_EXPIRES_IN en segundos (60–3600, default 3600).
- Administración bajo `/api/v1/admin/integrations`; rutas administrativas V1.0 conservadas como aliases. Se acepta INACTIVE como alias de entrada de SUSPENDED. No existe recuperación del secreto.
- NestJS 11 se eligió por compatibilidad con Throttler 6. El esqueleto original usaba NestJS 12.
- Overrides de seguridad: multer `^2.3.0` y deepmerge-ts `^8.0.0`; migraciones y E2E fueron comprobados tras instalarlos.
- Rate limiting en memoria para una instancia. Antes de escalar, evaluar almacenamiento compartido y proxies confiables.
- Mandaria no comparte código, entidades Prisma ni PostgreSQL con Coita Eats. La comunicación futura será mediante API/webhooks.

## Mapa de archivos

| Ruta | Propósito |
|---|---|
| `README.md` | Instalación, comandos, endpoints, seguridad y alcance |
| `VERIFICATION.md` | Evidencias y limitaciones de la verificación del Core |
| `src/` | Implementación modular NestJS |
| `prisma/schema.prisma` | Modelo de datos |
| `prisma/migrations/20260915000100_core/migration.sql` | Migración inicial versionada |
| `prisma/seed.ts` | Bootstrap idempotente de SUPER_ADMIN |
| `test/` y `src/config/environment.spec.ts` | Pruebas de servicios, HTTP, configuración y E2E |
| `scripts/init-local.mjs` | Crear `.env` aleatorio sólo si no existe |
| `scripts/create-test-db.mjs` | Crear `mandaria_test` si falta, sin borrar datos |
| `scripts/test-db.mjs` | Migrar base de pruebas y ejecutar E2E |
| `scripts/verify-local.mjs` | Verificar endpoints del servidor activo sin imprimir secretos |
| `Dockerfile`, `docker-compose.yml` | Preparación para uso futuro, ejecución pendiente |

## Verificaciones históricas del Core

Ejecutadas el 2026-09-15; no implican que se hayan repetido tras cada cambio documental:

- `npm run build`: correcto.
- `npm run lint`: correcto.
- `npm test`: 15 pruebas correctas (servicios, configuración y HTTP con dobles de DB).
- `node scripts/test-db.mjs`: 9 E2E correctos con PostgreSQL real.
- Migración aplicada a `mandaria_db` y a `mandaria_test` recién creada y vacía.
- Seed ejecutado dos veces: administrador creado y segunda ejecución sin cambios ni duplicados.
- Smoke HTTP local: health, Swagger, login del administrador, me, users, refresh, logout y rechazo del refresh revocado.
- Integraciones: autenticación, rotación, revocación y desactivación verificadas por E2E.
- `npm audit`: cero vulnerabilidades en aquella ejecución.
- Fallo de health 503 probado con fallo de consulta simulado; no se detuvo el servidor PostgreSQL compartido.

## Pendientes y límites del alcance

1. Verificar Docker build y Compose sólo cuando el propietario indique retomar Docker. Hasta entonces no declarar satisfecha toda la Definition of Done original.
2. Mantener la bitácora actualizada conforme lleguen nuevas solicitudes.
3. V1.2+: proveedores, flotillas, repartidores, vehículos, deliveries, tarifas, despacho, wallets/créditos, realtime, integración operativa con Coita Eats, mandados, paquetería y fletes. No comenzar sin ampliar el alcance.
4. Recuperación/restablecimiento de contraseña, verificación de correo y auditoría persistente: preparación arquitectónica, sin infraestructura implementada.
5. En modelos futuros, los créditos pertenecen al proveedor; los vehículos son recursos operativos y los repartidores realizan entregas.

## Cómo retomar

1. Leer este documento y las instrucciones de `AGENTS.md`.
2. Revisar el estado de Git y los archivos relevantes; no sobrescribir cambios del propietario.
3. Comprobar PostgreSQL y el proceso local antes de arrancarlos; no imprimir `.env`.
4. Para iniciar con configuración existente: `npm ci`, `npm run prisma:generate`, `npm run db:migrate`, `npm run db:seed`, `npm run start:dev`. El seed requiere las variables de bootstrap.
5. Ejecutar las verificaciones adecuadas al cambio y registrar resultados reales. Las instrucciones detalladas están en README.

## Historial

### 2026-09-15 — Implementación inicial del Core (1.0.0)

- **Solicitud:** implementar la especificación Mandaria V1.0 con independencia de Coita Eats.
- **Trabajo:** módulos NestJS, Prisma y migración, autenticación y roles, integraciones, health, seguridad, logging, Swagger, bootstrap, scripts, pruebas y documentación; archivos Docker preparados.
- **Correcciones:** compatibilidad NestJS/Throttler, dependencias vulnerables y acceso PostgreSQL corregido por el propietario.
- **Cambio de instrucción:** el propietario indicó no correr Docker y trabajar localmente. Se continuó con PostgreSQL instalado.
- **Resultados:** build, lint, 15 pruebas unitarias/HTTP, 9 E2E, migración desde base vacía, seed idempotente y smoke HTTP correctos.
- **Pendiente:** ejecución de Docker/Compose.

### 2026-09-15 — Continuidad entre agentes y versión (1.0.1)

- **Solicitud:** crear un archivo acumulativo para que otro agente conozca el trabajo y actualizar la versión de package.json.
- **Trabajo:** creada esta bitácora y `AGENTS.md` para que futuros agentes la lean y actualicen; versión incrementada de 1.0.0 a 1.0.1 en package.json y package-lock.json.
- **Verificación:** JSON de ambos manifiestos válido y versiones del paquete raíz sincronizadas; sin cambios en dependencias o lógica de ejecución.
- **Pruebas:** no se repitieron build/E2E por tratarse de documentación y metadatos de versión. Los resultados anteriores se conservan como históricos.
- **Pendiente:** Docker/Compose continúa pospuesto. La versión 1.0.1 no representa el cierre de esa verificación.

### 2026-09-15 — Publicación inicial en GitHub

- **Solicitud:** configurar origin, usar la rama main y subir el proyecto a `zorgoluis/mandaria-backend`.
- **Preparación:** el repositorio local no tenía commits ni remotos; el remoto consultado no tenía referencias publicadas. Se prepara el commit inicial del Core 1.0.1 y su push a main.
- **Verificación previa:** `.env` ignorado por Git; revisión de los 54 archivos publicables sin coincidencias con los secretos locales configurados. No se incluyen node_modules ni dist.
- **Pruebas:** no repetidas; esta tarea sólo publica el estado ya verificado y actualiza la bitácora.
- **Ajuste de publicación:** eliminadas líneas vacías sobrantes al final de archivos y agregado `.gitattributes` para conservar LF en scripts shell al clonar desde Windows.
- **Resultado:** commit inicial `b977b6e` publicado correctamente en `origin/main`; HEAD y origin/main coincidieron, el directorio de trabajo quedó limpio y `.env` no está versionado. Esta actualización documental registra el resultado después del push inicial.
- **Pendiente funcional:** Docker/Compose sigue pospuesto por indicación del propietario.

### 2026-09-15 — V1.1 Clientes B2B e Integraciones API

- **Solicitud:** extender V1.0 con Client Credentials, tokens temporales B2B separados de usuarios, scopes, administración SUPER_ADMIN, rotación, revocación, suspensión y auditoría mínima.
- **Diagnóstico previo:** existentes IntegrationClient/IntegrationCredential, guards, JWT, logging, configuración y tests reutilizables. No se reconstruyó Auth humano.
- **Implementación:** IntegrationAuthService, guard Bearer B2B, IntegrationScopes/IntegrationScopesGuard, controller administrativo, DTOs/respuestas Swagger y selects públicos. Logging de eventos sin secretos; token endpoint limitado a 10/min/IP.
- **Migración:** `20260915000200_b2b_credentials`; renombra INACTIVE a SUSPENDED y agrega estado/scopes/expiración/último uso de credenciales sin recrear tablas. Conserva revocaciones previas.
- **Configuración:** script upgrade-env-v11 agrega únicamente variables B2B faltantes al `.env` local. `.env.example` queda con campos sensibles vacíos. Los valores anteriores del ejemplo no coincidían con los secretos locales; no se divulgaron sus valores.
- **Instalación:** npm ci completado tras detener el proceso V1.0 que bloqueaba la DLL de Prisma. Prisma generate y build correctos; auditoría de instalación sin vulnerabilidades.
- **Validación final:** lint correcto; 18 pruebas unitarias/HTTP y 21 E2E (7 Core + 14 B2B) correctos. Migraciones aplicadas a mandaria_db y mandaria_test.
- **Preservación:** bases `mandaria_clean_4edab2c526_test` y `mandaria_upgrade_4edab2c526_test` verificadas y conservadas para inspección. Fixtures confirman conservación de usuarios, refresh, IDs, hashes y estados revocados al actualizar desde V1.0.
- **HTTP local:** verificado cliente temporal → credencial → token → me/scopes → suspensión/rechazo → reactivación → rotación con coexistencia → revocación/rechazo. El script elimina sólo su integración temporal.
- **Seguridad:** E2E comprueba que secretos generados no aparecen en logs ni metadata; respuestas sin secretHash. Inspección de logs del proceso local sin campos clientSecret/secretHash. Revisar `.env` únicamente mediante herramientas que no impriman valores.
- **Versión:** package.json y package-lock.json sincronizados a 1.1.0; Swagger 1.1.0.
- **Continuidad:** README documenta comandos completos, migración del contrato API key y registro de Coita Eats vía SUPER_ADMIN. No se registró una integración de producción ni se modificó Coita Eats.
- **Pendientes:** Docker sigue sin ejecutar; limitador distribuido, auditoría persistente, paginación y todos los módulos V1.2+ quedan fuera del alcance. No se realizó commit ni push de V1.1 en esta tarea.

### 2026-09-15 — Entrega de V1.1 a la rama actual

- **Solicitud:** crear commit y subir V1.1 a `v1-cliente_b2b_integracion_api` en origin.
- **Contenido de entrega:** implementación B2B 1.1.0, migración, pruebas, scripts y documentación descritos en la entrada anterior.
- **Verificación previa:** diff sin errores de formato; `.env` ignorado y archivos publicables sin coincidencias con los secretos locales configurados. No se repitieron las pruebas por tratarse de publicación del código ya verificado (18 unitarias/HTTP y 21 E2E).
- **Aclaración sobre OpenAPI:** documentación funcional existente; queda pendiente ampliar descripciones por endpoint, ejemplos completos y errores 400/401/403/404/409/429 aplicables. El README contiene actualmente una explicación más completa del flujo. Esta ampliación no está incluida en el commit solicitado.
- **Destino:** rama actual; sin merge a main. Comprobar sincronización con origin al finalizar el push.
