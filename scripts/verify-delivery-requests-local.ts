// LOCAL/TEST ONLY. Manual V1.5 scenario over real HTTP (prompt section 70).
// Reuses/creates IntegrationClients LOCAL_DELIVERY_CLIENT_A/B, issues a temporary credential
// with deliveries:create/read/cancel for each run and revokes it at the end. Requests stay as history.
// Requires: bootstrap SUPER_ADMIN, db:seed:local-provider-admins, db:seed:local-driver-users and a running backend.
// Usage: npm run verify:delivery-requests   (3 logins; never prints secrets, tokens or contact data)
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import {
  LOCAL_PROVIDER_ADMIN_DEFAULTS as SEED,
  assertLocalSeedAllowed,
} from './local-provider-admins.js';
import { LOCAL_DRIVER_USERS as DRIVERS } from './local-driver-users.js';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const base = `http://127.0.0.1:${process.env.PORT || 3000}/api/v1`;
const results: { check: string; result: string }[] = [];
const refreshTokens: string[] = [];
const credentials: { client: string; id: string }[] = [];
const publicIds: Record<string, string> = {};
let failed = false;
let saToken = '';

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
    signal: AbortSignal.timeout(10000),
  });
  const text = await response.text();
  if (/passwordHash|secretHash/.test(text))
    throw new Error(`${method} ${path} leaked a hash field`);
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
) {
  if (res.status !== status)
    throw new Error(
      `${label}: expected ${status}, got ${res.status} ${JSON.stringify(res.body.message ?? '')}`,
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
const order = (overrides: Json = {}, dropoff: Json = {}) => ({
  externalReference: 'ORDER-1842',
  stops: [
    {
      type: 'PICKUP',
      sequence: 1,
      address:
        'Restaurante local de prueba, Av. Central Poniente 120, Tuxtla Gutiérrez',
      latitude: 16.753554,
      longitude: -93.115983,
      contactName: 'Restaurante de prueba',
      contactPhone: '9610000001',
      instructions: 'Recoger en mostrador',
    },
    {
      type: 'DROPOFF',
      sequence: 2,
      address: 'Cliente local de prueba, 5a Norte Oriente 45, Tuxtla Gutiérrez',
      latitude: 16.759812,
      longitude: -93.109231,
      contactName: 'Cliente de prueba',
      contactPhone: '9610000002',
      ...dropoff,
    },
  ],
  packages: [
    { category: 'FOOD', description: 'Pedido preparado', quantity: 2 },
  ],
  financialContext: {
    goodsValue: '450.00',
    goodsPaymentMode: 'PREPAID',
    currency: 'MXN',
  },
  ...overrides,
});

try {
  const password = assertLocalSeedAllowed(process.env);
  saToken = await login(
    process.env.BOOTSTRAP_ADMIN_EMAIL ?? '',
    process.env.BOOTSTRAP_ADMIN_PASSWORD ?? '',
  );
  const providerAdmin = await login(SEED.emails.adminA, password);
  const driver = await login(DRIVERS.carlos, password);

  const b2bToken = async (code: string, name: string) => {
    const clients = expect(
      await call('GET', '/admin/integrations', saToken),
      200,
      'list integrations',
    ) as unknown as Json[];
    let client = clients.find((c) => c.code === code);
    if (!client)
      client = expect(
        await call('POST', '/admin/integrations', saToken, { name, code }),
        201,
        `create ${code}`,
      );
    if (client!.status !== 'ACTIVE')
      expect(
        await call('PATCH', `/admin/integrations/${client!.id}`, saToken, {
          status: 'ACTIVE',
        }),
        204,
        `activate ${code}`,
      );
    const credential = expect(
      await call(
        'POST',
        `/admin/integrations/${client!.id}/credentials`,
        saToken,
        {
          scopes: ['deliveries:create', 'deliveries:read', 'deliveries:cancel'],
        },
      ),
      201,
      `credential ${code}`,
    );
    credentials.push({ client: client!.id, id: credential.clientId });
    const token = expect(
      await call('POST', '/integrations/token', undefined, {
        clientId: credential.clientId,
        clientSecret: credential.clientSecret,
      }),
      200,
      `token ${code}`,
    );
    return { id: client!.id as string, token: token.accessToken as string };
  };
  const A = await b2bToken(
    'LOCAL_DELIVERY_CLIENT_A',
    'Local delivery client A',
  );
  const B = await b2bToken(
    'LOCAL_DELIVERY_CLIENT_B',
    'Local delivery client B',
  );
  const create = (token: string, key: string, body: Json) =>
    call('POST', '/delivery-requests', token, body, { 'Idempotency-Key': key });
  const keyA = `local-${randomUUID()}`;

  await check(
    'A crea ORDER-1842 PREPAID 450 MXN → MDR-XXXXXX CREATED',
    async () => {
      const res = await create(A.token, keyA, order());
      const body = expect(res, 201, 'create A1');
      if (!/^MDR-\d{6,}$/.test(body.publicId) || body.status !== 'CREATED')
        throw new Error('unexpected create response');
      if (
        body.financialContext.goodsValue !== '450.00' ||
        res.headers.get('idempotent-replayed') !== 'false'
      )
        throw new Error('unexpected financial context or replay header');
      publicIds.A1 = body.publicId;
    },
  );
  await check(
    'Misma Idempotency-Key + mismo payload → misma operación (200)',
    async () => {
      const res = await create(A.token, keyA, order());
      const body = expect(res, 200, 'replay');
      if (
        body.publicId !== publicIds.A1 ||
        res.headers.get('idempotent-replayed') !== 'true'
      )
        throw new Error('replay returned a different request');
    },
  );
  await check('Misma key + Dropoff distinto → 409', async () => {
    expect(
      await create(
        A.token,
        keyA,
        order({}, { address: 'Otra dirección de prueba 99' }),
      ),
      409,
      'conflict',
    );
    const detail = expect(
      await call('GET', `/delivery-requests/${publicIds.A1}`, A.token),
      200,
      'original',
    );
    if (detail.stops[1].address.startsWith('Otra'))
      throw new Error('original request was modified');
  });
  await check(
    'COURIER_ADVANCE goodsValue 450 válido; sin goodsValue → 400',
    async () => {
      const body = expect(
        await create(
          A.token,
          `local-${randomUUID()}`,
          order({
            externalReference: 'ORDER-1843',
            financialContext: {
              goodsValue: '450.00',
              goodsPaymentMode: 'COURIER_ADVANCE',
              currency: 'MXN',
            },
          }),
        ),
        201,
        'courier advance',
      );
      publicIds.A2 = body.publicId;
      expect(
        await create(
          A.token,
          `local-${randomUUID()}`,
          order({
            financialContext: {
              goodsPaymentMode: 'COURIER_ADVANCE',
              currency: 'MXN',
            },
          }),
        ),
        400,
        'courier advance without value',
      );
    },
  );
  await check(
    'Aislamiento A/B: lectura, listado y cancelación ajena → 404',
    async () => {
      publicIds.B1 = expect(
        await create(
          B.token,
          `local-${randomUUID()}`,
          order({ externalReference: 'B-ORDER-1' }),
        ),
        201,
        'create B1',
      ).publicId;
      expect(
        await call('GET', `/delivery-requests/${publicIds.A1}`, A.token),
        200,
        'A reads A1',
      );
      expect(
        await call('GET', `/delivery-requests/${publicIds.B1}`, A.token),
        404,
        'A reads B1',
      );
      expect(
        await call('GET', `/delivery-requests/${publicIds.B1}`, B.token),
        200,
        'B reads B1',
      );
      expect(
        await call('GET', `/delivery-requests/${publicIds.A1}`, B.token),
        404,
        'B reads A1',
      );
      expect(
        await call(
          'POST',
          `/delivery-requests/${publicIds.B1}/cancel`,
          A.token,
          { reason: 'Intento ajeno' },
        ),
        404,
        'A cancels B1',
      );
      const list = expect(
        await call(
          'GET',
          '/delivery-requests?externalReference=B-ORDER-1',
          A.token,
        ),
        200,
        'A list',
      );
      if (list.total !== 0) throw new Error('A can list B requests');
    },
  );
  await check('Cancelar A1; repetir conserva razón original', async () => {
    const first = expect(
      await call('POST', `/delivery-requests/${publicIds.A1}/cancel`, A.token, {
        reason: 'El cliente canceló el pedido',
      }),
      200,
      'cancel',
    );
    const again = expect(
      await call('POST', `/delivery-requests/${publicIds.A1}/cancel`, A.token, {
        reason: 'Otra',
      }),
      200,
      'cancel again',
    );
    if (
      first.status !== 'CANCELLED' ||
      again.cancellationReason !== 'El cliente canceló el pedido' ||
      again.cancelledAt !== first.cancelledAt
    )
      throw new Error('cancellation not idempotent');
  });
  await check(
    'ORDER-1842 puede repetirse tras cancelar (nueva key)',
    async () => {
      publicIds.A3 = expect(
        await create(A.token, `local-${randomUUID()}`, order()),
        201,
        'recreate',
      ).publicId;
      if (publicIds.A3 === publicIds.A1) throw new Error('same publicId');
    },
  );
  await check(
    'SUPER_ADMIN lista, consulta y filtra por IntegrationClient',
    async () => {
      const list = expect(
        await call(
          'GET',
          `/admin/delivery-requests?integrationClientId=${A.id}&externalReference=ORDER-1842`,
          saToken,
        ),
        200,
        'admin list',
      );
      const ids = list.items.map((i: Json) => i.publicId);
      if (
        !ids.includes(publicIds.A1) ||
        !ids.includes(publicIds.A3) ||
        ids.includes(publicIds.B1)
      )
        throw new Error('admin filter mismatch');
      const detail = expect(
        await call('GET', `/admin/delivery-requests/${publicIds.B1}`, saToken),
        200,
        'admin detail',
      );
      if (detail.integrationClientId !== B.id)
        throw new Error('admin detail owner mismatch');
    },
  );
  await check('PROVIDER_ADMIN y DRIVER bloqueados', async () => {
    for (const token of [providerAdmin, driver]) {
      expect(
        await call('GET', '/admin/delivery-requests', token),
        403,
        'admin list',
      );
      expect(
        await call('GET', `/admin/delivery-requests/${publicIds.A2}`, token),
        403,
        'admin detail',
      );
      expect(
        await call('GET', '/delivery-requests', token),
        401,
        'b2b list with human token',
      );
      expect(
        await create(token, `local-${randomUUID()}`, order()),
        401,
        'b2b create with human token',
      );
    }
  });
  await check(
    'IntegrationClient suspendido pierde acceso; reactivado lo recupera',
    async () => {
      expect(
        await call('PATCH', `/admin/integrations/${B.id}`, saToken, {
          status: 'SUSPENDED',
        }),
        204,
        'suspend B',
      );
      try {
        expect(
          await call('GET', `/delivery-requests/${publicIds.B1}`, B.token),
          401,
          'suspended read',
        );
        expect(
          await create(B.token, `local-${randomUUID()}`, order()),
          401,
          'suspended create',
        );
      } finally {
        expect(
          await call('PATCH', `/admin/integrations/${B.id}`, saToken, {
            status: 'ACTIVE',
          }),
          204,
          'reactivate B',
        );
      }
      expect(
        await call('GET', `/delivery-requests/${publicIds.B1}`, B.token),
        200,
        'reactivated read',
      );
    },
  );
} catch (error) {
  failed = true;
  results.push({
    check: 'setup',
    result: `FAIL: ${error instanceof Error ? error.message : 'error'}`,
  });
} finally {
  for (const credential of credentials)
    await call(
      'POST',
      `/admin/integrations/${credential.client}/credentials/${credential.id}/revoke`,
      saToken,
    ).catch(() => undefined);
  for (const refreshToken of refreshTokens)
    await call('POST', '/auth/logout', undefined, { refreshToken }).catch(
      () => undefined,
    );
  console.table(results);
  console.log('publicIds', publicIds);
  console.log(
    failed
      ? 'RESULT: FAIL'
      : 'RESULT: PASS (no secrets or contact data printed)',
  );
  if (failed) process.exitCode = 1;
}
