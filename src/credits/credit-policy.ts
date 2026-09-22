import type { CreditLedgerEntryType } from '@prisma/client';
import { DomainException } from '../common/domain-error.js';

/**
 * V1.10-A limits, mirrored by CHECK constraints in the migration (keep both in sync). One movement
 * moves at most MAX_CREDIT_MOVEMENT credits and no balance exceeds MAX_CREDIT_BALANCE; together they
 * keep balanceBefore + amount below 2^31, so INTEGER columns can never overflow.
 */
export const MAX_CREDIT_MOVEMENT = 1_000_000;
export const MAX_CREDIT_BALANCE = 1_000_000_000;
export const CREDIT_REASON_MIN = 3;
export const CREDIT_REASON_MAX = 500;
export const CREDIT_REFERENCE_MAX = 100;
/** Same contract as the B2B Idempotency-Key: 8-255 visible ASCII characters. */
export const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{8,255}$/;
/**
 * Free text reaches logs and the ledger: no control characters (Unicode Cc, i.e. C0, DEL and C1),
 * so a reason or reference can never forge a log line.
 */
export const PRINTABLE_TEXT = /^\P{Cc}+$/u;

export const CREDIT_ERRORS = {
  INSUFFICIENT_CREDITS: 409,
  CREDIT_BALANCE_LIMIT: 409,
  CREDIT_IDEMPOTENCY_CONFLICT: 409,
  CREDIT_MOVEMENT_CONFLICT: 409,
  CREDIT_ACCOUNT_NOT_FOUND: 404,
  // V1.10-D: an award cannot be charged, so the service is not awarded either (fail closed).
  CREDIT_ACCOUNT_UNAVAILABLE: 409,
  CREDIT_SNAPSHOT_UNAVAILABLE: 409,
} as const;
export type CreditErrorCode = keyof typeof CREDIT_ERRORS;
export const creditError = (code: CreditErrorCode, message: string) =>
  new DomainException(code, CREDIT_ERRORS[code], message);

/** The two movements a human may make in V1.10-A; SERVICE_* stay reserved for claim/take. */
export type HumanMovement =
  | {
      type: 'RECHARGE';
      amount: number;
      rechargeMethod: 'TRANSFER' | 'CASH' | 'OTHER';
      externalReference: string | null;
      reason: string | null;
    }
  | { type: 'ADMIN_ADJUSTMENT'; amount: number; reason: string };

/**
 * Sign convention, the same one the CHECK constraint enforces: RECHARGE and SERVICE_REFUND add,
 * SERVICE_AWARD removes, ADMIN_ADJUSTMENT goes either way, and nothing ever moves zero credits.
 */
export function signAllowed(type: CreditLedgerEntryType, amount: number) {
  if (!Number.isInteger(amount) || amount === 0) return false;
  if (type === 'RECHARGE' || type === 'SERVICE_REFUND') return amount > 0;
  if (type === 'SERVICE_AWARD') return amount < 0;
  return true;
}

/**
 * The balance a movement would leave, or why it cannot be applied. Evaluated under the account row
 * lock, so balanceBefore is the committed balance no concurrent movement can change meanwhile.
 */
export function nextBalance(
  balanceBefore: number,
  amount: number,
): { balanceAfter: number } | { rejection: CreditErrorCode } {
  const balanceAfter = balanceBefore + amount;
  if (balanceAfter < 0) return { rejection: 'INSUFFICIENT_CREDITS' };
  if (balanceAfter > MAX_CREDIT_BALANCE)
    return { rejection: 'CREDIT_BALANCE_LIMIT' };
  return { balanceAfter };
}

/**
 * A credit trigger (P0001: CREDIT_LEDGER_STALE, CREDIT_BALANCE_WITHOUT_LEDGER, ...) or a CHECK
 * (23514) rejecting a ledger write. Prisma wraps them differently depending on the call, so the
 * check is on the message.
 */
export function isLedgerRejection(error: unknown) {
  const message =
    error && typeof error === 'object' && 'message' in error
      ? String((error as { message: unknown }).message)
      : '';
  return /P0001|23514|CREDIT_[A-Z_]+|CreditLedgerEntry_|CreditAccount_/.test(
    message,
  );
}
