// LOCAL/TEST ONLY. Real HTTP validation of PROVIDER_ADMIN → ProviderMembership → DeliveryProvider
// against a running backend. Requires `npm run db:seed:local-provider-admins` first.
// Usage: npm run verify:provider-admins   (never prints passwords or tokens)
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import {
  LOCAL_PROVIDER_ADMIN_DEFAULTS as SEED,
  assertLocalSeedAllowed,
} from './local-provider-admins.js';

type Json = Record<string, unknown> & {
  items?: Json[];
  total?: number;
};
const base = `http://127.0.0.1:${process.env.PORT || 3000}/api/v1`;
const prisma = new PrismaClient();
const results: { check: string; result: string }[] = [];
const integrations: string[] = [];
const refreshTokens: string[] = [];
let failed = false;

async function call(
  method: string,
  path: string,
  token?: string,
  body?: unknown,
): Promise<{ status: number; body: Json }> {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10000),
  });
  const text = await response.text();
  if (/passwordHash|secretHash/.test(text))
    throw new Error(`${method} ${path} leaked a hash field`);
  return { status: response.status, body: text ? JSON.parse(text) : {} };
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
function expectStatus(
  res: { status: number },
  expected: number,
  label: string,
) {
  if (res.status !== expected)
    throw new Error(`${label}: expected ${expected}, got ${res.status}`);
}
async function login(email: string, password: string) {
  const res = await call('POST', '/auth/login', undefined, { email, password });
  expectStatus(res, 200, `login ${email}`);
  const { accessToken, refreshToken, tokenType } = res.body as {
    accessToken?: string;
    refreshToken?: string;
    tokenType?: string;
  };
  if (!accessToken || !refreshToken || tokenType !== 'Bearer')
    throw new Error('login response without access/refresh Bearer tokens');
  refreshTokens.push(refreshToken);
  return { accessToken, refreshToken };
}

