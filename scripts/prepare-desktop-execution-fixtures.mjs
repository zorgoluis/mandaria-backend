// Local API fixtures only. Never point this runner at another environment.
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  openSync,
  closeSync,
  unlinkSync,
} from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

const project = 'mandaria-local-20261003-execution';
const container = `${project}-backend-1`;
const dir = '.tmp/docker-desktop-local';
const manifestPath = `${dir}/operational-fixtures.json`;
const accountsPath = `${dir}/accounts.json`;
const credentialPath = `${dir}/fixture-credential.json`;
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
function save(p, value) {
  writeFileSync(`${p}.writing`, JSON.stringify(value, null, 2) + '\n', {
    mode: 0o600,
  });
  renameSync(`${p}.writing`, p);
}
function docker(args) {
  try {
    return execFileSync('docker', args, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    throw Error(
      'Docker command failed; inspect local service health. Output suppressed.',
    );
  }
}
function identity(expected = 'true') {
  const services = readDocker([
    'inspect',
    container,
    `${project}-postgres-1`,
    `${project}-gateway-1`,
  ]);
  for (const service of services) {
    assert.equal(service.Config.Labels['com.docker.compose.project'], project);
    assert.equal(service.State.Status, 'running');
  }
  const env = Object.fromEntries(
    services[0].Config.Env.map((v) => [
      v.slice(0, v.indexOf('=')),
      v.slice(v.indexOf('=') + 1),
    ]),
  );
  const db = new URL(env.DATABASE_URL);
  assert.equal(db.hostname, 'postgres');
  assert.equal(db.pathname, '/mandaria_desktop_local');
  assert.equal(db.username, 'mandaria_local');
  assert.equal(env.NODE_ENV, 'development');
  assert.equal(env.DETAILED_EXECUTION_ENABLED, expected);
  assert.equal(env.MAIL_PROVIDER, 'local_outbox');
  assert.equal(env.B2B_WEBHOOK_POLL_SECONDS, '0');
  assert.equal(env.ROUTING_PROVIDER, 'local_fake');
  assert.deepEqual(Object.keys(services[0].NetworkSettings.Networks), [
    `${project}_isolated`,
  ]);
  assert.equal(
    readDocker(['network', 'inspect', `${project}_isolated`])[0].Internal,
    true,
  );
  assert(
    services[1].Mounts.some(
      (m) =>
        m.Name === `${project}_pgdata` &&
        m.Destination === '/var/lib/postgresql/data',
    ),
  );
  const ports = services[2].HostConfig.PortBindings['3000/tcp'];
  assert.deepEqual(ports, [{ HostIp: '127.0.0.1', HostPort: '43130' }]);
}
function readDocker(args) {
  return JSON.parse(docker(args));
}
const hadManifest = existsSync(manifestPath);
const state = hadManifest
  ? read(manifestPath)
  : { project, keys: {}, cases: {}, resources: {} };
assert.equal(state.project, project);
const persist = () => save(manifestPath, state);
function key(name) {
  if (!state.keys[name]) {
    state.keys[name] = randomUUID();
    persist();
  }
  return state.keys[name];
}
const sessions = [];
async function api(token, method, path, body, idempotency, waited = false) {
  const response = await fetch(`http://127.0.0.1:43130/api/v1${path}`, {
    method,
    redirect: 'error',
    signal: AbortSignal.timeout(20000),
    headers: {
      'Content-Type': 'application/json',
      Connection: 'close',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(idempotency ? { 'Idempotency-Key': idempotency } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  const result = text ? JSON.parse(text) : null;
  if (response.status === 429 && !waited) {
    const seconds = Number(response.headers.get('retry-after'));
    if (Number.isFinite(seconds) && seconds > 0 && seconds <= 60) {
      console.log(`Rate limit: waiting ${seconds + 1}s before one retry.`);
      await new Promise((resolve) => setTimeout(resolve, (seconds + 1) * 1000));
      return api(token, method, path, body, idempotency, true);
    }
  }
  if (!response.ok) {
    const code = result?.error?.code ?? result?.code ?? 'HTTP_ERROR';
    throw Error(
      `${method} ${path.split('?')[0]}: HTTP ${response.status} ${/^[A-Z_]+$/.test(code) ? code : 'HTTP_ERROR'}`,
    );
  }
  return result;
}
async function login(account) {
  const s = await api(null, 'POST', '/auth/login', {
    email: account.email,
    password: account.password,
  });
  sessions.push(s);
  return s.accessToken;
}
async function list(token, path) {
  const result = await api(
    token,
    'GET',
    `${path}${path.includes('?') ? '&' : '?'}pageSize=100`,
  );
  if (Array.isArray(result)) return result;
  if (!Array.isArray(result.items))
    throw Error(`Unexpected list contract: ${path}`);
  assert(
    result.total <= 100,
    'Fixture scope unexpectedly large; stop instead of incomplete lookup',
  );
  return result.items;
}
async function ensure(token, path, predicate, body) {
  const found = (await list(token, path)).filter(predicate);
  assert(found.length <= 1, 'Ambiguous fixture');
  return found[0] ?? (await api(token, 'POST', path.split('?')[0], body));
}
function localAdmission(enabled) {
  const override = `${dir}/legacy-admission.yml`;
  const args = [
    'compose',
    '--env-file',
    `${dir}/runtime.env`,
    '-f',
    'compose.desktop-local.yml',
  ];
  if (!enabled) {
    writeFileSync(
      override,
      'services:\n  backend:\n    environment:\n      DETAILED_EXECUTION_ENABLED: "false"\n',
    );
    args.push('-f', override);
  }
  docker([
    ...args,
    'up',
    '-d',
    '--no-deps',
    '--no-build',
    '--pull',
    'never',
    '--wait',
    '--wait-timeout',
    '90',
    'backend',
  ]);
  identity(String(enabled));
}

async function main() {
  identity();
  console.log(
    'Identity verified: isolated Desktop project/database, simulated mail, webhook worker disabled.',
  );
  const accounts = read(accountsPath);
  const admin = await login(
    accounts.find((a) => a.email === 'admin@mandaria-local.test'),
  );
  const operator = await login(
    accounts.find((a) => a.email === 'provider@mandaria-local.test'),
  );
  if (!hadManifest) {
    const existing = await list(admin, '/admin/integrations');
    assert(
      !existing.some((i) => i.code === 'DESKTOP_EXECUTION'),
      'Recover the existing manifest instead of duplicating requests',
    );
  }
  const providers = await list(admin, '/admin/providers');
  const provider = providers.find((p) => p.code === 'DESKTOP_SYNTHETIC');
  assert(provider?.status === 'ACTIVE' && provider.type === 'FLEET');
  const pp = `/admin/providers/${provider.id}`;
  state.providerId = provider.id;
  persist();
  if (provider.maxDrivers < 5 || provider.maxVehicles < 5)
    await api(admin, 'PATCH', pp, {
      maxDrivers: Math.max(5, provider.maxDrivers),
      maxVehicles: Math.max(5, provider.maxVehicles),
    });
  let zone = await ensure(
    admin,
    '/admin/service-zones',
    (z) => z.code === 'DESKTOP_EXECUTION',
    {
      code: 'DESKTOP_EXECUTION',
      name: 'Zona ficticia pruebas Desktop',
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
    },
  );
  if (zone.status !== 'ACTIVE')
    zone = await api(
      admin,
      'POST',
      `/admin/service-zones/${zone.id}/activate`,
      {},
    );
  const rate = await ensure(
    admin,
    `/admin/rate-plans?serviceZoneId=${zone.id}`,
    (r) => r.serviceZoneId === zone.id,
    {
      serviceZoneId: zone.id,
      serviceType: 'LOCAL_DELIVERY',
      quoteValidityMinutes: 60,
      bands: [
        { minDistanceMeters: 0, maxDistanceMeters: 100000, amount: '55.00' },
      ],
    },
  );
  if (rate.status !== 'ACTIVE')
    await api(admin, 'POST', `/admin/rate-plans/${rate.id}/activate`, {});
  await ensure(
    admin,
    `${pp}/service-coverages`,
    (c) => c.serviceZone.id === zone.id && c.serviceType === 'LOCAL_DELIVERY',
    { serviceZoneId: zone.id, serviceType: 'LOCAL_DELIVERY' },
  );
  for (const actorType of ['PROVIDER', 'INDEPENDENT_DRIVER']) {
    const policy = await ensure(
      admin,
      `/admin/credit-policies?actorType=${actorType}&serviceType=LOCAL_DELIVERY&status=ACTIVE`,
      (p) => p.actorType === actorType,
      {
        serviceType: 'LOCAL_DELIVERY',
        actorType,
        calculationType: 'FLAT',
        flatCredits: 7,
        reason: 'Solo creditos sinteticos Desktop',
      },
    );
    assert.equal(policy.flatCredits, 7);
  }
  if (!state.recharged) {
    await api(
      admin,
      'POST',
      `${pp}/credits/recharge`,
      {
        credits: 1000,
        method: 'OTHER',
        reason: 'Saldo ficticio para ensayos locales, sin pago real',
        externalReference: 'DESKTOP-EXECUTION-INITIAL',
      },
      key('recharge'),
    );
    state.recharged = true;
    persist();
  }
  for (const [index, name] of [
    'normal',
    'return',
    'transfer',
    'legacy',
    'recipient',
  ].entries()) {
    const email =
      index === 0
        ? 'driver@mandaria-local.test'
        : `driver-${name}@mandaria-local.test`;
    let driver = (await list(admin, `${pp}/drivers`)).find(
      (d) => d.user.email === email,
    );
    if (!driver) {
      let account = accounts.find((a) => a.email === email);
      if (!account) {
        account = {
          email,
          role: 'DRIVER',
          password: randomBytes(24).toString('base64url'),
        };
        accounts.push(account);
        save(accountsPath, accounts);
      }
      const invites = await list(
        admin,
        `/admin/user-invitations?providerId=${provider.id}`,
      );
      if (!invites.some((i) => i.email === email))
        await api(admin, 'POST', `${pp}/invitations`, {
          email,
          role: 'DRIVER',
          driverName: `Sintetico ${name}`,
        });
      // Only read simulated mail in the isolated backend; token remains in memory, never printed.
      const mails = readDocker([
        'exec',
        container,
        'node',
        '-e',
        "const fs=require('fs'); const p='/app/local-outbox'; console.log(JSON.stringify(fs.readdirSync(p).filter(f=>f.endsWith('.json')).map(f=>JSON.parse(fs.readFileSync(p+'/'+f,'utf8')))))",
      ]);
      const mail = mails
        .filter((m) => m.to === email)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      assert(
        mail,
        'No local invitation mail; investigate without sending external email',
      );
      await api(null, 'POST', '/auth/activate-account', {
        token: new URL(mail.activationUrl).searchParams.get('token'),
        password: account.password,
      });
      driver = (await list(admin, `${pp}/drivers`)).find(
        (d) => d.user.email === email,
      );
      assert(driver);
    }
    if (driver.status === 'PENDING')
      await api(admin, 'PATCH', `${pp}/drivers/${driver.id}`, {
        status: 'ACTIVE',
        displayName: `Prueba ${name}`,
      });
    else assert.equal(driver.status, 'ACTIVE');
    const vehicle = await ensure(
      admin,
      `${pp}/vehicles`,
      (v) => v.identifier === `LOCAL-${name.toUpperCase()}`,
      {
        identifier: `LOCAL-${name.toUpperCase()}`,
        type: 'MOTORCYCLE',
        status: 'ACTIVE',
      },
    );
    if (!driver.currentAssignment)
      await api(admin, 'POST', `${pp}/drivers/${driver.id}/vehicle`, {
        vehicleId: vehicle.id,
      });
    state.resources[name] = {
      driverId: driver.id,
      vehicleId: vehicle.id,
      email,
      vehicle: vehicle.identifier,
    };
    persist();
  }
  const integration = await ensure(
    admin,
    '/admin/integrations',
    (i) => i.code === 'DESKTOP_EXECUTION',
    { code: 'DESKTOP_EXECUTION', name: 'Cliente sintetico Desktop' },
  );
  if (!existsSync(credentialPath)) {
    assert(
      !state.credentialAttempted,
      'Credential creation outcome uncertain: recover privately; do not duplicate',
    );
    state.credentialAttempted = true;
    persist();
    save(
      credentialPath,
      await api(
        admin,
        'POST',
        `/admin/integrations/${integration.id}/credentials`,
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
  }
  const credential = read(credentialPath);
  const machine = (
    await api(null, 'POST', '/integrations/token', {
      clientId: credential.clientId,
      clientSecret: credential.clientSecret,
    })
  ).accessToken;
  for (const name of ['normal', 'return', 'transfer', 'legacy']) {
    const fixture = (state.cases[name] ??= {
      externalReference: `DESKTOP-EXECUTION-${name.toUpperCase()}`,
    });
    persist();
    if (fixture.ready) {
      console.log(
        `${name}: already prepared; preserving current user progress`,
      );
      continue;
    }
    if (!fixture.request) {
      const request = await api(
        machine,
        'POST',
        '/delivery-requests',
        {
          externalReference: fixture.externalReference,
          stops: [
            {
              type: 'PICKUP',
              sequence: 1,
              address: 'Origen ficticio Desktop',
              latitude: 18.42,
              longitude: -95.38,
              contactName: 'Origen sintetico',
              contactPhone: '0000000000',
            },
            {
              type: 'DROPOFF',
              sequence: 2,
              address: 'Destino ficticio Desktop',
              latitude: 18.45,
              longitude: -95.35,
              contactName: 'Destino sintetico',
              contactPhone: '0000000000',
            },
          ],
          packages: [
            {
              category: 'FOOD',
              description: `Ensayo local ${name}, no entregar`,
              quantity: 1,
            },
          ],
          financialContext: {
            goodsValue: '100.00',
            goodsPaymentMode: 'PREPAID',
            currency: 'MXN',
          },
        },
        key(`request-${name}`),
      );
      fixture.request = request.publicId;
      persist();
    }
    if (!fixture.quote) {
      const quotes = await list(
        machine,
        `/delivery-requests/${fixture.request}/quotes`,
      );
      assert(quotes.length <= 1, 'Ambiguous quote');
      const quote =
        quotes[0] ??
        (await api(
          machine,
          'POST',
          `/delivery-requests/${fixture.request}/quotes`,
          {},
        ));
      fixture.quote = quote.publicId;
      persist();
    }
    if (!fixture.dispatchId) {
      await api(
        machine,
        'POST',
        `/delivery-quotes/${fixture.quote}/accept`,
        {},
      );
      const ds = await list(
        admin,
        `/admin/dispatches?deliveryRequestPublicId=${fixture.request}`,
      );
      assert.equal(ds.length, 1);
      fixture.dispatchId = ds[0].id;
      persist();
    }
    const dp = `/provider/dispatches/${fixture.dispatchId}`;
    if (!fixture.claimed) {
      const dispatch = await api(operator, 'GET', dp);
      if (!dispatch.claimedByMe) await api(operator, 'POST', `${dp}/claim`, {});
      fixture.claimed = true;
      persist();
    }
    if (!fixture.assignmentId) {
      const assignments = await api(operator, 'GET', `${dp}/assignments`);
      assert(
        assignments.length <= 1,
        'Fixture modified manually before setup finished',
      );
      try {
        if (name === 'legacy' && !assignments.length) localAdmission(false);
        const a =
          assignments[0] ??
          (await api(operator, 'POST', `${dp}/assignment`, {
            driverId: state.resources[name].driverId,
            vehicleId: state.resources[name].vehicleId,
          }));
        fixture.assignmentId = a.id;
        persist();
      } finally {
        if (name === 'legacy' && !assignments.length) localAdmission(true);
      }
    }
    if (name === 'return' || name === 'transfer') {
      const driverSession = await login(
        accounts.find((a) => a.email === state.resources[name].email),
      );
      for (const phase of ['TO_PICKUP', 'AT_PICKUP', 'PICKED_UP']) {
        if (fixture[phase]) continue;
        const { execution } = await api(operator, 'GET', `${dp}/execution`);
        fixture.commands ??= {};
        fixture.commands[phase] ??= {
          assignmentId: fixture.assignmentId,
          expectedRevision: execution.revision,
          phase,
        };
        persist();
        await api(
          driverSession,
          'POST',
          `/driver/dispatches/${fixture.dispatchId}/execution-events`,
          fixture.commands[phase],
          key(`${name}-${phase}`),
        );
        fixture[phase] = true;
        persist();
      }
      if (!fixture.incidentId) {
        const { execution } = await api(operator, 'GET', `${dp}/execution`);
        const incident = execution.openIncidentId
          ? { id: execution.openIncidentId }
          : await api(
              operator,
              'POST',
              `${dp}/custody-incidents`,
              {
                assignmentId: fixture.assignmentId,
                expectedRevision: execution.revision,
                reasonCode: 'OTHER',
                reasonDetail: `Simulacion Desktop ${name}; sin operacion fisica real`,
              },
              key(`incident-${name}`),
            );
        fixture.incidentId = incident.id;
        persist();
      }
    }
    fixture.ready = true;
    persist();
    console.log(
      `${name}: ${fixture.request} / ${fixture.quote} prepared via APIs`,
    );
  }
  identity();
  const verification = { checkedAt: new Date().toISOString(), cases: {} };
  for (const [name, fixture] of Object.entries(state.cases)) {
    const { execution } = await api(
      operator,
      'GET',
      `/provider/dispatches/${fixture.dispatchId}${name === 'legacy' ? '' : '/execution'}`,
    );
    verification.cases[name] = {
      request: fixture.request,
      dispatchId: fixture.dispatchId,
      execution,
    };
    if (name === 'legacy') assert.equal(execution, undefined);
  }
  const transfer = verification.cases.transfer.execution;
  if (transfer?.openIncidentId) {
    const candidates = await list(
      admin,
      `/admin/dispatches/${state.cases.transfer.dispatchId}/custody-transfer-candidates`,
    );
    verification.recipientEligible = candidates.some(
      (c) =>
        c.driverId === state.resources.recipient.driverId &&
        c.vehicleId === state.resources.recipient.vehicleId,
    );
    assert(
      verification.recipientEligible,
      'Designated recipient no longer eligible',
    );
  }
  verification.credits = await api(admin, 'GET', `${pp}/credits`);
  verification.ledger = await list(admin, `${pp}/credits/ledger`);
  save(`${dir}/operational-verification.json`, verification);
  console.log(
    JSON.stringify({
      cases: Object.fromEntries(
        Object.entries(state.cases).map(([k, v]) => [k, v.request]),
      ),
      recipientEligible: verification.recipientEligible,
      ledgerEntries: verification.ledger.length,
    }),
  );
}
let lock;
try {
  lock = openSync(`${dir}/operational-fixtures.lock`, 'wx');
  await main();
} catch (e) {
  console.error(
    e instanceof assert.AssertionError
      ? `Fixture invariant failed at ${e.stack
          .split('\n')
          .find((l) => l.includes('prepare-desktop-execution-fixtures.mjs'))
          ?.trim()}; stopped without resetting data.`
      : e.message,
  );
  process.exitCode = 1;
} finally {
  for (const s of sessions) {
    try {
      await api(null, 'POST', '/auth/logout', { refreshToken: s.refreshToken });
    } catch {
      /* Tokens remain private and expire normally. */
    }
  }
  if (lock !== undefined) {
    closeSync(lock);
    unlinkSync(`${dir}/operational-fixtures.lock`);
  }
}
