import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

const base = `http://127.0.0.1:${process.env.PORT || 3000}`;
const prisma = new PrismaClient();
let integrationId;
let adminToken;
async function call(method, path, status, body, token) {
  const result = await fetch(base + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body && method !== 'GET' && method !== 'HEAD'
      ? { body: JSON.stringify(body) }
      : {}),
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(
    result.status,
    status,
    `${method} ${path}: unexpected HTTP status`,
  );
  const data = status === 204 ? undefined : await result.json();
  assert.equal(
    JSON.stringify(data ?? {}).includes('secretHash'),
    false,
    'Response exposed a hash',
  );
  return data;
}
const exchange = (c, status = 200) =>
  call('POST', '/api/v1/integrations/token', status, {
    clientId: c.clientId,
    clientSecret: c.clientSecret,
  });
const me = (token, status = 200) =>
  call('GET', '/api/v1/integrations/me', status, undefined, token);
try {
  await call('GET', '/health', 200);
  const docs = await call('GET', '/docs-json', 200);
  assert.ok(docs.components.securitySchemes['integration-bearer']);
  const human = await call('POST', '/api/v1/auth/login', 200, {
    email: process.env.BOOTSTRAP_ADMIN_EMAIL,
    password: process.env.BOOTSTRAP_ADMIN_PASSWORD,
  });
  adminToken = human.accessToken;
  const client = await call(
    'POST',
    '/api/v1/admin/integrations',
    201,
    {
      name: 'Local B2B verification',
      code: `VERIFY_${randomUUID().replaceAll('-', '').toUpperCase()}`,
    },
    adminToken,
  );
  integrationId = client.id;
  const path = `/api/v1/admin/integrations/${integrationId}`;
  const a = await call(
    'POST',
    `${path}/credentials`,
    201,
    { scopes: ['deliveries:read'] },
    adminToken,
  );
  const tokenA = await exchange(a);
  await me(tokenA.accessToken);
  await call(
    'GET',
    '/api/v1/integrations/scope-check',
    200,
    undefined,
    tokenA.accessToken,
  );
  await call('PATCH', path, 204, { status: 'SUSPENDED' }, adminToken);
  await me(tokenA.accessToken, 401);
  await exchange(a, 401);
  await call('PATCH', path, 204, { status: 'ACTIVE' }, adminToken);
  await me(tokenA.accessToken);
  const b = await call(
    'POST',
    `${path}/credentials/${a.clientId}/rotate`,
    201,
    undefined,
    adminToken,
  );
  const tokenB = await exchange(b);
  await me(tokenA.accessToken);
  await me(tokenB.accessToken);
  await call(
    'POST',
    `${path}/credentials/${a.clientId}/revoke`,
    204,
    undefined,
    adminToken,
  );
  await exchange(a, 401);
  await me(tokenA.accessToken, 401);
  await me(tokenB.accessToken);
  const metadata = await call(
    'GET',
    `${path}/credentials`,
    200,
    undefined,
    adminToken,
  );
  assert.equal(JSON.stringify(metadata).includes('clientSecret'), false);
  assert.equal(
    [a.clientSecret, b.clientSecret].some((s) =>
      JSON.stringify(metadata).includes(s),
    ),
    false,
  );
  await call(
    'POST',
    `${path}/credentials/${b.clientId}/revoke`,
    204,
    undefined,
    adminToken,
  );
  await call('POST', '/api/v1/auth/logout', 204, {
    refreshToken: human.refreshToken,
  });
  console.log(
    'PASS local HTTP: create, credentials, token, me, scopes, suspension, reactivation, rotation overlap and revocation. Responses contain no secretHash; metadata contains no secrets.',
  );
} catch {
  console.error(
    'B2B local verification failed. Check backend, bootstrap credentials and rate limits; no secret values printed.',
  );
  process.exitCode = 1;
} finally {
  // Only the randomly named integration created by this verification is removed.
  if (integrationId)
    await prisma.integrationClient.delete({ where: { id: integrationId } });
  await prisma.$disconnect();
}
