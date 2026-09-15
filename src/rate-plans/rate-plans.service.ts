import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { ServiceType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { pageResult } from '../common/pagination.dto.js';
import { DomainException } from '../common/domain-error.js';
import { isUniqueViolation } from '../providers/provider-capacity.js';
import {
  CreateRatePlanDto,
  QUOTE_VALIDITY_LIMITS,
  RateBandDto,
  RatePlanListQueryDto,
} from './rate-plans.dto.js';
import { validateBands } from './rate-bands.js';

const bandSelect = {
  id: true,
  minDistanceMeters: true,
  maxDistanceMeters: true,
  amount: true,
  currency: true,
} as const;
const planSelect = {
  id: true,
  serviceZoneId: true,
  serviceType: true,
  version: true,
  status: true,
  calculationType: true,
  quoteValidityMinutes: true,
  currency: true,
  createdAt: true,
  updatedAt: true,
  activatedAt: true,
  deactivatedAt: true,
  serviceZone: { select: { id: true, code: true, name: true, status: true } },
  bands: { select: bandSelect, orderBy: { minDistanceMeters: 'asc' } },
} as const;
type PlanRow = Prisma.RatePlanGetPayload<{ select: typeof planSelect }>;
const view = (plan: PlanRow) => ({
  ...plan,
  bands: plan.bands.map((b) => ({ ...b, amount: b.amount.toFixed(2) })),
});
const notEditable = () =>
  new DomainException(
    'RATE_PLAN_NOT_EDITABLE',
    409,
    'Only DRAFT rate plans can be edited; clone it into a new DRAFT version',
  );

function checkValidity(serviceType: ServiceType, minutes: number) {
  const { min, max } = QUOTE_VALIDITY_LIMITS[serviceType];
  if (minutes < min || minutes > max)
    throw new BadRequestException([
      `quoteValidityMinutes must be between ${min} and ${max} for ${serviceType}`,
    ]);
}
function bandData(bands: RateBandDto[], currency: string) {
  for (const band of bands) {
    if (!new Prisma.Decimal(band.amount).gt(0))
      throw new BadRequestException([
        `band ${band.minDistanceMeters}-${band.maxDistanceMeters}: amount must be greater than 0`,
      ]);
    if (band.maxDistanceMeters <= band.minDistanceMeters)
      throw new BadRequestException([
        `band ${band.minDistanceMeters}-${band.maxDistanceMeters}: maxDistanceMeters must be greater than minDistanceMeters`,
      ]);
  }
  return bands.map((b) => ({
    minDistanceMeters: b.minDistanceMeters,
    maxDistanceMeters: b.maxDistanceMeters,
    amount: new Prisma.Decimal(b.amount),
    currency: b.currency ?? currency,
  }));
}

@Injectable()
export class RatePlansService {
  private readonly logger = new Logger(RatePlansService.name);
  constructor(private readonly prisma: PrismaService) {}

  /** Version = previous max + 1 under a zone row lock (unique zone/type/version as backstop). */
  async create(dto: CreateRatePlanDto, actorId: string) {
    checkValidity(dto.serviceType, dto.quoteValidityMinutes);
    const plan = await this.withUniqueGuard(() =>
      this.prisma.$transaction(async (tx) => {
        const [zone] = await tx.$queryRaw<
          { currency: string }[]
        >`SELECT currency FROM "ServiceZone" WHERE id = ${dto.serviceZoneId}::uuid FOR UPDATE`;
        if (!zone) throw new NotFoundException('Service zone not found');
        const version = await this.nextVersion(
          tx,
          dto.serviceZoneId,
          dto.serviceType,
        );
        return tx.ratePlan.create({
          data: {
            serviceZoneId: dto.serviceZoneId,
            serviceType: dto.serviceType,
            calculationType: dto.calculationType ?? 'DISTANCE_BANDS',
            quoteValidityMinutes: dto.quoteValidityMinutes,
            currency: zone.currency,
            version,
            bands: { create: bandData(dto.bands ?? [], zone.currency) },
          },
          select: planSelect,
        });
      }),
    );
    this.logger.log({
      event: 'RATE_PLAN_CREATED',
      ratePlanId: plan.id,
      version: plan.version,
      actorId,
    });
    return view(plan);
  }

  /** Copies any version (typically ACTIVE) into a new DRAFT with the same TTL and bands. */
  async clone(id: string, actorId: string) {
    const plan = await this.withUniqueGuard(() =>
      this.prisma.$transaction(async (tx) => {
        const source = await tx.ratePlan.findUnique({
          where: { id },
          select: planSelect,
        });
        if (!source) throw new NotFoundException('Rate plan not found');
        await tx.$queryRaw`SELECT id FROM "ServiceZone" WHERE id = ${source.serviceZoneId}::uuid FOR UPDATE`;
        const version = await this.nextVersion(
          tx,
          source.serviceZoneId,
          source.serviceType,
        );
        return tx.ratePlan.create({
          data: {
            serviceZoneId: source.serviceZoneId,
            serviceType: source.serviceType,
            calculationType: source.calculationType,
            quoteValidityMinutes: source.quoteValidityMinutes,
            currency: source.currency,
            version,
            bands: {
              create: source.bands.map((b) => ({
                minDistanceMeters: b.minDistanceMeters,
                maxDistanceMeters: b.maxDistanceMeters,
                amount: b.amount,
                currency: b.currency,
              })),
            },
          },
          select: planSelect,
        });
      }),
    );
    this.logger.log({
      event: 'RATE_PLAN_CLONED',
      ratePlanId: plan.id,
      sourceRatePlanId: id,
      version: plan.version,
      actorId,
    });
    return view(plan);
  }

  async update(id: string, quoteValidityMinutes: number, actorId: string) {
    const plan = await this.prisma.$transaction(async (tx) => {
      const current = await this.lockPlan(tx, id);
      if (current.status !== 'DRAFT') throw notEditable();
      checkValidity(current.serviceType, quoteValidityMinutes);
      return tx.ratePlan.update({
        where: { id },
        data: { quoteValidityMinutes },
        select: planSelect,
      });
    });
    this.logger.log({ event: 'RATE_PLAN_UPDATED', ratePlanId: id, actorId });
    return view(plan);
  }

  /** Replaces all bands of a DRAFT atomically. Gaps may be saved; activation rejects them. */
  async replaceBands(id: string, bands: RateBandDto[], actorId: string) {
    const plan = await this.prisma
      .$transaction(async (tx) => {
        const current = await this.lockPlan(tx, id);
        if (current.status !== 'DRAFT') throw notEditable();
        await tx.rateBand.deleteMany({ where: { ratePlanId: id } });
        await tx.rateBand.createMany({
          data: bandData(bands, current.currency).map((b) => ({
            ...b,
            ratePlanId: id,
          })),
        });
        return tx.ratePlan.findUniqueOrThrow({
          where: { id },
          select: planSelect,
        });
      })
      .catch((error: unknown) => {
        if (isUniqueViolation(error))
          throw new BadRequestException([
            'bands must not share the same minDistanceMeters',
          ]);
        throw error;
      });
    this.logger.log({
      event: 'RATE_PLAN_BANDS_REPLACED',
      ratePlanId: id,
      bands: bands.length,
      actorId,
    });
    return view(plan);
  }

  async validate(id: string) {
    const plan = await this.get(id);
    const result = validateBands(plan.bands, plan.currency);
    return { ratePlanId: id, valid: result.valid, errors: result.errors };
  }

  /** DRAFT → ACTIVE; the previous ACTIVE version becomes INACTIVE in the same transaction. */
  async activate(id: string, actorId: string) {
    const outcome = await this.withUniqueGuard(() =>
      this.prisma.$transaction(async (tx) => {
        const draft = await tx.ratePlan.findUnique({
          where: { id },
          select: planSelect,
        });
        if (!draft) throw new NotFoundException('Rate plan not found');
        // Zone lock serializes activations, clones and creations for this zone.
        await tx.$queryRaw`SELECT id FROM "ServiceZone" WHERE id = ${draft.serviceZoneId}::uuid FOR UPDATE`;
        const current = await this.lockPlan(tx, id);
        if (current.status === 'ACTIVE')
          return { plan: draft, previous: null, changed: false };
        if (current.status !== 'DRAFT')
          throw new DomainException(
            'RATE_PLAN_NOT_ACTIVATABLE',
            409,
            'Only DRAFT rate plans can be activated',
          );
        checkValidity(draft.serviceType, draft.quoteValidityMinutes);
        const { valid, errors } = validateBands(draft.bands, draft.currency);
        if (!valid)
          throw new DomainException(
            'RATE_PLAN_INVALID',
            422,
            errors.join('; '),
          );
        const now = new Date();
        const previous = await tx.ratePlan.findFirst({
          where: {
            serviceZoneId: draft.serviceZoneId,
            serviceType: draft.serviceType,
            status: 'ACTIVE',
          },
          select: { id: true },
        });
        if (previous)
          await tx.ratePlan.update({
            where: { id: previous.id },
            data: { status: 'INACTIVE', deactivatedAt: now },
          });
        const plan = await tx.ratePlan.update({
          where: { id },
          data: { status: 'ACTIVE', activatedAt: now },
          select: planSelect,
        });
        return { plan, previous: previous?.id ?? null, changed: true };
      }),
    );
    if (outcome.changed)
      this.logger.log({
        event: 'RATE_PLAN_ACTIVATED',
        ratePlanId: id,
        previousRatePlanId: outcome.previous,
        actorId,
      });
    return view(outcome.plan);
  }

  async deactivate(id: string, actorId: string) {
    const updated = await this.prisma.ratePlan.updateMany({
      where: { id, status: 'ACTIVE' },
      data: { status: 'INACTIVE', deactivatedAt: new Date() },
    });
    const plan = await this.get(id);
    if (!updated.count && plan.status === 'DRAFT')
      throw new DomainException(
        'RATE_PLAN_NOT_ACTIVE',
        409,
        'Only ACTIVE rate plans can be deactivated',
      );
    if (updated.count)
      this.logger.log({
        event: 'RATE_PLAN_DEACTIVATED',
        ratePlanId: id,
        actorId,
      });
    return plan;
  }

  async list(query: RatePlanListQueryDto) {
    const where: Prisma.RatePlanWhereInput = {
      serviceZoneId: query.serviceZoneId,
      serviceType: query.serviceType,
      status: query.status,
    };
    const [items, total] = await this.prisma.$transaction(
      [
        this.prisma.ratePlan.findMany({
          where,
          select: planSelect,
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
          orderBy: [
            { serviceZoneId: 'asc' },
            { serviceType: 'asc' },
            { version: 'desc' },
          ],
        }),
        this.prisma.ratePlan.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    return pageResult(items.map(view), total, query);
  }

  async get(id: string) {
    const plan = await this.prisma.ratePlan.findUnique({
      where: { id },
      select: planSelect,
    });
    if (!plan) throw new NotFoundException('Rate plan not found');
    return view(plan);
  }

  /** Used by quoting: the single ACTIVE plan with bands, or null. */
  findActive(serviceZoneId: string, serviceType: ServiceType) {
    return this.prisma.ratePlan.findFirst({
      where: { serviceZoneId, serviceType, status: 'ACTIVE' },
      select: planSelect,
    });
  }

  private async lockPlan(tx: Prisma.TransactionClient, id: string) {
    const [plan] = await tx.$queryRaw<
      { status: string; serviceType: ServiceType; currency: string }[]
    >`SELECT status, "serviceType", currency FROM "RatePlan" WHERE id = ${id}::uuid FOR UPDATE`;
    if (!plan) throw new NotFoundException('Rate plan not found');
    return plan;
  }
  private async nextVersion(
    tx: Prisma.TransactionClient,
    serviceZoneId: string,
    serviceType: ServiceType,
  ) {
    const last = await tx.ratePlan.aggregate({
      where: { serviceZoneId, serviceType },
      _max: { version: true },
    });
    return (last._max.version ?? 0) + 1;
  }
  private async withUniqueGuard<T>(fn: () => Promise<T>) {
    try {
      return await fn();
    } catch (error) {
      if (isUniqueViolation(error))
        throw new DomainException(
          'RATE_PLAN_CONFLICT',
          409,
          'Concurrent rate plan change; retry',
        );
      throw error;
    }
  }
}
