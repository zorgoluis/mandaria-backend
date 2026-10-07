import { ownerFields } from '../customers/demand-owner.js';
import { customerAttempt, CREATE_MPQ } from '../idempotency/human-attempt.js';
import type { DemandOwnerInput } from '../customers/demand-owner.js';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import type {
  ConsumptionDecision,
  PrequoteConsumption,
} from './prequote-consumption.js';
import { PrequotePublicError } from './prequote-errors.js';
import {
  consumptionRetryAt,
  routingProtectionMs,
  validateConsumptionLimits,
} from './consumption-policy.js';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
async function now(tx: Prisma.TransactionClient) {
  const [r] = await tx.$queryRaw<
    { now: Date }[]
  >`SELECT (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) AS now`;
  return r.now;
}
async function lock(tx: Prisma.TransactionClient) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(1313,5)::text`;
}
const invalid = () => new PrequotePublicError('PREQUOTE_PERMIT_INVALID');
@Injectable()
export class DurablePrequoteConsumption implements PrequoteConsumption {
  private readonly logger = new Logger(DurablePrequoteConsumption.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}
  private policy() {
    if (!this.config.get<boolean>('PREQUOTE_ENABLED'))
      throw new PrequotePublicError('PREQUOTE_DISABLED');
    try {
      const limits = validateConsumptionLimits({
        minute: this.config.getOrThrow<number>('PREQUOTE_PER_MINUTE'),
        day: this.config.getOrThrow<number>('PREQUOTE_PER_DAY'),
        concurrent: this.config.getOrThrow<number>('PREQUOTE_MAX_CONCURRENT'),
        globalUnits: this.config.getOrThrow<number>(
          'PREQUOTE_GLOBAL_DAILY_ROUTING_UNITS',
        ),
        reserveMs: this.config.getOrThrow<number>('PREQUOTE_PERMIT_RESERVE_MS'),
        retries: this.config.getOrThrow<number>('GOOGLE_ROUTES_MAX_RETRIES'),
        timeoutMs: this.config.getOrThrow<number>('GOOGLE_ROUTES_TIMEOUT_MS'),
      });
      return { limits, fingerprint: hash(JSON.stringify(limits)) };
    } catch {
      throw new PrequotePublicError('PREQUOTE_CONSUMPTION_UNAVAILABLE');
    }
  }
  private async checkedPolicy(tx: Prisma.TransactionClient) {
    const policy = this.policy();
    await tx.prequoteConsumptionPolicy.createMany({
      data: { id: 1, fingerprint: policy.fingerprint },
      skipDuplicates: true,
    });
    const stored = await tx.prequoteConsumptionPolicy.findUniqueOrThrow({
      where: { id: 1 },
    });
    if (stored.fingerprint !== policy.fingerprint)
      throw new PrequotePublicError('PREQUOTE_CONSUMPTION_UNAVAILABLE');
    return policy;
  }
  async admit(
    integrationClientId: DemandOwnerInput,
    attemptKey?: string,
  ): Promise<ConsumptionDecision> {
    this.policy();
    const owner = randomBytes(32).toString('hex');
    const result = await this.prisma.$transaction(async (tx) => {
      const attempt = attemptKey
        ? await customerAttempt(tx, integrationClientId, attemptKey, CREATE_MPQ)
        : null;
      await lock(tx);
      const { limits, fingerprint } = await this.checkedPolicy(tx);
      const time = await now(tx);
      // Bounded lazy state recovery; expired rows are excluded by projection even beyond this batch.
      const expired = await tx.prequoteConsumptionPermit.findMany({
        where: {
          OR: [
            { state: 'RESERVED', reserveExpiresAt: { lte: time } },
            { state: 'STARTED', protectedUntil: { lte: time } },
          ],
        },
        orderBy: { id: 'asc' },
        take: 100,
      });
      for (const row of expired)
        await tx.prequoteConsumptionPermit.update({
          where: { id: row.id },
          data: {
            state: row.state === 'RESERVED' ? 'EXPIRED' : 'ABANDONED',
            finishedAt: time,
          },
        });
      const rows = await tx.prequoteConsumptionPermit.findMany({
        where: {
          OR: [
            { state: 'RESERVED', reserveExpiresAt: { gt: time } },
            { startedAt: { gt: new Date(time.getTime() - 86400000) } },
            { protectedUntil: { gt: time } },
          ],
        },
      });
      const retryAt = consumptionRetryAt(
        rows,
        integrationClientId,
        limits,
        time,
      );
      if (retryAt)
        return {
          admitted: false as const,
          code: 'PREQUOTE_CONSUMPTION_LIMIT' as const,
          retryAt,
          recovered: expired.length,
        };
      const permit = await tx.prequoteConsumptionPermit.create({
        data: {
          id: randomUUID(),
          humanAttemptId: attempt?.id,
          ...ownerFields(integrationClientId),
          ownerHash: hash(owner),
          policyFingerprint: fingerprint,
          state: 'RESERVED',
          units: limits.retries + 1,
          routingBudgetMs: routingProtectionMs(limits),
          reservedAt: time,
          reserveExpiresAt: new Date(time.getTime() + limits.reserveMs),
        },
      });
      return {
        admitted: true as const,
        id: permit.id,
        recovered: expired.length,
      };
    });
    if (result.recovered)
      this.logger.log({
        event: 'PREQUOTE_PERMIT_RECOVERED',
        code: 'EXPIRED_PROTECTION',
        count: result.recovered,
      });
    if (!result.admitted) {
      this.logger.warn({
        event: 'PREQUOTE_ADMISSION_DENIED',
        code: result.code,
      });
      return result;
    }
    return {
      admitted: true,
      permit: {
        start: () => this.startPermit(result.id, owner),
        assertReady: () => this.assertReady(result.id, owner),
        finish: (outcome) => this.finishPermit(result.id, owner, outcome),
      },
    };
  }
  async startPermit(id: string, owner: string) {
    await this.prisma.$transaction(async (tx) => {
      await this.attemptPermit(tx, id, true);
      await lock(tx);
      const { fingerprint } = await this.checkedPolicy(tx);
      const p = await tx.prequoteConsumptionPermit.findUnique({
        where: { id },
      });
      const time = await now(tx);
      if (
        !p ||
        p.ownerHash !== hash(owner) ||
        p.state !== 'RESERVED' ||
        p.reserveExpiresAt <= time ||
        p.policyFingerprint !== fingerprint
      )
        throw invalid();
      await tx.prequoteConsumptionPermit.update({
        where: { id },
        data: {
          state: 'STARTED',
          startedAt: time,
          startBy: new Date(time.getTime() + 5000),
          protectedUntil: new Date(time.getTime() + p.routingBudgetMs),
        },
      });
    });
    this.logger.log({
      event: 'PREQUOTE_CONSUMPTION_STARTED',
      code: 'POTENTIAL_ROUTING_CONSUMED',
    });
  }
  async assertReady(id: string, owner: string) {
    const { fingerprint } = this.policy();
    await this.prisma.$transaction(async (tx) => {
      await this.attemptPermit(tx, id, false);
      const policy = await tx.prequoteConsumptionPolicy.findUnique({
        where: { id: 1 },
      });
      if (policy?.fingerprint !== fingerprint)
        throw new PrequotePublicError('PREQUOTE_CONSUMPTION_UNAVAILABLE');
      const p = await tx.prequoteConsumptionPermit.findUnique({
        where: { id },
      });
      const time = await now(tx);
      if (
        !p ||
        p.ownerHash !== hash(owner) ||
        p.state !== 'STARTED' ||
        !p.startBy ||
        p.startBy <= time ||
        p.policyFingerprint !== fingerprint
      )
        throw invalid();
    });
  }
  private async attemptPermit(
    tx: Prisma.TransactionClient,
    id: string,
    starting: boolean,
  ) {
    const permit = await tx.prequoteConsumptionPermit.findUnique({
      where: { id },
      include: { humanAttempt: true },
    });
    if (!permit?.humanAttempt) return;
    const a = permit.humanAttempt;
    const fence = await customerAttempt(
      tx,
      { kind: 'CUSTOMER', id: a.ownerId },
      a.key,
      CREATE_MPQ,
    );
    if (starting && fence)
      await tx.humanCommandAttempt.update({
        where: { id: fence.id },
        data: { routingEffectsPossible: true },
      });
  }
  async finishPermit(
    id: string,
    owner: string,
    outcome: { routingStarted: boolean; published: boolean },
  ) {
    await this.prisma.$transaction(async (tx) => {
      await lock(tx);
      const p = await tx.prequoteConsumptionPermit.findUnique({
        where: { id },
      });
      if (!p || p.ownerHash !== hash(owner)) throw invalid();
      if (!['RESERVED', 'STARTED'].includes(p.state)) return;
      const time = await now(tx);
      await tx.prequoteConsumptionPermit.update({
        where: { id },
        data:
          p.state === 'RESERVED'
            ? {
                state: 'CANCELLED',
                finishedAt: time,
                routingReported: false,
                publishedReported: false,
              }
            : {
                state: 'FINISHED',
                finishedAt: time,
                routingReported: outcome.routingStarted,
                publishedReported: outcome.published,
              },
      });
    });
    this.logger.log({
      event: 'PREQUOTE_CONSUMPTION_FINISHED',
      code: 'CONSUMPTION_EVIDENCE_PRESERVED',
    });
  }
}
