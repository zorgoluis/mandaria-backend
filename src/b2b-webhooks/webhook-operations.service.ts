import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { DomainException } from '../common/domain-error.js';
import { pageResult } from '../common/pagination.dto.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { B2bWebhooksService } from './b2b-webhooks.service.js';
import { publicType, transportOf } from './webhook-operations.js';
import type { EndpointRow } from './webhook-operations.js';
import type { AdminEventListQueryDto } from './b2b-webhooks.dto.js';

/** An administrator put an exhausted handover back in the queue. */
export const WEBHOOK_RESCUED_EVENT = 'B2B_WEBHOOK_RESCUED';
/** An administrator asked for a handover to be attempted now. */
export const WEBHOOK_REDELIVERY_EVENT = 'B2B_WEBHOOK_REDELIVERY_REQUESTED';

/** Everything the listing shows, read in one query instead of five. */
const listSelect = {
  id: true,
  type: true,
  occurredAt: true,
  recordedAt: true,
  integrationClientId: true,
  integrationClient: { select: { name: true, code: true } },
  deliveryRequest: { select: { publicId: true, externalReference: true } },
  delivery: {
    select: {
      state: true,
      attemptCount: true,
      nextAttemptAt: true,
      lastAttemptAt: true,
      deliveredAt: true,
      exhaustedAt: true,
      leaseExpiresAt: true,
    },
  },
} as const;

/**
 * V1.12-E: the operational view of what Mandaria owes its B2B clients.
 *
 * It reads; it does not deliver. The one thing it can start is the machinery V1.12-D already
 * has — an attempt now, or putting an exhausted handover back in the queue — and it says which of
 * the two happened rather than reporting success for work that was merely scheduled.
 */
@Injectable()
export class WebhookOperationsService {
  private readonly logger = new Logger(WebhookOperationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly webhooks: B2bWebhooksService,
  ) {}

  /**
   * The endpoints, read once per listing so the transport of an event outside reliable delivery
   * can still be explained without a query per row.
   */
  private async endpoints() {
    const rows = await this.prisma.b2bWebhookEndpoint.findMany({
      select: {
        integrationClientId: true,
        enabled: true,
        deliverFrom: true,
        secretCiphertext: true,
      },
    });
    return new Map(rows.map((r) => [r.integrationClientId, r]));
  }

  /** Newest first, with the id as a stable tiebreak so paging never repeats or skips a row. */
  async list(query: AdminEventListQueryDto) {
    if (
      query.occurredFrom &&
      query.occurredTo &&
      new Date(query.occurredFrom) > new Date(query.occurredTo)
    )
      throw new DomainException(
        'VALIDATION_ERROR',
        400,
        'occurredFrom must be before or equal to occurredTo',
      );
    const where: Prisma.B2bOutboxEventWhereInput = {
      integrationClientId: query.integrationClientId,
      type: query.type,
      deliveryRequest: {
        publicId: query.deliveryRequestPublicId?.toUpperCase(),
        externalReference: query.externalReference,
      },
      occurredAt:
        query.occurredFrom || query.occurredTo
          ? {
              gte: query.occurredFrom
                ? new Date(query.occurredFrom)
                : undefined,
              lte: query.occurredTo ? new Date(query.occurredTo) : undefined,
            }
          : undefined,
      // NO_DELIVERY is derived, so it is expressed here as "has no transport state" rather than
      // as a column that does not exist.
      delivery:
        query.transportState === 'NO_DELIVERY'
          ? { is: null }
          : query.transportState
            ? { is: { state: query.transportState } }
            : undefined,
    };
    const [rows, total, endpoints] = await Promise.all([
      this.prisma.b2bOutboxEvent.findMany({
        where,
        select: listSelect,
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      }),
      this.prisma.b2bOutboxEvent.count({ where }),
      this.endpoints(),
    ]);
    const now = new Date();
    return pageResult(
      rows.map((row) => this.summary(row, endpoints, now)),
      total,
      query,
    );
  }

