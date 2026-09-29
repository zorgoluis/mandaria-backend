import { DomainException } from '../common/domain-error.js';

export const PREQUOTE_ERRORS: Record<string, number> = {
  PREQUOTE_CONSUMPTION_LIMIT: 429,
  PREQUOTE_PERMIT_INVALID: 409,
  PREQUOTE_DISABLED: 503,
  PREQUOTE_CONSUMPTION_UNAVAILABLE: 503,
  PREQUOTE_IN_PROGRESS: 409,
  PREQUOTE_LEASE_LOST: 409,
  PREQUOTE_LEASE_BUDGET_INSUFFICIENT: 409,
  PREQUOTE_CONFIGURATION_CHANGED: 409,
  ATTEMPTS_EXHAUSTED: 409,
  PREQUOTE_FAILED: 409,
  ROUTING_UNAVAILABLE: 503,
  ROUTE_NOT_FOUND: 422,
  OUT_OF_SERVICE_AREA: 422,
  CROSS_ZONE_NOT_SUPPORTED: 422,
  DISTANCE_NOT_SUPPORTED: 422,
  RATE_CONFIGURATION_UNAVAILABLE: 503,
  RATE_CONFIGURATION_INVALID: 503,
  SERVICE_ZONE_AMBIGUOUS: 503,
  PREQUOTE_AUTHORIZATION_CHANGED: 401,
  PREQUOTE_EXECUTION_FAILED: 503,
};
export class PrequotePublicError extends DomainException {
  constructor(
    code: string,
    readonly retryAt?: Date,
    readonly terminal = false,
  ) {
    let safeCode = Object.hasOwn(PREQUOTE_ERRORS, code)
      ? code
      : 'PREQUOTE_EXECUTION_FAILED';
    // A terminal 5xx would hide its explanatory message in the global filter and invite retries.
    if (
      terminal &&
      (PREQUOTE_ERRORS[safeCode] >= 500 ||
        [
          'PREQUOTE_CONFIGURATION_CHANGED',
          'PREQUOTE_LEASE_BUDGET_INSUFFICIENT',
          'PREQUOTE_LEASE_LOST',
        ].includes(safeCode))
    )
      safeCode = 'PREQUOTE_FAILED';
    super(
      safeCode,
      PREQUOTE_ERRORS[safeCode],
      terminal
        ? 'This intention has failed permanently; use a new key only for a new intention'
        : 'Prequote execution could not complete',
    );
  }
}
