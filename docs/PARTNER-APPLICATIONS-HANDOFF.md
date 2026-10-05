# Solicitudes de socio — handoff para Frontend (Fase 1)

2026-10-04. Backend implementado contra `mandaria-landing/docs/solicitudes-socio/CONTRATO.md` y verificado localmente (ver [VERIFICATION.md](../VERIFICATION.md)). Sin commit, despliegue ni cambios en la VM.

Una solicitud es un **lead**: no crea `User`, `Driver`, `DeliveryProvider` ni `IndependentDriverProfile`. SUPER_ADMIN la revisa en Mandaria Web y, si procede, usa los flujos existentes (proveedor + invitación) y registra aquí los vínculos.

## Endpoints

| Método | Ruta | Acceso | Respuesta |
|---|---|---|---|
| POST | `/api/v1/public/partner-applications` | Pública (landing) | 202 `{ reference, status }` |
| GET | `/api/v1/admin/partner-applications?status=RECEIVED,CONTACTED&type=&q=&page=&pageSize=` | SUPER_ADMIN | 200 página |
| GET | `/api/v1/admin/partner-applications/:reference` | SUPER_ADMIN | 200 detalle |
| POST | `/api/v1/admin/partner-applications/:reference/status` | SUPER_ADMIN | 200 detalle |
| POST | `/api/v1/admin/partner-applications/:reference/links` | SUPER_ADMIN | 200 detalle |

`:reference` es `SOC-NNNNNN` y no distingue mayúsculas. Esquemas completos en [openapi.json](openapi.json).

> **Paginación.** El contrato pide «paginación existente». La paginación vigente del backend es `page`/`pageSize` (1/20, máximo 100) con `{ items, total, page, pageSize, totalPages }`. No existen `cursor`/`limit` en este backend, así que se usó `page`/`pageSize`. Propuesto para corregir en §7 del contrato.

## Captura pública (landing)

Reglas del cuerpo: contrato §4. Los textos se recortan, el correo se guarda en minúsculas y `fleetName`/`fleetUnits` son obligatorios con `FLEET` y prohibidos con `INDIVIDUAL`; un `null` explícito con `INDIVIDUAL` se trata como ausente. Campos desconocidos → 400.

Respuesta real, solicitud nueva (`FLEET`):

```json
{ "reference": "SOC-000003", "status": "RECEIVED" }
```

El mismo cuerpo enviado otra vez desde otra IP devuelve **la misma referencia** (`submissionCount` pasa a 2):

```json
{ "reference": "SOC-000003", "status": "RECEIVED" }
```

Un duplicado es una solicitud abierta (`RECEIVED`/`CONTACTED`), creada en los últimos 30 días, con el mismo teléfono **o** correo. Una solicitud cerrada (`APPROVED`/`REJECTED`/`DISCARDED`) o más antigua no absorbe el envío: se emite una referencia nueva.

400 real (formato del filtro global; la landing no debe depender del texto de `errors`):

```json
{
  "statusCode": 400,
  "code": "VALIDATION_ERROR",
  "requestId": "abe12f92-0cfd-4c90-a534-b7e5a6533f62",
  "message": "Validation failed",
  "errors": [
    "phone must be exactly 10 digits",
    "vehicleType must be one of the following values: BICYCLE, MOTORCYCLE, CAR, PICKUP, TRUCK",
    "fleetUnits is only allowed with type FLEET"
  ],
  "timestamp": "2026-10-05T01:40:20.845Z",
  "path": "/api/v1/public/partner-applications"
}
```

429 real (sexto envío de la misma IP en 10 minutos; las peticiones 400 también cuentan):

```json
{
  "statusCode": 429,
  "code": "HTTP_429",
  "requestId": "807059c3-bf7e-4403-9435-2f8844d88ae6",
  "message": "Request failed",
  "errors": [],
  "timestamp": "2026-10-05T01:40:22.927Z",
  "path": "/api/v1/public/partner-applications"
}
```

Honeypot: si `website` trae algo distinto de vacío o espacios, la respuesta es 202 con una referencia de formato válido que **no existe**, sin validar el resto del cuerpo, sin guardar nada y sin registrar el cuerpo en logs. Ejemplo real: `{ "reference": "SOC-674557", "status": "RECEIVED" }`.

Un cuerpo de más de 16 kB responde 413.

## Bandeja administrativa (Mandaria Web)

