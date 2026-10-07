// Exclusive synthetic native environment. Never accepts a target URL or shared database.
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  openSync,
  closeSync,
  cpSync,
  readdirSync,
} from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const home = join(repo, '.tmp/native-v119-legacy');
const pg = 'C:/Program Files/PostgreSQL/18/bin';
const data = join(home, 'pgdata'),
  dbName = 'mandaria_v119_legacy_local',
  pgPort = 55442,
  apiPort = 43131;
const apiRoot = `http://127.0.0.1:${apiPort}`;
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const save = (name, v) =>
  writeFileSync(join(home, name), JSON.stringify(v, null, 2) + '\n', {
    mode: 0o600,
  });
const hash = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
function run(label, exe, args, env) {
  const fd = openSync(join(home, label + '.log'), 'w');
  const r = spawnSync(exe, args, {
    cwd: repo,
    env,
    stdio: ['ignore', fd, fd],
    windowsHide: true,
    timeout: 180000,
  });
  closeSync(fd);
  save(label + '-result.json', {
    command: [exe, ...args],
    exitCode: r.status,
    signal: r.signal,
  });
  if (r.status !== 0) throw Error(label + ' failed; inspect private log');
}
function config() {
  const e = read(join(home, 'runtime.json'));
  const u = new URL(e.DATABASE_URL);
  assert.equal(u.hostname, '127.0.0.1');
  assert.equal(u.port, String(pgPort));
  assert.equal(u.pathname, '/' + dbName);
  assert.equal(e.PORT, String(apiPort));
  for (const k of [
    'DETAILED_EXECUTION_ENABLED',
    'LOCATION_TRACKING_ENABLED',
    'SHARED_TRACKING_ENABLED',
  ])
    assert.equal(e[k], 'false');
  assert.equal(e.ROUTING_PROVIDER, 'local_fake');
  assert.equal(e.MAIL_PROVIDER, 'local_outbox');
  assert.equal(e.B2B_WEBHOOK_POLL_SECONDS, '0');
  return e;
}
const free = (port) =>
  new Promise((ok, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(port, '127.0.0.1', () => s.close(ok));
  });