  private summary(
    row: Prisma.B2bOutboxEventGetPayload<{ select: typeof listSelect }>,
    endpoints: Map<string, EndpointRow & object>,
    now: Date,
  ) {
    const transport = transportOf(
      row,
      row.delivery,
      endpoints.get(row.integrationClientId) ?? null,
      now,
    );
    return {
      eventId: row.id,
      type: publicType(row.type),
      occurredAt: row.occurredAt,
      recordedAt: row.recordedAt,
      integrationClientId: row.integrationClientId,
      integrationClientName: row.integrationClient.name,
      integrationClientCode: row.integrationClient.code,
      // The two handles an operator is given when a client asks about one order.
      deliveryRequestPublicId: row.deliveryRequest.publicId,
      externalReference: row.deliveryRequest.externalReference,
      transportState: transport.state,
      noDeliveryReason: transport.reason,
      attemptCount: transport.attemptCount,
      lastAttemptAt: transport.lastAttemptAt,
      nextAttemptAt: transport.nextAttemptAt,
      deliveredAt: transport.deliveredAt,
      exhaustedAt: transport.exhaustedAt,
      inFlight: transport.inFlight,
    };
  }

  /**
   * Everything about one event in a single answer: the envelope, the frozen public snapshot the
   * client was meant to receive, who owns it, where it was being sent, how the transport is going
   * and what happened on each attempt. No secret in any form.
   */
  async detail(eventId: string) {
    const event = await this.prisma.b2bOutboxEvent.findUnique({
      where: { id: eventId },
      select: {
        ...listSelect,
        payload: true,
        dispatchId: true,
        deliveryRequestId: true,
      },
    });
    if (!event) throw new NotFoundException('B2B event not found');
    const endpoint = await this.prisma.b2bWebhookEndpoint.findUnique({
      where: { integrationClientId: event.integrationClientId },
      select: {
        id: true,
        url: true,
        enabled: true,
        deliverFrom: true,
        secretCiphertext: true,
        secretSetAt: true,
      },
    });
    const attempts = await this.prisma.b2bWebhookDeliveryAttempt.findMany({
      where: { eventId },
      orderBy: [{ attemptedAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        attemptNumber: true,
        attemptedAt: true,
        durationMs: true,
        result: true,
        httpStatus: true,
        failureKind: true,
        failureDetail: true,
        endpointUrl: true,
      },
    });
    const now = new Date();
    const transport = transportOf(event, event.delivery, endpoint, now);
    return {
      ...this.summary(
        event,
        new Map(endpoint ? [[event.integrationClientId, endpoint]] : []),
        now,
      ),
      // The very snapshot V1.12-B froze, not a reconstruction.
      payload: event.payload,
      endpoint: endpoint
        ? {
            id: endpoint.id,
            url: endpoint.url,
            enabled: endpoint.enabled,
            deliverFrom: endpoint.deliverFrom,
            // Whether there is a secret, never the secret and never its ciphertext.
            secretConfigured: endpoint.secretCiphertext !== null,
            secretSetAt: endpoint.secretSetAt,
          }
        : null,
      inFlight: transport.inFlight,
      attempts,
    };
  }

  /**
   * Puts an exhausted handover back in the queue: `EXHAUSTED → PENDING`, due now. It does not
   * attempt anything here, so the answer says «rescheduled» and not «delivered»; the worker picks
   * it up like any other pending work.
   *
   * Nothing of the history is erased: the attempts stay, the count keeps growing from where it
   * was, and the event is untouched. Because the count is not reset, a rescue buys one more
   * attempt; a handover that fails again returns to EXHAUSTED and can be rescued again.
   *
   * Two simultaneous rescues cannot disagree: the row is locked, and a second one finds it already
   * PENDING and says so instead of queueing it twice.
   */
  async rescue(eventId: string, actorUserId: string) {
    const outcome = await this.prisma.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<
        { id: string; state: string; attemptCount: number }[]
      >`SELECT "id", "state", "attemptCount" FROM "B2bWebhookDelivery"
          WHERE "eventId" = ${eventId}::uuid FOR UPDATE`;
      if (!row) return { kind: 'NO_DELIVERY' as const };
      if (row.state === 'DELIVERED')
        return { kind: 'ALREADY_DELIVERED' as const };
      if (row.state === 'PENDING') return { kind: 'ALREADY_PENDING' as const };
      await tx.b2bWebhookDelivery.update({
        where: { id: row.id },
        data: {
          state: 'PENDING',
          nextAttemptAt: new Date(),
          exhaustedAt: null,
          leaseOwner: null,
          leaseExpiresAt: null,
        },
      });
      return { kind: 'RESCHEDULED' as const, attemptCount: row.attemptCount };
    });
    if (outcome.kind === 'NO_DELIVERY')
      throw new DomainException(
        'WEBHOOK_DELIVERY_NOT_TRACKED',
        409,
        'This event is not in reliable delivery; deliver it manually instead',
      );
    if (outcome.kind === 'ALREADY_DELIVERED')
      throw new DomainException(
        'WEBHOOK_ALREADY_DELIVERED',
        409,
        'This event was already delivered; request an explicit redelivery instead',
      );
    if (outcome.kind === 'RESCHEDULED') {
      this.logger.log({
        event: WEBHOOK_RESCUED_EVENT,
        eventId,
        actorUserId,
        attemptsSoFar: outcome.attemptCount,
      });
      // The worker would find it on its next pass anyway; this only saves the wait.
      this.webhooks.nudge();
    }
    return {
      outcome:
        outcome.kind === 'RESCHEDULED' ? 'RESCHEDULED' : 'ALREADY_PENDING',
      eventId,
    };
  }

  /**
   * Worker observability, split into what it is configured to do and what the database says is
   * left. Deliberately **not** called global health: `B2B_WEBHOOK_POLL_SECONDS` and the lease are
   * this instance's configuration, and with several backends running the same loop, no instance
   * knows what the others are doing. The counts are durable and shared; the configuration is not.
   */
  async health() {
    const [pending, exhausted, delivered, inFlight, oldest] = await Promise.all(
      [
        this.prisma.b2bWebhookDelivery.count({ where: { state: 'PENDING' } }),
        this.prisma.b2bWebhookDelivery.count({ where: { state: 'EXHAUSTED' } }),
        this.prisma.b2bWebhookDelivery.count({ where: { state: 'DELIVERED' } }),
        this.prisma.$queryRaw<{ count: bigint }[]>`
        SELECT count(*) AS count FROM "B2bWebhookDelivery"
         WHERE "leaseExpiresAt" > (now() AT TIME ZONE 'UTC')`,
        this.prisma.b2bWebhookDelivery.findFirst({
          where: { state: 'PENDING' },
          orderBy: { nextAttemptAt: 'asc' },
          select: { nextAttemptAt: true },
        }),
      ],
    );
    const pollSeconds = this.config.getOrThrow<number>(
      'B2B_WEBHOOK_POLL_SECONDS',
    );
    return {
      // Persisted and shared by every instance.
      pending,
      exhausted,
      delivered,
      leased: Number(inFlight[0]?.count ?? 0),
      oldestPendingDueAt: oldest?.nextAttemptAt ?? null,
      // Configuration of the instance answering this request, not of the fleet.
      thisInstance: {
        workerEnabled: pollSeconds > 0,
        pollSeconds,
        leaseSeconds: this.config.getOrThrow<number>(
          'B2B_WEBHOOK_LEASE_SECONDS',
        ),
        lastPollAt: this.webhooks.lastPollAt,
      },
    };
  }

  /** Per-client totals, for the administrative view of an IntegrationClient. */
  async summaryFor(integrationClientId: string) {
    const grouped = await this.prisma.b2bWebhookDelivery.groupBy({
      by: ['state'],
      where: { integrationClientId },
      _count: { _all: true },
    });
    const counts = Object.fromEntries(
      grouped.map((g) => [g.state, g._count._all]),
    );
    return {
      events: await this.prisma.b2bOutboxEvent.count({
        where: { integrationClientId },
      }),
      pending: counts.PENDING ?? 0,
      delivered: counts.DELIVERED ?? 0,
      exhausted: counts.EXHAUSTED ?? 0,
    };
  }

  /** Records that a human asked for an attempt, before the attempt itself happens. */
  logRedeliveryRequest(eventId: string, actorUserId: string) {
    this.logger.log({
      event: WEBHOOK_REDELIVERY_EVENT,
      eventId,
      actorUserId,
    });
  }
}
