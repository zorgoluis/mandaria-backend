// LOCAL/TEST ONLY. Manual V1.4 scenario over real HTTP (prompt section 54) on Provider A
// "Rápidos de Coita". Idempotent: reuses Carlos/Pedro/José, MOTO-01/MOTO-02/BICI-01.
// Requires: db:seed:local-provider-admins, db:seed:local-driver-users and a running backend.
// Usage: npm run verify:drivers-vehicles   (5 logins: wait 60 s between runs)
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import {
  LOCAL_PROVIDER_ADMIN_DEFAULTS as SEED,
  assertLocalSeedAllowed,
} from './local-provider-admins.js';
import { LOCAL_DRIVER_USERS as DRIVERS } from './local-driver-users.js';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const base = `http://127.0.0.1:${process.env.PORT || 3000}/api/v1`;
const prisma = new PrismaClient();
const results: { check: string; result: string }[] = [];
const refreshTokens: string[] = [];
const integrations: string[] = [];
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
    signal: AbortSignal.timeout(10000),
  });
  const text = await response.text();
  if (/passwordHash|secretHash/.test(text))
    throw new Error(`${method} ${path} leaked a hash field`);
  return {
    status: response.status,
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
      `${label}: expected ${status}, got ${res.status} ${res.body.message ?? ''}`,
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

try {
  const password = assertLocalSeedAllowed(process.env);
  const providerA = await prisma.deliveryProvider.findUnique({
    where: { code: SEED.codes.providerA },
  });
  const providerB = await prisma.deliveryProvider.findUnique({
    where: { code: SEED.codes.providerB },
  });
  const users = await prisma.user.findMany({
    where: { email: { in: Object.values(DRIVERS) }, role: 'DRIVER' },
    select: { id: true, email: true },
  });
  const userId = (email: string) => {
    const user = users.find((u) => u.email === email);
    if (!user) throw new Error('Run npm run db:seed:local-driver-users first');
    return user.id;
  };
  if (!providerA || !providerB)
    throw new Error('Run npm run db:seed:local-provider-admins first');
  const A = providerA.id;
  const B = providerB.id;

  const sa = await login(
    process.env.BOOTSTRAP_ADMIN_EMAIL ?? '',
    process.env.BOOTSTRAP_ADMIN_PASSWORD ?? '',
  );
  const adminA = await login(SEED.emails.adminA, password);
  const adminB = await login(SEED.emails.adminB, password);
  const none = await login(SEED.emails.noMembership, password);
  const carlosToken = await login(DRIVERS.carlos, password);

  const ensureDriver = async (token: string, email: string, name: string) => {
    const existing = await prisma.driver.findUnique({
      where: { userId: userId(email) },
    });
    const driver = existing
      ? expect(
          await call('GET', `/provider/drivers/${existing.id}`, token),
          200,
          `get ${name}`,
        )
      : expect(
          await call('POST', '/provider/drivers', token, {
            userId: userId(email),
            name,
          }),
          201,
          `create ${name}`,
        );
    return expect(
      await call('PATCH', `/provider/drivers/${driver.id}`, token, {
        status: 'ACTIVE',
      }),
      200,
      `activate ${name}`,
    );
  };
  const ensureVehicle = async (
    token: string,
    identifier: string,
    type: string,
  ) => {
    const page = expect(
      await call('GET', `/provider/vehicles?search=${identifier}`, token),
      200,
      'search vehicle',
    );
    const found = page.items.find((v: Json) => v.identifier === identifier);
    const vehicle =
      found ??
      expect(
        await call('POST', '/provider/vehicles', token, { identifier, type }),
        201,
        `create ${identifier}`,
      );
    return expect(
      await call('PATCH', `/provider/vehicles/${vehicle.id}`, token, {
        status: 'ACTIVE',
      }),
      200,
      `activate ${identifier}`,
    );
  };
  const assign = (token: string, driverId: string, vehicleId: string) =>
    call('POST', `/provider/drivers/${driverId}/vehicle`, token, { vehicleId });
  const unassign = (token: string, driverId: string) =>
    call('DELETE', `/provider/drivers/${driverId}/vehicle`, token);

  let carlos!: Json,
    pedro!: Json,
    jose!: Json,
    moto1!: Json,
    moto2!: Json,
    bici!: Json;

  await check(
    'SUPER_ADMIN configura límites de Provider A (3 drivers / 3 vehicles)',
    async () => {
      expect(
        await call('PATCH', `/admin/providers/${A}`, sa, {
          maxDrivers: 3,
          maxVehicles: 3,
        }),
        200,
        'limits',
      );
    },
  );
  await check('Admin A crea/activa Carlos, Pedro y José', async () => {
    carlos = await ensureDriver(adminA, DRIVERS.carlos, 'Carlos');
    pedro = await ensureDriver(adminA, DRIVERS.pedro, 'Pedro');
    jose = await ensureDriver(adminA, DRIVERS.jose, 'José');
  });
  await check('maxDrivers: Luis → 409', async () => {
    expect(
      await call('POST', '/provider/drivers', adminA, {
        userId: userId(DRIVERS.luis),
        name: 'Luis',
      }),
      409,
      'Luis',
    );
  });
  await check('Admin A crea MOTO-01, MOTO-02, BICI-01', async () => {
    moto1 = await ensureVehicle(adminA, 'MOTO-01', 'MOTORCYCLE');
    moto2 = await ensureVehicle(adminA, 'MOTO-02', 'MOTORCYCLE');
    bici = await ensureVehicle(adminA, 'BICI-01', 'BICYCLE');
  });
  await check('maxVehicles: MOTO-03 → 409', async () => {
    expect(
      await call('POST', '/provider/vehicles', adminA, {
        identifier: 'MOTO-03',
        type: 'MOTORCYCLE',
      }),
      409,
      'MOTO-03',
    );
  });
  await check(
    'Asignar Carlos→MOTO-01, Pedro→MOTO-02, José→BICI-01',
    async () => {
      for (const driver of [carlos, pedro, jose])
        await unassign(adminA, driver.id); // idempotent reset
      expect(await assign(adminA, carlos.id, moto1.id), 201, 'Carlos→MOTO-01');
      expect(await assign(adminA, pedro.id, moto2.id), 201, 'Pedro→MOTO-02');
      expect(await assign(adminA, jose.id, bici.id), 201, 'José→BICI-01');
      const who = expect(
        await call('GET', `/provider/vehicles/${moto1.id}`, adminA),
        200,
        'who uses MOTO-01',
      );
      if (who.currentAssignment?.driver.id !== carlos.id)
        throw new Error('MOTO-01 current driver is not Carlos');
    },
  );
  await check(
    'Cambio Carlos: unassign MOTO-01; MOTO-02 ocupado 409; libre → 201; historial',
    async () => {
      const closed = expect(
        await unassign(adminA, carlos.id),
        200,
        'unassign Carlos',
      );
      if (!closed.unassignedAt) throw new Error('unassignedAt not set');
      expect(
        await assign(adminA, carlos.id, moto2.id),
        409,
        'MOTO-02 occupied by Pedro',
      );
      expect(await unassign(adminA, pedro.id), 200, 'unassign Pedro');
      expect(await assign(adminA, carlos.id, moto2.id), 201, 'Carlos→MOTO-02');
      expect(await assign(adminA, pedro.id, moto1.id), 201, 'Pedro→MOTO-01');
      const history = expect(
        await call(
          'GET',
          `/provider/drivers/${carlos.id}/assignments?pageSize=2`,
          adminA,
        ),
        200,
        'history',
      );
      const [current, previous] = history.items;
      if (current.vehicleId !== moto2.id || current.unassignedAt !== null)
        throw new Error('current assignment is not MOTO-02');
      if (previous.vehicleId !== moto1.id || previous.unassignedAt === null)
        throw new Error('MOTO-01 not kept in history');
    },
  );
  await check('Vehicle MAINTENANCE no asignable (409)', async () => {
    expect(await unassign(adminA, jose.id), 200, 'unassign José');
    expect(
      await call('PATCH', `/provider/vehicles/${bici.id}`, adminA, {
        status: 'MAINTENANCE',
      }),
      200,
      'maintenance',
    );
    expect(await assign(adminA, jose.id, bici.id), 409, 'assign maintenance');
    expect(
      await call('PATCH', `/provider/vehicles/${bici.id}`, adminA, {
        status: 'ACTIVE',
      }),
      200,
      'restore',
    );
    expect(await assign(adminA, jose.id, bici.id), 201, 'José→BICI-01');
  });
  await check(
    'DRIVER /driver/me y disponibilidad propia; suspendido → AVAILABLE 409',
    async () => {
      const me = expect(
        await call('GET', '/driver/me', carlosToken),
        200,
        '/driver/me',
      );
      if (
        me.provider.id !== A ||
        me.currentAssignment?.vehicle.identifier !== 'MOTO-02'
      )
        throw new Error('unexpected /driver/me');
      expect(
        await call('PATCH', '/driver/availability', carlosToken, {
          availability: 'AVAILABLE',
        }),
        200,
        'AVAILABLE',
      );
      expect(
        await call('PATCH', '/driver/availability', carlosToken, {
          availability: 'AVAILABLE',
          driverId: pedro.id,
        }),
        400,
        'foreign driverId',
      );
      expect(
        await call('PATCH', `/provider/drivers/${carlos.id}`, adminA, {
          status: 'SUSPENDED',
        }),
        200,
        'suspend Carlos',
      );
      try {
        expect(
          await call('PATCH', '/driver/availability', carlosToken, {
            availability: 'AVAILABLE',
          }),
          409,
          'suspended AVAILABLE',
        );
      } finally {
        expect(
          await call('PATCH', `/provider/drivers/${carlos.id}`, adminA, {
            status: 'ACTIVE',
          }),
          200,
          'reactivate Carlos',
        );
      }
    },
  );
  await check(
    'Provider SUSPENDED → Driver AVAILABLE 409 (se reactiva al final)',
    async () => {
      expect(
        await call('POST', `/admin/providers/${A}/suspend`, sa),
        200,
        'suspend A',
      );
      try {
        expect(
          await call('PATCH', '/driver/availability', carlosToken, {
            availability: 'AVAILABLE',
          }),
          409,
          'AVAILABLE on suspended provider',
        );
        expect(
          await assign(adminA, carlos.id, moto1.id),
          409,
          'assign on suspended provider',
        );
      } finally {
        expect(
          await call('POST', `/admin/providers/${A}/activate`, sa),
          200,
          'activate A',
        );
      }
    },
  );
  let driverB!: Json, vehicleB!: Json;
  await check('Provider B: Admin B gestiona Mario y VAN-01', async () => {
    driverB = await ensureDriver(adminB, DRIVERS.mario, 'Mario');
    vehicleB = await ensureVehicle(adminB, 'VAN-01', 'VAN');
    const list = expect(
      await call('GET', '/provider/drivers', adminB),
      200,
      'list B',
    );
    if (list.items.some((d: Json) => d.providerId !== B))
      throw new Error('Provider B list leaked drivers');
  });
  await check(
    'Cross-provider: A→B 403/404; Driver A + Vehicle B 404',
    async () => {
      expect(
        await call('GET', `/provider/drivers?providerId=${B}`, adminA),
        403,
        'A list B drivers',
      );
      expect(
        await call('GET', `/provider/vehicles?providerId=${B}`, adminA),
        403,
        'A list B vehicles',
      );
      expect(
        await call('GET', `/provider/drivers/${driverB.id}`, adminA),
        404,
        'A get B driver',
      );
      expect(
        await call('PATCH', `/provider/vehicles/${vehicleB.id}`, adminA, {
          status: 'SUSPENDED',
        }),
        404,
        'A patch B vehicle',
      );
      expect(
        await assign(adminA, jose.id, vehicleB.id),
        404,
        'A driver + B vehicle',
      );
      expect(
        await call('GET', `/provider/drivers?providerId=${A}`, adminB),
        403,
        'B list A drivers',
      );
      expect(
        await call('GET', `/provider/vehicles/${moto1.id}`, adminB),
        404,
        'B get A vehicle',
      );
    },
  );
  await check('Admin sin membership bloqueado', async () => {
    expect(
      await call('POST', '/provider/drivers', none, {
        userId: userId(DRIVERS.luis),
        name: 'Luis',
      }),
      403,
      'create driver',
    );
    expect(
      await call('GET', `/provider/drivers?providerId=${A}`, none),
      403,
      'list drivers A',
    );
    expect(
      await call('POST', '/provider/vehicles', none, {
        identifier: 'NOPE-01',
        type: 'CAR',
      }),
      403,
      'create vehicle',
    );
    expect(
      await call('GET', `/provider/vehicles?providerId=${A}`, none),
      403,
      'list vehicles A',
    );
  });
  await check('SUPER_ADMIN ve A y B con conteos', async () => {
    const capacity = expect(
      await call('GET', `/admin/providers/${A}/capacity`, sa),
      200,
      'capacity A',
    );
    if (
      capacity.drivers.count !== 3 ||
      capacity.drivers.max !== 3 ||
      capacity.vehicles.count !== 3
    )
      throw new Error(`unexpected capacity ${JSON.stringify(capacity)}`);
    expect(
      await call('GET', `/admin/providers/${B}/drivers`, sa),
      200,
      'SA drivers B',
    );
    expect(
      await call('GET', `/admin/providers/${B}/vehicles`, sa),
      200,
      'SA vehicles B',
    );
    const list = expect(
      await call('GET', '/admin/providers?search=LOCAL_', sa),
      200,
      'SA provider list',
    );
    if (!list.items.every((p: Json) => p.usage?.drivers && p.usage?.vehicles))
      throw new Error('usage missing');
  });
  await check('DRIVER no administra proveedores', async () => {
    expect(
      await call('GET', '/provider/drivers', carlosToken),
      403,
      'driver → provider drivers',
    );
    expect(
      await call('POST', '/provider/vehicles', carlosToken, {
        identifier: 'X-1',
        type: 'CAR',
      }),
      403,
      'driver → create vehicle',
    );
    expect(
      await call('GET', `/admin/providers/${A}/drivers`, carlosToken),
      403,
      'driver → admin',
    );
  });
  await check('IntegrationClient JWT → Drivers/Vehicles 401', async () => {
    const client = expect(
      await call('POST', '/admin/integrations', sa, {
        name: 'Local V1.4 validation',
        code: `VERIFY_${randomUUID().replaceAll('-', '').toUpperCase()}`,
      }),
      201,
      'integration',
    );
    integrations.push(client.id);
    const cred = expect(
      await call(
        'POST',
        `/admin/integrations/${client.id}/credentials`,
        sa,
        {},
      ),
      201,
      'credential',
    );
    const token = expect(
      await call('POST', '/integrations/token', undefined, {
        clientId: cred.clientId,
        clientSecret: cred.clientSecret,
      }),
      200,
      'token',
    ).accessToken as string;
    expect(
      await call('POST', '/provider/drivers', token, {
        userId: userId(DRIVERS.luis),
        name: 'X',
      }),
      401,
      'create driver',
    );
    expect(
      await call('PATCH', `/provider/drivers/${pedro.id}`, token, {
        status: 'SUSPENDED',
      }),
      401,
      'patch driver',
    );
    expect(
      await call('POST', '/provider/vehicles', token, {
        identifier: 'B2B-1',
        type: 'CAR',
      }),
      401,
      'create vehicle',
    );
    expect(
      await call('PATCH', `/provider/vehicles/${moto1.id}`, token, {
        status: 'SUSPENDED',
      }),
      401,
      'patch vehicle',
    );
    expect(await assign(token, jose.id, moto1.id), 401, 'assign');
    expect(
      await call(
        'POST',
        `/admin/providers/${A}/drivers/${jose.id}/vehicle`,
        token,
        { vehicleId: moto1.id },
      ),
      401,
      'admin assign',
    );
  });
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
  await prisma.integrationClient.deleteMany({
    where: { id: { in: integrations } },
  });
  await prisma.$disconnect();
  console.table(results);
  console.log(failed ? 'RESULT: FAIL' : 'RESULT: PASS (no secrets printed)');
  if (failed) process.exitCode = 1;
}
