import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
export async function continueScenarios(h) {
  const {
    e,
    db,
    expect,
    check,
    api,
    ok,
    cmd,
    login,
    shot,
    uiTerms,
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
    secret,
    secrets,
    identityCase,
  } = h;
  const cpath = (id) => '/verification-cases/' + id;
  const current = async (a, id) => ok(a, cpath(id));
  const revision = async (a, id) => (await current(a, id)).revision;
  async function unitForm(a, id, ownership) {
    const p = a.page;
    await p.goto(e.web + '/verification/cases/' + id);
    await p
      .getByLabel('Nombre del titular declarado *', { exact: true })
      .fill('Titular Sintético Flotilla');
    await p
      .getByLabel('Número de serie *', { exact: true })
      .fill('SERIE-SINTETICA-' + ownership);
    await p
      .getByLabel('Propiedad o uso autorizado *', { exact: true })
      .selectOption(ownership);
    const old = await revision(a, id);
    await p.getByRole('button', { name: 'Guardar datos', exact: true }).click();
    await expect.poll(() => revision(a, id)).toBe(old + 1);
    await uiUpload(a, id, 'REGISTRATION_CARD');
    await uiUpload(
      a,
      id,
      {
        OWNED: 'OWNERSHIP_PROOF',
        RENTED: 'RENTAL_CONTRACT',
        BORROWED: 'OWNER_AUTHORIZATION',
      }[ownership],
    );
  }
  async function vehicle(a, identifier) {
    const p = a.page;
    await p.goto(e.web + '/driver/onboarding');
    await p
      .getByText('Registrar unidad independiente', { exact: true })
      .click();
    await p.getByLabel('Identificador *', { exact: true }).fill(identifier);
    await p.getByLabel('Tipo *', { exact: true }).selectOption('MOTORCYCLE');
    await p.getByLabel('Placa', { exact: true }).fill('SYNTH01');
    await p
      .getByRole('button', { name: 'Crear unidad pendiente', exact: true })
      .click();
    await expect
      .poll(() => db.vehicle.count({ where: { identifier } }))
      .toBe(1);
    const v = await db.vehicle.findFirstOrThrow({ where: { identifier } });
    await p
      .getByRole('heading', { name: identifier, exact: true })
      .locator('..')
      .getByRole('button', { name: 'Preparar expediente de esta unidad' })
      .click();
    await p.waitForURL(/verification\/cases\//);
    return { v, id: p.url().split('/').pop() };
  }
  let owned, rejected, corrected, fd, fb, fc, bcase;
  for (const ownership of ['OWNED', 'RENTED', 'BORROWED'])
    await check('C-unit-' + ownership + '-browser', async () => {
      const r = await vehicle(A, 'SYNTH-' + ownership);
      if (ownership === 'OWNED') owned = r;
      await unitForm(A, r.id, ownership);
      await uiSubmit(A, r.id);
      await uiDecision(
        admin,
        r.id,
        ownership === 'OWNED' ? 'REJECT' : 'APPROVE',
      );
      if (ownership === 'OWNED') {
        rejected = r.id;
        await A.page.goto(e.web + '/verification/cases/' + r.id);
        await expect(
          A.page.getByText(
            'Motivo de decisión: Corregir evidencia sintética de prueba',
          ),
        ).toBeVisible();
        await A.page
          .getByRole('button', {
            name: 'Preparar nueva corrección',
            exact: true,
          })
          .click();
        await A.page.waitForURL(
          (u) => u.pathname !== '/verification/cases/' + r.id,
        );
        corrected = A.page.url().split('/').pop();
        await unitForm(A, corrected, 'OWNED');
        await uiSubmit(A, corrected);
        await uiDecision(admin, corrected);
        assert.equal((await current(A, rejected)).status, 'REJECTED');
        assert.equal((await current(A, corrected)).status, 'APPROVED');
        assert.equal(
          await db.verificationCase.count({
            where: { subjectId: (await current(A, rejected)).subjectId },
          }),
          2,
        );
      }
      await shot(admin, 'unit-' + ownership.toLowerCase());
    });
  await check('E-concurrency-and-decision-permissions-HTTP', async () => {
    assert(identityCase);
    const r = await api(
      admin,
      '/admin/verification-cases/' + identityCase + '/decision',
      'POST',
      {
        expectedVersion: 1,
        decision: 'REJECT',
        publicReason: 'stale synthetic',
        checklistVersion: 'LOCAL-TEST-1',
        passedChecks: [],
      },
      randomUUID(),
    );
    assert.equal(r.status, 409);
    assert.equal(
      (
        await api(
          A,
          '/admin/verification-cases/' + identityCase + '/decision',
          'POST',
          {
            expectedVersion: 1,
            decision: 'REJECT',
            publicReason: 'not permitted',
            checklistVersion: 'LOCAL-TEST-1',
            passedChecks: [],
          },
          randomUUID(),
        )
      ).status,
      403,
    );
    assert.equal(
      await db.verificationEvent.count({
        where: { target: identityCase, kind: 'DECIDE' },
      }),
      1,
    );
  });
  await check('H-mail-failure-and-retry-real-outbox', async () => {
    e.failMail(true);
    await e.notices.flush();
    const n = await db.verificationNotice.findFirstOrThrow({
      where: { caseId: identityCase },
    });
    assert.equal(n.status, 'PENDING');
    assert.equal(n.errorCode, 'MAIL_ACCEPTANCE_UNCONFIRMED');
    assert.equal((await current(admin, identityCase)).status, 'APPROVED');
    e.failMail(false);
    await db.verificationNotice.updateMany({
      where: { status: 'PENDING' },
      data: { retryAt: new Date(Date.now() - 1000) },
    });
    await e.notices.flush();
    const after = await db.verificationNotice.findUniqueOrThrow({
      where: { id: n.id },
    });
    assert.equal(after.status, 'ACCEPTED_BY_PROVIDER');
    assert.equal(after.attempts, n.attempts + 1);
    assert.equal(
      await db.verificationEvent.count({
        where: { target: identityCase, kind: 'DECIDE' },
      }),
      1,
    );
    assert(e.messages.some((m) => m.to === A.email));
  });
  await check('D-fleet-representative-terms-and-invitation', async () => {
    await login(rep);
    await uiTerms(rep, 'FLEET', fleet.id);
    await expect
      .poll(() =>
        db.verificationAcceptance.count({
          where: { userId: rep.id, scope: 'FLEET' },
        }),
      )
      .toBe(1);
    await ok(
      rep,
      '/provider/driver-invitations?providerId=' + fleet.id,
      'POST',
      {
        email: 'driver-a.synthetic@example.test',
        driverName: 'Conductor Sintético A',
      },
    );
    const message = e.messages.find(
      (m) => m.to === 'driver-a.synthetic@example.test',
    );
    const token = new URL(message.activationUrl).searchParams.get('token');
    assert(token);
    secrets.add(token);
    fd = { email: message.to, password: secret() };
    await ok(null, '/auth/activate-account', 'POST', {
      token,
      password: fd.password,
    });
    const user = await db.user.findUniqueOrThrow({
      where: { email: fd.email },
      include: { driver: true },
    });
    fd.id = user.id;
    fd.driver = user.driver.id;
    assert.equal(user.driver.providerId, fleet.id);
    const bad = await api(
      rep,
      '/provider/verification-cases',
      'POST',
      { subjectType: 'DRIVER_IDENTITY', subjectId: fd.driver },
      randomUUID(),
    );
    assert.equal(bad.status, 409);
    const terms = await ok(A, '/verification-terms?scope=DRIVER');
    assert.equal(
      (
        await api(
          rep,
          '/verification-terms/accept',
          'POST',
          {
            scope: 'DRIVER',
            version: terms.version,
            hash: terms.hash,
            accepted: true,
            method: 'WEB_CHECKBOX_BUTTON',
          },
          randomUUID(),
        )
      ).status,
      403,
    );
    await login(fd);
    await uiTerms(fd);
    await expect
      .poll(() =>
        db.verificationAcceptance.count({
          where: { userId: fd.id, scope: 'DRIVER' },
        }),
      )
      .toBe(1);
    await shot(fd, 'fleet-personal-terms');
  });
  await check('D-fleet-identity-browser-independent-of-unit', async () => {
    assert(fd?.driver);
    await rep.page.goto(
      e.web + '/provider/verification?providerId=' + fleet.id,
    );
    await rep.page
      .getByLabel('Seleccionar recurso autorizado', { exact: true })
      .selectOption(fd.driver);
    await rep.page
      .getByRole('button', { name: 'Crear borrador de flotilla', exact: true })
      .click();
    await rep.page.waitForURL(/verification\/cases\//);
    fc = rep.page.url().split('/').pop();
    await uiIdentity(rep, fc);
    for (const category of ['FACE_PHOTO', 'INE_FRONT', 'INE_BACK', 'LICENSE'])
      await uiUpload(rep, fc, category);
    await uiSubmit(rep, fc);
    await uiDecision(admin, fc);
    assert.equal((await ok(fd, '/driver/me')).provider.id, fleet.id);
    await shot(rep, 'fleet-identity');
  });
  await check('D-fleet-unit-owned-by-organization', async () => {
    const v = await ok(
      rep,
      '/provider/vehicles?providerId=' + fleet.id,
      'POST',
      { identifier: 'FLEET-UNIT', type: 'MOTORCYCLE', plate: 'SYNTH02' },
    );
    await rep.page.goto(
      e.web + '/provider/verification?providerId=' + fleet.id,
    );
    await rep.page
      .getByLabel('Recurso', { exact: true })
      .selectOption('VEHICLE');
    await rep.page
      .getByLabel('Seleccionar recurso autorizado', { exact: true })
      .selectOption(v.id);
    await rep.page
      .getByRole('button', { name: 'Crear borrador de flotilla', exact: true })
      .click();
    await rep.page.waitForURL(/verification\/cases\//);
    const id = rep.page.url().split('/').pop();
    await unitForm(rep, id, 'BORROWED');
    await uiSubmit(rep, id);
    await uiDecision(admin, id);
    rep.vehicle = v.id;
    rep.unitCase = id;
    assert.equal(
      (await current(rep, id)).data.declaredOwnerName,
      'Titular Sintético Flotilla',
    );
  });
  await check('E-fleet-B-isolation-HTTP-and-browser', async () => {
    await login(repB);
    await uiTerms(repB, 'FLEET', fleetB.id);
    await expect
      .poll(() =>
        db.verificationAcceptance.count({ where: { userId: repB.id } }),
      )
      .toBe(1);
    const vb = await ok(
      repB,
      '/provider/vehicles?providerId=' + fleetB.id,
      'POST',
      { identifier: 'FLEET-B-UNIT', type: 'BICYCLE' },
    );
    bcase = await cmd(repB, '/provider/verification-cases', {
      subjectType: 'VEHICLE',
      subjectId: vb.id,
    });
    await repB.page.goto(e.web + '/verification/cases/' + bcase.id);
    await unitForm(repB, bcase.id, 'OWNED');
    const r = await current(repB, bcase.id);
    assert.equal((await api(rep, cpath(r.id))).status, 404);
    assert.equal((await api(A, cpath(r.id))).status, 404);
    assert.equal((await api(fd, cpath(r.id))).status, 404);
    for (const who of [null, A, rep, fd])
      assert(
        [401, 404].includes(
          (
            await api(
              who,
              cpath(r.id) + '/attachments/' + r.attachments[0].id + '/access',
              'POST',
            )
          ).status,
        ),
      );
    await rep.page.goto(e.web + '/verification/cases/' + r.id);
    await expect(rep.page.getByRole('alert')).toBeVisible();
    await expect(
      rep.page.getByText('Titular Sintético Flotilla', { exact: true }),
    ).toHaveCount(0);
    await shot(rep, 'cross-fleet-denied');
  });
  await check('F-browser-storage-error-and-file-validation', async () => {
    assert(bcase);
    const p = repB.page;
    await p.goto(e.web + '/verification/cases/' + bcase.id);
    const section = p
      .getByRole('heading', { name: 'Evidencias privadas' })
      .locator('..');
    e.denyUpload();
    await section
      .getByLabel('Categoría *', { exact: true })
      .selectOption('REGISTRATION_CARD');
    await section
      .getByLabel('Imagen sintética *', { exact: true })
      .setInputFiles({
        name: 'synthetic.png',
        mimeType: 'image/png',
        buffer: png,
      });
    await section
      .getByRole('button', { name: 'Cargar imagen sintética', exact: true })
      .click();
    await expect(section.getByRole('alert')).toBeVisible();
    const r = await current(repB, bcase.id);
    assert(r.attachments.some((a) => a.status === 'CREATED'));
    await shot(repB, 'upload-denied');
    await p.reload();
    await section
      .getByLabel('Imagen sintética *', { exact: true })
      .setInputFiles({
        name: 'invalid.png',
        mimeType: 'image/png',
        buffer: Buffer.from('invalid synthetic image'),
      });
    await section
      .getByRole('button', { name: 'Cargar imagen sintética', exact: true })
      .click();
    await expect(section.getByRole('alert')).toBeVisible();
    assert(
      (await current(repB, bcase.id)).attachments.filter(
        (a) => a.status === 'VALIDATED',
      ).length === 2,
    );
  });
  await check('F-expired-missing-manipulated-uploads-HTTP', async () => {
    assert(bcase);
    const id = bcase.id;
    const u = await cmd(repB, cpath(id) + '/uploads', {
      expectedVersion: await revision(repB, id),
      category: 'REGISTRATION_CARD',
    });
    const ticket = e.tickets.get(new URL(u.uploadUrl).pathname.slice(1));
    ticket.expires = Date.now() - 1;
    assert.equal(
      (await fetch(u.uploadUrl, { method: 'PUT', body: png })).status,
      403,
    );
    const missing = await api(
      repB,
      cpath(id) + '/uploads/' + u.id + '/complete',
      'POST',
      { expectedVersion: await revision(repB, id) },
      randomUUID(),
    );
    assert(missing.status >= 400);
    assert.equal(
      (
        await api(
          repB,
          cpath(id) + '/uploads',
          'POST',
          {
            expectedVersion: await revision(repB, id),
            category: 'REGISTRATION_CARD',
            objectKey: 'not-owned',
          },
          randomUUID(),
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await api(
          repB,
          cpath(id) + '/uploads/' + randomUUID() + '/complete',
          'POST',
          { expectedVersion: await revision(repB, id) },
          randomUUID(),
        )
      ).status,
      404,
    );
  });
  await check(
    'G-absent-close-late-command-and-actor-isolation-HTTP',
    async () => {
      const key = randomUUID(),
        query = '?operation=CREATE_VEHICLE&target=SELF';
      assert.equal(
        (await ok(A, '/verification-command-attempts/' + key + query)).state,
        'ABSENT',
      );
      const close = await ok(
        A,
        '/verification-command-attempts/' + key + '/close',
        'POST',
        { operation: 'CREATE_VEHICLE', target: 'SELF' },
      );
      assert.equal(close.state, 'CLOSED_NO_EFFECTS');
      const late = await api(
        A,
        '/driver/onboarding/vehicles',
        'POST',
        { identifier: 'MUST-NOT-EXIST', type: 'BICYCLE' },
        key,
      );
      assert.equal(late.status, 409);
      assert.equal(late.data.code, 'VERIFICATION_ATTEMPT_CLOSED');
      assert.equal(
        await db.vehicle.count({ where: { identifier: 'MUST-NOT-EXIST' } }),
        0,
      );
      assert.equal(
        (await api(rep, '/verification-command-attempts/' + key + query))
          .status,
        403,
      );
      const m = e.lost[0];
      const applied = await ok(
        A,
        '/verification-command-attempts/' + m.key + '/close',
        'POST',
        { operation: 'ACCEPT_TERMS', target: 'DRIVER' },
      );
      assert.equal(applied.state, 'APPLIED');
    },
  );

  await check('G-historical-submit-separated-from-current-HTTP', async () => {
    const m = e.lost.find((x) =>
      x.path.endsWith('/' + identityCase + '/submit'),
    );
    assert(m);
    const attempt = await ok(
      A,
      '/verification-command-attempts/' +
        m.key +
        '?operation=SUBMIT&target=' +
        identityCase,
    );
    assert.equal(attempt.state, 'APPLIED');
    assert.equal(attempt.result.status, 'SUBMITTED');
    assert.equal((await current(A, identityCase)).status, 'APPROVED');
    assert.equal(
      await db.verificationEvent.count({
        where: { target: identityCase, kind: 'SUBMIT' },
      }),
      1,
    );
  });
  await check('B-terms-version-conflict-historical-receipt-HTTP', async () => {
    const old = await ok(A, '/verification-terms?scope=DRIVER');
    const policy = await db.verificationPolicy.findUniqueOrThrow({
      where: { id: 1 },
    });
    e.report.termsPolicyFields = Object.keys(policy);
    const changed = await api(
      A,
      '/verification-terms/accept',
      'POST',
      {
        scope: 'DRIVER',
        version: 'LOCAL-NOT-CURRENT',
        hash: '0'.repeat(64),
        accepted: true,
        method: 'WEB_CHECKBOX_BUTTON',
      },
      randomUUID(),
    );
    assert.equal(changed.status, 409);
    assert.equal(
      await db.verificationAcceptance.count({
        where: { userId: A.id, scope: 'DRIVER' },
      }),
      1,
    );
    assert.equal(old.environment, 'LOCAL_TEST');
  });

  await check('F-reject-disallowed-MIME-with-image-bytes-browser', async () => {
    assert(bcase);
    await repB.page.goto(e.web + '/verification/cases/' + bcase.id);
    const section = repB.page
      .getByRole('heading', { name: 'Evidencias privadas' })
      .locator('..');
    await expect(
      section.getByRole('button', {
        name: 'Cargar imagen sintética',
        exact: true,
      }),
    ).toBeEnabled();
    const before = await db.verificationAttachment.count({
      where: { caseId: bcase.id },
    });
    await section
      .getByLabel('Imagen sintética *', { exact: true })
      .setInputFiles({
        name: 'unsupported.pdf',
        mimeType: 'application/pdf',
        buffer: png,
      });
    await section
      .getByRole('button', { name: 'Cargar imagen sintética', exact: true })
      .click();
    await expect(section.getByRole('alert')).toContainText(/JPEG|PNG/);
    assert.equal(
      await db.verificationAttachment.count({ where: { caseId: bcase.id } }),
      before,
    );
  });
  await check('E-driver-B-and-logout-browser-isolation', async () => {
    await ok(
      repB,
      '/provider/driver-invitations?providerId=' + fleetB.id,
      'POST',
      {
        email: 'driver-b.synthetic@example.test',
        driverName: 'Conductor Sintético B',
      },
    );
    const message = e.messages.find(
      (m) => m.to === 'driver-b.synthetic@example.test',
    );
    const token = new URL(message.activationUrl).searchParams.get('token');
    secrets.add(token);
    fb = { email: message.to, password: secret() };
    await ok(null, '/auth/activate-account', 'POST', {
      token,
      password: fb.password,
    });
    const user = await db.user.findUniqueOrThrow({
      where: { email: fb.email },
      include: { driver: true },
    });
    fb.id = user.id;
    fb.driver = user.driver.id;
    await login(fb);
    assert.equal((await api(fb, cpath(identityCase))).status, 404);
    assert.equal((await api(fb, cpath(fc))).status, 404);
    await admin.page.goto(e.web + '/verification/cases/' + identityCase);
    await admin.page
      .getByRole('button', { name: 'Ver evidencia', exact: true })
      .first()
      .click();
    await expect(
      admin.page.getByAltText('Evidencia sintética privada del expediente'),
    ).toBeVisible();
    await admin.page.locator('.user-trigger').click();
    await admin.page
      .getByRole('button', { name: 'Cerrar sesión', exact: true })
      .click();
    await admin.page.waitForURL(/login/);
    await expect(
      admin.page.getByAltText('Evidencia sintética privada del expediente'),
    ).toHaveCount(0);
    const p = admin.page;
    await p.getByLabel('Correo electrónico', { exact: true }).fill(repB.email);
    await p.getByLabel('Contraseña', { exact: true }).fill(repB.password);
    await p
      .getByRole('button', { name: 'Iniciar sesión', exact: true })
      .click();
    await p.waitForURL(/provider\/verification/);
    await p.goto(e.web + '/verification/cases/' + identityCase);
    await expect(p.getByRole('alert')).toBeVisible();
    await expect(
      p.getByAltText('Evidencia sintética privada del expediente'),
    ).toHaveCount(0);
    await p.locator('.user-trigger').click();
    await p.getByRole('button', { name: 'Cerrar sesión', exact: true }).click();
    await p.waitForURL(/login/);
    await login(admin);
  });

  await check('E-mobile-keyboard-and-private-storage', async () => {
    await A.page.goto(e.web + '/driver/onboarding');
    await A.page.setViewportSize({ width: 390, height: 844 });
    await expect(
      A.page.getByRole('heading', { name: 'Mi verificación documental' }),
    ).toBeVisible();
    assert(
      await A.page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    );
    await A.page.keyboard.press('Tab');
    assert(
      await A.page.evaluate(() => document.activeElement !== document.body),
    );
    await shot(A, 'onboarding-mobile');
    for (const actor of [A, admin, rep, repB, fd].filter((a) => a?.page)) {
      const data = await actor.page.evaluate(() => ({
        local: { ...localStorage },
        session: { ...sessionStorage },
      }));
      delete data.session['mandaria.refresh'];
      const raw = JSON.stringify(data);
      assert(!raw.includes('uploadUrl'));
      assert(!raw.includes('quarantine'));
      assert(!raw.includes('Titular Sintético'));
      assert(!raw.includes('data:image'));
      for (const s of secrets) assert(!raw.includes(s));
    }
  });
  await import('./revalidation.mjs').then(m => m.revalidate({ ...h, fd, owned, corrected }));
  await import('./operational.mjs').then((m) =>
    m.operational({ ...h, fd, owned, corrected }),
  );
  await import('./revalidation.mjs').then(m => m.finalPending({ ...h, fd, owned, corrected }));
}