Respuesta real de `GET /api/v1/admin/partner-applications?type=INDIVIDUAL&page=1&pageSize=1`:

```json
{
  "items": [
    {
      "reference": "SOC-000004",
      "type": "INDIVIDUAL",
      "status": "RECEIVED",
      "contactName": "José Hernández",
      "phone": "9615556677",
      "email": "jose.hernandez@example.com",
      "city": "San Cristóbal de las Casas",
      "vehicleType": "BICYCLE",
      "fleetName": null,
      "fleetUnits": null,
      "privacyNoticeVersion": "2026-10",
      "privacyAcceptedAt": "2026-10-05T01:41:09.010Z",
      "source": "LANDING",
      "submissionCount": 1,
      "lastSubmittedAt": "2026-10-05T01:41:09.010Z",
      "reviewNote": null,
      "statusChangedAt": null,
      "statusChangedByUserId": null,
      "providerId": null,
      "invitationId": null,
      "createdAt": "2026-10-05T01:41:09.010Z",
      "updatedAt": "2026-10-05T01:41:09.014Z",
      "allowedTransitions": ["CONTACTED", "REJECTED", "DISCARDED"]
    }
  ],
  "total": 2,
  "page": 1,
  "pageSize": 1,
  "totalPages": 2
}
```

Filtro `status`: uno o varios estados separados por comas. Para la vista por defecto de solicitudes abiertas usar `?status=RECEIVED,CONTACTED`. `?status=RECEIVED` filtra un solo estado y sin `status` se devuelven todos. Se recortan espacios, no se distinguen mayúsculas y se ignoran duplicados. Un valor desconocido, una entrada vacía (`RECEIVED,`, `,`) o más de 5 valores responden 400 `VALIDATION_ERROR`. `total` y `totalPages` cuentan todos los estados pedidos; el orden y la forma de la respuesta no cambian.

Orden: de la más reciente a la más antigua. `q` busca sin distinguir mayúsculas en referencia, nombre, teléfono, correo y nombre de flotilla. El detalle (`GET …/:reference`) devuelve el mismo objeto que cada `item`. La respuesta nunca incluye el `id` interno: la clave para Frontend es `reference`.

`allowedTransitions` sirve para habilitar los botones de cambio de estado sin duplicar la máquina de estados en Frontend.

### Cambiar estado

`POST …/:reference/status` con `{ "status": "...", "reviewNote": "..." }`.

| Desde | Hacia |
|---|---|
| `RECEIVED` | `CONTACTED`, `REJECTED`, `DISCARDED` |
| `CONTACTED` | `APPROVED`, `REJECTED`, `DISCARDED` |
| `APPROVED` | `REJECTED` (con `reviewNote` nueva en la misma petición) |
| `REJECTED`, `DISCARDED` | — (terminales) |

- `reviewNote` (1–500, nota interna sin datos sensibles) reemplaza la anterior; si se omite se conserva la que había.
- `APPROVED` exige una nota (nueva o conservada) o un vínculo. Como los vínculos sólo se registran estando `APPROVED`, en la práctica aprobar exige nota.
- Cada cambio registra `statusChangedAt` y `statusChangedByUserId`.

Respuesta real tras `{ "status": "APPROVED", "reviewNote": "Flotilla validada por teléfono." }` sobre una solicitud `CONTACTED`:

```json
{
  "reference": "SOC-000003",
  "type": "FLEET",
  "status": "APPROVED",
  "contactName": "María Gómez",
  "phone": "9612223344",
  "email": "maria@example.com",
  "city": "Tuxtla Gutiérrez",
  "vehicleType": "CAR",
  "fleetName": "Envíos Rápidos del Sur",
  "fleetUnits": 8,
  "privacyNoticeVersion": "2026-10",
  "privacyAcceptedAt": "2026-10-05T01:41:08.731Z",
  "source": "LANDING",
  "submissionCount": 2,
  "lastSubmittedAt": "2026-10-05T01:41:09.258Z",
  "reviewNote": "Flotilla validada por teléfono.",
  "statusChangedAt": "2026-10-05T01:41:09.942Z",
  "statusChangedByUserId": "cadd243b-5506-498c-89f3-cb360b5103eb",
  "providerId": null,
  "invitationId": null,
  "createdAt": "2026-10-05T01:41:08.731Z",
  "updatedAt": "2026-10-05T01:41:09.943Z",
  "allowedTransitions": ["REJECTED"]
}
```

409 real al intentar aprobar una solicitud `RECEIVED`:

