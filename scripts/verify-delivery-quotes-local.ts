// LOCAL/TEST ONLY. Manual V1.6 scenario over real HTTP (prompt section 86 example).
// Requires: db:seed:local-pricing, db:seed:local-provider-admins, db:seed:local-driver-users and a backend
// started with ROUTING_PROVIDER=local_fake (or google with GOOGLE_ROUTES_API_KEY for a real route).
// Usage: npm run verify:delivery-quotes   (3 logins; revokes its temporary credentials; no secrets printed)
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import {
  LOCAL_PROVIDER_ADMIN_DEFAULTS as SEED,
  assertLocalSeedAllowed,
} from './local-provider-admins.js';
import { LOCAL_DRIVER_USERS as DRIVERS } from './local-driver-users.js';
import { LOCAL_PRICING } from './local-pricing.js';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const base = `http://127.0.0.1:${process.env.PORT || 3000}/api/v1`;
const results: { check: string; result: string }[] = [];
const refreshTokens: string[] = [];
const credentials: { client: string; id: string }[] = [];
const summary: Record<string, unknown> = {};
let failed = false;
let sa = '';

async function call(
  method: string,
  path: string,
  token?: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30000),
  });
  const text = await response.text();
  if (/passwordHash|secretHash|GOOGLE_ROUTES_API_KEY/.test(text))
    throw new Error(`${method} ${path} leaked sensitive fields`);
  return {
    status: response.status,
    headers: response.headers,
    body: (text ? JSON.parse(text) : {}) as Json,
  };
}
function expect(
  res: { status: number; body: Json },
  status: number,
  label: string,
  code?: string,
) {
  if (res.status !== status || (code && res.body.code !== code))
    throw new Error(
      `${label}: expected ${status}${code ? ` ${code}` : ''}, got ${res.status} ${res.body.code ?? ''}`,
    );
  return res.body;
}
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    results.push({ check: name, result: 'PASS' });
  } catch (error) {
    failed = true;
    results.push({
      check: name,
      result: `FAIL: ${error instanceof Error ? error.message : 'error'}`,
    });
  }
}
async function login(email: string, password: string) {
  const body = expect(
    await call('POST', '/auth/login', undefined, { email, password }),
    200,
    `login ${email}`,
  );
  refreshTokens.push(body.refreshToken);
  return body.accessToken as string;
}
// Points inside the local Ocozocoautla zone (~4.5 km apart with local_fake) and one in Tuxtla.
const P = {
  pickup: [16.755, -93.39],
  dropoff: [16.775, -93.365],
  tuxtla: [16.753, -93.116],
  outside: [16.95, -93.7],
};
const order = (
  pickup: number[],
  dropoff: number[],
  financial: Json = {
    goodsValue: '450.00',
    goodsPaymentMode: 'PREPAID',
    currency: 'MXN',
  },
) => ({
  externalReference: 'ORDER-1842',
  stops: [
    {
      type: 'PICKUP',
      sequence: 1,
      address: 'Restaurante local de prueba',
      latitude: pickup[0],
      longitude: pickup[1],
      contactName: 'Restaurante',
      contactPhone: '9610000001',
    },
    {
      type: 'DROPOFF',
      sequence: 2,
      address: 'Cliente local de prueba',
      latitude: dropoff[0],
      longitude: dropoff[1],
      contactName: 'Cliente',
      contactPhone: '9610000002',
    },
  ],
  packages: [
    { category: 'FOOD', description: 'Pedido preparado', quantity: 2 },
  ],
  financialContext: financial,
});

