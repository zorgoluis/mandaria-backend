import { randomUUID } from 'node:crypto';
import {
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DomainException } from '../common/domain-error.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  attemptWebhookDelivery,
  type AttemptOutcome,
  type RecordedEvent,
} from './webhook-transport.js';
import {
  WebhookTargetError,
  parseWebhookTarget,
  type WebhookTargetPolicy,
} from './webhook-target.js';
import {
  WebhookSecretError,
  decryptSecret,
  masterKey,
} from './webhook-secret.js';
import {
  classifyFailure,
  classifyStatus,
  nextStep,
  type HttpDisposition,
} from './webhook-retry-policy.js';

/** Structured log of one handover. Ids, host and outcome; never the payload, body or secret. */
export const WEBHOOK_ATTEMPT_EVENT = 'B2B_WEBHOOK_ATTEMPT';
/** Why an event was not even attempted. Not a failure: there was nothing to fail. */
export const WEBHOOK_SKIPPED_EVENT = 'B2B_WEBHOOK_SKIPPED';

export type SkipReason = 'NO_ENDPOINT' | 'ENDPOINT_DISABLED' | 'NO_SECRET';
export type DeliveryState = 'PENDING' | 'DELIVERED' | 'EXHAUSTED' | 'UNTRACKED';

export type DeliveryOutcome =
  | {
      kind: 'attempted';
      attemptId: string;
      attemptNumber: number | null;
      outcome: AttemptOutcome;
      state: DeliveryState;
      nextAttemptAt: Date | null;
    }
  | { kind: 'skipped'; reason: SkipReason };

const eventSelect = {
  id: true,
  type: true,
  occurredAt: true,
  payload: true,
  integrationClientId: true,
} as const;

const endpointSelect = {
  id: true,
  url: true,
  enabled: true,
  secretCiphertext: true,
} as const;

type Endpoint = {
  id: string;
  url: string;
  enabled: boolean;
  secretCiphertext: string | null;
};
type LeasedDelivery = {
  id: string;
  eventId: string;
  integrationClientId: string;
  endpointId: string;
  attemptCount: number;
  /** Already stamped? A redelivery of something delivered must not restamp when it happened. */
  deliveredAt?: Date | null;
  exhaustedAt?: Date | null;
};

/**
 * V1.12-D: reliable, signed transport of a recorded event to the client that owns it.
 *
 * Three concerns stay separate, and this service keeps them that way. `B2bOutboxEvent` is the
 * immutable fact, `B2bWebhookDeliveryAttempt` is immutable history, and `B2bWebhookDelivery` — the
 * only mutable piece — holds nothing but what is still owed and when to try again. The outbox is
 * never turned into a queue.
 *
 * Work is **discovered from the database**, not remembered in memory, which is what closes the
 * V1.12-C crash window: a process that dies between the outbox commit and the first request loses
 * nothing, because the next worker finds the event again by looking at the outbox itself.
 *
 * Every pickup is leased with `FOR UPDATE SKIP LOCKED` plus a durable expiry, so several backends
 * can run the same loop without doing the same work, and a worker that dies does not block its
 * event forever. The HTTP call happens **between** two short transactions and never inside one: a
 * slow receiver must not hold a PostgreSQL row lock open.
 */