```json
{
  "statusCode": 409,
  "code": "PARTNER_APPLICATION_INVALID_TRANSITION",
  "requestId": "8fad9ff9-5509-4958-9d6d-39984d1dbafa",
  "message": "Cannot change a RECEIVED application to APPROVED",
  "errors": [],
  "timestamp": "2026-10-05T01:40:38.180Z",
  "path": "/api/v1/admin/partner-applications/SOC-000001/status"
}
```

### Registrar vínculos

`POST …/:reference/links` con `{ "providerId"?: uuid, "invitationId"?: uuid }` (al menos uno; si faltan ambos, 400). Sólo en `APPROVED`. Un valor nuevo reemplaza al anterior. Los vínculos se conservan si la solicitud pasa después a `REJECTED`.

- `providerId`: sólo en solicitudes `FLEET`; debe existir y ser `FLEET`.
- `invitationId`: debe existir y su `email` debe coincidir con el de la solicitud.
- Si hay proveedor e invitación (ahora o de un vínculo anterior), la invitación debe ser de ese proveedor.

No crea ni modifica proveedores o invitaciones: sólo registra los que SUPER_ADMIN ya creó con `POST /api/v1/admin/providers` y `POST /api/v1/admin/providers/:providerId/invitations`.

Respuesta real tras vincular proveedor e invitación a `SOC-000003`: el mismo objeto de arriba con `"providerId": "38cd48e1-a46e-460f-8560-789f14d62856"`, `"invitationId": "dcebf693-1fb6-4fe6-b9da-1933d941ce81"` y `updatedAt` nuevo.

409 real al vincular una solicitud que no está aprobada:

```json
{
  "statusCode": 409,
  "code": "PARTNER_APPLICATION_LINK_INVALID",
  "requestId": "7b7c7ef4-03e8-4514-a6a0-a1addb266e2f",
  "message": "Links can only be recorded on APPROVED applications",
  "errors": [],
  "timestamp": "2026-10-05T01:40:39.831Z",
  "path": "/api/v1/admin/partner-applications/SOC-000002/links"
}
```

### Errores de dominio

| HTTP | `code` | Cuándo |
|---|---|---|
| 404 | `PARTNER_APPLICATION_NOT_FOUND` | Referencia inexistente o con formato inválido |
| 409 | `PARTNER_APPLICATION_INVALID_TRANSITION` | Transición no permitida, `APPROVED` sin nota ni vínculo, `APPROVED→REJECTED` sin nota nueva |
| 409 | `PARTNER_APPLICATION_LINK_INVALID` | No `APPROVED`; proveedor inexistente, no `FLEET` o en solicitud `INDIVIDUAL`; invitación inexistente, con otro email o de otro proveedor |
| 401 / 403 | `HTTP_401` / `HTTP_403` | Sin access JWT humano / rol distinto de SUPER_ADMIN |

Usar `code` para decidir el mensaje, no `message`.

## Cómo convertir una solicitud aprobada

### FLEET

1. `POST /api/v1/admin/providers` con `type: "FLEET"`. Activarlo según el flujo vigente de proveedores.
2. `POST /api/v1/admin/providers/:providerId/invitations` con el **mismo correo** de la solicitud, `role: "PROVIDER_ADMIN"` y `membershipRole: "OWNER"`.
3. `POST …/:reference/links` con `providerId` e `invitationId`.

### INDIVIDUAL — respuesta a la pregunta abierta §9.3

**Cómo se da de alta hoy un repartidor independiente** (V1.6.1 + V1.9, sin cambios en esta tarea):

1. Todo `Driver` pertenece a un proveedor: `Driver.providerId` es obligatorio y además inmutable (`Driver_owner_guard`). No hay forma de crear un Driver sin proveedor.
2. Las cuentas de repartidor sólo nacen por invitación: `POST /api/v1/admin/providers/:providerId/invitations` con `role: "DRIVER"` y `driverName`. La invitación reserva un lugar de `maxDrivers` de ese proveedor. Al activar la cuenta se crean el `User` DRIVER y el `Driver` con ese `providerId`.
3. Con el `Driver` ya activo, SUPER_ADMIN lo habilita como independiente: `POST /api/v1/admin/drivers/:driverId/independent`, que crea `IndependentDriverProfile` en `APPROVED`.
4. SUPER_ADMIN registra sus vehículos propios: `POST /api/v1/admin/drivers/:driverId/independent/vehicles`. Esos vehículos no pertenecen al proveedor.
5. En la solicitud se registra sólo `invitationId`. `providerId` se rechaza para `INDIVIDUAL`, porque el contrato lo reserva para el proveedor FLEET creado.

