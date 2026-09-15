# API Access — Mandaria

Generado por `npm run docs:openapi`. No editar manualmente.

Los roles y scopes se obtienen de los decorators del backend. El perfil del proveedor requiere además una membership vigente; los guards validan estado y asociación en cada petición.

| Método | Ruta | Autenticación | Roles globales | Scopes | Operación |
|---|---|---|---|---|---|
| GET | /api/v1/admin/delivery-requests | bearer | SUPER_ADMIN | — | Listar todas las DeliveryRequests |
| GET | /api/v1/admin/delivery-requests/{publicId} | bearer | SUPER_ADMIN | — | Consultar cualquier DeliveryRequest |
| POST | /api/v1/admin/delivery-requests/{publicId}/cancel | bearer | SUPER_ADMIN | — | Cancelar cualquier DeliveryRequest |
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
| GET | /api/v1/admin/providers/{id}/capacity | bearer | SUPER_ADMIN | — | Consultar uso de límites del proveedor |
| POST | /api/v1/admin/providers/{id}/suspend | bearer | SUPER_ADMIN | — | Suspender proveedor activo |
| GET | /api/v1/admin/providers/{providerId}/drivers | bearer | SUPER_ADMIN | — | Listar Drivers del proveedor |
| POST | /api/v1/admin/providers/{providerId}/drivers | bearer | SUPER_ADMIN | — | Crear Driver para un User DRIVER existente |
| GET | /api/v1/admin/providers/{providerId}/drivers/{driverId} | bearer | SUPER_ADMIN | — | Consultar Driver |
| PATCH | /api/v1/admin/providers/{providerId}/drivers/{driverId} | bearer | SUPER_ADMIN | — | Editar nombre o estado del Driver |
| GET | /api/v1/admin/providers/{providerId}/drivers/{driverId}/assignments | bearer | SUPER_ADMIN | — | Historial de vehículos del Driver |
| POST | /api/v1/admin/providers/{providerId}/drivers/{driverId}/vehicle | bearer | SUPER_ADMIN | — | Asignar vehículo al Driver |
| DELETE | /api/v1/admin/providers/{providerId}/drivers/{driverId}/vehicle | bearer | SUPER_ADMIN | — | Desasignar vehículo vigente |
| GET | /api/v1/admin/providers/{providerId}/members | bearer | SUPER_ADMIN | — | Listar memberships administrativas |
| POST | /api/v1/admin/providers/{providerId}/members | bearer | SUPER_ADMIN | — | Asociar administrador existente |
| DELETE | /api/v1/admin/providers/{providerId}/members/{membershipId} | bearer | SUPER_ADMIN | — | Retirar administrador de este proveedor |
| GET | /api/v1/admin/providers/{providerId}/vehicles | bearer | SUPER_ADMIN | — | Listar vehículos del proveedor |
| POST | /api/v1/admin/providers/{providerId}/vehicles | bearer | SUPER_ADMIN | — | Crear vehículo del proveedor |
| GET | /api/v1/admin/providers/{providerId}/vehicles/{vehicleId} | bearer | SUPER_ADMIN | — | Consultar vehículo |
| PATCH | /api/v1/admin/providers/{providerId}/vehicles/{vehicleId} | bearer | SUPER_ADMIN | — | Editar datos o estado del vehículo |
| GET | /api/v1/admin/providers/{providerId}/vehicles/{vehicleId}/assignments | bearer | SUPER_ADMIN | — | Historial de Drivers del vehículo |
| POST | /api/v1/auth/login | Pública | — | — | AuthController_login |
| POST | /api/v1/auth/logout | Pública | — | — | AuthController_logout |
| GET | /api/v1/auth/me | bearer | — | — | AuthController_me |
| POST | /api/v1/auth/refresh | Pública | — | — | AuthController_refresh |
| GET | /api/v1/delivery-requests | integration-bearer | — | deliveries:read | Listar mis DeliveryRequests |
| POST | /api/v1/delivery-requests | integration-bearer | — | deliveries:create | Crear DeliveryRequest (qué transportar) |
| GET | /api/v1/delivery-requests/{publicId} | integration-bearer | — | deliveries:read | Consultar mi DeliveryRequest |
| POST | /api/v1/delivery-requests/{publicId}/cancel | integration-bearer | — | deliveries:cancel | Cancelar mi DeliveryRequest |
| PATCH | /api/v1/driver/availability | bearer | DRIVER | — | Cambiar mi disponibilidad |
| GET | /api/v1/driver/me | bearer | DRIVER | — | Consultar mi perfil de repartidor |
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
| GET | /api/v1/provider/capacity | bearer | PROVIDER_ADMIN | — | Consultar uso de Drivers y Vehicles de mi proveedor |
| GET | /api/v1/provider/drivers | bearer | PROVIDER_ADMIN | — | Listar Drivers de mi proveedor |
| POST | /api/v1/provider/drivers | bearer | PROVIDER_ADMIN | — | Crear Driver en mi proveedor |
| GET | /api/v1/provider/drivers/{driverId} | bearer | PROVIDER_ADMIN | — | Consultar Driver de mi proveedor |
| PATCH | /api/v1/provider/drivers/{driverId} | bearer | PROVIDER_ADMIN | — | Editar nombre o estado de un Driver de mi proveedor |
| GET | /api/v1/provider/drivers/{driverId}/assignments | bearer | PROVIDER_ADMIN | — | Historial de vehículos del Driver |
| POST | /api/v1/provider/drivers/{driverId}/vehicle | bearer | PROVIDER_ADMIN | — | Asignar vehículo de mi proveedor |
| DELETE | /api/v1/provider/drivers/{driverId}/vehicle | bearer | PROVIDER_ADMIN | — | Desasignar vehículo vigente |
| GET | /api/v1/provider/profile | bearer | PROVIDER_ADMIN | — | Consultar perfil de un proveedor asociado |
| GET | /api/v1/provider/profiles | bearer | PROVIDER_ADMIN | — | Identificar mis proveedores asociados |
| GET | /api/v1/provider/vehicles | bearer | PROVIDER_ADMIN | — | Listar vehículos de mi proveedor |
| POST | /api/v1/provider/vehicles | bearer | PROVIDER_ADMIN | — | Crear vehículo en mi proveedor |
| GET | /api/v1/provider/vehicles/{vehicleId} | bearer | PROVIDER_ADMIN | — | Consultar vehículo de mi proveedor |
| PATCH | /api/v1/provider/vehicles/{vehicleId} | bearer | PROVIDER_ADMIN | — | Editar vehículo de mi proveedor |
| GET | /api/v1/provider/vehicles/{vehicleId}/assignments | bearer | PROVIDER_ADMIN | — | Historial de Drivers del vehículo |
| GET | /api/v1/users | bearer | SUPER_ADMIN | — | UsersController_list |
| GET | /health | Pública | — | — | HealthController_check |
