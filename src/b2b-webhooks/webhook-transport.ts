import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { B2B_EVENT_TYPES } from '../b2b-events/b2b-outbox.js';
import {
  WebhookTargetError,
  assertResolvedAddresses,
  parseWebhookTarget,
  type WebhookTargetPolicy,
} from './webhook-target.js';

/** Header a consumer can read without parsing the body, and the deduplication key it will use. */
export const EVENT_ID_HEADER = 'x-mandaria-event-id';
export const EVENT_TYPE_HEADER = 'x-mandaria-event-type';

export type Fetch = typeof fetch;
export type Resolver = (hostname: string) => Promise<string[]>;

/** The durable event, exactly as V1.12-B recorded it. Nothing here is recomputed. */
export type RecordedEvent = {
  id: string;
  type: keyof typeof B2B_EVENT_TYPES;
  occurredAt: Date;
  payload: unknown;
};

export type AttemptOutcome =
  | { result: 'SUCCEEDED'; httpStatus: number; durationMs: number }
  | {
      result: 'FAILED';
      failureKind: 'HTTP_STATUS' | 'TIMEOUT' | 'NETWORK' | 'INVALID_ENDPOINT';
      failureDetail: string;
      httpStatus?: number;
      durationMs: number;
    };

/**
 * The body a consumer receives. Built from the columns and the frozen snapshot of V1.12-B, never
 * from DeliveryRequest or Dispatch as they are now: a webhook that leaves today must carry what
 * was true when the delivery happened.
 */
export const webhookBody = (event: RecordedEvent) => ({
  eventId: event.id,
  type: B2B_EVENT_TYPES[event.type],
  occurredAt: event.occurredAt.toISOString(),
  data: event.payload,
});

/** Keeps a remote message from becoming a log or a database row of unknown size and content. */
const sanitize = (value: string) =>
  value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[^\x20-\x7e]/g, '')
    .trim()
    .slice(0, 200) || 'UNKNOWN';

/**
 * One attempt to hand an event to one endpoint. It resolves the hostname and re-applies the SSRF
 * policy first, POSTs the event with an explicit timeout, and refuses to follow redirects, because
 * a redirect is the easiest way to turn an approved public URL into an internal one.
 *
 * Success is any 2xx: consumers legitimately answer 200, 201, 202 or 204, and demanding one exact
 * code would break integrations for no benefit. Everything else — including a 3xx, which means the
 * endpoint tried to send Mandaria somewhere else — is a transport failure.
 *
 * The response body is read and discarded. Storing it would mean keeping arbitrary HTML, stack
 * traces or personal data that a remote system chose to return.
 */
export async function attemptWebhookDelivery(
  url: string,
  event: RecordedEvent,
  options: {
    timeoutMs: number;
    policy: WebhookTargetPolicy;
    fetcher?: Fetch;
    resolver?: Resolver;
  },
): Promise<AttemptOutcome> {
  const started = Date.now();
  const elapsed = () => Math.max(0, Date.now() - started);
  const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  const resolver =
    options.resolver ??
    (async (hostname: string) =>
      (await lookup(hostname, { all: true })).map((entry) => entry.address));

  let target: URL;
  try {
    target = parseWebhookTarget(url, options.policy);
    const host = target.hostname.replace(/^\[|\]$/g, '');
    // A literal address was already decided; only a name needs resolving.
    if (!isIP(host))
      assertResolvedAddresses(await resolver(host), options.policy);
  } catch (error) {
    return {
      result: 'FAILED',
      failureKind: 'INVALID_ENDPOINT',
      failureDetail: sanitize(
        error instanceof WebhookTargetError ? error.reason : 'DNS_FAILED',
      ),
      durationMs: elapsed(),
    };
  }

  let response: Response;
  try {
    response = await fetcher(target.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [EVENT_ID_HEADER]: event.id,
        [EVENT_TYPE_HEADER]: B2B_EVENT_TYPES[event.type],
      },
      body: JSON.stringify(webhookBody(event)),
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    const timeout = name === 'TimeoutError' || name === 'AbortError';
    return {
      result: 'FAILED',
      failureKind: timeout ? 'TIMEOUT' : 'NETWORK',
      failureDetail: sanitize(timeout ? 'TIMEOUT' : name || 'NETWORK'),
      durationMs: elapsed(),
    };
  }
  // Drain the body so the socket is released, then forget it.
  await response.arrayBuffer().catch(() => undefined);
  if (response.status >= 200 && response.status <= 299)
    return {
      result: 'SUCCEEDED',
      httpStatus: response.status,
      durationMs: elapsed(),
    };
  return {
    result: 'FAILED',
    failureKind: 'HTTP_STATUS',
    failureDetail: `HTTP_${response.status}`,
    httpStatus: response.status,
    durationMs: elapsed(),
  };
}
