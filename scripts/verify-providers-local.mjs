import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';

const base = `http://127.0.0.1:${process.env.PORT || 3000}/api/v1`;
const prisma = new PrismaClient();
const userId = randomUUID();
const email = `provider-check-${userId}@example.test`;
const password = randomBytes(24).toString('base64url');
const providers = [],
  integrations = [];
let createdUser = false;
async function call(method, path, expected, body, token) {
  const response = await fetch(base + path, {
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
    response.status,
    expected,
    `${method} ${path}: unexpected HTTP status`,
  );
  const data = expected === 204 ? undefined : await response.json();
  const serialized = JSON.stringify(data ?? {});
  assert.equal(
    serialized.includes('passwordHash') || serialized.includes('secretHash'),
    false,
  );
  return data;
}
try {
  const admin = await call('POST', '/auth/login', 200, {
    email: process.env.BOOTSTRAP_ADMIN_EMAIL,
    password: process.env.BOOTSTRAP_ADMIN_PASSWORD,
  });
  const token = admin.accessToken;
  const create = async (type) => {
    const p = await call(
      'POST',
      '/admin/providers',
      201,
      {
        name: 'Local provider verification',
        code: `VERIFY_${randomUUID().replaceAll('-', '').toUpperCase()}`,
        type,
      },
      token,
    );
    providers.push(p.id);
    return p;
  };
  const fleet = await create('FLEET');
  assert.equal(
    fleet.maxDrivers,
    Number(process.env.DEFAULT_FLEET_MAX_DRIVERS || 10),
  );
  assert.equal(
    fleet.maxVehicles,
    Number(process.env.DEFAULT_FLEET_MAX_VEHICLES || 10),
  );
  const independent = await create('INDEPENDENT');
  assert.equal(
    independent.maxDrivers,
    Number(process.env.DEFAULT_INDEPENDENT_MAX_DRIVERS || 1),
  );
  assert.equal(
    independent.maxVehicles,
    Number(process.env.DEFAULT_INDEPENDENT_MAX_VEHICLES || 2),
  );
  const updated = await call(
    'PATCH',
    `/admin/providers/${fleet.id}`,
    200,
    { maxDrivers: 15, maxVehicles: 18 },
    token,
  );
  assert.equal(updated.maxVehicles, 18);
  assert.equal(
    (
      await call(
        'POST',
        `/admin/providers/${fleet.id}/activate`,
        200,
        undefined,
        token,
      )
    ).status,
    'ACTIVE',
  );
  assert.equal(
    (
      await call(
        'POST',
        `/admin/providers/${fleet.id}/suspend`,
        200,
        undefined,
        token,
      )
    ).status,
    'SUSPENDED',
  );
  await prisma.user.create({
    data: {
      id: userId,
      email,
      passwordHash: await argon2.hash(password),
      role: 'PROVIDER_ADMIN',
    },
  });
  createdUser = true;
  const member = await call(
    'POST',
    `/admin/providers/${fleet.id}/members`,
    201,
    { userId, role: 'OWNER' },
    token,
  );
  const user = await call('POST', '/auth/login', 200, { email, password });
  const profile = await call(
    'GET',
    '/provider/profile',
    200,
    undefined,
    user.accessToken,
  );
  assert.equal(profile.id, fleet.id);
  assert.equal(profile.membershipRole, 'OWNER');
  await call(
    'GET',
    `/provider/profile?providerId=${independent.id}`,
    403,
    undefined,
    user.accessToken,
  );
  await call('GET', '/admin/integrations', 403, undefined, user.accessToken);
  const client = await call(
    'POST',
    '/admin/integrations',
    201,
    {
      name: 'Provider separation verification',
      code: `VERIFY_${randomUUID().replaceAll('-', '').toUpperCase()}`,
    },
    token,
  );
  integrations.push(client.id);
  const credential = await call(
    'POST',
    `/admin/integrations/${client.id}/credentials`,
    201,
    {},
    token,
  );
  const b2b = await call('POST', '/integrations/token', 200, {
    clientId: credential.clientId,
    clientSecret: credential.clientSecret,
  });
  await call('GET', '/provider/profile', 401, undefined, b2b.accessToken);
  await call('GET', '/admin/providers', 401, undefined, b2b.accessToken);
  await call(
    'DELETE',
    `/admin/providers/${fleet.id}/members/${member.id}`,
    204,
    undefined,
    token,
  );
  await call('GET', '/provider/profile', 403, undefined, user.accessToken);
  assert.equal(
    await prisma.user.count({ where: { id: userId, role: 'PROVIDER_ADMIN' } }),
    1,
  );
  await call('POST', '/auth/logout', 204, { refreshToken: user.refreshToken });
  await call('POST', '/auth/logout', 204, { refreshToken: admin.refreshToken });
  console.log(
    'PASS local HTTP: SUPER_ADMIN login, FLEET/INDEPENDENT defaults, limits, activation/suspension, membership, PROVIDER_ADMIN login/profile, cross-provider 403, B2B 401, removal without deleting User.',
  );
} catch {
  console.error(
    'Provider verification failed. Check backend, bootstrap credentials and rate limits; no sensitive values printed.',
  );
  process.exitCode = 1;
} finally {
  // Remove only fixtures whose randomly generated IDs belong to this run.
  await prisma.providerMembership.deleteMany({
    where: { providerId: { in: providers } },
  });
  await prisma.deliveryProvider.deleteMany({
    where: { id: { in: providers } },
  });
  await prisma.integrationClient.deleteMany({
    where: { id: { in: integrations } },
  });
  if (createdUser) await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
}