async function identity(db) {
  const [r] = await db.$queryRawUnsafe(
    `SELECT current_database() AS database,current_setting('port') AS port,current_setting('data_directory') AS directory,pg_postmaster_start_time()::text AS started`,
  );
  assert.equal(r.database, dbName);
  assert.equal(r.port, String(pgPort));
  assert.equal(
    r.directory.replaceAll('\\', '/').toLowerCase(),
    data.replaceAll('\\', '/').toLowerCase(),
  );
  return r;
}
async function init() {
  await free(apiPort);
  await free(pgPort);
  assert(
    !existsSync(home),
    'Environment exists; use status/start, never overwrite',
  );
  mkdirSync(home, { recursive: true });
  // Restrict private local credentials/dumps to the current Windows account before creating them.
  const acl = spawnSync(
    'icacls',
    [
      home,
      '/inheritance:r',
      '/grant:r',
      `${process.env.USERDOMAIN}\\${process.env.USERNAME}:(OI)(CI)F`,
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  assert.equal(acl.status, 0, 'Private ACL failed');
  const password = randomBytes(32).toString('hex');
  writeFileSync(join(home, 'pg-password.txt'), password, { mode: 0o600 });
  const accounts = {
    admin: {
      email: 'admin@v119-legacy.test',
      password: randomBytes(24).toString('base64url'),
    },
    operator: {
      email: 'operator@v119-legacy.test',
      password: randomBytes(24).toString('base64url'),
    },
    driver: {
      email: 'driver@v119-legacy.test',
      password: randomBytes(24).toString('base64url'),
    },
  };
  save('accounts.json', accounts);
  const env = {
    NODE_ENV: 'development',
    PORT: String(apiPort),
    DATABASE_URL: `postgresql://v119_legacy:${password}@127.0.0.1:${pgPort}/${dbName}`,
    JWT_ACCESS_SECRET: randomBytes(48).toString('hex'),
    JWT_REFRESH_SECRET: randomBytes(48).toString('hex'),
    INTEGRATION_JWT_SECRET: randomBytes(48).toString('hex'),
    B2B_WEBHOOK_SECRET_KEY: randomBytes(32).toString('hex'),
    DETAILED_EXECUTION_ENABLED: 'false',
    LOCATION_TRACKING_ENABLED: 'false',
    SHARED_TRACKING_ENABLED: 'false',
    MAIL_PROVIDER: 'local_outbox',
    LOCAL_MAIL_OUTBOX_DIR: join(home, 'mail-outbox'),
    ROUTING_PROVIDER: 'local_fake',
    B2B_WEBHOOK_POLL_SECONDS: '0',
    B2B_WEBHOOK_ALLOW_INSECURE_TARGETS: 'false',
    RUN_DB_SEED: 'false',
    PREQUOTE_ENABLED: 'false',
    PREQUOTE_CONVERSION_ENABLED: 'false',
    PREQUOTE_AUTHORIZED_ACCEPT_ENABLED: 'false',
    CUSTOMER_ADMISSION_ENABLED: 'false',
    MANDARIA_WEB_URL: 'http://localhost:5173',
    DOTENV_CONFIG_PATH: join(home, 'absent.env'),
  };
  save('runtime.json', env);
  save('environment.json', {
    apiPort,
    pgPort,
    dbName,
    data,
    apiRoot,
    emulatorApi: 'http://10.0.2.2:43131/api/v1',
    initializedAt: new Date().toISOString(),
  });
  const nativeEnv = { ...process.env, ...env, PGPASSWORD: password };
  run(
    'initdb',
    join(pg, 'initdb.exe'),
    [
      '-D',
      data,
      '-U',
      'v119_legacy',
      '--auth=scram-sha-256',
      '--pwfile=' + join(home, 'pg-password.txt'),
      '--encoding=UTF8',
      '--no-locale',
    ],
    nativeEnv,
  );
  run(
    'pg-start',
    join(pg, 'pg_ctl.exe'),
    [
      'start',
      '-D',
      data,
      '-l',
      join(home, 'postgres.log'),
      '-o',
      `-h 127.0.0.1 -p ${pgPort}`,
      '-w',
    ],
    nativeEnv,
  );
  run(
    'createdb',
    join(pg, 'createdb.exe'),
    ['-h', '127.0.0.1', '-p', String(pgPort), '-U', 'v119_legacy', dbName],
    nativeEnv,
  );
  const db = new PrismaClient({ datasourceUrl: env.DATABASE_URL, log: [] });
  try {
    save('identity.json', await identity(db));
  } finally {
    await db.$disconnect();
  }
  run(
    'migrate',
    process.execPath,
    ['node_modules/prisma/build/index.js', 'migrate', 'deploy'],
    nativeEnv,
  );
  run(
    'bootstrap-admin',
    process.execPath,
    ['node_modules/tsx/dist/cli.mjs', 'prisma/seed.ts'],
    {
      ...nativeEnv,
      BOOTSTRAP_ADMIN_EMAIL: accounts.admin.email,
      BOOTSTRAP_ADMIN_PASSWORD: accounts.admin.password,
    },
  );
  cpSync(join(repo, 'dist'), join(home, 'dist'), {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  save('snapshot.json', {
    head: spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: repo,
      encoding: 'utf8',
    }).stdout.trim(),
    openapiSha256: hash(join(repo, 'docs/openapi.json')),
    sourceFiles: [
      'src/delivery-assignments/delivery-assignments.service.ts',
      'src/delivery-execution/execution.persistence.ts',
      'src/delivery-execution/execution.responses.ts',
    ].map((path) => ({ path, sha256: hash(join(repo, path)) })),
    builtAt: new Date().toISOString(),
  });
  writeFileSync(
    join(home, 'server.mjs'),
    `import {readFileSync} from 'node:fs';\nimport {dirname} from 'node:path';\nimport {fileURLToPath} from 'node:url';\nconst here=dirname(fileURLToPath(import.meta.url));process.chdir(here);Object.assign(process.env,JSON.parse(readFileSync(here+'/runtime.json','utf8')));\nconst {NestFactory}=await import('@nestjs/core');const {AppModule}=await import('./dist/app.module.js');const {setup}=await import('./dist/setup.js');const app=await NestFactory.create(AppModule,{bodyParser:false});setup(app);await app.listen(${apiPort},'127.0.0.1');\n`,
  );
  console.log(
    'Exclusive cluster initialized; migrations and normal administrator bootstrap applied.',
  );
}
async function start() {
  const env = config();
  await free(apiPort);
  const db = new PrismaClient({ datasourceUrl: env.DATABASE_URL, log: [] });
  try {
    await identity(db);
  } catch {
    await free(pgPort);
    run(
      'pg-start',
      join(pg, 'pg_ctl.exe'),
      [
        'start',
        '-D',
        data,
        '-l',
        join(home, 'postgres.log'),
        '-o',
        `-h 127.0.0.1 -p ${pgPort}`,
        '-w',
      ],
      { ...process.env, ...env },
    );
    await identity(db);
  } finally {
    await db.$disconnect();
  }
  const out = openSync(join(home, 'backend.stdout.log'), 'a'),
    err = openSync(join(home, 'backend.stderr.log'), 'a');
  const child = spawn(process.execPath, [join(home, 'server.mjs')], {
    cwd: home,
    env: { ...process.env, ...env },
    detached: true,
    windowsHide: true,
    stdio: ['ignore', out, err],
  });
  save('backend-process.json', {
    pid: child.pid,
    started: new Date().toISOString(),
    launcher: join(home, 'server.mjs'),
  });
  child.unref();
  closeSync(out);
  closeSync(err);
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(apiRoot + '/health', {
        signal: AbortSignal.timeout(1000),
      });
      if (r.status === 200) {
        console.log('Independent backend healthy ' + apiRoot);
        return;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw Error('Backend health unavailable');
}
let state;
function persist() {
  save('preparation-private.json', state);
}
function key(name) {
  if (!state.keys[name]) {
    state.keys[name] = randomUUID();
    persist();
  }
  return state.keys[name];
}
async function api(token, method, path, body, idem, expected) {
  const r = await fetch(apiRoot + '/api/v1' + path, {
    method,
    redirect: 'error',
    signal: AbortSignal.timeout(20000),
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(idem ? { 'Idempotency-Key': idem } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  let value;
  try {
    value = text ? JSON.parse(text) : null;
  } catch {
    throw Error('Non JSON API response');
  }
  if (expected) {
    if (r.status !== expected)
      throw Error(
        `${method} ${path}: expected HTTP ${expected}, received ${r.status}`,
      );
    return { status: r.status, code: value?.error?.code ?? value?.code };
  }
  if (!r.ok)
    throw Error(
      `${method} ${path} HTTP ${r.status} ${value?.error?.code ?? 'REQUEST_FAILED'}`,
    );
  return value;
}
async function step(name, fn) {
  if (state.done[name] !== undefined) return state.done[name];
  assert(
    !state.pending,
    'Previous operation uncertain: inspect private state without automatic retry',
  );
  state.pending = name;
  persist();
  const result = await fn();
  state.done[name] = result ?? true;
  delete state.pending;
  persist();
  return result;
}
const login = (a) =>
  api(null, 'POST', '/auth/login', a).then((s) => s.accessToken);
async function prepare() {
  const env = config(),
    db = new PrismaClient({ datasourceUrl: env.DATABASE_URL, log: [] });
  try {
    await identity(db);
  } finally {
    await db.$disconnect();
  }
  state = existsSync(join(home, 'preparation-private.json'))
    ? read(join(home, 'preparation-private.json'))
    : { done: {}, keys: {} };
  assert(!state.pending, 'Uncertain previous step; inspect before continuing');
  const accounts = read(join(home, 'accounts.json')),
    admin = await login(accounts.admin);
  const provider = await step('provider', () =>
    api(admin, 'POST', '/admin/providers', {
      name: 'Flotilla sintetica V119 LEGACY',
      code: 'V119_LEGACY',
      type: 'FLEET',
    }),
  );
  const pp = '/admin/providers/' + provider.id;
  await step('provider-active', () => api(admin, 'POST', pp + '/activate', {}));
  for (const name of ['operator', 'driver']) {
    await step(name + '-invite', () =>
      api(admin, 'POST', pp + '/invitations', {
        email: accounts[name].email,
        role: name === 'driver' ? 'DRIVER' : 'PROVIDER_ADMIN',
        ...(name === 'driver'
          ? { driverName: 'Repartidor sintetico LEGACY' }
          : { membershipRole: 'OWNER' }),
      }),
    );
    await step(name + '-activate', async () => {
      const mails = readdirSync(join(home, 'mail-outbox'))
        .filter((x) => x.endsWith('.json'))
        .map((x) => read(join(home, 'mail-outbox', x)));
      const m = mails
        .filter((x) => x.to === accounts[name].email)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      assert(m?.activationUrl);
      return api(null, 'POST', '/auth/activate-account', {
        token: new URL(m.activationUrl).searchParams.get('token'),
        password: accounts[name].password,
      });
    });
  }
  const operator = await login(accounts.operator),
    driverToken = await login(accounts.driver);
  const driver = await step('driver-ref', async () => {
    const r = await api(admin, 'GET', pp + '/drivers?pageSize=100');
    const d = r.items.find((x) => x.user.email === accounts.driver.email);
    assert(d);
    return { id: d.id, userId: d.user.id };
  });
  await step('driver-active', () =>
    api(admin, 'PATCH', pp + '/drivers/' + driver.id, {
      status: 'ACTIVE',
      displayName: 'Repartidor sintetico LEGACY',
    }),
  );
  const vehicle = await step('vehicle', () =>
    api(admin, 'POST', pp + '/vehicles', {
      identifier: 'V119-LEGACY-01',
      type: 'MOTORCYCLE',
      status: 'ACTIVE',
    }),
  );
  await step('pairing', () =>
    api(admin, 'POST', pp + '/drivers/' + driver.id + '/vehicle', {
      vehicleId: vehicle.id,
    }),
  );
  const zone = await step('zone', () =>
    api(admin, 'POST', '/admin/service-zones', {
      code: 'V119_LEGACY',
      name: 'Zona ficticia V119',
      currency: 'MXN',
      boundary: {
        type: 'Polygon',
        coordinates: [
          [
            [-95.4, 18.4],
            [-95.3, 18.4],
            [-95.3, 18.5],
            [-95.4, 18.5],
            [-95.4, 18.4],
          ],
        ],
      },
    }),
  );
  await step('zone-active', () =>
    api(admin, 'POST', '/admin/service-zones/' + zone.id + '/activate', {}),
  );
  const rate = await step('rate', () =>
    api(admin, 'POST', '/admin/rate-plans', {
      serviceZoneId: zone.id,
      serviceType: 'LOCAL_DELIVERY',
      quoteValidityMinutes: 60,
      bands: [
        { minDistanceMeters: 0, maxDistanceMeters: 100000, amount: '55.00' },
      ],
    }),
  );
  await step('rate-active', () =>
    api(admin, 'POST', '/admin/rate-plans/' + rate.id + '/activate', {}),
  );
  await step('coverage', () =>
    api(admin, 'POST', pp + '/service-coverages', {
      serviceZoneId: zone.id,
      serviceType: 'LOCAL_DELIVERY',
    }),
  );
  for (const actorType of ['PROVIDER', 'INDEPENDENT_DRIVER'])
    await step('policy-' + actorType, () =>
      api(admin, 'POST', '/admin/credit-policies', {
        serviceType: 'LOCAL_DELIVERY',
        actorType,
        calculationType: 'FLAT',
        flatCredits: 7,
        reason: 'Creditos sinteticos fixture nativo V119',
      }),
    );
  await step('recharge', () =>
    api(
      admin,
      'POST',
      pp + '/credits/recharge',
      {
        credits: 100,
        method: 'OTHER',
        reason: 'Saldo sintetico sin pago real V119',
        externalReference: 'V119-LEGACY-INITIAL',
      },
      key('recharge'),
    ),
  );
  const integration = await step('integration', () =>
    api(admin, 'POST', '/admin/integrations', {
      code: 'V119_LEGACY',
      name: 'Integrador sintetico V119',
    }),
  );
  const policy = await api(
    admin,
    'GET',
    '/admin/integrations/' + integration.id + '/shipping-policy',
  );
  assert.equal(policy.payer, 'RECIPIENT');
  const credential = await step('credential', () =>
    api(
      admin,
      'POST',
      '/admin/integrations/' + integration.id + '/credentials',
      {
        scopes: [
          'deliveries:create',
          'deliveries:read',
          'quotes:create',
          'quotes:read',
          'quotes:accept',
        ],
      },
    ),
  );
  const machine = (
    await api(null, 'POST', '/integrations/token', {
      clientId: credential.clientId,
      clientSecret: credential.clientSecret,
    })
  ).accessToken;
  const request = await step('request', () =>
    api(
      machine,
      'POST',
      '/delivery-requests',
      {
        externalReference: 'V119-LEGACY-READ-ONLY',
        stops: [
          {
            type: 'PICKUP',
            sequence: 1,
            address: 'Origen ficticio V119',
            latitude: 18.42,
            longitude: -95.38,
            contactName: 'Origen sintetico',
            contactPhone: '0000000000',
          },
          {
            type: 'DROPOFF',
            sequence: 2,
            address: 'Destino ficticio V119',
            latitude: 18.45,
            longitude: -95.35,
            contactName: 'Destino sintetico',
            contactPhone: '0000000000',
          },
        ],
        packages: [
          {
            category: 'FOOD',
            description: 'Fixture de lectura, no entregar',
            quantity: 1,
          },
        ],
        financialContext: {
          goodsValue: '100.00',
          goodsPaymentMode: 'PREPAID',
          currency: 'MXN',
        },
      },
      key('request'),
    ),
  );
  const quote = await step('quote', () =>
    api(
      machine,
      'POST',
      '/delivery-requests/' + request.publicId + '/quotes',
      {},
    ),
  );
  await step('accept', () =>
    api(machine, 'POST', '/delivery-quotes/' + quote.publicId + '/accept', {}),
  );
  const dispatch = await step('dispatch-ref', async () => {
    const r = await api(
      admin,
      'GET',
      '/admin/dispatches?deliveryRequestPublicId=' + request.publicId,
    );
    assert.equal(r.items.length, 1);
    return { id: r.items[0].id };
  });
  await step('claim', () =>
    api(operator, 'POST', '/provider/dispatches/' + dispatch.id + '/claim', {}),
  );
  const assignment = await step('assignment', () =>
    api(
      operator,
      'POST',
      '/provider/dispatches/' + dispatch.id + '/assignment',
      { driverId: driver.id, vehicleId: vehicle.id },
    ),
  );
  save('references.json', {
    providerId: provider.id,
    driverId: driver.id,
    userId: driver.userId,
    vehicleId: vehicle.id,
    dispatchId: dispatch.id,
    assignmentId: assignment.id,
    requestPublicId: request.publicId,
    quotePublicId: quote.publicId,
  });
  console.log(
    'Fixture prepared exclusively through APIs; verifying read-only surfaces.',
  );
  await verify(driverToken, operator);
}
async function verify(driverToken, operator) {
  const env = config(),
    db = new PrismaClient({ datasourceUrl: env.DATABASE_URL, log: [] });
  try {
    const identityResult = await identity(db);
    const refs = read(join(home, 'references.json'));
    const accounts = read(join(home, 'accounts.json'));
    driverToken ??= await login(accounts.driver);
    operator ??= await login(accounts.operator);
    const me = await api(driverToken, 'GET', '/driver/me');
    const detail = await api(
      driverToken,
      'GET',
      '/driver/dispatches/' + refs.dispatchId,
    );
    const execution = await api(
      driverToken,
      'GET',
      '/driver/dispatches/' + refs.dispatchId + '/execution',
      undefined,
      undefined,
      404,
    );
    save('api-readbacks-private.json', { me, detail, execution });
    assert.equal(me.activeDeliveryAssignment.id, refs.assignmentId);
    assert.equal(me.activeDeliveryAssignment.mode, 'FLEET');
    assert.equal(me.activeDeliveryAssignment.trackingMode, 'LEGACY');
    assert.equal(detail.trackingMode, 'LEGACY');
    assert.equal(detail.execution, undefined);
    assert.equal(detail.access, 'OWNER');
    assert.equal(me.id, refs.driverId);
    assert.equal(detail.assignment.id, refs.assignmentId);
    const assignments = await api(
      operator,
      'GET',
      '/provider/dispatches/' + refs.dispatchId + '/assignments',
    );
    assert.equal(
      assignments.find((a) => a.id === refs.assignmentId)?.status,
      'ACTIVE',
    );
    const denied = await api(
      operator,
      'GET',
      '/driver/me',
      undefined,
      undefined,
      403,
    );
    const foreign = await api(
      driverToken,
      'GET',
      '/driver/dispatches/' + randomUUID(),
      undefined,
      undefined,
      409,
    );
    assert.equal(foreign.code, 'INDEPENDENT_NOT_APPROVED');
    await api(null, 'GET', '/driver/me', undefined, undefined, 401);
    const baseline = await db.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
        const assignment = await tx.deliveryAssignment.findUniqueOrThrow({
          where: { id: refs.assignmentId },
        });
        assert.equal(assignment.status, 'ACTIVE');
        const [e] =
          await tx.$queryRaw`SELECT count(*)::int AS count FROM "DeliveryExecution" WHERE "dispatchId"=${refs.dispatchId}::uuid`;
        assert.equal(e.count, 0);
        assert.equal(await tx.deliveryExecutionEvent.count(), 0);
        assert.equal(await tx.b2bWebhookEndpoint.count(), 0);
        const [terms] = await tx.$queryRawUnsafe(
          'SELECT payer FROM "DeliveryShippingTerms"',
        );
        assert.equal(terms.payer, 'RECIPIENT');
        const hashes = [];
        for (const table of [
          'Dispatch',
          'DeliveryAssignment',
          'DeliveryExecution',
          'DeliveryExecutionEvent',
          'DeliveryExecutionCommand',
          'DeliveryCustodyIncident',
          'DeliveryCustodyResolution',
          'CreditLedgerEntry',
          'DeliveryLocationHead',
          'DeliveryShippingTerms',
          'ShippingCollectionDeclaration',
        ]) {
          const [r] = await tx.$queryRawUnsafe(
            `SELECT count(*)::int AS count,md5(COALESCE(string_agg(md5(to_jsonb(t)::text),'' ORDER BY to_jsonb(t)->>'id',to_jsonb(t)::text),'')) AS md5 FROM "${table}" t`,
          );
          hashes.push({ table, ...r });
        }
        return hashes;
      },
      { isolationLevel: 'RepeatableRead', timeout: 15000 },
    );
    const manifest = {
      status: 'READY_FOR_ANDROID_READS',
      preparedVia:
        'normal seed admin; invitation activation; administrative/B2B/provider APIs; no operational SQL writes',
      at: new Date().toISOString(),
      api: apiRoot + '/api/v1',
      emulatorApi: 'http://10.0.2.2:43131/api/v1',
      identity: identityResult,
      revision: read(join(home, 'snapshot.json')),
      references: refs,
      trackingMode: 'LEGACY',
      assignmentStatus: 'ACTIVE',
      executionField: 'omitted',
      checks: {
        driverMe: 200,
        driverDetail: 200,
        driverExecution: execution.status,
        operatorDriverRoute: denied.status,
        foreignDispatch: foreign.status,
      },
      baseline: {
        algorithm:
          'md5(concat(md5(to_jsonb(row)::text) ORDER BY JSON id, full JSON text))',
        tables: baseline,
      },
      credentialsFile: join(home, 'accounts.json'),
      flags: { detailed: false, gps: false, shared: false },
      sharedEnvironmentUntouched: true,
    };
    const filename = existsSync(join(home, 'manifest.json'))
      ? 'verification-latest.json'
      : 'manifest.json';
    save(filename, manifest);
    console.log(
      JSON.stringify({
        status: manifest.status,
        manifest: join(home, filename),
        references: refs,
        trackingMode: manifest.trackingMode,
        assignmentStatus: 'ACTIVE',
      }),
    );
  } finally {
    await db.$disconnect();
  }
}
async function stop() {
  const env = config();
  const db = new PrismaClient({ datasourceUrl: env.DATABASE_URL, log: [] });
  try {
    await identity(db);
  } finally {
    await db.$disconnect();
  }
  const pid = read(join(home, 'backend-process.json')).pid;
  assert(Number.isInteger(pid));
  const launcher = join(home, 'server.mjs').replaceAll("'", "''");
  const command = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if (!$p -or $p.CommandLine -notlike '*${launcher}*') {throw 'Process identity mismatch'}; Stop-Process -Id ${pid} -ErrorAction Stop`;
  run(
    'backend-stop',
    'powershell.exe',
    ['-NoProfile', '-Command', command],
    process.env,
  );
  run(
    'pg-stop',
    join(pg, 'pg_ctl.exe'),
    ['stop', '-D', data, '-m', 'fast', '-w'],
    { ...process.env, ...env },
  );
  console.log('Exclusive environment stopped; data retained');
}
const action = process.argv[2];
try {
  if (action === 'init') await init();
  else if (action === 'start') await start();
  else if (action === 'prepare') await prepare();
  else if (action === 'verify') await verify();
  else if (action === 'stop') await stop();
  else throw Error('Use init/start/prepare/verify/stop');
} catch (e) {
  console.error(
    e instanceof assert.AssertionError
      ? 'Fixture contract/identity assertion failed; inspect local artifacts'
      : String(e.message).replace(
          /postgres(?:ql)?:\/\/\S+/g,
          '[private database]',
        ),
  );
  process.exitCode = 1;
}
