// LOCAL/TEST ONLY. Manual V1.6.1 provisioning scenario over real HTTP and the local mail outbox.
// Requires: db:seed (bootstrap SUPER_ADMIN), db:seed:local-provider-admins and a backend started with
// MAIL_PROVIDER=local_outbox and MANDARIA_WEB_URL set (e.g. http://localhost:5173).
// Usage: npm run verify:user-invitations   (at most 5 logins; deletes the accounts it creates; no secrets printed)
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import {
  LOCAL_PROVIDER_ADMIN_DEFAULTS as SEED,
  assertLocalSeedAllowed,
} from './local-provider-admins.js';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const base = `http://127.0.0.1:${process.env.PORT || 3000}/api/v1`;
const outbox =
  process.env.LOCAL_MAIL_OUTBOX_DIR || join(tmpdir(), 'mandaria-mail-outbox');
const stamp = Date.now().toString(36);
const invitees = {
  admin: `provider-admin-real-${stamp}@mandaria.local`,
  driver: `driver-real-${stamp}@mandaria.local`,
};
const results: { check: string; result: string }[] = [];
const refreshTokens: string[] = [];
const summary: Record<string, unknown> = {};
let failed = false;

async function call(
  method: string,
  path: string,
  token?: string,
  body?: unknown,
) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30000),
  });
  const text = await response.text();
  if (/passwordHash|tokenHash|activate-account\?token/.test(text))
    throw new Error(`${method} ${path} leaked sensitive fields`);
  return {
    status: response.status,
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
    'login',
  );
  refreshTokens.push(body.refreshToken);
  return body.accessToken as string;
}
/** Reads the activation token the way a person would: from the emailed link. Deletes the message. */
async function tokenFromOutbox(email: string) {
  for (const file of (await readdir(outbox)).sort().reverse()) {
    const path = join(outbox, file);
    const message = JSON.parse(await readFile(path, 'utf8')) as Json;
    if (message.to !== email) continue;
    await rm(path);
    const token = new URL(message.activationUrl).searchParams.get('token');
    if (!token) throw new Error('outbox message without token');
    return token;
  }
  throw new Error('invitation email not found in local outbox');
}

// Refuses production or non-local databases before anything is written or deleted.
const password = assertLocalSeedAllowed(process.env);
const prisma = new PrismaClient();
try {
  const sa = await login(
    process.env.BOOTSTRAP_ADMIN_EMAIL ?? '',
    process.env.BOOTSTRAP_ADMIN_PASSWORD ?? '',
  );
  const adminA = await login(SEED.emails.adminA, password);
  const providers = expect(
    await call('GET', `/admin/providers?search=${SEED.codes.providerA}`, sa),
    200,
    'providers',
  ).items as Json[];
  const providerA = providers.find((p) => p.code === SEED.codes.providerA);
  const providerB = (
    expect(
      await call('GET', `/admin/providers?search=${SEED.codes.providerB}`, sa),
      200,
      'providers',
    ).items as Json[]
  ).find((p) => p.code === SEED.codes.providerB);
  if (!providerA || !providerB)
    throw new Error('Run npm run db:seed:local-provider-admins first');
  const chosen = {
    admin: randomBytes(18).toString('base64url'),
    driver: randomBytes(18).toString('base64url'),
  };

  await check(
    'SUPER_ADMIN invita PROVIDER_ADMIN a Rápidos de Coita → User INVITED + correo',
    async () => {
      const body = expect(
        await call('POST', `/admin/providers/${providerA.id}/invitations`, sa, {
          email: invitees.admin,
          role: 'PROVIDER_ADMIN',
          membershipRole: 'ADMIN',
        }),
        201,
        'invite',
      );
      if (body.status !== 'PENDING' || body.emailDelivery !== 'SENT')
        throw new Error('invitation not pending or email not delivered');
      const users = expect(
        await call('GET', '/users?status=INVITED', sa),
        200,
        'users',
      ) as unknown as Json[];
      if (!users.some((u) => u.email === invitees.admin))
        throw new Error('invited user not listed as INVITED');
      // INVITED login (401) is covered by E2E: the 5 logins/min budget is kept for real sessions.
    },
  );
  await check(
    'Activación desde el enlace → login → /provider/profile A ✅ / B ❌',
    async () => {
      const token = await tokenFromOutbox(invitees.admin);
      expect(
        await call('POST', '/auth/activate-account', undefined, {
          token,
          password: chosen.admin,
        }),
        200,
        'activate',
      );
      expect(
        await call('POST', '/auth/activate-account', undefined, {
          token,
          password: chosen.admin,
        }),
        409,
        'reuse',
        'INVITATION_ALREADY_ACCEPTED',
      );
      const session = await login(invitees.admin, chosen.admin);
      const profile = expect(
        await call('GET', '/provider/profile', session),
        200,
        'profile',
      );
      if (profile.id !== providerA.id) throw new Error('wrong provider');
      expect(
        await call(
          'GET',
          `/provider/profile?providerId=${providerB.id}`,
          session,
        ),
        403,
        'foreign provider',
      );
    },
  );
  await check(
    'PROVIDER_ADMIN invita DRIVER en su proveedor (A ❌ en B / B ❌ en A) → activación → login → /driver/me',
    async () => {
      const invite = (session: string, providerId: string) =>
        call(
          'POST',
          `/provider/driver-invitations?providerId=${providerId}`,
          session,
          { email: invitees.driver, driverName: 'Repartidor local' },
        );
      expect(await invite(adminA, providerB.id), 403, 'Admin A → Provider B');
      // The local V1.4 scenario may leave Provider A at maxDrivers: then the seat guard must
      // answer 409 and the flow continues with Admin B in Provider B.
      let target = providerA;
      const first = await invite(adminA, providerA.id);
      if (first.status === 409) {
        expect(first, 409, 'Provider A full', 'PROVIDER_DRIVER_LIMIT_REACHED');
        summary.providerAFull = true;
        const adminB = await login(SEED.emails.adminB, password);
        expect(await invite(adminB, providerA.id), 403, 'Admin B → Provider A');
        expect(await invite(adminB, providerB.id), 201, 'Admin B → Provider B');
        target = providerB;
      } else expect(first, 201, 'Admin A → Provider A');
      summary.driverProvider = target.code;
      const token = await tokenFromOutbox(invitees.driver);
      expect(
        await call('POST', '/auth/activate-account', undefined, {
          token,
          password: chosen.driver,
        }),
        200,
        'activate driver',
      );
      const session = await login(invitees.driver, chosen.driver);
      const me = expect(await call('GET', '/driver/me', session), 200, 'me');
      if (me.provider?.id !== target.id) throw new Error('wrong provider');
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
  // Remove only the accounts created by this run (LOCAL database already asserted).
  const users = await prisma.user.findMany({
    where: { email: { in: Object.values(invitees) } },
    select: { id: true },
  });
  const userIds = users.map((u) => u.id);
  await prisma.userInvitation.deleteMany({
    where: { userId: { in: userIds } },
  });
  await prisma.driver.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.providerMembership.deleteMany({
    where: { userId: { in: userIds } },
  });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
}
console.log(JSON.stringify({ summary, results }, null, 2));
if (failed) process.exitCode = 1;
