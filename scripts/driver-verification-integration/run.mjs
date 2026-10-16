import { environment, snapshot, web, backend } from './environment.mjs';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import argon2 from 'argon2';
import sharp from 'sharp';
const e = await environment('documentary-revalidation');
const { db, expect } = e;
const secrets = new Set();
const secret = () => {
  const s = randomBytes(24).toString('hex');
  secrets.add(s);
  return s;
};
const clean = (s) => {
  for (const value of secrets) s = s.replaceAll(value, '[redacted]');
  return s
    .replace(/postgres(?:ql)?:\/\/[^\s]+/g, '[isolated database]')
    .replace(/\$argon2[^\s]+/g, '[password hash]')
    .replace(/https?:\/\/[^\s)"']+/g, '[local URL]')
    .slice(0, 1400);
};
const note = (id, status, detail) => {
  e.report.checks.push({ id, status, detail });
  e.save();
  console.log(id + ' ' + status);
};
async function check(id, fn) {
  try {
    await fn();
    note(
      id,
      'PASS',
      'Verified by real browser/HTTP and dedicated PostgreSQL as specified in scenario.',
    );
  } catch (err) {
    note(id, 'FAIL', clean(err.message));
    for (const [i, c] of contexts.entries()) {
      const p = c.pages()[0];
      if (p && !p.isClosed()) {
        await p.screenshot({
          path: join(e.output, id + '-actor-' + i + '.png'),
          fullPage: true,
          animations: 'disabled',
        });
      }
    }
  }
}
const contexts = [];
let browser;
const A = {
  email: 'independent.synthetic@example.test',
  password: secret(),
  name: 'Persona Sintética',
};
async function api(actor, path, method = 'GET', body, key) {
  const r = await fetch(e.api + path, {
    method,
    headers: {
      ...(actor?.token ? { Authorization: 'Bearer ' + actor.token } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let data = null;
  if (r.headers.get('content-type')?.includes('json')) data = await r.json();
  return { status: r.status, data };
}
async function ok(actor, path, method = 'GET', body, key) {
  const r = await api(actor, path, method, body, key);
  assert(
    r.status >= 200 && r.status < 300,
    `${method} ${path}: ${r.status} ${r.data?.code || ''}`,
  );
  return r.data;
}
async function cmd(actor, path, body) {
  return ok(actor, path, 'POST', body, randomUUID());
}
async function session(actor) {
  const ctx = await browser.newContext({
    viewport: { width: 1365, height: 900 },
  });
  contexts.push(ctx);
  ctx.setDefaultTimeout(12000);
  const page = await ctx.newPage();
  actor.page = page;
  page.on('pageerror', (err) => e.report.errors.push(clean(err.message)));
  page.on('response', async (r) => {
    if (/\/auth\/(login|refresh)$/.test(r.url()) && r.status() === 200) {
      const t = await r.json();
      actor.token = t.accessToken;
      secrets.add(t.accessToken);
      secrets.add(t.refreshToken);
    }
  });
  await ctx.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (!['127.0.0.1', 'localhost'].includes(u.hostname)) return route.abort();
    return route.continue();
  });
  return page;
}
async function login(actor) {
  const p = actor.page || (await session(actor));
  await p.goto(e.web + '/login?next=onboarding');
  await p.getByLabel('Correo electrónico', { exact: true }).fill(actor.email);
  await p.getByLabel('Contraseña', { exact: true }).fill(actor.password);
  await p.getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
  await expect.poll(() => Boolean(actor.token)).toBe(true);
  await p.waitForURL(/onboarding|verification/);
}
async function shot(actor, name) {
  await actor.page.screenshot({
    path: join(e.output, name + '.png'),
    fullPage: true,
    animations: 'disabled',
  });
}
async function recovery(actor) {
  const p = actor.page;
  await expect(
    p.getByRole('heading', { name: 'Pendiente de reconciliación' }),
  ).toBeVisible({ timeout: 30000 });
  await p.waitForTimeout(20500);
  const markers = await p.evaluate(() =>
    Object.entries(localStorage)
      .filter(([k]) => k.startsWith('mandaria.verification.pending:'))
      .flatMap(([, v]) => JSON.parse(v)),
  );
  assert.equal(markers.length, 1);
  assert.deepEqual(Object.keys(markers[0]).sort(), [
    'actor',
    'key',
    'operation',
    'target',
  ]);
  assert.equal(markers[0].actor, actor.id);
  await p.reload();
  await p
    .getByRole('button', { name: 'Consultar intento', exact: true })
    .click();
  await expect(p.getByText(/Comprobante histórico recuperado/)).toBeVisible();
  await expect(
    p.getByRole('heading', { name: 'Pendiente de reconciliación' }),
  ).toHaveCount(0);
}
async function uiTerms(actor, scope = 'DRIVER', provider) {
  const p = actor.page;
  await p.goto(
    e.web +
      (scope === 'DRIVER'
        ? '/driver/onboarding'
        : '/provider/verification?providerId=' + provider),
  );
  await expect(
    p.getByRole('region', { name: 'Texto completo de los términos' }),
  ).toContainText('PRUEBA');
  const box = p.getByRole('checkbox').first();
  await expect(box).not.toBeChecked();
  await box.check();
  await p
    .getByRole('button', {
      name:
        scope === 'DRIVER'
          ? 'Aceptar personalmente (prueba)'
          : 'Aceptar por esta flotilla (prueba)',
      exact: true,
    })
    .click();
}
async function uiCase(actor, resource, type) {
  const p = actor.page;
  if (type === 'DRIVER_IDENTITY' && actor === A) {
    await p.goto(e.web + '/driver/onboarding');
    await p
      .getByRole('button', {
        name: 'Preparar expediente de identidad independiente',
        exact: true,
      })
      .click();
  } else {
    const area = actor === A ? 'driver' : 'provider';
    const c = await cmd(actor, `/${area}/verification-cases`, {
      subjectType: type,
      subjectId: resource,
    });
    await p.goto(e.web + '/verification/cases/' + c.id);
  }
  await p.waitForURL(/verification\/cases\//);
  return p.url().split('/').pop();
}
async function uiIdentity(actor, id, license = true) {
  const p = actor.page;
  await p.goto(e.web + '/verification/cases/' + id);
  await p
    .getByLabel('Nombre completo *', { exact: true })
    .fill('Persona Sintética');
  await p
    .getByLabel('Teléfono de contacto *', { exact: true })
    .fill('0000000000');
  await p
    .getByLabel('Ciudad de operación *', { exact: true })
    .fill('Ciudad sintética');
  if (license) {
    await p.getByRole('checkbox', { name: /Declarar licencia/ }).check();
    await p.getByLabel('Emisor *', { exact: true }).fill('Emisor sintético');
    await p
      .getByRole('textbox', { name: 'Categoría *', exact: true })
      .fill('Categoría sintética');
    await p
      .getByLabel('Vencimiento, hora local *', { exact: true })
      .fill('2027-10-13T12:00');
    await p.getByRole('checkbox', { name: 'Motocicleta', exact: true }).check();
  }
  const old = (await ok(actor, '/verification-cases/' + id)).revision;
  await p.getByRole('button', { name: 'Guardar datos', exact: true }).click();
  await expect
    .poll(async () => (await ok(actor, '/verification-cases/' + id)).revision)
    .toBe(old + 1);
}
let png, jpeg;
async function uiUpload(actor, id, category, bytes = png, mime = 'image/png') {
  const p = actor.page;
  await expect(
    p.getByRole('button', { name: 'Cargar imagen sintética', exact: true }),
  ).toBeEnabled();
  const before = await ok(actor, '/verification-cases/' + id);
  const section = p
    .getByRole('heading', { name: 'Evidencias privadas' })
    .locator('..');
  await section
    .getByLabel('Categoría *', { exact: true })
    .selectOption(category);
  await section
    .getByLabel('Imagen sintética *', { exact: true })
    .setInputFiles({
      name: 'synthetic.' + (mime === 'image/jpeg' ? 'jpg' : 'png'),
      mimeType: mime,
      buffer: bytes,
    });
  await section
    .getByRole('button', { name: 'Cargar imagen sintética', exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await ok(actor, '/verification-cases/' + id)).attachments.filter(
          (a) => a.status === 'VALIDATED',
        ).length,
      { timeout: 25000 },
    )
    .toBe(
      before.attachments.filter((a) => a.status === 'VALIDATED').length + 1,
    );
  await expect(
    section.getByRole('button', {
      name: 'Cargar imagen sintética',
      exact: true,
    }),
  ).toBeEnabled();
}
async function uiSubmit(actor, id, lost = false) {
  const p = actor.page;
  await p.goto(e.web + '/verification/cases/' + id);
  if (lost) e.loseResponse('/verification-cases/' + id + '/submit');
  await p
    .getByRole('button', { name: 'Presentar para revisión', exact: true })
    .click();
  await p.getByRole('button', { name: 'Confirmar', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await db.verificationCase.findUnique({ where: { id } })).status,
      { timeout: 15000 },
    )
    .toBe('SUBMITTED');
  if (lost) await recovery(actor);
  else
    await expect(p.getByRole('heading', { name: /En revisión/ })).toBeVisible();
}
async function uiDecision(actor, id, decision = 'APPROVE', lost = false) {
  const p = actor.page;
  await p.goto(e.web + '/verification/cases/' + id);
  await p.getByLabel('Resultado', { exact: true }).selectOption(decision);
  if (decision === 'APPROVE') {
    for (const box of await p.getByRole('checkbox').all()) await box.check();
  } else
    await p
      .getByLabel('Motivo público *', { exact: true })
      .fill('Corregir evidencia sintética de prueba');
  if (lost) e.loseResponse('/admin/verification-cases/' + id + '/decision');
  await p
    .getByRole('button', { name: 'Registrar decisión explícita', exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await db.verificationCase.findUnique({ where: { id } })).status,
      { timeout: 15000 },
    )
    .toBe(decision === 'APPROVE' ? 'APPROVED' : 'REJECTED');
  if (lost) await recovery(actor);
}
const seed = async (role, email) => {
  const password = secret();
  const user = await db.user.create({
    data: {
      email,
      passwordHash: await argon2.hash(password),
      role,
      active: true,
      emailVerifiedAt: new Date(),
    },
  });
  return { id: user.id, email, password };
};
try {
  browser = await e.chromium.launch();
  png = await sharp({
    create: { width: 320, height: 160, channels: 3, background: '#66aabb' },
  })
    .png()
    .toBuffer();
  jpeg = await sharp(png).jpeg().toBuffer();
  const admin = await seed('SUPER_ADMIN', 'admin.synthetic@example.test');
  const rep = await seed('PROVIDER_ADMIN', 'fleet-a.synthetic@example.test');
  const repB = await seed('PROVIDER_ADMIN', 'fleet-b.synthetic@example.test');
  const fleet = await db.deliveryProvider.create({
    data: {
      name: 'Flotilla sintética A',
      code: 'SYNTH-A',
      type: 'FLEET',
      status: 'ACTIVE',
      maxDrivers: 10,
      maxVehicles: 10,
    },
  });
  const fleetB = await db.deliveryProvider.create({
    data: {
      name: 'Flotilla sintética B',
      code: 'SYNTH-B',
      type: 'FLEET',
      status: 'ACTIVE',
      maxDrivers: 10,
      maxVehicles: 10,
    },
  });
  for (const [actor, p] of [
    [rep, fleet],
    [repB, fleetB],
  ])
    await db.providerMembership.create({
      data: { userId: actor.id, providerId: p.id, role: 'OWNER' },
    });
  e.report.seed =
    'Only admin and two representatives with verified email, providers and memberships. Independent registration and driver invitation are public flows.';
  e.save();
  await check('A-registration-browser', async () => {
    const p = await session(A);
    await p.goto(e.web + '/driver/register');
    await p.getByLabel('Correo electrónico *').fill(A.email);
    await p
      .getByRole('button', {
        name: 'Solicitar correo de registro',
        exact: true,
      })
      .click();
    await expect(p.getByText(/Revisa el correo de pruebas/)).toBeVisible();
    assert.equal(await db.user.findUnique({ where: { email: A.email } }), null);
    const token = e.messages.find((m) => m.to === A.email).token;
    secrets.add(token);
    await p
      .getByRole('link', { name: 'Confirmar con el código recibido' })
      .click();
    await p.getByLabel('Código de confirmación *').fill(token);
    await p.getByLabel('Nombre *', { exact: true }).fill(A.name);
    await p
      .getByLabel('Contraseña nueva (16–128 caracteres) *')
      .fill(A.password);
    await p
      .getByRole('button', { name: 'Confirmar y continuar a login' })
      .click();
    await p.waitForURL(/login/);
    await login(A);
    const u = await db.user.findUniqueOrThrow({
      where: { email: A.email },
      include: { driver: { include: { independentProfile: true } } },
    });
    A.id = u.id;
    A.driver = u.driver.id;
    assert.equal(u.driver.providerId, null);
    assert.equal(u.driver.status, 'PENDING');
    await p.reload();
    await expect(
      p.getByText('Independiente sin proveedor', { exact: false }),
    ).toBeVisible();
    assert.equal((await api(A, '/driver/dispatches/available')).status, 409);
    await shot(A, 'independent-pending');
  });
  await check('B-terms-committed-response-lost-reload', async () => {
    assert(A.id);
    e.loseResponse('/verification-terms/accept');
    await uiTerms(A);
    await expect.poll(() => e.lost.length).toBe(1);
    await recovery(A);
    assert.equal(
      await db.verificationAcceptance.count({
        where: { userId: A.id, scope: 'DRIVER' },
      }),
      1,
    );
    const m = e.lost[0];
    assert.equal(m.status, 200);
    const r = await ok(
      A,
      '/verification-command-attempts/' +
        m.key +
        '?operation=ACCEPT_TERMS&target=DRIVER',
    );
    assert.equal(r.state, 'APPLIED');
    assert.equal(r.result.contractuallyEffective, false);
    await shot(A, 'terms-recovered');
  });
  let identityCase;
  await check('C-identity-license-browser-JPEG-PNG', async () => {
    identityCase = await uiCase(A, A.driver, 'DRIVER_IDENTITY');
    await uiIdentity(A, identityCase);
    for (const c of ['FACE_PHOTO', 'INE_FRONT', 'INE_BACK', 'LICENSE'])
      await uiUpload(
        A,
        identityCase,
        c,
        c === 'FACE_PHOTO' ? jpeg : png,
        c === 'FACE_PHOTO' ? 'image/jpeg' : 'image/png',
      );
    const r = await ok(A, '/verification-cases/' + identityCase);
    assert.equal(r.attachments.length, 4);
    assert(
      r.attachments.every(
        (a) => a.status === 'VALIDATED' && a.mime === 'image/png',
      ),
    );
    await shot(A, 'identity-files');
  });
  await check('G-submit-committed-response-lost-reload', async () => {
    assert(identityCase);
    await uiSubmit(A, identityCase, true);
    assert.equal(
      await db.verificationEvent.count({
        where: { target: identityCase, kind: 'SUBMIT' },
      }),
      1,
    );
  });
  await check('E-admin-browser-review-evidence', async () => {
    await login(admin);
    await admin.page
      .getByRole('link', { name: 'Expediente · En revisión' })
      .first()
      .click();
    await admin.page
      .getByRole('button', { name: 'Ver evidencia', exact: true })
      .first()
      .click();
    await expect(
      admin.page.getByAltText('Evidencia sintética privada del expediente'),
    ).toBeVisible();
    await shot(admin, 'admin-evidence');
  });
  await check('G-decision-committed-response-lost-reload', async () => {
    assert(identityCase);
    await uiDecision(admin, identityCase, 'APPROVE', true);
    assert.equal(
      await db.verificationEvent.count({
        where: { target: identityCase, kind: 'DECIDE' },
      }),
      1,
    );
    const d = await db.driver.findUniqueOrThrow({ where: { id: A.driver } });
    assert.equal(d.status, 'ACTIVE');
  });
  await import('./scenarios.mjs').then((m) =>
    m.continueScenarios({
      e,
      db,
      expect,
      check,
      note,
      api,
      ok,
      cmd,
      login,
      session,
      shot,
      uiTerms,
      uiCase,
      uiIdentity,
      uiUpload,
      uiSubmit,
      uiDecision,
      admin,
      A,
      rep,
      repB,
      fleet,
      fleetB,
      png,
      jpeg,
      secret,
      secrets,
      identityCase,
    }),
  );
} catch (err) {
  e.report.errors.push(clean(err.message));
  console.log('INTEGRATION_INTERRUPTED ' + clean(err.message));
} finally {
  for (const c of contexts) await c.close();
  await browser?.close();
  e.report.webUnchanged =
    JSON.stringify(snapshot(web).files) ===
    JSON.stringify(e.report.versions.web.files);
  e.report.versions.backendAfter = snapshot(backend);
  e.save();
  await e.close();
  process.exitCode =
    e.report.checks.some((x) => x.status === 'FAIL') ||
    e.report.errors.length ||
    !e.report.webUnchanged
      ? 1
      : 0;
  console.log(
    'RESULT ' +
      JSON.stringify({
        checks: e.report.checks.map((x) => ({ id: x.id, status: x.status })),
        errors: e.report.errors.length,
        webUnchanged: e.report.webUnchanged,
        stopped: e.report.stopped,
      }),
  );
}
