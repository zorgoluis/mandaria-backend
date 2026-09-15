# API Access — Mandaria

Generado por `npm run docs:openapi`. No editar manualmente.

Los roles y scopes se obtienen de los decorators del backend. El perfil del proveedor requiere además una membership vigente; los guards validan estado y asociación en cada petición.

| Método | Ruta | Autenticación | Roles globales | Scopes | Operación |
|---|---|---|---|---|---|
| GET | /api/v1/admin/integrations | bearer | SUPER_ADMIN | — | List up to 100 clients; /integrations administrative routes are compatibility aliases |
| POST | /api/v1/admin/integrations | bearer | SUPER_ADMIN | — | AdminIntegrationsController_create[0] |
| GET | /api/v1/admin/integrations/{id} | bearer | SUPER_ADMIN | — | AdminIntegrationsController_get[0] |
| PATCH | /api/v1/admin/integrations/{id} | bearer | SUPER_ADMIN | — | AdminIntegrationsController_status[0] |
| GET | /api/v1/admin/integrations/{id}/credentials | bearer | SUPER_ADMIN | — | AdminIntegrationsController_credentials[0] |
| POST | /api/v1/admin/integrations/{id}/credentials | bearer | SUPER_ADMIN | — | Generate Client Credentials; secret shown only in this response |
| DELETE | /api/v1/admin/integrations/{id}/credentials/{credentialId} | bearer | SUPER_ADMIN | — | Compatibility alias for credential revocation |
| POST | /api/v1/admin/integrations/{id}/credentials/{credentialId}/revoke | bearer | SUPER_ADMIN | — | AdminIntegrationsController_revoke[0] |
| POST | /api/v1/admin/integrations/{id}/credentials/{credentialId}/rotate | bearer | SUPER_ADMIN | — | Create replacement with the same scopes/expiry; revoke old credential explicitly after transition |
| GET | /api/v1/admin/providers | bearer | SUPER_ADMIN | — | Listar proveedores con filtros y paginación |
| POST | /api/v1/admin/providers | bearer | SUPER_ADMIN | — | Crear proveedor FLEET o INDEPENDENT |
| GET | /api/v1/admin/providers/{id} | bearer | SUPER_ADMIN | — | Consultar proveedor por ID |
| PATCH | /api/v1/admin/providers/{id} | bearer | SUPER_ADMIN | — | Editar datos y límites administrativos |
| POST | /api/v1/admin/providers/{id}/activate | bearer | SUPER_ADMIN | — | Activar o reactivar proveedor |
| POST | /api/v1/admin/providers/{id}/suspend | bearer | SUPER_ADMIN | — | Suspender proveedor activo |
| GET | /api/v1/admin/providers/{providerId}/members | bearer | SUPER_ADMIN | — | Listar memberships administrativas |
| POST | /api/v1/admin/providers/{providerId}/members | bearer | SUPER_ADMIN | — | Asociar administrador existente |
| DELETE | /api/v1/admin/providers/{providerId}/members/{membershipId} | bearer | SUPER_ADMIN | — | Retirar administrador de este proveedor |
| POST | /api/v1/auth/login | Pública | — | — | AuthController_login |
| POST | /api/v1/auth/logout | Pública | — | — | AuthController_logout |
| GET | /api/v1/auth/me | bearer | — | — | AuthController_me |
| POST | /api/v1/auth/refresh | Pública | — | — | AuthController_refresh |
| GET | /api/v1/integrations | bearer | SUPER_ADMIN | — | List up to 100 clients; /integrations administrative routes are compatibility aliases |
| POST | /api/v1/integrations | bearer | SUPER_ADMIN | — | AdminIntegrationsController_create[1] |
| GET | /api/v1/integrations/{id} | bearer | SUPER_ADMIN | — | AdminIntegrationsController_get[1] |
| PATCH | /api/v1/integrations/{id} | bearer | SUPER_ADMIN | — | AdminIntegrationsController_status[1] |
| GET | /api/v1/integrations/{id}/credentials | bearer | SUPER_ADMIN | — | AdminIntegrationsController_credentials[1] |
| POST | /api/v1/integrations/{id}/credentials | bearer | SUPER_ADMIN | — | Generate Client Credentials; secret shown only in this response |
| DELETE | /api/v1/integrations/{id}/credentials/{credentialId} | bearer | SUPER_ADMIN | — | Compatibility alias for credential revocation |
| POST | /api/v1/integrations/{id}/credentials/{credentialId}/revoke | bearer | SUPER_ADMIN | — | AdminIntegrationsController_revoke[1] |
| POST | /api/v1/integrations/{id}/credentials/{credentialId}/rotate | bearer | SUPER_ADMIN | — | Create replacement with the same scopes/expiry; revoke old credential explicitly after transition |
| GET | /api/v1/integrations/me | integration-bearer | — | — | IntegrationsController_me |
| GET | /api/v1/integrations/scope-check | integration-bearer | — | deliveries:read | Authorization probe for deliveries:read; does not access or implement deliveries |
| POST | /api/v1/integrations/token | Pública | — | — | Exchange Client Credentials for a short-lived B2B token; no refresh token |
| GET | /api/v1/provider/profile | bearer | PROVIDER_ADMIN | — | Consultar perfil de un proveedor asociado |
| GET | /api/v1/provider/profiles | bearer | PROVIDER_ADMIN | — | Identificar mis proveedores asociados |
| GET | /api/v1/users | bearer | SUPER_ADMIN | — | UsersController_list |
| GET | /health | Pública | — | — | HealthController_check |
