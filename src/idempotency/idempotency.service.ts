import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';

export type IdempotencyScope = {
  integrationClientId: string;
  key: string;
  /** Logical operation, part of the fingerprint (e.g. delivery_requests.create). */
  operation: string;
  resourceType: string;
};

/** Stable JSON: sorted object keys, undefined dropped, arrays keep their order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(',')}}`;
  return JSON.stringify(value ?? null);
}
export const fingerprint = (operation: string, payload: unknown) =>
  createHash('sha256')
    .update(canonicalJson({ operation, payload }))
    .digest('hex');

/**
 * Reusable B2B idempotency. The ledger row is inserted first inside the same transaction
 * that creates the resource; the unique (integrationClientId, key) index makes a concurrent
 * duplicate wait for that transaction and then fail, after which it replays the committed
 * result or reports a payload conflict. Only a hash of the normalized payload is stored.
 */
@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);
  constructor(private readonly prisma: PrismaService) {}

  async execute<T>(
    scope: IdempotencyScope,
    payload: unknown,
    create: (tx: Prisma.TransactionClient, resourceId: string) => Promise<void>,
    load: (resourceId: string) => Promise<T>,
  ): Promise<{ result: T; replayed: boolean }> {
    const requestHash = fingerprint(scope.operation, payload);
    const existing = await this.find(scope);
    if (existing) return this.replay(scope, existing, requestHash, load);
    const resourceId = randomUUID();
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.apiIdempotencyRecord.create({
          data: { ...scope, requestHash, resourceId },
        });
        await create(tx, resourceId);
      });
    } catch (error) {
      const winner =
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
          ? await this.find(scope)
          : null;
      if (!winner) throw error;
      return this.replay(scope, winner, requestHash, load);
    }
    return { result: await load(resourceId), replayed: false };
  }

  private find(scope: IdempotencyScope) {
    return this.prisma.apiIdempotencyRecord.findUnique({
      where: {
        integrationClientId_key: {
          integrationClientId: scope.integrationClientId,
          key: scope.key,
        },
      },
      select: { requestHash: true, resourceId: true, resourceType: true },
    });
  }

  private async replay<T>(
    scope: IdempotencyScope,
    record: { requestHash: string; resourceId: string; resourceType: string },
    requestHash: string,
    load: (resourceId: string) => Promise<T>,
  ) {
    if (
      record.requestHash !== requestHash ||
      record.resourceType !== scope.resourceType
    ) {
      this.logger.warn({
        event: 'IDEMPOTENCY_CONFLICT',
        integrationClientId: scope.integrationClientId,
        operation: scope.operation,
      });
      throw new ConflictException(
        'Idempotency-Key was already used with a different request',
      );
    }
    this.logger.log({
      event: 'IDEMPOTENCY_REPLAY',
      integrationClientId: scope.integrationClientId,
      operation: scope.operation,
      resourceId: record.resourceId,
    });
    return { result: await load(record.resourceId), replayed: true };
  }
}