try {
  const password = assertLocalSeedAllowed(process.env);
  const providerA = await prisma.deliveryProvider.findUnique({
    where: { code: SEED.codes.providerA },
  });
  const providerB = await prisma.deliveryProvider.findUnique({
    where: { code: SEED.codes.providerB },
  });
  if (!providerA || !providerB)
    throw new Error('Run npm run db:seed:local-provider-admins first');

  let a!: { accessToken: string; refreshToken: string };
  let b!: { accessToken: string; refreshToken: string };
  let none!: { accessToken: string; refreshToken: string };
  let sa!: { accessToken: string; refreshToken: string };

  await check(
    'Login PROVIDER_ADMIN A/B/sin membership (endpoint real)',
    async () => {
      a = await login(SEED.emails.adminA, password);
      b = await login(SEED.emails.adminB, password);
      none = await login(SEED.emails.noMembership, password);
    },
  );
  await check('Login SUPER_ADMIN bootstrap', async () => {
    sa = await login(
      process.env.BOOTSTRAP_ADMIN_EMAIL ?? '',
      process.env.BOOTSTRAP_ADMIN_PASSWORD ?? '',
    );
  });
  await check('/auth/me devuelve PROVIDER_ADMIN activo', async () => {
    for (const [session, email] of [
      [a, SEED.emails.adminA],
      [b, SEED.emails.adminB],
      [none, SEED.emails.noMembership],
    ] as const) {
      const me = await call('GET', '/auth/me', session.accessToken);
      expectStatus(me, 200, '/auth/me');
      if (
        me.body.email !== email ||
        me.body.role !== 'PROVIDER_ADMIN' ||
        me.body.active !== true
      )
        throw new Error('/auth/me returned unexpected identity');
    }
  });
  await check('Refresh rota tokens y revoca el anterior', async () => {
    const rotated = await call('POST', '/auth/refresh', undefined, {
      refreshToken: a.refreshToken,
    });
    expectStatus(rotated, 200, 'refresh');
    const reuse = await call('POST', '/auth/refresh', undefined, {
      refreshToken: a.refreshToken,
    });
    expectStatus(reuse, 401, 'refresh reuse');
    a = {
      accessToken: rotated.body.accessToken as string,
      refreshToken: rotated.body.refreshToken as string,
    };
    refreshTokens.push(a.refreshToken);
    expectStatus(
      await call('GET', '/auth/me', a.accessToken),
      200,
      'me after refresh',
    );
  });
  await check(
    'Admin A → Provider A permitido (/provider/profile)',
    async () => {
      for (const path of [
        '/provider/profile',
        `/provider/profile?providerId=${providerA.id}`,
      ]) {
        const res = await call('GET', path, a.accessToken);
        expectStatus(res, 200, path);
        if (
          res.body.id !== providerA.id ||
          res.body.name !== SEED.names.providerA ||
          res.body.type !== 'FLEET' ||
          res.body.status !== 'ACTIVE' ||
          res.body.membershipRole !== 'OWNER'
        )
          throw new Error(`${path} did not return Provider A`);
      }
      const list = await call('GET', '/provider/profiles', a.accessToken);
      expectStatus(list, 200, '/provider/profiles');
      if (list.body.total !== 1 || list.body.items?.[0]?.id !== providerA.id)
        throw new Error('/provider/profiles must list only Provider A');
    },
  );
  await check('Admin A → Provider B bloqueado (403)', async () => {
    expectStatus(
      await call(
        'GET',
        `/provider/profile?providerId=${providerB.id}`,
        a.accessToken,
      ),
      403,
      'A→B',
    );
    expectStatus(
      await call(
        'GET',
        `/provider/profile?providerId=${randomUUID()}`,
        a.accessToken,
      ),
      403,
      'A→random',
    );
    expectStatus(
      await call(
        'GET',
        `/provider/profile?providerId=${providerA.id}&userId=${randomUUID()}`,
        a.accessToken,
      ),
      400,
      'client-supplied userId rejected',
    );
  });
  await check('Admin B → Provider B permitido; → Provider A 403', async () => {
    const own = await call('GET', '/provider/profile', b.accessToken);
    expectStatus(own, 200, 'B→B');
    if (own.body.id !== providerB.id)
      throw new Error('B did not get Provider B');
    expectStatus(
      await call(
        'GET',
        `/provider/profile?providerId=${providerA.id}`,
        b.accessToken,
      ),
      403,
      'B→A',
    );
  });
  await check('PROVIDER_ADMIN sin membership bloqueado', async () => {
    expectStatus(
      await call('GET', '/provider/profile', none.accessToken),
      403,
      'none→profile',
    );
    for (const id of [providerA.id, providerB.id])
      expectStatus(
        await call(
          'GET',
          `/provider/profile?providerId=${id}`,
          none.accessToken,
        ),
        403,
        'none→provider',
      );
    const list = await call('GET', '/provider/profiles', none.accessToken);
    expectStatus(list, 200, 'none→profiles');
    if (list.body.total !== 0)
      throw new Error('user without membership sees providers');
  });
  await check(
    'PROVIDER_ADMIN → endpoints SUPER_ADMIN bloqueados (403)',
    async () => {
      const t = a.accessToken;
      const denied: [string, string, unknown?][] = [
        ['GET', '/admin/providers'],
        [
          'POST',
          '/admin/providers',
          { name: 'X', code: 'DENIED_X', type: 'FLEET' },
        ],
        ['GET', `/admin/providers/${providerA.id}`],
        ['GET', `/admin/providers/${providerB.id}`],
        ['PATCH', `/admin/providers/${providerA.id}`, { maxDrivers: 999 }],
        ['POST', `/admin/providers/${providerA.id}/suspend`],
        ['POST', `/admin/providers/${providerB.id}/activate`],
        ['GET', `/admin/providers/${providerA.id}/members`],
        [
          'POST',
          `/admin/providers/${providerB.id}/members`,
          { userId: (await call('GET', '/auth/me', t)).body.id, role: 'OWNER' },
        ],
        ['DELETE', `/admin/providers/${providerB.id}/members/${randomUUID()}`],
        ['GET', '/users'],
      ];
      for (const [method, path, body] of denied)
        expectStatus(
          await call(method, path, t, body),
          403,
          `${method} ${path}`,
        );
    },
  );

  let client!: { id: string };
  let credential!: { clientId: string; clientSecret: string };
  await check('SUPER_ADMIN crea IntegrationClient temporal', async () => {
    const created = await call('POST', '/admin/integrations', sa.accessToken, {
      name: 'Local PROVIDER_ADMIN validation',
      code: `VERIFY_${randomUUID().replaceAll('-', '').toUpperCase()}`,
    });
    expectStatus(created, 201, 'create integration');
    client = created.body as { id: string };
    integrations.push(client.id);
    const cred = await call(
      'POST',
      `/admin/integrations/${client.id}/credentials`,
      sa.accessToken,
      { scopes: ['deliveries:read'] },
    );
    expectStatus(cred, 201, 'create credential');
    const { clientId, clientSecret } = cred.body as typeof credential;
    credential = { clientId, clientSecret };
  });
  await check(
    'PROVIDER_ADMIN → Integraciones B2B bloqueadas (403)',
    async () => {
      const t = a.accessToken;
      const denied: [string, string, unknown?][] = [];
      for (const prefix of ['/admin/integrations', '/integrations'])
        denied.push(
          ['GET', prefix],
          ['POST', prefix, { name: 'Denied', code: 'DENIED_INTEGRATION' }],
          ['GET', `${prefix}/${client.id}`],
          ['PATCH', `${prefix}/${client.id}`, { status: 'SUSPENDED' }],
          ['POST', `${prefix}/${client.id}/credentials`, {}],
          ['GET', `${prefix}/${client.id}/credentials`],
          [
            'POST',
            `${prefix}/${client.id}/credentials/${credential.clientId}/rotate`,
          ],
          [
            'POST',
            `${prefix}/${client.id}/credentials/${credential.clientId}/revoke`,
          ],
          [
            'DELETE',
            `${prefix}/${client.id}/credentials/${credential.clientId}`,
          ],
        );
      for (const [method, path, body] of denied)
        expectStatus(
          await call(method, path, t, body),
          403,
          `${method} ${path}`,
        );
      const state = await call(
        'GET',
        `/admin/integrations/${client.id}`,
        sa.accessToken,
      );
      const creds = await call(
        'GET',
        `/admin/integrations/${client.id}/credentials`,
        sa.accessToken,
      );
      const list = creds.body as unknown as { status: string }[];
      if (
        state.body.status !== 'ACTIVE' ||
        list.length !== 1 ||
        list[0].status !== 'ACTIVE'
      )
        throw new Error('integration state changed after denied requests');
    },
  );
  await check(
    'IntegrationClient JWT → Provider Admin endpoints (401)',
    async () => {
      const token = await call(
        'POST',
        '/integrations/token',
        undefined,
        credential,
      );
      expectStatus(token, 200, 'integration token');
      const b2b = token.body.accessToken as string;
      for (const path of [
        '/provider/profile',
        `/provider/profile?providerId=${providerA.id}`,
        '/provider/profiles',
        '/admin/providers',
        '/auth/me',
      ])
        expectStatus(await call('GET', path, b2b), 401, `B2B ${path}`);
      expectStatus(
        await call('GET', '/integrations/me', a.accessToken),
        401,
        'user JWT → /integrations/me',
      );
    },
  );
  await check(
    'SUPER_ADMIN administra Provider A y B sin regresiones',
    async () => {
      for (const [p, email] of [
        [providerA, SEED.emails.adminA],
        [providerB, SEED.emails.adminB],
      ] as const) {
        const got = await call(
          'GET',
          `/admin/providers/${p.id}`,
          sa.accessToken,
        );
        expectStatus(got, 200, 'SA get provider');
        const patched = await call(
          'PATCH',
          `/admin/providers/${p.id}`,
          sa.accessToken,
          {
            maxDrivers: got.body.maxDrivers,
          },
        );
        expectStatus(patched, 200, 'SA patch provider (same value)');
        const members = await call(
          'GET',
          `/admin/providers/${p.id}/members`,
          sa.accessToken,
        );
        expectStatus(members, 200, 'SA members');
        const emails = (members.body.items ?? []).map(
          (m) => (m.user as { email: string }).email,
        );
        if (emails.length !== 1 || emails[0] !== email)
          throw new Error(`unexpected members for ${p.code}`);
      }
      expectStatus(
        await call('GET', '/admin/providers?search=LOCAL_', sa.accessToken),
        200,
        'SA list',
      );
      expectStatus(
        await call('GET', '/users', sa.accessToken),
        200,
        'SA users',
      );
      // By design SUPER_ADMIN manages providers through /admin, not the PROVIDER_ADMIN surface.
      expectStatus(
        await call('GET', '/provider/profile', sa.accessToken),
        403,
        'SA /provider/profile',
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
  for (const refreshToken of refreshTokens)
    await call('POST', '/auth/logout', undefined, { refreshToken }).catch(
      () => undefined,
    );
  // Remove only the temporary IntegrationClient created by this run.
  await prisma.integrationClient.deleteMany({
    where: { id: { in: integrations } },
  });
  await prisma.$disconnect();
  console.table(results);
  console.log(failed ? 'RESULT: FAIL' : 'RESULT: PASS (no secrets printed)');
  if (failed) process.exitCode = 1;
}
