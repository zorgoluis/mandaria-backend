import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CreditAccountOwnerType, ServiceType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { pageResult } from '../common/pagination.dto.js';
import { DomainException } from '../common/domain-error.js';
import { isUniqueViolation } from '../providers/provider-capacity.js';
import {
  calculateCreditCost,
  creditPolicyError,
  validatePolicyConfig,
} from './credit-policy-engine.js';
import type { PolicyConfig } from './credit-policy-engine.js';

const rangeSelect = {
  id: true,
  position: true,
  minDistanceMeters: true,
  maxDistanceMeters: true,
  credits: true,
} as const;
export const creditPolicySelect = {
  id: true,
  serviceType: true,
  actorType: true,
  version: true,
  status: true,
  calculationType: true,
  creditsPerKm: true,
  minimumCredits: true,
  flatCredits: true,
  effectiveFrom: true,
  effectiveUntil: true,
  reason: true,
  createdByUserId: true,
  createdAt: true,
  ranges: { select: rangeSelect, orderBy: { position: 'asc' } },
} satisfies Prisma.CreditPolicySelect;
export type CreditPolicyRecord = Prisma.CreditPolicyGetPayload<{
  select: typeof creditPolicySelect;
}>;

type Db = Prisma.TransactionClient | PrismaService;
type Actor = { userId: string };
type Combination = {
  serviceType: ServiceType;
  actorType: CreditAccountOwnerType;
};
/** Namespace of the per-combination advisory lock (the zone activation lock is 71_600_001). */
const POLICY_LOCK_NAMESPACE = 71_600_020;

@Injectable()
export class CreditPoliciesService {
  private readonly logger = new Logger(CreditPoliciesService.name);
  constructor(private readonly prisma: PrismaService) {}

  // ------------------------------------------------------------------ resolution + calculation

  /**
   * The single ACTIVE policy of a service type and actor, or CREDIT_POLICY_UNAVAILABLE. Never
   * picks an arbitrary version and never turns a missing policy into a free service: the caller
   * must fail closed. The partial unique index guarantees there is at most one.
   */
  async resolveActivePolicy(
    serviceType: ServiceType,
    actorType: CreditAccountOwnerType,
    db: Db = this.prisma,
  ) {
    const policy = await db.creditPolicy.findFirst({
      where: { serviceType, actorType, status: 'ACTIVE' },
      select: creditPolicySelect,
    });
    if (!policy)
      throw creditPolicyError(
        'CREDIT_POLICY_UNAVAILABLE',
        `No ACTIVE credit policy for ${serviceType} / ${actorType}`,
      );
    return policy;
  }

  /**
   * Resolves the ACTIVE policy and calculates the cost of a service with the canonical distance
   * already computed by Mandaria. Reads policies only: no routing, no account, no ledger.
   */
  async calculate(
    serviceType: ServiceType,
    actorType: CreditAccountOwnerType,
    distanceMeters: number,
    db: Db = this.prisma,
  ) {
    const policy = await this.resolveActivePolicy(serviceType, actorType, db);
    return calculateCreditCost({ policy, distanceMeters });
  }

  // ------------------------------------------------------------------ reads

