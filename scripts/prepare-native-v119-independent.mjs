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
  appendFileSync,
  unlinkSync,
  readdirSync,
} from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const home = join(repo, '.tmp/native-v119-independent');
const pg = 'C:/Program Files/PostgreSQL/18/bin';
const data = join(home, 'pgdata'),
  dbName = 'mandaria_v119_independent_local',
  pgPort = 55445,
  apiPort = 43133;
const driverAliases = [
  'driverA',
  'driverB',
  'driverC',
  'driverD',
  'driverE',
  'driverF',
  'driverG',
  'driverH',
  'driverI',
  'driverJ',
  'driverK',
  'driverL',
];
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
    at: new Date().toISOString(),
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
  for (const k of ['LOCATION_TRACKING_ENABLED', 'SHARED_TRACKING_ENABLED'])
    assert.equal(e[k], 'false');
  assert.equal(e.ROUTING_PROVIDER, 'local_fake');
  assert.equal(e.MAIL_PROVIDER, 'local_outbox');
  assert.equal(e.B2B_WEBHOOK_POLL_SECONDS, '0');
  assert.equal(
    e.DETAILED_EXECUTION_ENABLED,
    read(join(home, 'phase.json')).detailed ? 'true' : 'false',
  );
  assert.equal(
    e.PREQUOTE_AUTHORIZED_ACCEPT_ENABLED,
    e.DETAILED_EXECUTION_ENABLED,
  );
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
  const accounts = Object.fromEntries(
    ['admin', 'operator', ...driverAliases].map((alias) => [
      alias,
      {
        email: alias.toLowerCase() + '@v119-independent.test',
        password: randomBytes(24).toString('base64url'),
      },
    ]),
  );
  save('accounts.json', accounts);
  const env = {
    NODE_ENV: 'development',
    PORT: String(apiPort),
    DATABASE_URL: `postgresql://v119_independent:${password}@127.0.0.1:${pgPort}/${dbName}`,
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
    DISPATCH_TTL_MINUTES: '1440',
    PREQUOTE_ENABLED: 'false',
    PREQUOTE_CONVERSION_ENABLED: 'false',
    PREQUOTE_AUTHORIZED_ACCEPT_ENABLED: 'false',
    CUSTOMER_ADMISSION_ENABLED: 'false',
    MANDARIA_WEB_URL: 'http://localhost:5173',
    DOTENV_CONFIG_PATH: join(home, 'absent.env'),
  };
  save('runtime.json', env);
  save('phase.json', { detailed: false });
  save('preflight.json', {
    at: new Date().toISOString(),
    apiPortWasFree: true,
    pgPortWasFree: true,
    homeWasAbsent: true,
  });
  save('environment.json', {
    apiPort,
    pgPort,
    dbName,
    data,
    apiRoot,
    emulatorApi: 'http://10.0.2.2:43133/api/v1',
    initializedAt: new Date().toISOString(),
  });
  const nativeEnv = localEnv({ ...env, PGPASSWORD: password });
  run(
    'initdb',
    join(pg, 'initdb.exe'),
    [
      '-D',
      data,
      '-U',
      'v119_independent',
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
    ['-h', '127.0.0.1', '-p', String(pgPort), '-U', 'v119_independent', dbName],
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
      'src/independent-drivers/independent-dispatches.service.ts',
      'src/independent-drivers/independent-attempts.ts',
      'src/independent-drivers/driver-dispatches.controller.ts',
      'src/delivery-assignments/delivery-assignments.service.ts',
      'src/delivery-execution/execution.persistence.ts',
      'src/delivery-execution/execution.responses.ts',
    ].map((path) => ({ path, sha256: hash(join(repo, path)) })),
    copiedAt: new Date().toISOString(),
    build: treeHash(join(home, 'dist')),
    preparerSha256: hash(fileURLToPath(import.meta.url)),
    nodeVersion: process.version,
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
      localEnv(env),
    );
    await identity(db);
  } finally {
    await db.$disconnect();
  }
  const out = openSync(join(home, 'backend.stdout.log'), 'a'),
    err = openSync(join(home, 'backend.stderr.log'), 'a');
  const child = spawn(process.execPath, [join(home, 'server.mjs')], {
    cwd: home,
    env: localEnv(env),
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
  if (path === '/auth/activate-account' && method === 'POST') {
    const log = join(home, 'activation-times.json');
    let times = existsSync(log) ? read(log) : [];
    times = times.filter((t) => Date.now() - t < 61000);
    if (times.length >= 10) {
      console.log('Waiting for existing activation quota; no limit changes.');
      await new Promise((r) =>
        setTimeout(r, Math.min(60000, 61010 - (Date.now() - times[0]))),
      );
    }
    times.push(Date.now());
    save('activation-times.json', times.slice(-10));
  }
  assert(
    !/execution-events|shipping-collection|custody-incidents|execution-completion|independent-attempt\/close|\/resolve(?:\?|$)|\/deliver(?:\?|$)|\/take(?:\?|$)|\/release(?:\?|$)/.test(
      path,
    ) || method === 'GET',
    'Operational commands reserved for Android and coordinated SUPER_ADMIN',
  );
  await new Promise((r) =>
    setTimeout(r, Math.max(0, 750 - (Date.now() - lastRequest))),
  );
  lastRequest = Date.now();
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
  appendFileSync(
    join(home, 'http-audit.jsonl'),
    JSON.stringify({
      at: new Date().toISOString(),
      method,
      path,
      status: r.status,
      requestId: r.headers.get('x-request-id'),
    }) + '\n',
  );
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
      `${method} ${path} HTTP ${r.status} ${value?.error?.code ?? value?.code ?? 'REQUEST_FAILED'}`,
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
function localEnv(extra = {}) {
  const names = [
    'PATH',
    'Path',
    'SystemRoot',
    'WINDIR',
    'COMSPEC',
    'PATHEXT',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'USERDOMAIN',
    'USERNAME',
    'SystemDrive',
    'ProgramFiles',
    'ProgramFiles(x86)',
    'PROCESSOR_ARCHITECTURE',
  ];
  return {
    ...Object.fromEntries(
      names
        .filter((k) => process.env[k] !== undefined)
        .map((k) => [k, process.env[k]]),
    ),
    ...extra,
  };
}
function treeHash(root) {
  const rows = [];
  function walk(dir, prefix = '') {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const rel = prefix + e.name;
      if (e.isDirectory()) walk(join(dir, e.name), rel + '/');
      else if (e.isFile())
        rows.push({ path: rel, sha256: hash(join(dir, e.name)) });
    }
  }
  walk(root);
  return {
    files: rows.length,
    sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
    algorithm: 'SHA256(JSON array of ordered relative path + file SHA256)',
  };
}
function processIdentity() {
  const backend = read(join(home, 'backend-process.json'));
  const expectedPg = Number(
    readFileSync(join(data, 'postmaster.pid'), 'utf8').split(/\r?\n/)[0],
  );
  const launcher = join(home, 'server.mjs').replaceAll("'", "''");
  const script = `$ErrorActionPreference='Stop'; $rows=@(); foreach($port in @(${apiPort},${pgPort})){ $c=@(Get-NetTCPConnection -State Listen -LocalPort $port); if($c.Count -ne 1 -or $c[0].LocalAddress -ne '127.0.0.1'){throw 'Listener mismatch'}; $p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$c[0].OwningProcess); if($port -eq ${apiPort} -and ($p.ProcessId -ne ${backend.pid} -or $p.CommandLine -notlike '*${launcher}*')){throw 'Backend identity mismatch'}; if($port -eq ${pgPort} -and $p.ProcessId -ne ${expectedPg}){throw 'PostgreSQL identity mismatch'}; $rows += [pscustomobject]@{port=$port;address=$c[0].LocalAddress;pid=$p.ProcessId;name=$p.Name;path=$p.ExecutablePath;started=$p.CreationDate.ToUniversalTime().ToString('o')} }; ConvertTo-Json -InputObject $rows`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20000,
  });
  assert.equal(r.status, 0, 'Process identity lookup failed');
  return JSON.parse(r.stdout);
}
const sessions = new Map();
let lastRequest = 0;
async function login(alias) {
  if (sessions.has(alias)) return sessions.get(alias);
  // Respect the real 5/min login throttle even across preparer process restarts.
  const recentFile = join(home, 'login-times.json');
  let recent = existsSync(recentFile) ? read(recentFile) : [];
  recent = recent.filter((t) => Date.now() - t < 61000);
  if (recent.length >= 5) {
    const wait = 61010 - (Date.now() - recent[recent.length - 5]);
    console.log(
      'Waiting for the existing local authentication quota; no limit changes.',
    );
    await new Promise((r) => setTimeout(r, wait));
  }
  recent.push(Date.now());
  save('login-times.json', recent.slice(-5));
  const token = (
    await api(
      null,
      'POST',
      '/auth/login',
      read(join(home, 'accounts.json'))[alias],
    )
  ).accessToken;
  sessions.set(alias, token);
  return token;
}
async function setupResources(admin) {
  const accounts = read(join(home, 'accounts.json'));
  const provider = await step('provider', () =>
    api(admin, 'POST', '/admin/providers', {
      name: 'Flotilla sintetica V119 Operativa',
      code: 'V119_INDEPENDENT',
      type: 'FLEET',
      maxDrivers: 20,
      maxVehicles: 20,
    }),
  );
  const pp = '/admin/providers/' + provider.id;
  await step('provider-active', () => api(admin, 'POST', pp + '/activate', {}));
  const resources = {};
  for (const alias of ['operator', ...driverAliases]) {
    const isDriver = alias !== 'operator';
    await step(alias + '-invite', () =>
      api(admin, 'POST', pp + '/invitations', {
        email: accounts[alias].email,
        role: isDriver ? 'DRIVER' : 'PROVIDER_ADMIN',
        ...(isDriver
          ? { driverName: 'Repartidor sintetico ' + alias }
          : { membershipRole: 'OWNER' }),
      }),
    );
    await step(alias + '-activate', async () => {
      const mails = readdirSync(join(home, 'mail-outbox'))
        .filter((x) => x.endsWith('.json'))
        .map((x) => read(join(home, 'mail-outbox', x)));
      const m = mails
        .filter((x) => x.to === accounts[alias].email)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      assert(m?.activationUrl);
      const r = await api(null, 'POST', '/auth/activate-account', {
        token: new URL(m.activationUrl).searchParams.get('token'),
        password: accounts[alias].password,
      });
      return { activated: true, userId: r.user?.id };
    });
    if (!isDriver) continue;
    const driver = await step(alias + '-ref', async () => {
      const r = await api(admin, 'GET', pp + '/drivers?pageSize=100');
      const d = r.items.find((x) => x.user.email === accounts[alias].email);
      assert(d);
      return { id: d.id, userId: d.user.id };
    });
    await step(alias + '-active', () =>
      api(admin, 'PATCH', pp + '/drivers/' + driver.id, {
        status: 'ACTIVE',
        displayName: 'Repartidor sintetico ' + alias,
      }),
    );
    const vehicle = await step(alias + '-vehicle', () =>
      api(admin, 'POST', pp + '/vehicles', {
        identifier: 'V119-INDEP-' + alias,
        type: 'MOTORCYCLE',
        status: 'ACTIVE',
      }),
    );
    const pairing = await step(alias + '-pairing', () =>
      api(admin, 'POST', pp + '/drivers/' + driver.id + '/vehicle', {
        vehicleId: vehicle.id,
      }),
    );
    resources[alias] = {
      driverId: driver.id,
      userId: driver.userId,
      vehicleId: vehicle.id,
      pairingId: pairing.id,
    };
  }
  const zone = await step('zone', () =>
    api(admin, 'POST', '/admin/service-zones', {
      code: 'V119_INDEPENDENT',
      name: 'Zona ficticia operativa V119',
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
    await step('credit-policy-' + actorType, () =>
      api(admin, 'POST', '/admin/credit-policies', {
        serviceType: 'LOCAL_DELIVERY',
        actorType,
        calculationType: 'FLAT',
        flatCredits: actorType === 'PROVIDER' ? 7 : 14,
        reason: 'Politica sintetica V119 operativa',
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
        reason: 'Saldo sintetico sin pago real',
        externalReference: 'V119-INDEP-INITIAL',
      },
      key('recharge'),
    ),
  );
  const members = await api(admin, 'GET', pp + '/members');
  const operator = members.items.find(
    (x) => x.user?.email === accounts.operator.email,
  );
  assert(operator, 'Operator membership absent');
  return {
    providerId: provider.id,
    serviceZoneId: zone.id,
    operatorUserId: operator.userId ?? operator.user.id,
    resources,
  };
}
async function machine(admin, payer) {
  if (sessions.has('machine-' + payer)) return sessions.get('machine-' + payer);
  const integration = await step('integration-' + payer, () =>
    api(admin, 'POST', '/admin/integrations', {
      code: 'V119_INDEPENDENT_' + payer,
      name: 'Integrador sintetico ' + payer,
    }),
  );
  const policyPath =
    '/admin/integrations/' + integration.id + '/shipping-policy';
  if (payer === 'REQUESTER')
    await step('shipping-policy-requester', async () => {
      const policy = await api(admin, 'GET', policyPath);
      return api(
        admin,
        'POST',
        policyPath,
        { payer, expectedRevision: policy.revision },
        key('shipping-policy'),
      );
    });
  assert.equal((await api(admin, 'GET', policyPath)).payer, payer);
  const credential = await step('credential-' + payer, () =>
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
  const token = (
    await api(null, 'POST', '/integrations/token', {
      clientId: credential.clientId,
      clientSecret: credential.clientSecret,
    })
  ).accessToken;
  sessions.set('machine-' + payer, token);
  return token;
}
async function createScenario(alias, driverAlias, payer, ctx, admin, operator) {
  const machineToken = await machine(admin, payer);
  const request = await step(alias + '-request', () =>
    api(
      machineToken,
      'POST',
      '/delivery-requests',
      {
        externalReference: 'V119-INDEP-' + alias,
        ...(payer === 'REQUESTER'
          ? {
              payerContact: {
                name: 'Pagador sintetico ' + alias,
                phone: '0000000000',
                capacity: 'AUTHORIZED_REPRESENTATIVE',
              },
            }
          : {}),
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
            description: 'Servicio sintetico reservado Android ' + alias,
            quantity: 1,
          },
        ],
        financialContext: {
          goodsValue: '100.00',
          goodsPaymentMode: 'PREPAID',
          currency: 'MXN',
        },
      },
      key(alias + '-request'),
    ),
  );
  assert.equal(request.shippingTerms.payer, payer);
  const quote = await step(alias + '-quote', () =>
    api(
      machineToken,
      'POST',
      '/delivery-requests/' + request.publicId + '/quotes',
      {},
    ),
  );
  await step(alias + '-accept', () =>
    api(
      machineToken,
      'POST',
      '/delivery-quotes/' + quote.publicId + '/accept',
      payer === 'REQUESTER'
        ? {
            customerAuthorization: {
              version: 2,
              status: 'AUTHORIZED_BY_CUSTOMER',
              reference: 'synthetic-' + alias,
              authorizedAt: new Date().toISOString(),
              quotePublicId: quote.publicId,
              amount: quote.amount,
              currency: quote.currency,
              expiresAt: quote.expiresAt,
              shippingTermsVersion: request.shippingTerms.termsVersion,
              shippingTermsHash: request.shippingTerms.termsHash,
            },
          }
        : {},
      key(alias + '-accept'),
    ),
  );
  const dispatch = await step(alias + '-dispatch', async () => {
    const r = await api(
      admin,
      'GET',
      '/admin/dispatches?deliveryRequestPublicId=' + request.publicId,
    );
    assert.equal(r.items.length, 1);
    return { id: r.items[0].id };
  });
  if (alias !== 'legacy-readonly') {
    const view = await api(admin, 'GET', '/admin/dispatches/' + dispatch.id);
    return {
      alias,
      driverAlias,
      ...ctx.resources[driverAlias],
      dispatchId: dispatch.id,
      assignmentId: null,
      requestPublicId: request.publicId,
      quotePublicId: quote.publicId,
      trackingMode: null,
      trackingModeAfterTake: 'DETAILED',
      payer,
      amount: quote.amount,
      currency: quote.currency,
      termsHash: request.shippingTerms.termsHash,
      expiresAt: view.expiresAt,
    };
  }
  await step(alias + '-claim', () =>
    api(operator, 'POST', '/provider/dispatches/' + dispatch.id + '/claim', {}),
  );
  const resource = ctx.resources[driverAlias];
  const assignment = await step(alias + '-assignment', () =>
    api(
      operator,
      'POST',
      '/provider/dispatches/' + dispatch.id + '/assignment',
      { driverId: resource.driverId, vehicleId: resource.vehicleId },
    ),
  );
  return {
    alias,
    driverAlias,
    ...resource,
    providerId: ctx.providerId,
    dispatchId: dispatch.id,
    assignmentId: assignment.id,
    requestPublicId: request.publicId,
    quotePublicId: quote.publicId,
    trackingMode: payer === 'REQUESTER' ? 'DETAILED' : 'LEGACY',
    payer,
    amount: quote.amount,
    currency: quote.currency,
    termsHash: request.shippingTerms.termsHash,
  };
}
async function enableDetailed() {
  if (config().DETAILED_EXECUTION_ENABLED === 'true') return;
  assert(
    state.done['legacy-readonly-assignment'],
    'Legacy must be created first',
  );
  await stopBackend();
  const env = read(join(home, 'runtime.json'));
  env.DETAILED_EXECUTION_ENABLED = 'true';
  env.PREQUOTE_AUTHORIZED_ACCEPT_ENABLED = 'true';
  save('runtime.json', env);
  save('phase.json', {
    detailed: true,
    at: new Date().toISOString(),
    reason: 'New REQUESTER fixtures only; legacy preserved',
  });
  await start();
}
async function prepare() {
  const lock = join(home, 'prepare.lock');
  const fd = openSync(lock, 'wx');
  writeFileSync(fd, String(process.pid));
  closeSync(fd);
  try {
    const db = new PrismaClient({
      datasourceUrl: config().DATABASE_URL,
      log: [],
    });
    try {
      await identity(db);
      processIdentity();
    } finally {
      await db.$disconnect();
    }
    state = existsSync(join(home, 'preparation-private.json'))
      ? read(join(home, 'preparation-private.json'))
      : { done: {}, keys: {} };
    assert(!state.pending, 'Uncertain previous operation; do not retry');
    if (state.complete) {
      console.log('Already prepared; read-only verification, never reset');
      return await verify();
    }
    const admin = await login('admin');
    const ctx = await setupResources(admin);
    const operator = await login('operator');
    // Legacy fleet assignment legitimately created while detailed admission is off.
    const legacy = await createScenario(
      'legacy-readonly',
      'driverD',
      'RECIPIENT',
      ctx,
      admin,
      operator,
    );
    for (const alias of driverAliases) {
      const r = ctx.resources[alias],
        p = '/admin/drivers/' + r.driverId + '/independent';
      const profile = await step(alias + '-independent', () =>
        api(admin, 'POST', p, {
          reason: 'Capacidad sintetica V119 independiente',
        }),
      );
      const vehicle = await step(alias + '-own-vehicle', () =>
        api(admin, 'POST', p + '/vehicles', {
          identifier: 'V119-IND-' + alias.toUpperCase(),
          type: 'MOTORCYCLE',
        }),
      );
      const credits = alias === 'driverC' ? 13 : 100;
      await step(alias + '-recharge', () =>
        api(
          admin,
          'POST',
          p + '/credits/recharge',
          {
            credits,
            method: 'OTHER',
            reason: 'Credito sintetico sin pago real',
            externalReference: 'V119-IND-' + alias,
          },
          key(alias + '-recharge'),
        ),
      );
      ctx.resources[alias] = {
        ...r,
        fleetVehicleId: r.vehicleId,
        vehicleId: vehicle.id,
        independentProfileId: profile.id,
        initialCredits: credits,
      };
    }
    await enableDetailed();
    const scenarios = [legacy];
    for (const [alias, driverAlias, payer] of [
      ['take-normal', 'driverA', 'RECIPIENT'],
      ['competition', 'driverB', 'RECIPIENT'],
      ['insufficient', 'driverC', 'RECIPIENT'],
      ['response-lost', 'driverE', 'RECIPIENT'],
      ['close-take', 'driverF', 'RECIPIENT'],
      ['close-release', 'driverG', 'RECIPIENT'],
      ['release-custody', 'driverH', 'RECIPIENT'],
      ['release-incident', 'driverI', 'RECIPIENT'],
      ['release-cash', 'driverJ', 'REQUESTER'],
    ]) {
      scenarios.push(
        await createScenario(alias, driverAlias, payer, ctx, admin, operator),
      );
    }
    save('references.json', {
      providerId: ctx.providerId,
      operatorUserId: ctx.operatorUserId,
      serviceZoneId: ctx.serviceZoneId,
      actors: ctx.resources,
      scenarios,
    });
    state.complete = true;
    persist();
    await verify();
  } finally {
    unlinkSync(lock);
  }
}
const tables = [
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
];
async function verify() {
  const env = config(),
    db = new PrismaClient({ datasourceUrl: env.DATABASE_URL, log: [] });
  try {
    const identityResult = await identity(db),
      processes = processIdentity();
    assert.equal(env.DETAILED_EXECUTION_ENABLED, 'true');
    const refs = read(join(home, 'references.json')),
      checked = [],
      actors = {},
      raw = {};
    for (const alias of driverAliases) {
      const token = await login(alias),
        r = refs.actors[alias];
      const me = await api(token, 'GET', '/driver/me');
      const vehicles = await api(token, 'GET', '/driver/vehicles');
      const credit = await api(token, 'GET', '/driver/credits');
      assert.equal(me.id, r.driverId);
      assert.equal(me.status, 'ACTIVE');
      assert.equal(me.independent.status, 'APPROVED');
      assert(
        vehicles.some((v) => v.id === r.vehicleId && v.status === 'ACTIVE'),
      );
      assert.equal(credit.balance, r.initialCredits);
      assert.equal(me.independent.canTakeServices, alias !== 'driverD');
      if (alias !== 'driverD') assert.equal(me.activeDeliveryAssignment, null);
      actors[alias] = {
        ...r,
        role: 'DRIVER',
        status: me.status,
        independentStatus: me.independent.status,
        canTakeServices: me.independent.canTakeServices,
        activeDeliveryAssignment: me.activeDeliveryAssignment?.id ?? null,
        credits: credit.balance,
      };
      raw[alias] = { me, vehicles, credit };
    }
    for (const r of refs.scenarios) {
      const token = await login(r.driverAlias);
      const detail = await api(
        token,
        'GET',
        '/driver/dispatches/' + r.dispatchId,
      );
      raw[r.alias] = { detail };
      if (r.alias === 'legacy-readonly') {
        assert.equal(detail.access, 'OWNER');
        assert.equal(detail.trackingMode, 'LEGACY');
        assert.equal(detail.assignment.id, r.assignmentId);
        assert.equal(detail.execution, undefined);
        await api(
          token,
          'GET',
          '/driver/dispatches/' + r.dispatchId + '/execution',
          undefined,
          undefined,
          404,
        );
        checked.push({
          ...r,
          status: 'CLAIMED',
          assignmentStatus: 'ACTIVE',
          phase: null,
          ready: 'READ_ONLY',
          appSteps: ['Only read; do not release or deliver'],
        });
      } else {
        assert.equal(detail.access, 'OFFER');
        assert.equal(detail.status, 'OPEN');
        assert.equal(detail.trackingMode, null);
        assert.equal(detail.creditCost, 14);
        assert(new Date(detail.expiresAt).getTime() > Date.now());
        if (r.payer === 'REQUESTER') {
          assert.equal(detail.shippingPayment.payer, 'REQUESTER');
          assert.equal(detail.shippingPayment.method, 'CASH');
          assert.equal(detail.shippingPayment.dueAt, 'PICKUP');
          assert.equal(detail.shippingPayment.amount, r.amount);
        }
        const attempt = await api(
          token,
          'GET',
          '/driver/dispatches/' +
            r.dispatchId +
            '/independent-attempt?operation=TAKE',
          undefined,
          randomUUID(),
        );
        assert.equal(attempt.state, 'PENDING_OR_UNKNOWN');
        assert.equal(attempt.result, null);
        checked.push({
          ...r,
          status: 'OPEN',
          assignmentStatus: null,
          trackingMode: detail.trackingMode,
          phase: null,
          creditCost: detail.creditCost,
          expiresAt: detail.expiresAt,
          ready: 'OFFER_ONLY_TAKE_RESERVED_FOR_APP',
          competitorAlias:
            r.alias === 'competition'
              ? 'driverK'
              : r.alias === 'response-lost'
                ? 'driverL'
                : null,
        });
      }
    }
    const offers = await api(
      await login('driverA'),
      'GET',
      '/driver/dispatches/available?pageSize=100',
    );
    for (const r of refs.scenarios.filter((r) => r.assignmentId === null))
      assert(
        offers.items.some((o) => o.id === r.dispatchId),
        'Reserved offer absent from authorized listing',
      );
    raw.availableOffers = offers;
    const admin = await login('admin');
    await api(admin, 'GET', '/driver/me', undefined, undefined, 403);
    await api(null, 'GET', '/driver/me', undefined, undefined, 401);
    save('api-readbacks-private.json', raw);
    const baseline = await db.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
        assert.equal(await tx.deliveryAssignment.count(), 1);
        assert.equal(
          await tx.deliveryAssignment.count({
            where: { status: 'ACTIVE', mode: 'FLEET' },
          }),
          1,
        );
        for (const model of [
          'deliveryExecution',
          'deliveryExecutionEvent',
          'deliveryExecutionCommand',
          'deliveryCustodyIncident',
          'deliveryCustodyResolution',
          'shippingCollectionDeclaration',
          'b2bWebhookEndpoint',
          'independentDispatchAttempt',
        ])
          assert.equal(
            await tx[model].count(),
            0,
            model + ' must remain untouched',
          );
        const [location] = await tx.$queryRawUnsafe(
          'SELECT count(*)::int AS heads,count(*) FILTER (WHERE "trackingEnabled" OR sample IS NOT NULL OR "sampleHash" IS NOT NULL OR "lastSequence"<>0)::int AS samples FROM "DeliveryLocationHead"',
        );
        assert.equal(location.heads, refs.scenarios.length);
        assert.equal(
          location.samples,
          0,
          'GPS samples/tracking must remain absent',
        );
        const migrations = await tx.$queryRawUnsafe(
          'SELECT migration_name,checksum,finished_at FROM "_prisma_migrations" ORDER BY migration_name',
        );
        assert.equal(migrations.length, 43);
        assert(migrations.every((m) => m.finished_at));
        const ledger = await tx.creditLedgerEntry.findMany({
          select: { type: true, amount: true },
        });
        assert.equal(
          ledger.filter((e) => e.type === 'SERVICE_AWARD').length,
          1,
        );
        assert.equal(ledger.find((e) => e.type === 'SERVICE_AWARD').amount, -7);
        assert.equal(
          ledger.filter((e) => e.type === 'SERVICE_REFUND').length,
          0,
        );
        assert.equal(
          ledger.filter((e) => e.type === 'RECHARGE').length,
          driverAliases.length + 1,
        );
        const hashes = [];
        for (const table of [...tables, 'IndependentDispatchAttempt']) {
          const [h] = await tx.$queryRawUnsafe(
            `SELECT count(*)::int AS count,md5(COALESCE(string_agg(md5(to_jsonb(t)::text),'' ORDER BY to_jsonb(t)->>'id',to_jsonb(t)::text),'')) AS md5 FROM "${table}" t`,
          );
          hashes.push({ table, ...h });
        }
        return {
          tables: hashes.filter(
            (h) => h.table !== 'IndependentDispatchAttempt',
          ),
          independentAttempts: hashes.find(
            (h) => h.table === 'IndependentDispatchAttempt',
          ),
          migrations,
          economic: {
            recharges: driverAliases.length + 1,
            serviceAwards: 1,
            serviceRefunds: 0,
            legacyFleetAward: -7,
            independentAwards: 0,
          },
        };
      },
      { isolationLevel: 'RepeatableRead', timeout: 15000 },
    );
    const manifest = {
      status: 'READY_FOR_ANDROID_TAKE',
      at: new Date().toISOString(),
      api: apiRoot + '/api/v1',
      emulatorApi: 'http://10.0.2.2:' + apiPort + '/api/v1',
      identity: identityResult,
      processes,
      revision: read(join(home, 'snapshot.json')),
      preparerSha256: hash(fileURLToPath(import.meta.url)),
      actors,
      scenarios: checked,
      baseline,
      flags: {
        detailed: true,
        gps: false,
        shared: false,
        webhooksPollSeconds: 0,
        routing: 'local_fake',
        mail: 'local_outbox',
        dispatchTtlMinutes: 1440,
      },
      checks: {
        driverMe: 200,
        vehicles: 200,
        credits: 200,
        offers: 200,
        attemptRead: 200,
        legacyRead: 200,
        legacyExecution: 404,
        adminForbidden: 403,
        anonymous: 401,
      },
      credentialsFile: join(home, 'accounts.json'),
      commands: Object.fromEntries(
        ['start', 'snapshot', 'stop', 'prepare', 'verify'].map((x) => [
          x,
          'node scripts/prepare-native-v119-independent.mjs ' + x,
        ]),
      ),
      limitations: [
        'No reserved TAKE/RELEASE/close/phase/cash/incident executed',
        'All offers share synthetic market; actor labels are test reservations, not product access restrictions',
        'ExpiresAt is real; no automatic renewal or reopened states',
        'Backend validation only, emulator connectivity and Android operations pending',
      ],
    };
    const file = existsSync(join(home, 'manifest.json'))
      ? 'verification-latest.json'
      : 'manifest.json';
    save(file, manifest);
    console.log(
      JSON.stringify({
        status: manifest.status,
        manifest: join(home, file),
        scenarios: checked.map((r) => ({
          alias: r.alias,
          driverAlias: r.driverAlias,
          dispatchId: r.dispatchId,
          status: r.status,
          trackingMode: r.trackingMode,
        })),
      }),
    );
  } finally {
    await db.$disconnect();
  }
}

