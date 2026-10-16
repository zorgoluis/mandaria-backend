import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { backend } from './environment.mjs';
export async function operational(h) {
  const {
    e,
    db,
    expect,
    check,
    note,
    api,
    ok,
    cmd,
    admin,
    rep,
    fleet,
    A,
    fd,
    owned,
    shot,
  } = h;
  const eligibility = async (d, v, local = true) =>
    db.$transaction(async (tx) => {
      if (local)
        await tx.$executeRaw`SELECT set_config('mandaria.verification_environment','LOCAL_TEST',true)`;
      const [r] =
        await tx.$queryRaw`SELECT verification_eligibility(${d}::uuid,${v}::uuid) code`;
      return r.code;
    });
  const policy = async (enabled) =>
    cmd(admin, '/admin/verification-policy', {
      enabled,
      expectedVersion: (
        await db.verificationPolicy.findUniqueOrThrow({ where: { id: 1 } })
      ).revision,
    });
  let legacyD, legacyV, service;
  await check('I-existing-resources-control-off-and-on-HTTP', async () => {
    const u = await db.user.create({
      data: {
        email: 'existing.synthetic@example.test',
        passwordHash: 'synthetic-unusable-hash',
        role: 'DRIVER',
        active: true,
        emailVerifiedAt: new Date(),
      },
    });
    legacyD = await db.driver.create({
      data: {
        userId: u.id,
        providerId: fleet.id,
        name: 'Conductor existente sintético',
        status: 'ACTIVE',
      },
    });
    legacyV = await db.vehicle.create({
      data: {
        providerId: fleet.id,
        identifier: 'EXISTING-UNIT',
        type: 'BICYCLE',
        status: 'ACTIVE',
      },
    });
    await ok(
      rep,
      '/provider/drivers/' + legacyD.id + '/vehicle?providerId=' + fleet.id,
      'POST',
      { vehicleId: legacyV.id },
    );
    await ok(
      rep,
      '/provider/drivers/' + legacyD.id + '/vehicle?providerId=' + fleet.id,
      'DELETE',
    );
    await policy(true);
    const blocked = await api(
      rep,
      '/provider/drivers/' + legacyD.id + '/vehicle?providerId=' + fleet.id,
      'POST',
      { vehicleId: legacyV.id },
    );
    assert.equal(blocked.status, 409);
    assert.equal(blocked.data.code, 'VERIFICATION_REVIEW_REQUIRED');
    await policy(false);
  });
  await check('I-committed-service-preparation-HTTP', async () => {
    const { tsImport } = await import('tsx/esm/api');
    const { ensureTestCreditPolicies } = await tsImport(
      pathToFileURL(join(backend, 'test/support/credit-policies.ts')).href,
      import.meta.url,
    );
    const { fundForAward } = await tsImport(
      pathToFileURL(join(backend, 'test/support/credits.ts')).href,
      import.meta.url,
    );
    await ensureTestCreditPolicies(db);
    const zone = await ok(admin, '/admin/service-zones', 'POST', {
      code: 'SYNTH_ZONE',
      name: 'Zona sintética',
      currency: 'MXN',
      boundary: {
        type: 'Polygon',
        coordinates: [
          [
            [-95, 18],
            [-94.9, 18],
            [-94.9, 18.1],
            [-95, 18.1],
            [-95, 18],
          ],
        ],
      },
    });
    await ok(admin, '/admin/service-zones/' + zone.id + '/activate', 'POST');
    const plan = await ok(admin, '/admin/rate-plans', 'POST', {
      serviceZoneId: zone.id,
      serviceType: 'LOCAL_DELIVERY',
      quoteValidityMinutes: 60,
      bands: [
        { minDistanceMeters: 0, maxDistanceMeters: 100000, amount: '60' },
      ],
    });
    await ok(admin, '/admin/rate-plans/' + plan.id + '/activate', 'POST');
    await ok(
      admin,
      '/admin/providers/' + fleet.id + '/service-coverages',
      'POST',
      { serviceZoneId: zone.id, serviceType: 'LOCAL_DELIVERY' },
    );
    const client = await ok(admin, '/admin/integrations', 'POST', {
      name: 'Cliente sintético aislado',
      code: 'DOC_SYNTH',
    });
    const credential = await ok(
      admin,
      '/admin/integrations/' + client.id + '/credentials',
      'POST',
      {
        scopes: [
          'deliveries:create',
          'deliveries:read',
          'quotes:create',
          'quotes:accept',
        ],
      },
    );
    h.secrets.add(credential.clientSecret);
    const auth = await ok(null, '/integrations/token', 'POST', {
      clientId: credential.clientId,
      clientSecret: credential.clientSecret,
    });
    h.secrets.add(auth.accessToken);
    const b2b = { token: auth.accessToken };
    const stop = (type, sequence, d) => ({
      type,
      sequence,
      address: 'Calle sintética',
      latitude: 18 + d,
      longitude: -95 + d,
      contactName: 'Contacto sintético',
      contactPhone: '0000000000',
    });
    const req = await cmd(b2b, '/delivery-requests', {
      stops: [stop('PICKUP', 1, 0.02), stop('DROPOFF', 2, 0.05)],
      packages: [
        { category: 'FOOD', description: 'Paquete sintético', quantity: 1 },
      ],
      financialContext: { goodsPaymentMode: 'PREPAID', currency: 'MXN' },
    });
    const quote = await ok(
      b2b,
      '/delivery-requests/' + req.publicId + '/quotes',
      'POST',
    );
    await ok(b2b, '/delivery-quotes/' + quote.publicId + '/accept', 'POST');
    const dispatch = await db.dispatch.findFirstOrThrow({
      where: { deliveryRequest: { publicId: req.publicId } },
    });
    await fundForAward(db, dispatch.id, { providerId: fleet.id });
    await ok(
      rep,
      '/provider/dispatches/' + dispatch.id + '/claim?providerId=' + fleet.id,
      'POST',
    );
    await ok(
      rep,
      '/provider/dispatches/' +
        dispatch.id +
        '/assignment?providerId=' +
        fleet.id,
      'POST',
      { driverId: legacyD.id, vehicleId: legacyV.id },
    );
    service = { id: dispatch.id, requestId: req.publicId };
  });
  await check('I-identity-only-unit-only-and-local-positive', async () => {
    await policy(true);
    assert(fd?.driver && rep.vehicle && owned?.v);
    assert.equal(
      await eligibility(legacyD.id, legacyV.id),
      'VERIFICATION_REVIEW_REQUIRED',
    );
    assert.equal(
      await eligibility(fd.driver, legacyV.id),
      'VERIFICATION_REVIEW_REQUIRED',
    );
    assert.equal(
      await eligibility(legacyD.id, rep.vehicle),
      'VERIFICATION_REVIEW_REQUIRED',
    );
    assert.equal(await eligibility(fd.driver, rep.vehicle), null);
    assert.equal(await eligibility(A.driver, owned.v.id), null);
    assert.equal(
      await eligibility(A.driver, owned.v.id, false),
      'VERIFICATION_TEST_RECEIPT_NOT_OPERATIONAL',
    );
    await ok(
      rep,
      '/provider/drivers/' + fd.driver + '/vehicle?providerId=' + fleet.id,
      'POST',
      { vehicleId: rep.vehicle },
    );
  });
  await check(
    'I-failed-reassignment-preserves-legacy-service-HTTP',
    async () => {
      assert(service);
      const before = await db.deliveryAssignment.findFirstOrThrow({
        where: { dispatchId: service.id, status: 'ACTIVE' },
      });
      const another = await db.vehicle.create({
        data: {
          providerId: fleet.id,
          identifier: 'EXISTING-OTHER',
          type: 'BICYCLE',
          status: 'ACTIVE',
        },
      });
      const r = await api(
        rep,
        '/provider/dispatches/' +
          service.id +
          '/assignment/reassign?providerId=' +
          fleet.id,
        'POST',
        {
          driverId: legacyD.id,
          vehicleId: another.id,
          reason: 'OPERATIONAL_CHANGE',
        },
      );
      assert.equal(r.status, 409);
      assert.equal(
        (
          await db.deliveryAssignment.findFirstOrThrow({
            where: { dispatchId: service.id, status: 'ACTIVE' },
          })
        ).id,
        before.id,
      );
      const view = await ok(
        rep,
        '/provider/dispatches/' + service.id + '?providerId=' + fleet.id,
      );
      assert.equal(view.trackingMode, 'LEGACY');
      e.report.legacy = {
        requestPublicId: service.requestId,
        readTrackingMode: view.trackingMode,
      };
    },
  );
  await check('I-documentary-read-preserves-search-and-claim', async () => {
    assert(service);
    const select = {
      status: true,
      claimedByProviderId: true,
      claimedAt: true,
      searchMaxAttempts: true,
      searchAttempt: true,
      searchWindowSeconds: true,
      searchStoppedReason: true,
      searchRounds: true,
    };
    const before = await db.dispatch.findUniqueOrThrow({
      where: { id: service.id },
      select,
    });
    await ok(admin, '/admin/verification-cases');
    await ok(rep, '/provider/verification-cases?providerId=' + fleet.id);
    await ok(A, '/driver/onboarding');
    assert.deepEqual(
      await db.dispatch.findUniqueOrThrow({
        where: { id: service.id },
        select,
      }),
      before,
    );
  });

  await check('I-license-category-and-expiry-HTTP', async () => {
    assert(fd?.driver && rep.vehicle);
    const beforeService = service
      ? await db.dispatch.findUniqueOrThrow({
          where: { id: service.id },
          include: { searchRounds: true },
        })
      : null;
    async function identity(types, expiresAt) {
      const c = await cmd(rep, '/provider/verification-cases', {
        subjectType: 'DRIVER_IDENTITY',
        subjectId: fd.driver,
      });
      const base = '/verification-cases/' + c.id;
      let r = await ok(
        rep,
        base,
        'PATCH',
        {
          expectedVersion: 1,
          data: {
            fullName: 'Conductor Sintético A',
            contactPhone: '0000000000',
            operatingCity: 'Ciudad sintética',
            documentType: 'INE',
            license: {
              issuer: 'Emisor sintético',
              category: 'Categoría sintética',
              vehicleTypes: types,
              expiresAt,
            },
          },
        },
        randomUUID(),
      );
      for (const category of [
        'FACE_PHOTO',
        'INE_FRONT',
        'INE_BACK',
        'LICENSE',
      ]) {
        const upload = await cmd(rep, base + '/uploads', {
          expectedVersion: r.revision,
          category,
        });
        assert.equal(
          (await fetch(upload.uploadUrl, { method: 'PUT', body: h.png }))
            .status,
          200,
        );
        r = await cmd(rep, base + '/uploads/' + upload.id + '/complete', {
          expectedVersion: upload.revision,
        });
      }
      const sub = await cmd(rep, base + '/submit', {
        expectedVersion: r.revision,
      });
      await cmd(admin, '/admin/verification-cases/' + c.id + '/decision', {
        expectedVersion: sub.revision,
        decision: 'APPROVE',
        checklistVersion: 'LOCAL-TEST-1',
        passedChecks: [
          'IDENTITY_MATCH',
          'LEGIBLE',
          'LICENSE_HOLDER',
          'LICENSE_VALIDITY',
          'LICENSE_CATEGORY',
        ],
      });
    }
    await identity(['CAR'], new Date(Date.now() + 86400000).toISOString());
    assert.equal(
      await eligibility(fd.driver, rep.vehicle),
      'LICENSE_CATEGORY_MISMATCH',
    );
    const expiry = new Date(Date.now() + 30000);
    await identity(['MOTORCYCLE'], expiry.toISOString());
    assert.equal(await eligibility(fd.driver, rep.vehicle), null);
    await new Promise((r) =>
      setTimeout(r, Math.max(0, expiry - Date.now()) + 100),
    );
    assert.equal(await eligibility(fd.driver, rep.vehicle), 'LICENSE_EXPIRED');
    const attempts = await db.deliveryAssignment.count({
      where: { dispatchId: service?.id },
    });
    assert.equal(attempts, 1);
    assert.deepEqual(
      await db.dispatch.findUniqueOrThrow({
        where: { id: service.id },
        include: { searchRounds: true },
      }),
      beforeService,
    );
  });
  await check('I-legacy-delivery-browser-after-activation', async () => {
    assert(service);
    const before = await db.creditLedgerEntry.count();
    await rep.page.goto(
      e.web + '/services/' + service.id + '?providerId=' + fleet.id,
    );
    await expect(
      rep.page.getByRole('button', {
        name: 'MARCAR COMO ENTREGADO',
        exact: true,
      }),
    ).toBeVisible();
    await shot(rep, 'legacy-committed-after-activation');
    await rep.page
      .getByRole('button', { name: 'MARCAR COMO ENTREGADO', exact: true })
      .click();
    await rep.page
      .getByRole('button', { name: 'Confirmar entrega', exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (await db.dispatch.findUniqueOrThrow({ where: { id: service.id } }))
            .status,
      )
      .toBe('DELIVERED');
    assert.equal(await db.creditLedgerEntry.count(), before);
    assert.equal(
      (
        await db.deliveryAssignment.findFirstOrThrow({
          where: { dispatchId: service.id },
        })
      ).status,
      'COMPLETED',
    );
    await shot(rep, 'legacy-delivered');
  });
  if (process.env.DOCUMENTARY_SKIP_SEARCH === '1') {
    note(
      'J-five-search-rounds-complete-file',
      'NOT RUN',
      'Explicitly skipped: see previously completed 16/16 file in this task.',
    );
    return;
  }
  await check('J-five-search-rounds-complete-file', async () => {
    // Separate database on the already identity-checked exclusive cluster. No existing DB is reused.
    const url = new URL(e.databaseUrl);
    url.pathname = '/documentary_search_regression_test';
    const pass = new URL(e.databaseUrl).password;
    const pg = 'C:/Program Files/PostgreSQL/18/bin';
    e.run(
      join(pg, 'createdb.exe'),
      [
        '-h',
        '127.0.0.1',
        '-p',
        url.port,
        '-U',
        'postgres',
        url.pathname.slice(1),
      ],
      { PGPASSWORD: pass },
    );
    e.run(
      process.execPath,
      [
        join(backend, 'node_modules/prisma/build/index.js'),
        'migrate',
        'deploy',
        '--config',
        join(backend, '.tmp/documentary-integrated-prisma.config.ts'),
      ],
      { DATABASE_URL: url.toString() },
    );
    const config = join(backend, '.tmp/documentary-regression.config.mts');
    writeFileSync(
      config,
      `export default {test:{root:${JSON.stringify(backend)},include:['test/**/*.e2e-spec.ts'],fileParallelism:false}}`,
    );
    const env = {
      ...process.env,
      TEST_DATABASE_URL: url.toString(),
      DATABASE_URL: e.databaseUrl,
    };
    const result = await new Promise((resolve) => {
      let output = '';
      const p = spawn(
        process.execPath,
        [
          join(backend, 'node_modules/vitest/vitest.mjs'),
          'run',
          '--config',
          config,
          '--root',
          backend,
          'test/dispatch-search.e2e-spec.ts',
        ],
        { cwd: e.temp, env, windowsHide: true },
      );
      p.stdout.on('data', (c) => (output += c));
      p.stderr.on('data', (c) => (output += c));
      p.on('close', (code) => resolve({ code, output }));
    });
    const safe = result.output
      .replaceAll(pass, '[redacted]')
      .replace(/postgres(?:ql)?:\/\/[^\s]+/g, '[isolated database]');
    writeFileSync(join(e.output, 'dispatch-search.txt'), safe);
    e.report.searchRegression = {
      exitCode: result.code,
      log: 'dispatch-search.txt',
    };
    assert.equal(result.code, 0);
  });
}
