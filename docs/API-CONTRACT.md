# Contrato económico de adjudicación — V1.10-D

Este documento complementa `openapi.json` y `API_ACCESS.md`. No cambia autenticación ni permisos.

## CLAIM y TAKE

- `POST /api/v1/provider/dispatches/:dispatchId/claim`: el proveedor paga desde su cuenta.
- `POST /api/v1/driver/dispatches/:dispatchId/take`: el independiente paga desde su cuenta y obtiene su asignación en la misma transacción.
- El cliente no elige precio, snapshot, cuenta ni tipo de pagador. El costo proviene exclusivamente de `DispatchCreditSnapshot`.
- Un saldo exacto es válido. Saldo insuficiente devuelve `409 INSUFFICIENT_CREDITS` sin cambios operacionales ni económicos.
- El CLAIM del propietario conserva su idempotencia. TAKE repetido conserva el conflicto operacional existente; ninguno vuelve a cobrar.

## `creditEnforcementMode`

Campo de las vistas Provider, Driver y Admin de Dispatch, documentado como enum en OpenAPI:

| Valor | Significado |
|---|---|
| `LEGACY` | Frontera pre-C persistida en `Dispatch.creditMode`; no hay débito ni snapshot inventado. |
| `PRE_ENFORCEMENT_AWARD` | La adjudicación actual coincide por actor y fecha con un registro inmutable de `DispatchPreEnforcementAward`. Se conserva sin cobro retroactivo. |
| `ENFORCED` | Una nueva adjudicación requiere exactamente un `SERVICE_AWARD` del pagador correcto por el importe negativo del snapshot. |

El campo expresa la regla aplicable; **no es un recibo de pago**. `creditCost` sigue siendo el costo congelado, incluso en una adjudicación transicional que nunca lo pagó. Las vistas sólo exponen su metadata permitida; no revelan identidades de otros pagadores.

Después de liberar un servicio transicional, el Dispatch vuelve a `ENFORCED` para una nueva adjudicación. La excepción histórica permanece en PostgreSQL para auditoría, pero no autoriza el siguiente premio. Ni cambios de política ni ausencia de snapshot modifican la frontera: un servicio nuevo sin snapshot falla cerrado.

## Integridad y auditoría

Los constraint triggers `DEFERRABLE INITIALLY DEFERRED` comprueban al COMMIT la correspondencia operacional/económica. El guard existente del ledger mantiene la validación inmediata del monto, snapshot y ganador. Historial de candidaturas/asignaciones liberadas conserva la referencia del pagador; no se permite borrar esa evidencia dejando un débito huérfano.

Eventos relevantes: `LEGACY_DISPATCH_CREDIT_SKIPPED`, `PRE_ENFORCEMENT_AWARD`, `SERVICE_AWARD_CHARGED`, `SERVICE_AWARD_REJECTED_INSUFFICIENT_CREDITS`. No contienen secretos ni JWT.

No hay refunds en V1.10-D. Reasignar no vuelve a cobrar; cancelar/liberar no devuelve créditos. V1.10-E queda pendiente.

## Verificación reproducible

```powershell
npm run db:generate
npm run db:deploy
npm run build
npx vitest run --config vitest.config.e2e.ts test/credit-consumption.e2e-spec.ts
node scripts/verify-award-boundary.mjs
node scripts/scan-award-integrity.mjs
```

El verificador de frontera compila los commits históricos B `7881efb` y C `a4daeb5` y usa PostgreSQL/HTTP reales. Crea una base propia `_test`, guarda evidencias en `.tmp/check-v110d` y la conserva para inspección. Requiere permiso `CREATEDB`, commits disponibles y `psql`; `PSQL_PATH` permite indicar su ubicación. El escáner sólo lee la base de `DATABASE_URL` y devuelve conteos/IDs, sin credenciales. No ejecutar Docker ni reset para este flujo.

# Solicitudes de socio — Fase 1 (2026-10-04)

Fuente compartida: `mandaria-landing/docs/solicitudes-socio/CONTRATO.md`. Ejemplos reales, conversión y despliegue: [PARTNER-APPLICATIONS-HANDOFF.md](PARTNER-APPLICATIONS-HANDOFF.md). No cambia autenticación, invitaciones ni proveedores existentes.

| Método | Ruta | Acceso | Éxito |
|---|---|---|---|
| POST | `/api/v1/public/partner-applications` | Pública, 5 envíos / 10 min por IP | 202 `{ reference: "SOC-NNNNNN", status: "RECEIVED" }` |
| GET | `/api/v1/admin/partner-applications` | SUPER_ADMIN | 200 `{ items, total, page, pageSize, totalPages }`; filtros `status` (uno o varios separados por comas, p. ej. `RECEIVED,CONTACTED`; sin vacíos, máximo 5, duplicados ignorados), `type`, `q`, `page`, `pageSize` |
| GET | `/api/v1/admin/partner-applications/:reference` | SUPER_ADMIN | 200 detalle |
| POST | `/api/v1/admin/partner-applications/:reference/status` | SUPER_ADMIN | 200 detalle; `{ status, reviewNote? }` |
| POST | `/api/v1/admin/partner-applications/:reference/links` | SUPER_ADMIN | 200 detalle; `{ providerId?, invitationId? }` |

- **Lead, no cuenta:** ninguna ruta crea User, Driver, DeliveryProvider, UserInvitation ni IndependentDriverProfile.
- **Duplicados:** una solicitud RECEIVED/CONTACTED de los últimos 30 días con el mismo teléfono o correo absorbe el envío: misma referencia, `submissionCount + 1`, `lastSubmittedAt` actualizado. Advisory locks por teléfono y correo, en orden fijo y dentro de la transacción, resuelven envíos simultáneos a una sola fila.
- **Honeypot `website`:** con un valor no vacío responde 202 con una referencia de formato válido, antes de validar, sin persistir ni registrar el cuerpo.
- **Estados:** RECEIVED→CONTACTED/REJECTED/DISCARDED; CONTACTED→APPROVED/REJECTED/DISCARDED; APPROVED→REJECTED con nota nueva. APPROVED exige nota o vínculo. REJECTED y DISCARDED son terminales.
- **Vínculos:** sólo en APPROVED. `providerId` sólo en solicitudes FLEET y debe ser un proveedor FLEET existente; `invitationId` debe existir con el mismo email. Si hay ambos, la invitación debe ser de ese proveedor.
- **Errores de dominio:** 404 `PARTNER_APPLICATION_NOT_FOUND`, 409 `PARTNER_APPLICATION_INVALID_TRANSITION`, 409 `PARTNER_APPLICATION_LINK_INVALID`. Validación: 400 `VALIDATION_ERROR`; límite: 429 `HTTP_429`.
- **PostgreSQL:** `PartnerApplication_fleet_check` (fleetName/fleetUnits sólo y siempre con FLEET, 2–10 000 unidades), `PartnerApplication_values_check` (formato de referencia, teléfono de 10 dígitos, correo en minúsculas, longitudes, `source = LANDING`) y `PartnerApplication_review_check` (vínculos sólo en APPROVED/REJECTED; APPROVED con nota o vínculo; actor y fecha de cambio juntos). Secuencia `PartnerApplication_publicId_seq`.
- **Configuración:** `TRUST_PROXY_HOPS` (0–3, por defecto 0) y `PARTNER_APPLICATIONS_NOTIFY_EMAIL` (opcional); `CORS_ORIGINS` debe incluir el origen de la landing cuando la API está en otro origen.
