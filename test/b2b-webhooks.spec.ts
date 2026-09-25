import { describe, expect, it, vi } from 'vitest';

const { parseWebhookTarget, assertResolvedAddresses, isForbiddenAddress } =
  await import('../dist/b2b-webhooks/webhook-target.js');
const {
  attemptWebhookDelivery,
  webhookBody,
  EVENT_ID_HEADER,
  EVENT_TYPE_HEADER,
} = await import('../dist/b2b-webhooks/webhook-transport.js');

const PROD = { allowInsecureTargets: false };
const LOCAL = { allowInsecureTargets: true };
const reason = (fn: () => unknown) => {
  try {
    fn();
    return 'ACCEPTED';
  } catch (error) {
    return (error as { reason?: string }).reason ?? 'UNKNOWN';
  }
};

const event = {
  id: '9a1f0c7e-1111-4000-8000-000000000001',
  type: 'DELIVERY_COMPLETED' as const,
  occurredAt: new Date('2026-09-25T10:15:30.500Z'),
  payload: {
    publicId: 'MDR-000123',
    externalReference: 'ORDER-4711',
    status: 'DELIVERED',
    execution: { mode: 'PROVIDER' },
    requestedAt: '2026-09-25T09:00:00.000Z',
    deliveredAt: '2026-09-25T10:15:30.500Z',
    cancelledAt: null,
  },
};
const ok = (status = 200) =>
  vi.fn(async () => new Response(null, { status })) as unknown as typeof fetch;

describe('V1.12-C webhook target policy', () => {
  it('requires https in production and says so', () => {
    expect(reason(() => parseWebhookTarget('http://example.com/h', PROD))).toBe(
      'SCHEME',
    );
    expect(
      parseWebhookTarget('https://example.com/h', PROD).toString(),
    ).toContain('https://example.com/h');
  });

  it('refuses every scheme that is not http(s)', () => {
    for (const url of [
      'file:///etc/passwd',
      'ftp://example.com/x',
      'gopher://example.com',
      'data:text/plain,hello',
      'not a url at all',
    ])
      expect(reason(() => parseWebhookTarget(url, PROD))).not.toBe('ACCEPTED');
  });

  it('refuses credentials in the URL, which would travel in every request', () => {
    expect(
      reason(() => parseWebhookTarget('https://user:pass@example.com/h', PROD)),
    ).toBe('CREDENTIALS');
    expect(
      reason(() => parseWebhookTarget('https://user@example.com/h', PROD)),
    ).toBe('CREDENTIALS');
  });

  it('refuses loopback, private, link-local and metadata destinations', () => {
    const rejected = [
      'https://127.0.0.1/h',
      'https://127.13.9.2/h',
      'https://localhost/h',
      'https://api.localhost/h',
      'https://[::1]/h',
      'https://169.254.169.254/latest/meta-data',
      'https://10.0.0.5/h',
      'https://172.16.4.9/h',
      'https://192.168.1.10/h',
      'https://100.64.0.1/h',
      'https://0.0.0.0/h',
      'https://255.255.255.255/h',
      'https://[fd00::1]/h',
      'https://[fe80::1]/h',
      // IPv4 wearing an IPv6 costume. The URL parser rewrites these to hex, so the policy has to
      // decide on the expanded address and not on how it was typed.
      'https://[::ffff:127.0.0.1]/h',
      'https://[::ffff:169.254.169.254]/h',
      'https://[0:0:0:0:0:ffff:0a00:0001]/h',
      'https://[::]/h',
      'https://[ff02::1]/h',
      'https://printer.local/h',
      'https://vault.internal/h',
    ];
    for (const url of rejected)
      expect([url, reason(() => parseWebhookTarget(url, PROD))]).toEqual([
        url,
        expect.stringMatching(/^(HOST|PRIVATE_HOST)$/),
      ]);
  });

  it('accepts an ordinary public destination', () => {
    for (const url of [
      'https://coita-eats.example.com/hooks/mandaria',
      'https://example.com:8443/h?tenant=1',
      'https://93.184.216.34/h',
      'https://[2606:4700::1111]/h',
    ])
      expect(reason(() => parseWebhookTarget(url, PROD))).toBe('ACCEPTED');
  });

  it('the LOCAL/TEST switch is the only way to reach http and loopback', () => {
    expect(reason(() => parseWebhookTarget('http://127.0.0.1:4599/h', PROD)))
      .toBe('SCHEME');
    expect(
      reason(() => parseWebhookTarget('http://127.0.0.1:4599/h', LOCAL)),
    ).toBe('ACCEPTED');
  });

  it('judges the addresses a hostname resolves to, not just its spelling', () => {
    // The classic bypass: a perfectly public name pointing inside the network.
    expect(reason(() => assertResolvedAddresses(['10.1.2.3'], PROD))).toBe(
      'PRIVATE_HOST',
    );
    expect(
      reason(() => assertResolvedAddresses(['93.184.216.34', '10.1.2.3'], PROD)),
    ).toBe('PRIVATE_HOST');
    expect(reason(() => assertResolvedAddresses([], PROD))).toBe(
      'PRIVATE_HOST',
    );
    expect(reason(() => assertResolvedAddresses(['93.184.216.34'], PROD))).toBe(
      'ACCEPTED',
    );
  });

  it('classifies addresses the same way wherever they come from', () => {
    expect(isForbiddenAddress('169.254.169.254')).toBe(true);
    expect(isForbiddenAddress('::1')).toBe(true);
    expect(isForbiddenAddress('8.8.8.8')).toBe(false);
    expect(isForbiddenAddress('2606:4700::1111')).toBe(false);
  });
});

