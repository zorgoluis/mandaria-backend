import type { PrismaClient } from '@prisma/client';

/**
 * The slice of the Prisma Client the credit fixtures actually touch.
 *
 * The migration checks reconstruct a historical backend and generate its Prisma Client for the
 * schema of that moment, then reuse these same fixtures against it. A client generated for an
 * older schema cannot have the models added later, so demanding the whole current `PrismaClient`
 * rejected it over `DispatchPreEnforcementAward`, a model these fixtures never use. Declaring what
 * they need instead keeps both clients valid with no cast and no suppression.
 *
 * Callers holding a full `PrismaClient` pass it unchanged.
 */
export type CreditFixtureClient = Pick<
  PrismaClient,
  | '$queryRawUnsafe'
  | '$transaction'
  | 'user'
  | 'creditAccount'
  | 'creditLedgerEntry'
  | 'creditPolicy'
>;
