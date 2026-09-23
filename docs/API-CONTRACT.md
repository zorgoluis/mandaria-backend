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