describe('V1.12-C the body carries the recorded event, unchanged', () => {
  it('sends the envelope and the frozen snapshot, with the public type name', () => {
    expect(webhookBody(event)).toEqual({
      eventId: event.id,
      type: 'delivery.completed',
      occurredAt: '2026-09-25T10:15:30.500Z',
      data: event.payload,
    });
  });

  it('never leaks the internal enum name to a consumer', () => {
    expect(JSON.stringify(webhookBody(event))).not.toContain(
      'DELIVERY_COMPLETED',
    );
  });

  it('posts JSON with the event id and type in headers', async () => {
    const fetcher = ok(200);
    await attemptWebhookDelivery('https://example.com/h', event, {
      timeoutMs: 1000,
      policy: PROD,
      fetcher,
      resolver: async () => ['93.184.216.34'],
    });
    const [url, init] = (fetcher as unknown as { mock: { calls: [string, RequestInit][] } })
      .mock.calls[0];
    expect(url).toBe('https://example.com/h');
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('manual');
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers[EVENT_ID_HEADER]).toBe(event.id);
    expect(headers[EVENT_TYPE_HEADER]).toBe('delivery.completed');
    expect(JSON.parse(init.body as string)).toEqual(webhookBody(event));
  });
});

describe('V1.12-C what counts as delivered', () => {
  const deliver = (fetcher: typeof fetch) =>
    attemptWebhookDelivery('https://example.com/h', event, {
      timeoutMs: 1000,
      policy: PROD,
      fetcher,
      resolver: async () => ['93.184.216.34'],
    });

  it('accepts any 2xx, because consumers legitimately answer more than 200', async () => {
    for (const status of [200, 201, 202, 204, 299]) {
      const outcome = await deliver(ok(status));
      expect(outcome).toMatchObject({ result: 'SUCCEEDED', httpStatus: status });
    }
  });

  it('treats every other status as a transport failure, including a redirect', async () => {
    for (const status of [301, 302, 400, 401, 404, 409, 429, 500, 503]) {
      const outcome = await deliver(ok(status));
      expect(outcome).toMatchObject({
        result: 'FAILED',
        failureKind: 'HTTP_STATUS',
        httpStatus: status,
        failureDetail: `HTTP_${status}`,
      });
    }
  });

  it('never follows a redirect: that is how an approved URL becomes an internal one', async () => {
    const fetcher = ok(307);
    await deliver(fetcher);
    const [, init] = (fetcher as unknown as { mock: { calls: [string, RequestInit][] } })
      .mock.calls[0];
    expect(init.redirect).toBe('manual');
  });

  it('separates a timeout from any other network failure', async () => {
    const timeout = vi.fn(async () => {
      const error = new Error('timed out');
      error.name = 'TimeoutError';
      throw error;
    }) as unknown as typeof fetch;
    expect(await deliver(timeout)).toMatchObject({
      result: 'FAILED',
      failureKind: 'TIMEOUT',
    });
    const refused = vi.fn(async () => {
      const error = new Error('connect ECONNREFUSED');
      error.name = 'TypeError';
      throw error;
    }) as unknown as typeof fetch;
    expect(await deliver(refused)).toMatchObject({
      result: 'FAILED',
      failureKind: 'NETWORK',
    });
  });

  it('refuses to call a destination the policy rejects, without any request', async () => {
    const fetcher = ok(200);
    const outcome = await attemptWebhookDelivery(
      'https://169.254.169.254/latest/meta-data',
      event,
      { timeoutMs: 1000, policy: PROD, fetcher, resolver: async () => [] },
    );
    expect(outcome).toMatchObject({
      result: 'FAILED',
      failureKind: 'INVALID_ENDPOINT',
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('refuses a public name that resolves inside the network, without any request', async () => {
    const fetcher = ok(200);
    const outcome = await attemptWebhookDelivery(
      'https://totally-public.example.com/h',
      event,
      {
        timeoutMs: 1000,
        policy: PROD,
        fetcher,
        resolver: async () => ['10.0.0.7'],
      },
    );
    expect(outcome).toMatchObject({
      result: 'FAILED',
      failureKind: 'INVALID_ENDPOINT',
      failureDetail: 'PRIVATE_HOST',
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('keeps a hostile remote message out of what gets stored', async () => {
    const hostile = vi.fn(async () => {
      const error = new Error('x');
      error.name = 'A'.repeat(500) + '\n\rsecret=abc';
      throw error;
    }) as unknown as typeof fetch;
    const outcome = (await deliver(hostile)) as { failureDetail: string };
    expect(outcome.failureDetail.length).toBeLessThanOrEqual(200);
    expect(outcome.failureDetail).not.toContain('\n');
    expect(outcome.failureDetail).not.toContain('\r');
  });

  it('never keeps the remote response body', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response('<html>stack trace with pii</html>', { status: 500 }),
    ) as unknown as typeof fetch;
    const outcome = await deliver(fetcher);
    expect(JSON.stringify(outcome)).not.toContain('stack trace');
    expect(JSON.stringify(outcome)).not.toContain('html');
  });
});