async function stopBackend() {
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
  await free(apiPort);
}
async function stop() {
  await stopBackend();
  const env = config();
  run(
    'pg-stop',
    join(pg, 'pg_ctl.exe'),
    ['stop', '-D', data, '-m', 'fast', '-w'],
    localEnv(env),
  );
  console.log('Exclusive environment stopped; data retained');
}
// After Android writes, initial-state verify must fail rather than resetting fixtures.
// This read-only command records a separate snapshot for expected-delta review instead.
async function snapshot() {
  const env = config(),
    db = new PrismaClient({ datasourceUrl: env.DATABASE_URL, log: [] });
  try {
    const identified = await identity(db),
      processes = processIdentity();
    const rows = await db.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
        const result = [];
        for (const table of [...tables, 'IndependentDispatchAttempt']) {
          const [r] = await tx.$queryRawUnsafe(
            `SELECT count(*)::int AS count,md5(COALESCE(string_agg(md5(to_jsonb(t)::text),'' ORDER BY to_jsonb(t)->>'id',to_jsonb(t)::text),'')) AS md5 FROM "${table}" t`,
          );
          result.push({ table, ...r });
        }
        return result;
      },
      { isolationLevel: 'RepeatableRead', timeout: 15000 },
    );
    const report = {
      at: new Date().toISOString(),
      identity: identified,
      processes,
      tables: rows,
    };
    const file = 'snapshot-' + Date.now() + '.json';
    save(file, report);
    console.log(JSON.stringify({ snapshot: join(home, file), tables: rows }));
  } finally {
    await db.$disconnect();
  }
}
const action = process.argv[2];
try {
  if (action === 'init') await init();
  else if (action === 'start') await start();
  else if (action === 'prepare') await prepare();
  else if (action === 'verify') await verify();
  else if (action === 'stop') await stop();
  else if (action === 'snapshot') await snapshot();
  else throw Error('Use init/start/prepare/verify/stop/snapshot');
} catch (e) {
  if (existsSync(home))
    save('failure-private.json', {
      at: new Date().toISOString(),
      name: e.name,
      message: e.message,
      stack: e.stack,
    });
  console.error(
    'Preparation/verification failed; inspect the private failure file. No automatic retry.',
  );
  process.exitCode = 1;
}
