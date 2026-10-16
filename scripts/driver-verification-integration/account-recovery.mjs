import { environment, snapshot, web } from './environment.mjs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import argon2 from 'argon2';
const e = await environment('documentary-account-recovery');
let browser;
const secrets = new Set();
try {
  const password = randomBytes(24).toString('hex');
  secrets.add(password);
  const email = 'recovery.synthetic@example.test',
    adminEmail = 'recovery-admin.synthetic@example.test';
  const call = async (path, body, token) => {
    const r = await fetch(e.api + path, {
      method: body ? 'POST' : 'GET',
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, data: await r.json() };
  };
  assert.equal(
    (await call('/independent-driver-registrations', { email })).status,
    202,
  );
  const token = e.messages.find((m) => m.to === email).token;
  secrets.add(token);
  assert.equal(
    (
      await call('/independent-driver-registrations/confirm', {
        token,
        password,
        name: 'Persona sintética recuperación',
      })
    ).status,
    200,
  );
  const user = await e.db.user.findUniqueOrThrow({ where: { email } });
  await e.db.user.create({
    data: {
      email: adminEmail,
      passwordHash: await argon2.hash(password),
      role: 'SUPER_ADMIN',
      active: true,
      emailVerifiedAt: new Date(),
    },
  });
  browser = await e.chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1365, height: 900 },
  });
  const page = await context.newPage();
  let access;
  await context.route('**/*', (route) =>
    ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname)
      ? route.continue()
      : route.abort(),
  );
  page.on('response', async (r) => {
    if (r.url().endsWith('/auth/login') && r.status() === 200) {
      const tokens = await r.json();
      access = tokens.accessToken;
      secrets.add(access);
      secrets.add(tokens.refreshToken);
    }
  });
  const login = async (email) => {
    access = null;
    await page.goto(e.web + '/login?next=onboarding');
    await page.getByLabel('Correo electrónico', { exact: true }).fill(email);
    await page.getByLabel('Contraseña', { exact: true }).fill(password);
    await page
      .getByRole('button', { name: 'Iniciar sesión', exact: true })
      .click();
    await page.waitForURL(/onboarding|verification/);
    await e.expect.poll(() => Boolean(access)).toBe(true);
  };
  const logout = async () => {
    await page.locator('.user-trigger').click();
    await page
      .getByRole('button', { name: 'Cerrar sesión', exact: true })
      .click();
    await page.waitForURL(/login/);
  };
  await login(email);
  await e.expect(page.getByRole('checkbox').first()).not.toBeChecked();
  await page.getByRole('checkbox').first().check();
  e.loseResponse('/verification-terms/accept');
  await page
    .getByRole('button', {
      name: 'Aceptar personalmente (prueba)',
      exact: true,
    })
    .click();
  await e.expect
    .poll(() =>
      e.db.verificationAcceptance.count({ where: { userId: user.id } }),
    )
    .toBe(1);
  await page.waitForTimeout(20500);
  const markers = await page.evaluate(() =>
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
  assert.equal(markers[0].actor, user.id);
  const key = markers[0].key;
  await logout();
  await login(adminEmail);
  await e
    .expect(page.getByText(/Hay un intento pendiente de otra cuenta/))
    .toBeVisible();
  await e
    .expect(
      page.getByRole('button', { name: 'Consultar intento', exact: true }),
    )
    .toHaveCount(0);
  assert.equal(
    (
      await call(
        '/verification-command-attempts/' +
          key +
          '?operation=ACCEPT_TERMS&target=DRIVER',
        undefined,
        access,
      )
    ).status,
    403,
  );
  await page.reload();
  await e
    .expect(page.getByText(/Hay un intento pendiente de otra cuenta/))
    .toBeVisible();
  await page.screenshot({
    path: join(e.output, 'pending-other-account.png'),
    fullPage: true,
  });
  await logout();
  await login(email);
  await page
    .getByRole('button', { name: 'Consultar intento', exact: true })
    .click();
  await e
    .expect(page.getByText(/Comprobante histórico recuperado/))
    .toBeVisible();
  await e
    .expect(page.getByRole('heading', { name: 'Pendiente de reconciliación' }))
    .toHaveCount(0);
  assert.equal(
    await e.db.verificationAcceptance.count({ where: { userId: user.id } }),
    1,
  );
  assert.equal(
    await e.db.verificationCommand.count({
      where: { actorId: user.id, operation: 'ACCEPT_TERMS' },
    }),
    1,
  );
  assert.equal(e.lost.length, 1);
  assert.equal(e.lost[0].status, 200);
  await page.screenshot({
    path: join(e.output, 'recovered-own-account.png'),
    fullPage: true,
  });
  e.report.checks.push({
    id: 'G-pending-marker-user-change-and-reload-browser',
    status: 'PASS',
    detail:
      'Real committed terms acceptance, response withheld, actor switch, foreign HTTP403, reload, original actor recovery; exactly one receipt and command.',
  });
} catch (err) {
  e.report.checks.push({
    id: 'G-pending-marker-user-change-and-reload-browser',
    status: 'FAIL',
    detail: [...secrets]
      .reduce(
        (message, value) => message.replaceAll(value, '[redacted]'),
        String(err.message),
      )
      .replace(/https?:\/\/[^\s]+/g, '[local URL]')
      .slice(0, 1200),
  });
  process.exitCode = 1;
} finally {
  await browser?.close();
  e.report.webUnchanged =
    JSON.stringify(snapshot(web).files) ===
    JSON.stringify(e.report.versions.web.files);
  await e.close();
  console.log(
    JSON.stringify({
      checks: e.report.checks,
      webUnchanged: e.report.webUnchanged,
      stopped: e.report.stopped,
    }),
  );
}