try {
  const password = assertLocalSeedAllowed(process.env);
  sa = await login(
    process.env.BOOTSTRAP_ADMIN_EMAIL ?? '',
    process.env.BOOTSTRAP_ADMIN_PASSWORD ?? '',
  );
  const providerAdmin = await login(SEED.emails.adminA, password);
  const driver = await login(DRIVERS.carlos, password);
  const scopes = [
    'deliveries:create',
    'deliveries:read',
    'deliveries:cancel',
    'quotes:create',
    'quotes:read',
    'quotes:accept',
  ];
  const b2b = async (code: string, name: string) => {
    const clients = expect(
      await call('GET', '/admin/integrations', sa),
      200,
      'integrations',
    ) as unknown as Json[];
    let client = clients.find((c) => c.code === code);
    if (!client)
      client = expect(
        await call('POST', '/admin/integrations', sa, { name, code }),
        201,
        `create ${code}`,
      );
    if (client!.status !== 'ACTIVE')
      expect(
        await call('PATCH', `/admin/integrations/${client!.id}`, sa, {
          status: 'ACTIVE',
        }),
        204,
        'activate',
      );
    const cred = expect(
      await call('POST', `/admin/integrations/${client!.id}/credentials`, sa, {
        scopes,
      }),
      201,
      'credential',
    );
    credentials.push({ client: client!.id, id: cred.clientId });
    const token = expect(
      await call('POST', '/integrations/token', undefined, {
        clientId: cred.clientId,
        clientSecret: cred.clientSecret,
      }),
      200,
      'token',
    );
    return token.accessToken as string;
  };
  const A = await b2b('LOCAL_DELIVERY_CLIENT_A', 'Local delivery client A');
  const B = await b2b('LOCAL_DELIVERY_CLIENT_B', 'Local delivery client B');
  const newRequest = async (token: string, body: Json) =>
    expect(
      await call('POST', '/delivery-requests', token, body, {
        'Idempotency-Key': `local-${randomUUID()}`,
      }),
      201,
      'create request',
    ).publicId as string;
  const quote = (token: string, id: string) =>
    call('POST', `/delivery-requests/${id}/quotes`, token);

  let requestId = '';
  let quoteId = '';
  await check(
    'Configuración local: zona Ocozocoautla ACTIVE y RatePlan LOCAL_DELIVERY ACTIVE',
    async () => {
      const zones = expect(
        await call(
          'GET',
          `/admin/service-zones?search=${LOCAL_PRICING.zones.ocozocoautla.code}&status=ACTIVE`,
          sa,
        ),
        200,
        'zones',
      );
      if (zones.total !== 1)
        throw new Error('Run npm run db:seed:local-pricing');
      const plans = expect(
        await call(
          'GET',
          `/admin/rate-plans?serviceZoneId=${zones.items[0].id}&status=ACTIVE`,
          sa,
        ),
        200,
        'plans',
      );
      if (plans.total !== 1)
        throw new Error('No ACTIVE rate plan for Ocozocoautla');
      summary.ratePlanVersion = plans.items[0].version;
    },
  );
  await check(
    'MDR → Quote OFFERED (MQ) con distancia de ruta y banda',
    async () => {
      requestId = await newRequest(A, order(P.pickup, P.dropoff));
      const res = await quote(A, requestId);
      const body = expect(res, 201, 'quote');
      if (
        !/^MQ-\d{6,}$/.test(body.publicId) ||
        body.status !== 'OFFERED' ||
        Number(body.amount) <= 0
      )
        throw new Error('unexpected quote');
      quoteId = body.publicId;
      Object.assign(summary, {
        request: requestId,
        quote: quoteId,
        distanceMeters: body.distanceMeters,
        amount: `${body.amount} ${body.currency}`,
        expiresAt: body.expiresAt,
      });
    },
  );
  await check(
    'Repetir cotización reutiliza la OFFERED vigente (200)',
    async () => {
      const res = await quote(A, requestId);
      const body = expect(res, 200, 'reuse');
      if (
        body.publicId !== quoteId ||
        res.headers.get('quote-reused') !== 'true'
      )
        throw new Error('quote not reused');
    },
  );
  await check(
    'Aceptar → ACCEPTED (idempotente) y precio congelado',
    async () => {
      const accepted = expect(
        await call('POST', `/delivery-quotes/${quoteId}/accept`, A),
        200,
        'accept',
      );
      const again = expect(
        await call('POST', `/delivery-quotes/${quoteId}/accept`, A),
        200,
        'accept again',
      );
      if (
        accepted.status !== 'ACCEPTED' ||
        again.acceptedAt !== accepted.acceptedAt
      )
        throw new Error('not idempotent');
    },
  );
  await check('COURIER_ADVANCE 450: Quote sólo precio logístico', async () => {
    const id = await newRequest(
      A,
      order(P.pickup, P.dropoff, {
        goodsValue: '450.00',
        goodsPaymentMode: 'COURIER_ADVANCE',
        currency: 'MXN',
      }),
    );
    const q = expect(await quote(A, id), 201, 'quote courier advance');
    const detail = expect(
      await call('GET', `/delivery-requests/${id}`, A),
      200,
      'request',
    );
    if (
      Number(q.amount) >= 450 ||
      detail.financialContext.goodsValue !== '450.00'
    )
      throw new Error('goods value mixed with delivery price');
  });
  await check(
    'Fuera de zona → 422 OUT_OF_SERVICE_AREA; cross-zone → 422 CROSS_ZONE_NOT_SUPPORTED',
    async () => {
      expect(
        await quote(A, await newRequest(A, order(P.outside, P.dropoff))),
        422,
        'outside',
        'OUT_OF_SERVICE_AREA',
      );
      const cross = await newRequest(A, order(P.pickup, P.tuxtla));
      expect(await quote(A, cross), 422, 'cross', 'CROSS_ZONE_NOT_SUPPORTED');
      if (
        expect(
          await call('GET', `/delivery-requests/${cross}`, A),
          200,
          'still created',
        ).status !== 'CREATED'
      )
        throw new Error('request changed');
    },
  );
  await check('Aislamiento A/B en Quotes (404)', async () => {
    expect(await quote(B, requestId), 404, 'B quotes A request');
    expect(
      await call('GET', `/delivery-quotes/${quoteId}`, B),
      404,
      'B reads A quote',
    );
    expect(
      await call('POST', `/delivery-quotes/${quoteId}/accept`, B),
      404,
      'B accepts A quote',
    );
  });
  await check('Cancelar solicitud con OFFERED → Quote CANCELLED', async () => {
    const id = await newRequest(A, order(P.pickup, P.dropoff));
    const q = expect(await quote(A, id), 201, 'quote');
    expect(
      await call('POST', `/delivery-requests/${id}/cancel`, A, {
        reason: 'Prueba local',
      }),
      200,
      'cancel',
    );
    const after = expect(
      await call('GET', `/delivery-quotes/${q.publicId}`, A),
      200,
      'quote after cancel',
    );
    if (after.status !== 'CANCELLED') throw new Error('quote not cancelled');
    expect(
      await call('POST', `/delivery-quotes/${q.publicId}/accept`, A),
      409,
      'accept cancelled',
      'QUOTE_NOT_ACCEPTABLE',
    );
  });
  await check(
    'SUPER_ADMIN consulta Quotes con plan/banda; PROVIDER_ADMIN y DRIVER bloqueados',
    async () => {
      const detail = expect(
        await call('GET', `/admin/delivery-quotes/${quoteId}`, sa),
        200,
        'admin detail',
      );
      if (
        !detail.ratePlan?.version ||
        !detail.rateBand ||
        detail.status !== 'ACCEPTED'
      )
        throw new Error('admin detail incomplete');
      summary.routingProvider = detail.routingProvider;
      summary.band = `${detail.rateBand.minDistanceMeters}-${detail.rateBand.maxDistanceMeters} m`;
      for (const token of [providerAdmin, driver]) {
        expect(
          await call('GET', '/admin/delivery-quotes', token),
          403,
          'admin quotes',
        );
        expect(
          await call('GET', '/admin/rate-plans', token),
          403,
          'admin plans',
        );
        expect(
          await quote(token, requestId),
          401,
          'b2b quote with human token',
        );
      }
    },
  );
} catch (error) {
  failed = true;
  results.push({
    check: 'setup',
    result: `FAIL: ${error instanceof Error ? error.message : 'error'}`,
  });
} finally {
  for (const c of credentials)
    await call(
      'POST',
      `/admin/integrations/${c.client}/credentials/${c.id}/revoke`,
      sa,
    ).catch(() => undefined);
  for (const refreshToken of refreshTokens)
    await call('POST', '/auth/logout', undefined, { refreshToken }).catch(
      () => undefined,
    );
  console.table(results);
  console.log(JSON.stringify(summary, null, 2));
  console.log(
    failed
      ? 'RESULT: FAIL'
      : 'RESULT: PASS (no secrets or contact data printed)',
  );
  if (failed) process.exitCode = 1;
}
