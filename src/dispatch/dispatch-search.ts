import type { Prisma, DispatchStatus } from '@prisma/client';
import { ApiProperty } from '@nestjs/swagger';

export interface SearchRecord {
  status: DispatchStatus | string;
  expiresAt: Date;
  searchMaxAttempts?: number;
  searchAttempt?: number;
  searchStoppedReason?: string | null;
}
export function retryPending(d: SearchRecord, now: Date) {
  return (
    d.status === 'OPEN' &&
    d.expiresAt <= now &&
    d.searchMaxAttempts === 5 &&
    (d.searchAttempt ?? 1) < 5 &&
    !d.searchStoppedReason
  );
}
export const SEARCH_STATES = [
  'SEARCHING',
  'RETRY_PENDING',
  'EXECUTOR_FOUND',
  'CANCELLED',
  'EXHAUSTED',
  'STOPPED',
] as const;
export class DispatchSearchResponse {
  @ApiProperty({ enum: SEARCH_STATES }) state!: (typeof SEARCH_STATES)[number];
  @ApiProperty({ minimum: 1, maximum: 5 }) attempt!: number;
  @ApiProperty({ enum: [5] }) maxAttempts!: number;
  @ApiProperty({ format: 'date-time' }) windowExpiresAt!: Date;
  @ApiProperty({ type: String, nullable: true }) stoppedReason!: string | null;
}
export function searchFields(
  d: SearchRecord,
  now: Date,
): { search?: DispatchSearchResponse } {
  if (d.searchMaxAttempts !== 5) return {};
  const reason = d.searchStoppedReason ?? null;
  const state =
    d.status === 'CANCELLED' || reason === 'REQUEST_CANCELLED'
      ? 'CANCELLED'
      : reason === 'EXECUTOR_FOUND' ||
          d.status === 'CLAIMED' ||
          d.status === 'DELIVERED'
        ? 'EXECUTOR_FOUND'
        : reason && reason !== 'EXHAUSTED'
          ? 'STOPPED'
          : retryPending(d, now)
            ? 'RETRY_PENDING'
            : d.status === 'EXPIRED' || d.expiresAt <= now
              ? 'EXHAUSTED'
              : 'SEARCHING';
  return {
    search: {
      state,
      attempt: d.searchAttempt ?? 1,
      maxAttempts: 5,
      windowExpiresAt: d.expiresAt,
      stoppedReason: state === 'EXHAUSTED' ? 'EXHAUSTED' : reason,
    },
  };
}
export const searchSelect = {
  searchMaxAttempts: true,
  searchAttempt: true,
  searchStoppedReason: true,
} as const;

/** Use the same clock as renewal, after acquiring the dispatch lock. */
export async function dispatchClaimTime(
  tx: Prisma.TransactionClient,
  d: SearchRecord,
) {
  if (d.searchMaxAttempts !== 5) return new Date();
  const [clock] = await tx.$queryRaw<
    { now: Date }[]
  >`SELECT dispatch_search_now() AS now`;
  return clock.now;
}
/** SQL can catch a window ending after the application checked it. The transaction rolled back. */
export function searchWindowRejection(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('DISPATCH_SEARCH_CLAIM_RETRY_PENDING'))
    return 'DISPATCH_RETRY_PENDING' as const;
  if (message.includes('DISPATCH_SEARCH_CLAIM_EXPIRED'))
    return 'DISPATCH_EXPIRED' as const;
  return null;
}
