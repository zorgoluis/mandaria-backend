import { createHash } from 'node:crypto';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { isUUID } from 'class-validator';
import type { Prisma } from '@prisma/client';
import { DomainException } from '../common/domain-error.js';

export type IndependentOperation = 'TAKE' | 'RELEASE';
export type IndependentCommandResult = {
  operation: IndependentOperation;
  dispatchId: string;
  assignmentId: string;
  dispatchStatus: 'CLAIMED' | 'OPEN' | 'EXPIRED';
  assignmentStatus: 'ACTIVE' | 'CANCELLED';
  credits: {
    awardEntryId: string | null;
    refundEntryId: string | null;
    amount: number;
  };
};
type Receipt = {
  state: 'APPLIED' | 'CLOSED_NO_EFFECTS';
  hash: string;
  response: IndependentCommandResult;
};
export function attemptKey(key: string) {
  if (!isUUID(key))
    throw new BadRequestException('Idempotency-Key must be a UUID');
  return key.toLowerCase();
}
export async function attemptLock(
  tx: Prisma.TransactionClient,
  actor: string,
  dispatch: string,
  operation: IndependentOperation,
  key: string,
) {
  // All keyed commands and closures take this lock BEFORE operational locks. A hash collision
  // only serializes unrelated intents; receipt identity still uses all four exact columns.
  const scope = `${actor.toLowerCase()}:${dispatch.toLowerCase()}:${operation}:${key}`;
  await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${scope},0))`;
}
export async function attemptActor(
  tx: Prisma.TransactionClient,
  actor: string,
) {
  const users = await tx.$queryRaw<
    { id: string }[]
  >`SELECT u.id FROM "User" u JOIN "Driver" d ON d."userId"=u.id WHERE u.id=${actor}::uuid AND u.active AND u.role='DRIVER' FOR SHARE OF u`;
  if (!users.length) throw new ForbiddenException();
}
export async function attemptReceipt(
  tx: Prisma.TransactionClient,
  actor: string,
  dispatch: string,
  operation: IndependentOperation,
  key: string,
) {
  const rows = await tx.$queryRaw<
    Receipt[]
  >`SELECT state,hash,response FROM "IndependentDispatchAttempt" WHERE "actorUserId"=${actor}::uuid AND "dispatchId"=${dispatch}::uuid AND operation=${operation} AND key=${key}::uuid`;
  return rows[0] ?? null;
}
export function attemptHash(
  body: { vehicleId: string } | { reason: string; reasonDetail?: string },
) {
  // Only validated DTO fields, with stable ordering; never persist the private release reason.
  return createHash('sha256')
    .update(
      JSON.stringify(
        'vehicleId' in body
          ? { vehicleId: body.vehicleId.toLowerCase() }
          : { reason: body.reason, reasonDetail: body.reasonDetail ?? null },
      ),
    )
    .digest('hex');
}
export function replay(receipt: Receipt, hash: string) {
  if (receipt.state === 'CLOSED_NO_EFFECTS')
    throw new DomainException(
      'INDEPENDENT_ATTEMPT_CLOSED',
      409,
      'This technical attempt is permanently closed',
    );
  if (receipt.hash !== hash)
    throw new DomainException(
      'IDEMPOTENCY_KEY_REUSED',
      409,
      'This key belongs to different command terms',
    );
  return receipt.response;
}
export async function saveAttempt(
  tx: Prisma.TransactionClient,
  actor: string,
  dispatch: string,
  operation: IndependentOperation,
  key: string,
  hash: string,
  result: IndependentCommandResult,
) {
  await tx.$executeRaw`INSERT INTO "IndependentDispatchAttempt" ("actorUserId","dispatchId",operation,key,state,hash,response) VALUES (${actor}::uuid,${dispatch}::uuid,${operation},${key}::uuid,'APPLIED',${hash},${JSON.stringify(result)}::jsonb)`;
}
