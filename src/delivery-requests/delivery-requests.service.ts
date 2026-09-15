import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { pageResult } from '../common/pagination.dto.js';
import { IdempotencyService } from '../idempotency/idempotency.service.js';
import {
  AdminDeliveryRequestListQueryDto,
  CreateDeliveryRequestDto,
  DeliveryRequestListQueryDto,
} from './delivery-requests.dto.js';
import {
  deliveryRequestDetailSelect,
  deliveryRequestSummarySelect,
  toDetail,
  toSummary,
} from './delivery-request.select.js';

export type DeliveryActor =
  | { type: 'INTEGRATION'; integrationClientId: string }
  | { type: 'USER'; userId: string };

/** Formats the sequence value without truncating beyond six digits. */
export const formatPublicId = (value: bigint | number) =>
  `MDR-${String(value).padStart(6, '0')}`;

const invalid = (message: string) => new BadRequestException([message]);

/**
 * Validates cross-field rules that DTO decorators cannot express and returns the
 * normalized payload used both for persistence and for the idempotency fingerprint.
 */
export function normalizeDeliveryRequest(dto: CreateDeliveryRequestDto) {
  const stops = [...dto.stops].sort((a, b) => a.sequence - b.sequence);
  const layout = stops.map((s) => `${s.sequence}:${s.type}`).join(',');
  if (layout !== '1:PICKUP,2:DROPOFF')
    throw invalid(
      'stops must contain exactly one PICKUP with sequence 1 and one DROPOFF with sequence 2',
    );
  const financial = dto.financialContext;
  const goodsValue =
    financial.goodsValue === undefined || financial.goodsValue === null
      ? null
      : new Prisma.Decimal(financial.goodsValue);
  if (goodsValue && goodsValue.lte(0))
    throw invalid('financialContext.goodsValue must be greater than 0');
  if (financial.goodsPaymentMode === 'COURIER_ADVANCE' && !goodsValue)
    throw invalid(
      'financialContext.goodsValue is required and must be greater than 0 for COURIER_ADVANCE',
    );
  return {
    externalReference: dto.externalReference ?? null,
    stops: stops.map((s) => ({
      type: s.type,
      sequence: s.sequence,
      address: s.address,
      latitude: s.latitude,
      longitude: s.longitude,
      contactName: s.contactName,
      contactPhone: s.contactPhone,
      instructions: s.instructions ?? null,
    })),
    packages: dto.packages.map((p) => ({
      category: p.category,
      description: p.description,
      quantity: p.quantity,
      weightKg: p.weightKg ?? null,
      lengthCm: p.lengthCm ?? null,
      widthCm: p.widthCm ?? null,
      heightCm: p.heightCm ?? null,
      isFragile: p.isFragile ?? false,
      handlingInstructions: p.handlingInstructions ?? null,
    })),
    financialContext: {
      // Canonical 2-decimal string: "450", 450 and "450.00" are the same request.
      goodsValue: goodsValue ? goodsValue.toFixed(2) : null,
      goodsPaymentMode: financial.goodsPaymentMode,
      currency: financial.currency,
    },
  };
}

@Injectable()
export class DeliveryRequestsService {
  private readonly logger = new Logger(DeliveryRequestsService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly idempotency: IdempotencyService,
  ) {}

  async create(
    integrationClientId: string,
    idempotencyKey: string,
    dto: CreateDeliveryRequestDto,
  ) {
    const payload = normalizeDeliveryRequest(dto);
    const outcome = await this.idempotency.execute(
      {
        integrationClientId,
        key: idempotencyKey,
        operation: 'delivery_requests.create',
        resourceType: 'DeliveryRequest',
      },
      payload,
      async (tx, id) => {
        // Sequence values are never handed out twice, even across concurrent transactions.
        const [{ value }] = await tx.$queryRaw<
          { value: bigint }[]
        >`SELECT nextval('"DeliveryRequest_publicId_seq"') AS value`;
        await tx.deliveryRequest.create({
          data: {
            id,
            publicId: formatPublicId(value),
            integrationClientId,
            externalReference: payload.externalReference,
            stops: { create: payload.stops },
            packages: { create: payload.packages },
            financialContext: { create: payload.financialContext },
          },
        });
      },
      (id) => this.findDetail({ id }),
    );
    if (!outcome.replayed)
      this.logger.log({
        event: 'DELIVERY_REQUEST_CREATED',
        deliveryRequestId: outcome.result.id,
        publicId: outcome.result.publicId,
        integrationClientId,
        actorType: 'INTEGRATION',
        actorId: integrationClientId,
      });
    return outcome;
  }

  async list(
    query: AdminDeliveryRequestListQueryDto | DeliveryRequestListQueryDto,
    integrationClientId?: string,
  ) {
    if (
      query.requestedFrom &&
      query.requestedTo &&
      new Date(query.requestedFrom) > new Date(query.requestedTo)
    )
      throw invalid('requestedFrom must be before or equal to requestedTo');
    const where: Prisma.DeliveryRequestWhereInput = {
      // B2B callers are always scoped to themselves; only admins may filter by client.
      integrationClientId:
        integrationClientId ??
        ('integrationClientId' in query
          ? query.integrationClientId
          : undefined),
      publicId: query.publicId,
      externalReference: query.externalReference,
      status: query.status,
      requestedAt:
        query.requestedFrom || query.requestedTo
          ? {
              gte: query.requestedFrom
                ? new Date(query.requestedFrom)
                : undefined,
              lte: query.requestedTo ? new Date(query.requestedTo) : undefined,
            }
          : undefined,
    };
    const [items, total] = await this.prisma.$transaction(
      [
        this.prisma.deliveryRequest.findMany({
          where,
          select: deliveryRequestSummarySelect,
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
          orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
        }),
        this.prisma.deliveryRequest.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    return pageResult(items.map(toSummary), total, query);
  }

  /** Foreign and missing requests are indistinguishable (404). */
  async findDetail(
    where: { id: string } | { publicId: string },
    integrationClientId?: string,
  ) {
    const request = await this.prisma.deliveryRequest.findFirst({
      where: { ...where, integrationClientId },
      select: deliveryRequestDetailSelect,
    });
    if (!request) throw new NotFoundException('Delivery request not found');
    return toDetail(request);
  }

  /**
   * CREATED → CANCELLED. Cancelling an already CANCELLED request returns it unchanged
   * (original reason and timestamp are preserved) and emits no new audit event.
   */
  async cancel(publicId: string, reason: string, actor: DeliveryActor) {
    const scope =
      actor.type === 'INTEGRATION'
        ? { integrationClientId: actor.integrationClientId }
        : {};
    const updated = await this.prisma.deliveryRequest.updateMany({
      where: { publicId, status: 'CREATED', ...scope },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancellationReason: reason,
      },
    });
    const request = await this.findDetail(
      { publicId },
      scope.integrationClientId,
    );
    if (updated.count)
      this.logger.log({
        event: 'DELIVERY_REQUEST_CANCELLED',
        deliveryRequestId: request.id,
        publicId,
        integrationClientId: request.integrationClientId,
        actorType: actor.type,
        actorId:
          actor.type === 'INTEGRATION'
            ? actor.integrationClientId
            : actor.userId,
      });
    return request;
  }
}