  async list(query: {
    page: number;
    pageSize: number;
    serviceType?: ServiceType;
    actorType?: CreditAccountOwnerType;
    status?: 'ACTIVE' | 'INACTIVE';
  }) {
    const where: Prisma.CreditPolicyWhereInput = {
      serviceType: query.serviceType,
      actorType: query.actorType,
      status: query.status,
    };
    const [items, total] = await this.prisma.$transaction(
      [
        this.prisma.creditPolicy.findMany({
          where,
          select: creditPolicySelect,
          orderBy: [
            { serviceType: 'asc' },
            { actorType: 'asc' },
            { version: 'desc' },
          ],
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
        }),
        this.prisma.creditPolicy.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    return pageResult(items, total, query);
  }

  async get(id: string) {
    const policy = await this.prisma.creditPolicy.findUnique({
      where: { id },
      select: creditPolicySelect,
    });
    if (!policy) throw new NotFoundException('Credit policy not found');
    return policy;
  }

  // ------------------------------------------------------------------ writes

  /** Version 1 of a combination that has never had a policy. Later changes use createVersion. */
  async createInitial(
    input: Combination & PolicyConfig & { reason?: string },
    actor: Actor,
  ) {
    const ranges = this.validated(input);
    const policy = await this.guarded(() =>
      this.prisma.$transaction(async (tx) => {
        await this.lockCombination(tx, input);
        const existing = await tx.creditPolicy.findFirst({
          where: { serviceType: input.serviceType, actorType: input.actorType },
          orderBy: { version: 'desc' },
          select: { id: true, version: true },
        });
        if (existing)
          throw creditPolicyError(
            'CREDIT_POLICY_EXISTS',
            `${input.serviceType} / ${input.actorType} already has policies (latest v${existing.version}); create a new version from the ACTIVE one`,
          );
        return this.insert(tx, input, 1, ranges, actor, new Date());
      }),
    );
    this.logger.log({
      event: 'CREDIT_POLICY_CREATED',
      ...this.auditFields(policy),
      actorUserId: actor.userId,
    });
    return policy;
  }

  /**
   * A new version of the combination of `baseId`, which must be its current ACTIVE version: in one
   * transaction, under a per-combination lock, the base becomes INACTIVE (effectiveUntil = now) and
   * the new version is inserted ACTIVE with version max + 1 (effectiveFrom = now). The base row is
   * never edited otherwise. Basing a version on a superseded one — typically the loser of two
   * concurrent requests — is a 409 CREDIT_POLICY_VERSION_CONFLICT: nothing is written.
   */
  async createVersion(
    baseId: string,
    input: PolicyConfig & { reason?: string },
    actor: Actor,
  ) {
    const ranges = this.validated(input);
    const outcome = await this.guarded(() =>
      this.prisma.$transaction(async (tx) => {
        const base = await tx.creditPolicy.findUnique({
          where: { id: baseId },
          select: {
            id: true,
            serviceType: true,
            actorType: true,
            version: true,
          },
        });
        if (!base) throw new NotFoundException('Credit policy not found');
        await this.lockCombination(tx, base);
        const active = await tx.creditPolicy.findFirst({
          where: {
            serviceType: base.serviceType,
            actorType: base.actorType,
            status: 'ACTIVE',
          },
          select: { id: true, version: true },
        });
        if (!active || active.id !== base.id)
          throw creditPolicyError(
            'CREDIT_POLICY_VERSION_CONFLICT',
            active
              ? `v${base.version} is not the ACTIVE version (v${active.version} is); base the new version on it`
              : `${base.serviceType} / ${base.actorType} has no ACTIVE version`,
          );
        const [{ next }] = await tx.$queryRaw<{ next: number }[]>`
          SELECT (coalesce(max(version), 0) + 1)::int AS next FROM "CreditPolicy"
           WHERE "serviceType" = ${base.serviceType}::"ServiceType" AND "actorType" = ${base.actorType}::"CreditAccountOwnerType"`;
        const now = new Date();
        await tx.creditPolicy.update({
          where: { id: base.id },
          data: { status: 'INACTIVE', effectiveUntil: now },
        });
        const policy = await this.insert(
          tx,
          {
            ...input,
            serviceType: base.serviceType,
            actorType: base.actorType,
          },
          next,
          ranges,
          actor,
          now,
        );
        return { previous: base, policy };
      }),
    );
    this.logger.log({
      event: 'CREDIT_POLICY_VERSIONED',
      ...this.auditFields(outcome.policy),
      previousPolicyId: outcome.previous.id,
      previousVersion: outcome.previous.version,
      actorUserId: actor.userId,
    });
    return outcome.policy;
  }

  // ------------------------------------------------------------------ internals

  private validated(input: PolicyConfig) {
    const result = validatePolicyConfig(input);
    if (!result.valid) throw new BadRequestException(result.errors);
    return result.ranges;
  }

  /** Serializes every write of one serviceType + actorType; the unique indexes are the backstop. */
  private async lockCombination(tx: Prisma.TransactionClient, c: Combination) {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(${POLICY_LOCK_NAMESPACE}::int, hashtext(${`${c.serviceType}:${c.actorType}`}))`;
  }

  private insert(
    tx: Prisma.TransactionClient,
    input: Combination & PolicyConfig & { reason?: string },
    version: number,
    ranges: ReturnType<typeof validatePolicyConfig>['ranges'],
    actor: Actor,
    now: Date,
  ) {
    const type = input.calculationType;
    return tx.creditPolicy.create({
      data: {
        serviceType: input.serviceType,
        actorType: input.actorType,
        version,
        status: 'ACTIVE',
        calculationType: type,
        creditsPerKm: type === 'PER_KM' ? input.creditsPerKm : null,
        minimumCredits: type === 'PER_KM' ? input.minimumCredits : null,
        flatCredits: type === 'FLAT' ? input.flatCredits : null,
        effectiveFrom: now,
        reason: input.reason ?? null,
        createdByUserId: actor.userId,
        ranges: {
          create: ranges.map((r) => ({
            position: r.position,
            minDistanceMeters: r.minDistanceMeters,
            maxDistanceMeters: r.maxDistanceMeters,
            credits: r.credits,
          })),
        },
      },
      select: creditPolicySelect,
    });
  }

  /**
   * Under the lock these never fire; if some other writer raced past it, PostgreSQL refuses the
   * second version or the second ACTIVE, and that is a conflict — never a 500, never corruption.
   */
  private async guarded<T>(fn: () => Promise<T>) {
    try {
      return await fn();
    } catch (error) {
      if (
        error instanceof DomainException ||
        error instanceof NotFoundException ||
        error instanceof BadRequestException
      )
        throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (
        isUniqueViolation(error) ||
        /CREDIT_POLICY_(VERSION_INVALID|INVALID)|CreditPolicy_active_key/.test(
          message,
        )
      )
        throw creditPolicyError(
          'CREDIT_POLICY_VERSION_CONFLICT',
          'Another version of this credit policy was created at the same time; reload and retry',
        );
      throw error;
    }
  }

  private auditFields(policy: CreditPolicyRecord) {
    return {
      policyId: policy.id,
      serviceType: policy.serviceType,
      actorType: policy.actorType,
      version: policy.version,
      calculationType: policy.calculationType,
      creditsPerKm: policy.creditsPerKm,
      minimumCredits: policy.minimumCredits,
      flatCredits: policy.flatCredits,
      ranges: policy.ranges.map((r) => [
        r.minDistanceMeters,
        r.maxDistanceMeters,
        r.credits,
      ]),
      effectiveFrom: policy.effectiveFrom,
    };
  }
}
