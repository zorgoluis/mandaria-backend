# Verificación de Mandaria Core

Fecha: 2026-09-15. Entorno: Windows, Node.js 24.15.0 y PostgreSQL 18 local.

## Resultado

Core implementado y verificado localmente. **V1.0 no se declara completamente terminada según la Definition of Done original:** la ejecución de Docker/Compose fue pospuesta expresamente por el propietario.

| Verificación | Resultado |
|---|---|
| Build TypeScript/Nest | PASS |
| ESLint | PASS |
| Tests unitarios y HTTP con dobles de DB | 15 PASS |
| E2E con PostgreSQL real | 9 PASS |
| Migración inicial en mandaria_db | PASS |
| Migración desde base mandaria_test vacía | PASS |
| Repetir migrate deploy sin pendientes | PASS |
| Seed SUPER_ADMIN | PASS |
| Seed repetido sin duplicados | PASS |
| Login, me, users, refresh y logout por HTTP local | PASS |
| Refresh concurrente y rechazo de reutilización | PASS, E2E |
| Roles y rechazo de usuarios inactivos | PASS, E2E |
| Integraciones: autenticación, rotación, revocación y desactivación | PASS, E2E |
| Health consulta PostgreSQL | PASS |
| Health 503 ante fallo de consulta | PASS, fallo simulado; no se detuvo el PostgreSQL compartido |
| Swagger y OpenAPI | PASS |
| CORS, Helmet, body y validación | PASS |
| npm audit | 0 vulnerabilidades tras overrides |
| Docker build y docker compose up | PENDIENTE por instrucción del propietario |

## Problemas encontrados y resueltos

- El esqueleto NestJS 12 no satisfacía los peer dependencies de Throttler 6. Se alineó el runtime con NestJS 11 y Swagger 11.
- Prisma y Vitest/tsx requerían descargas/subprocesos que el aislamiento de Windows bloqueaba. Se ejecutaron con autorización y completaron correctamente.
- PostgreSQL rechazaba las credenciales iniciales (P1000). El propietario corrigió `.env`; las migraciones y pruebas posteriores pasaron.
- Avisos transitivos en multer y deepmerge-ts: overrides a `^2.3.0` y `^8.0.0`, respectivamente. Migraciones y E2E se repitieron después de actualizar.
- Docker Desktop no respondía inicialmente. No se prosiguió con contenedores tras la instrucción de trabajar localmente.

## Límites conocidos

- La prueba 503 inyecta un fallo de consulta; no simula caída física del servidor.
- Logout revoca refresh; access conserva vigencia hasta expirar. Desactivar un usuario impide el acceso inmediatamente al volver a consultar su estado.
- Rate limiting en memoria para una instancia. Al escalar habrá que compartir almacenamiento.
- Los secretos locales permanecen sólo en `.env`, ignorado por Git. Las verificaciones no imprimieron contraseñas, JWT ni API keys.
- Las pruebas E2E limpian sus propios registros; la base `mandaria_test` permanece disponible.

Los comandos reproducibles, endpoints y alcance futuro están en README.md.
