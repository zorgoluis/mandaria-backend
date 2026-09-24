import {
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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

/** Structured log of one handover. Ids, host and outcome; never the payload or the remote body. */
export const WEBHOOK_ATTEMPT_EVENT = 'B2B_WEBHOOK_ATTEMPT';
/** Why an event was not even attempted. Not a failure: there was nothing to fail. */
export const WEBHOOK_SKIPPED_EVENT = 'B2B_WEBHOOK_SKIPPED';

export type DeliveryOutcome =
  | { kind: 'attempted'; attemptId: string; outcome: AttemptOutcome }
  | { kind: 'skipped'; reason: 'NO_ENDPOINT' | 'ENDPOINT_DISABLED' };

const eventSelect = {
  id: true,
  type: true,
  occurredAt: true,
  payload: true,
  integrationClientId: true,
} as const;

/**
 * V1.12-C: hands a recorded event to the client that owns it.
 *
 * The HTTP call deliberately lives outside the completion transaction. V1.12-B already guaranteed
 * that a delivered service and its event commit together; transport is a separate concern that may
 * fail, hang or be unreachable without any of that mattering to the driver who just delivered.
 *
 * The first attempt is fired right after the completion request has been answered, as background
 * work this service owns and drains on shutdown. There is no retry, no backoff and no scheduler:
 * a failure is recorded as a FAILED attempt and stops there, which is exactly the evidence V1.12-D
 * will build retries on.
 */
@Injectable()
export class B2bWebhooksService implements OnApplicationShutdown {
  private readonly logger = new Logger(B2bWebhooksService.name);
  private readonly pending = new Set<Promise<unknown>>();

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

  /** Validates a URL the way the endpoint configuration must, surfacing a readable reason. */
  validateUrl(url: string) {
    parseWebhookTarget(url, this.policy);
  }

  /**
   * Schedules the first attempt without making the caller wait for a remote system. Failures are
   * swallowed here on purpose: they are already recorded as an attempt, and an unhandled rejection
   * must never take the process down because a client's server is misbehaving.
   */
  scheduleFirstAttempt(eventId: string) {
    const work = this.deliver(eventId).catch((error: unknown) => {
      this.logger.error({
        event: WEBHOOK_ATTEMPT_EVENT,
        eventId,
        result: 'ERROR',
        detail: error instanceof Error ? error.name : 'UNKNOWN',
      });
    });
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work));
  }

  /** Lets a graceful shutdown finish the handovers already in flight instead of dropping them. */
  async onApplicationShutdown() {
    await Promise.allSettled(this.pending);
  }

  /**
   * One attempt for one event. The endpoint is resolved from the event's own owner — the persisted
   * relation, never anything that travelled in a payload — so a client's events can only ever
   * reach that client's receiver.
   *
   * The endpoint used is the one active at this moment, and the attempt records the exact URL it
   * went to, so editing the configuration later does not rewrite what was tried.
   */
  async deliver(eventId: string): Promise<DeliveryOutcome> {
    const event = await this.prisma.b2bOutboxEvent.findUnique({
      where: { id: eventId },
      select: eventSelect,
    });
    if (!event) throw new NotFoundException('B2B event not found');
    const endpoint = await this.prisma.b2bWebhookEndpoint.findUnique({
      where: { integrationClientId: event.integrationClientId },
      select: { id: true, url: true, enabled: true },
    });
    if (!endpoint || !endpoint.enabled) {
      // No HTTP request happened, so there is no attempt to record: an attempt is the history of
      // a handover, and inventing one for a client that asked for none would be a lie.
      const reason = endpoint ? 'ENDPOINT_DISABLED' : 'NO_ENDPOINT';
      this.logger.log({
        event: WEBHOOK_SKIPPED_EVENT,
        eventId,
        integrationClientId: event.integrationClientId,
        reason,
      });
      return { kind: 'skipped', reason };
    }

    const attemptedAt = new Date();
    const outcome = await attemptWebhookDelivery(
      endpoint.url,
      event as RecordedEvent,
      {
        timeoutMs: this.config.getOrThrow<number>('B2B_WEBHOOK_TIMEOUT_MS'),
        policy: this.policy,
      },
    );
    const attempt = await this.prisma.b2bWebhookDeliveryAttempt.create({
      data: {
        eventId: event.id,
        integrationClientId: event.integrationClientId,
        endpointId: endpoint.id,
        endpointUrl: endpoint.url,
        attemptedAt,
        durationMs: outcome.durationMs,
        result: outcome.result,
        httpStatus:
          outcome.result === 'SUCCEEDED'
            ? outcome.httpStatus
            : (outcome.httpStatus ?? null),
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
      eventId: event.id,
      type: event.type,
      endpointId: endpoint.id,
      // The host, not the full URL: a path can carry a token a client chose to put there.
      endpointHost: safeHost(endpoint.url),
      result: outcome.result,
      httpStatus: outcome.result === 'SUCCEEDED' ? outcome.httpStatus : (outcome.httpStatus ?? null),
      failureKind: outcome.result === 'FAILED' ? outcome.failureKind : null,
      durationMs: outcome.durationMs,
    });
    return { kind: 'attempted', attemptId: attempt.id, outcome };
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