**Lo que SUPER_ADMIN debe decidir:** en qué proveedor existente se crea la invitación del paso 2. El backend no lo puede decidir y esta tarea no crea proveedores sintéticos. Consecuencias de lo que existe hoy:

- **Flotilla real existente que acepte al repartidor.** El Driver también forma parte de esa flotilla: su PROVIDER_ADMIN lo ve en `/provider/drivers`, puede asignarle servicios de la flotilla y ocupa un lugar de `maxDrivers`. Los contextos están separados: en `take` independiente sólo usa sus vehículos propios, y suspenderlo en un contexto no afecta al otro.
- **`ProviderType.INDEPENDENT`.** Según la documentación V1.9 describe a un proveedor pequeño de una persona con su propia flotilla y administradores, y no es el mecanismo del repartidor independiente («el independiente no es un proveedor ficticio»). Crear uno por cada repartidor para cumplir el requisito equivale al proveedor sintético que el contrato excluye. No se recomienda sin decisión explícita del propietario.

**Pendiente del propietario:** definir qué proveedor recibe a los repartidores independientes aprobados. Si la respuesta es «ninguno», hace falta un cambio de modelo (Driver sin proveedor u onboarding independiente con `IndependentDriverStatus.PENDING`). Eso es alcance V1.1+ y no se implementó.

## Configuración de despliegue (no aplicada en la VM)

Topología indicada por el propietario: landing en `https://mandaria.com.mx`, Mandaria Web en `https://app.mandaria.com.mx` y API en `https://api.mandaria.com.mx`.

- `CORS_ORIGINS` debe incluir **ambos** orígenes de navegador que llaman a la API: `https://mandaria.com.mx` (landing) y `https://app.mandaria.com.mx` (admin). Si la landing también se sirve en `www`, agregar `https://www.mandaria.com.mx`. Son orígenes exactos, sin barra final.
- `TRUST_PROXY_HOPS=1` si un solo nginx atiende `api.mandaria.com.mx` delante del backend. Sin esto, el backend ve la IP del contenedor nginx en todas las peticiones: el límite de 5 envíos / 10 min sería compartido por **todos** los visitantes (y el global de 100/min ya lo es hoy). El valor por defecto 0 conserva el comportamiento actual. El puerto 3000 del backend no debe ser accesible sin pasar por nginx, o un cliente podría falsificar `X-Forwarded-For`. Si hubiera dos proxies encadenados, usar 2.
- `MANDARIA_WEB_URL=https://app.mandaria.com.mx` para que los enlaces de activación de las invitaciones apunten al nuevo dominio de administración.
- `PARTNER_APPLICATIONS_NOTIFY_EMAIL` (opcional): buzón interno que recibe «Nueva solicitud de socio SOC-…» con sólo referencia, tipo y ciudad. Se envía únicamente para solicitudes nuevas, no para duplicados; un fallo de envío no afecta la respuesta 202.
- La landing configura `VITE_API_URL=https://api.mandaria.com.mx`, el origen sin `/api/v1`.
- Los documentos B2B publicados declaran hoy `https://mandaria.com.mx/api/v1` como API. Moverla a `api.` es una decisión aparte que exige actualizar el exportador, las guías y a los integradores. No se cambió aquí.
- Migración incremental `20261004000100_partner_applications`: aplicar con `npm run db:deploy`, nunca con reset.

## Privacidad y logs

Los logs de este módulo sólo contienen `reference`, `requestId`, estados, `submissionCount`, IDs de proveedor/invitación y del actor. Nunca incluyen nombre, teléfono, correo, ciudad ni el cuerpo. Eventos: `PARTNER_APPLICATION_RECEIVED`, `PARTNER_APPLICATION_DUPLICATE`, `PARTNER_APPLICATION_HONEYPOT`, `PARTNER_APPLICATION_STATUS_CHANGED`, `PARTNER_APPLICATION_LINKED`, `PARTNER_APPLICATION_NOTICE_SENT` y `PARTNER_APPLICATION_NOTICE_FAILED`.

Fuera de alcance (Fase 2): conversión automática, creación de cuentas, WhatsApp, documentos y retención/borrado de datos personales de solicitudes.
