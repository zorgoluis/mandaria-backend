# Bitácora de Mandaria

Documento de continuidad para el propietario y los agentes que trabajen en este repositorio. Actualizar el estado actual y agregar una entrada al historial al finalizar cada tarea.

## Estado actual

- **Versión del paquete:** 1.0.1.
- **Repositorio remoto previsto:** https://github.com/zorgoluis/mandaria-backend.git, rama `main`.
- **Objetivo:** Core backend de Mandaria V1.0, plataforma independiente de logística y entregas.
- **Estado funcional:** implementado y verificado localmente el 2026-09-15.
- **Definition of Done original:** no completamente cerrada; Docker/Compose está pendiente de ejecución por instrucción expresa del propietario.
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
- Integraciones externas usan `x-api-key`, separadas de usuarios. Sólo se almacena hash del secreto; hay emisión, rotación por coexistencia, revocación y desactivación del cliente.
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
3. V1.1+: proveedores, flotillas, repartidores, vehículos, deliveries, tarifas, despacho, wallets/créditos, realtime, integración operativa con Coita Eats, mandados, paquetería y fletes. No comenzar sin ampliar el alcance.
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
- **Comprobación de publicación:** tras el push, comparar HEAD con origin/main y comprobar el estado local. Este registro se incluye antes del push; confirmar el resultado mediante Git o el reporte de la tarea.
- **Pendiente funcional:** Docker/Compose sigue pospuesto por indicación del propietario.