@Injectable()
export class B2bWebhooksService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(B2bWebhooksService.name);
  /** Identifies this process in a lease, so an operator can tell who holds what. */
  private readonly workerId = `${process.pid}-${randomUUID().slice(0, 8)}`;
  private timer: NodeJS.Timeout | undefined;
  /** When this process last looked for work. Per-instance memory, and reported as such. */
  private lastPoll: Date | null = null;
  private running: Promise<unknown> = Promise.resolve();
  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /** LOCAL/TEST ONLY switch, refused in production by the environment schema. */
  get policy(): WebhookTargetPolicy {
    return {
      allowInsecureTargets:
        this.config.get<boolean>('B2B_WEBHOOK_ALLOW_INSECURE_TARGETS') === true,
    };
  }

  private get leaseMs() {
    return this.config.getOrThrow<number>('B2B_WEBHOOK_LEASE_SECONDS') * 1000;
  }

  /** Validates a URL the way the endpoint configuration must, surfacing a readable reason. */
  validateUrl(url: string) {
    parseWebhookTarget(url, this.policy);
  }

  /** The master key, read per use so a misconfiguration surfaces where it can be reported. */
  key() {
    return masterKey(this.config.get<string>('B2B_WEBHOOK_SECRET_KEY'));
  }

  onModuleInit() {
    const seconds = this.config.getOrThrow<number>('B2B_WEBHOOK_POLL_SECONDS');
    // Zero disables the loop, which is how the suites drive the worker deterministically instead
    // of waiting for a timer.
    if (seconds <= 0) return;
    this.timer = setInterval(() => void this.tick(), seconds * 1000);
    // The loop must not be the reason the process stays alive.
    this.timer.unref?.();
  }

  /**
   * Stops taking new work and lets what is in flight finish. It never waits forever: if this
   * process is killed anyway, the lease expires and another worker picks the event up.
   */
  async onApplicationShutdown() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    let guard: NodeJS.Timeout | undefined;
    await Promise.race([
      this.running,
      new Promise((resolve) => {
        guard = setTimeout(resolve, this.leaseMs);
        guard.unref?.();
      }),
    ]);
    if (guard) clearTimeout(guard);
  }

  /**
   * A hint that there is probably work now, used by the completion path so the first attempt does
   * not wait for the next poll. It is **only** a hint: the event was already committed to the
   * outbox, so if this process dies before the request happens the next worker finds it anyway.
   * That is the difference with V1.12-C, where this was the whole mechanism.
   */
  nudge() {
    if (this.stopped) return;
    void this.tick().catch(() => undefined);
  }

  /** What V1.12-E reports as this instance's last poll; it knows nothing about other backends. */
  get lastPollAt() {
    return this.lastPoll;
  }

  /** One pass of the worker. Exposed so tests drive it deterministically instead of waiting. */
  async tick(limit = 20): Promise<DeliveryOutcome[]> {
    if (this.stopped) return [];
    this.lastPoll = new Date();
    const pass = this.drain(limit);
    this.running = pass.catch(() => undefined);
    return pass;
  }

  private async drain(limit: number) {
    const results: DeliveryOutcome[] = [];
    for (let i = 0; i < limit; i += 1) {
      if (this.stopped) break;
      const leased = await this.lease();
      if (!leased) break;
      results.push(await this.attempt(leased));
    }
    return results;
  }

  /**
   * Takes one unit of work, in a short transaction.
   *
   * It looks in two places. First a delivery already tracked whose next attempt is due and whose
   * lease is free or expired. Then, if there is none, an eligible event with no transport state
   * yet — and that second query is what makes the work durable, because the outbox is the queue of
   * record and a restart re-discovers everything.
   *
   * Eligibility is the endpoint's own `deliverFrom` boundary: only what happened from that instant
   * on. That is why deploying this version does not hand over years of history, and why wiring a
   * webhook today does not either.
   *
   * `SKIP LOCKED` is what lets several backends run this loop: a row another worker is claiming
   * right now is stepped over instead of waited on.
   */
  private async lease(): Promise<LeasedDelivery | null> {
    // Times are compared DB-side against `now() AT TIME ZONE 'UTC'`, never against a bound JS Date.
    // The columns are `timestamp` without a zone and hold UTC; a bound Date arrives as
    // `timestamptz`, so PostgreSQL would reinterpret them in the server's own zone and shift every
    // comparison by the offset — which is how nothing ever came due.
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.leaseMs);
    return this.prisma.$transaction(async (tx) => {
      const [due] = await tx.$queryRaw<LeasedDelivery[]>`
        SELECT d."id", d."eventId", d."integrationClientId", d."endpointId", d."attemptCount"
          FROM "B2bWebhookDelivery" d
          JOIN "B2bWebhookEndpoint" p ON p."id" = d."endpointId"
         WHERE d."state" = 'PENDING'
           AND d."nextAttemptAt" <= (now() AT TIME ZONE 'UTC')
           AND (d."leaseExpiresAt" IS NULL
             OR d."leaseExpiresAt" <= (now() AT TIME ZONE 'UTC'))
           AND p."enabled" = true
           AND p."secretCiphertext" IS NOT NULL
         ORDER BY d."nextAttemptAt"
         FOR UPDATE OF d SKIP LOCKED
         LIMIT 1`;
      if (due) {
        await tx.b2bWebhookDelivery.update({
          where: { id: due.id },
          data: { leaseOwner: this.workerId, leaseExpiresAt: expiresAt },
        });
        return due;
      }
      const [fresh] = await tx.$queryRaw<
        { eventId: string; integrationClientId: string; endpointId: string }[]
      >`
        SELECT e."id" AS "eventId", e."integrationClientId", p."id" AS "endpointId"
          FROM "B2bOutboxEvent" e
          JOIN "B2bWebhookEndpoint" p ON p."integrationClientId" = e."integrationClientId"
         WHERE p."enabled" = true
           AND p."secretCiphertext" IS NOT NULL
           AND e."occurredAt" >= p."deliverFrom"
           AND NOT EXISTS (SELECT 1 FROM "B2bWebhookDelivery" d WHERE d."eventId" = e."id")
         ORDER BY e."occurredAt"
         FOR UPDATE OF e SKIP LOCKED
         LIMIT 1`;
      if (!fresh) return null;
      const created = await tx.b2bWebhookDelivery.create({
        data: {
          eventId: fresh.eventId,
          integrationClientId: fresh.integrationClientId,
          endpointId: fresh.endpointId,
          nextAttemptAt: now,
          leaseOwner: this.workerId,
          leaseExpiresAt: expiresAt,
        },
        select: { id: true, attemptCount: true },
      });
      return { ...fresh, id: created.id, attemptCount: created.attemptCount };
    });
  }

  /** The HTTP call, with a short transaction on each side of it. */
  private async attempt(delivery: LeasedDelivery): Promise<DeliveryOutcome> {
    const event = await this.prisma.b2bOutboxEvent.findUniqueOrThrow({
      where: { id: delivery.eventId },
      select: eventSelect,
    });
    const endpoint = await this.prisma.b2bWebhookEndpoint.findUniqueOrThrow({
      where: { id: delivery.endpointId },
      select: endpointSelect,
    });
    const outcome = await this.send(event, endpoint);
    return this.record(delivery, endpoint, outcome, event.type);
  }

  /** Performs the request with the secret **active at this moment**, as the contract says. */
  private async send(
    event: { id: string; type: string; occurredAt: Date; payload: unknown },
    endpoint: Endpoint,
  ): Promise<AttemptOutcome> {
    let secret: string | undefined;
    if (endpoint.secretCiphertext)
      try {
        secret = decryptSecret(endpoint.secretCiphertext, this.key());
      } catch (error) {
        // An unreadable secret is a configuration problem, not a remote one. Sending unsigned
        // would be worse than failing: the receiver would reject it and never learn why.
        return {
          result: 'FAILED',
          failureKind: 'INVALID_ENDPOINT',
          failureDetail:
            error instanceof WebhookSecretError ? error.reason : 'SECRET',
          durationMs: 0,
        };
      }
    return attemptWebhookDelivery(endpoint.url, event as RecordedEvent, {
      timeoutMs: this.config.getOrThrow<number>('B2B_WEBHOOK_TIMEOUT_MS'),
      policy: this.policy,
      secret,
    });
  }

  /** How Mandaria reads what came back. */
  private disposition(outcome: AttemptOutcome): HttpDisposition {
    if (outcome.result === 'SUCCEEDED') return 'SUCCESS';
    if (outcome.failureKind === 'HTTP_STATUS')
      // A status failure always carries its status; without one there is nothing to classify and
      // the safe reading is "do not hammer the receiver".
      return outcome.httpStatus
        ? classifyStatus(outcome.httpStatus)
        : 'TERMINAL';
    return classifyFailure(outcome.failureKind);
  }

  /**
   * Writes the attempt and moves the transport state, in one short transaction.
   *
   * The attempt is recorded **after** the request, so a row never claims a result that did not
   * happen. The price is the window this version accepts openly: if the process dies between the
   * receiver answering and this commit, the event is retried and the receiver sees the same
   * `eventId` twice. That is why deduplication by `eventId` is a contract and not a suggestion —
   * Mandaria promises at-least-once, never exactly-once.
   */
  private async record(
    delivery: LeasedDelivery,
    endpoint: { id: string; url: string },
    outcome: AttemptOutcome,
    type: string,
  ): Promise<DeliveryOutcome> {
    const now = new Date();
    const attemptNumber = delivery.attemptCount + 1;
    const disposition = this.disposition(outcome);
    const step = nextStep(disposition, attemptNumber, now);

    const attemptId = await this.prisma.$transaction(async (tx) => {
      const attempt = await tx.b2bWebhookDeliveryAttempt.create({
        data: {
          eventId: delivery.eventId,
          integrationClientId: delivery.integrationClientId,
          endpointId: endpoint.id,
          endpointUrl: endpoint.url,
          attemptNumber,
          attemptedAt: now,
          durationMs: outcome.durationMs,
          result: outcome.result,
          httpStatus: outcome.httpStatus ?? null,
          failureKind:
            outcome.result === 'FAILED' ? outcome.failureKind : undefined,
          failureDetail:
            outcome.result === 'FAILED' ? outcome.failureDetail : undefined,
        },
        select: { id: true },
      });
      await tx.b2bWebhookDelivery.update({
        where: { id: delivery.id },
        data: {
          attemptCount: attemptNumber,
          lastAttemptAt: now,
          leaseOwner: null,
          leaseExpiresAt: null,
          state: step.state,
          nextAttemptAt: step.state === 'PENDING' ? step.nextAttemptAt : null,
          // Stamped once, when it first happened. An administrator resending something already
          // delivered adds an attempt to the history; it does not move the moment it was handed
          // over, and PostgreSQL refuses that rewrite anyway.
          deliveredAt:
            step.state === 'DELIVERED' && !delivery.deliveredAt
              ? now
              : undefined,
          // Rescuing an exhausted handover clears the giving-up stamp: it did get through in the
          // end, and a delivered row that still claimed to be exhausted would be a contradiction
          // PostgreSQL refuses anyway.
          exhaustedAt:
            step.state === 'DELIVERED'
              ? null
              : step.state === 'EXHAUSTED' && !delivery.exhaustedAt
                ? now
                : undefined,
        },
      });
      return attempt.id;
    });

    this.logger.log({
      event: WEBHOOK_ATTEMPT_EVENT,
      attemptId,
      eventId: delivery.eventId,
      type,
      attemptNumber,
      endpointId: endpoint.id,
      // The host, not the full URL: a path can carry a token a client chose to put there.
      endpointHost: safeHost(endpoint.url),
      result: outcome.result,
      httpStatus: outcome.httpStatus ?? null,
      failureKind: outcome.result === 'FAILED' ? outcome.failureKind : null,
      disposition,
      state: step.state,
      durationMs: outcome.durationMs,
    });
    return {
      kind: 'attempted',
      attemptId,
      attemptNumber,
      outcome,
      state: step.state,
      nextAttemptAt: step.state === 'PENDING' ? step.nextAttemptAt : null,
    };
  }

  /**
   * One attempt requested by an administrator: how an EXHAUSTED handover is retried, and the only
   * way an event older than the boundary is handed over at all.
   *
   * It takes the lease first, so a manual push never races the worker on the same event; if the
   * worker holds it right now, the request is refused rather than doubled. A DELIVERED handover
   * can be pushed again on purpose — at-least-once already allows duplicates and an operator may
   * know the consumer lost it — and the state stays DELIVERED with the extra attempt audited.
   *
   * An event outside reliable delivery, with no transport state because it predates the boundary,
   * is sent exactly as V1.12-C did: one attempt, recorded, with no state created, so pushing old
   * history by hand never quietly enrols it into the retry loop.
   */
  async deliver(eventId: string): Promise<DeliveryOutcome> {
    const event = await this.prisma.b2bOutboxEvent.findUnique({
      where: { id: eventId },
      select: eventSelect,
    });
    if (!event) throw new NotFoundException('B2B event not found');
    const endpoint = await this.prisma.b2bWebhookEndpoint.findUnique({
      where: { integrationClientId: event.integrationClientId },
      select: endpointSelect,
    });
    const skip = (reason: SkipReason): DeliveryOutcome => {
      this.logger.log({
        event: WEBHOOK_SKIPPED_EVENT,
        eventId,
        integrationClientId: event.integrationClientId,
        reason,
      });
      return { kind: 'skipped', reason };
    };
    if (!endpoint) return skip('NO_ENDPOINT');
    if (!endpoint.enabled) return skip('ENDPOINT_DISABLED');
    if (!endpoint.secretCiphertext) return skip('NO_SECRET');

    const now = new Date();
    const leased = await this.prisma.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<
        {
          id: string;
          attemptCount: number;
          leaseExpiresAt: Date | null;
          deliveredAt: Date | null;
          exhaustedAt: Date | null;
          state: string;
        }[]
      >`SELECT "id", "attemptCount", "leaseExpiresAt", "deliveredAt", "exhaustedAt", "state"
           FROM "B2bWebhookDelivery" WHERE "eventId" = ${eventId}::uuid FOR UPDATE`;
      if (!row) return null;
      if (row.leaseExpiresAt && row.leaseExpiresAt > now)
        return 'BUSY' as const;
      // A lease is a worker concept, and the worker only ever looks at PENDING work. Taking one on
      // something already delivered or exhausted would claim a contention that cannot happen —
      // and PostgreSQL refuses it, because a finished handover is nobody's to hold.
      if (row.state === 'PENDING')
        await tx.b2bWebhookDelivery.update({
          where: { id: row.id },
          data: {
            leaseOwner: this.workerId,
            leaseExpiresAt: new Date(now.getTime() + this.leaseMs),
          },
        });
      return {
        id: row.id,
        eventId,
        integrationClientId: event.integrationClientId,
        endpointId: endpoint.id,
        attemptCount: row.attemptCount,
        deliveredAt: row.deliveredAt,
        exhaustedAt: row.exhaustedAt,
      };
    });
    if (leased === 'BUSY')
      throw new DomainException(
        'WEBHOOK_DELIVERY_IN_PROGRESS',
        409,
        'This event is being delivered right now',
      );

    const outcome = await this.send(event, endpoint);
    if (leased) return this.record(leased, endpoint, outcome, event.type);

    const attempt = await this.prisma.b2bWebhookDeliveryAttempt.create({
      data: {
        eventId,
        integrationClientId: event.integrationClientId,
        endpointId: endpoint.id,
        endpointUrl: endpoint.url,
        attemptedAt: now,
        durationMs: outcome.durationMs,
        result: outcome.result,
        httpStatus: outcome.httpStatus ?? null,
        failureKind:
          outcome.result === 'FAILED' ? outcome.failureKind : undefined,
        failureDetail:
          outcome.result === 'FAILED' ? outcome.failureDetail : undefined,
      },
      select: { id: true },
    });
    this.logger.log({
      event: WEBHOOK_ATTEMPT_EVENT,
      attemptId: attempt.id,
      eventId,
      type: event.type,
      endpointId: endpoint.id,
      endpointHost: safeHost(endpoint.url),
      result: outcome.result,
      httpStatus: outcome.httpStatus ?? null,
      failureKind: outcome.result === 'FAILED' ? outcome.failureKind : null,
      state: 'UNTRACKED',
      durationMs: outcome.durationMs,
    });
    return {
      kind: 'attempted',
      attemptId: attempt.id,
      attemptNumber: null,
      outcome,
      state: 'UNTRACKED',
      nextAttemptAt: null,
    };
  }
}

/** Host only, and never a reason to throw while building a log line. */
function safeHost(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return 'INVALID';
  }
}

export { WebhookTargetError };
