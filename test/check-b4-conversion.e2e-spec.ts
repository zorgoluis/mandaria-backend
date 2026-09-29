import 'reflect-metadata';
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';

/**
 * CHECK V1.13-B4 — recorrido integral de la conversión con wiring real.
 *
 * Las suites B2 y B3 sustituyen el consumo durable A5 por un doble. Esta suite no: emite la MPQ
 * con `DurablePrequoteConsumption` real y sólo controla el proveedor de routing, que es la única
 * dependencia externa pagada. Autenticación, token, idempotencia, conversión, persistencia y
 * PostgreSQL son los de producción. Eso permite exigir lo que ninguna suite anterior exigía:
 * que emitir consuma lo que A5 promete y que convertir no consuma nada.
 */
const url = process.env.TEST_DATABASE_URL;
if (
  !url ||
  !['localhost', '127.0.0.1'].includes(new URL(url).hostname) ||
  !new URL(url).pathname.endsWith('_test')
)
  throw Error('Local test database required');
process.env.DATABASE_URL = url;
process.env.NODE_ENV = 'test';
process.env.PREQUOTE_ENABLED = 'true';
process.env.PREQUOTE_GLOBAL_DAILY_ROUTING_UNITS = '1000000';
process.env.B2B_WEBHOOK_POLL_SECONDS = '0';
for (const key of [
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'INTEGRATION_JWT_SECRET',
])
  process.env[key] = randomBytes(48).toString('hex');

const p = new PrismaClient({ datasourceUrl: url });
const run = randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase();
const bearer = { type: 'bearer' } as const;
const SCOPES = [
  'prequotes:create',
  'prequotes:read',
  'prequotes:convert',
  'deliveries:create',
  'deliveries:read',
  'deliveries:cancel',
  'quotes:create',
  'quotes:read',
  'quotes:accept',
];
/** Límites de consumo declarados; la huella debe coincidir con la política persistida. */
const LIMITS = {
  minute: 1000,
  day: 100000,
  concurrent: 100,
  globalUnits: 1000000,
  reserveMs: 1000,
  retries: 0,
  timeoutMs: 1000,
};
const CONFIG_KEYS = {
  minute: 'PREQUOTE_PER_MINUTE',
  day: 'PREQUOTE_PER_DAY',
  concurrent: 'PREQUOTE_MAX_CONCURRENT',
  globalUnits: 'PREQUOTE_GLOBAL_DAILY_ROUTING_UNITS',
  reserveMs: 'PREQUOTE_PERMIT_RESERVE_MS',
  retries: 'GOOGLE_ROUTES_MAX_RETRIES',
  timeoutMs: 'GOOGLE_ROUTES_TIMEOUT_MS',
} as const;

const lat = 30 + randomInt(0, 100000) / 10000;
const at = (offset: number) => Number((lat + offset).toFixed(6));
const LNG = 70;
const conditions = {
  conditionsVersion: 1,
  serviceType: 'LOCAL_DELIVERY',
  stops: [
    {
      type: 'PICKUP',
      sequence: 1,
      latitude: at(0.000002),
      longitude: 70.000002,
    },
    {
      type: 'DROPOFF',
      sequence: 2,
      latitude: at(0.000008),
      longitude: 70.000008,
    },
  ],
  packages: [{ category: 'FOOD', quantity: 1 }],
};
const route = () => ({
  distanceMeters: 1800,
  durationSeconds: 300,
  routingProvider: 'b4-controlled',
  calculatedAt: new Date(),
});
const routings = [
  { name: 'b4-control-a', calculateRoute: vi.fn(async () => route()) },
  { name: 'b4-control-b', calculateRoute: vi.fn(async () => route()) },
];
const logs: string[] = [];
const capture = (...args: unknown[]) => void logs.push(JSON.stringify(args));
const logger = {
  log: capture,
  error: capture,
  warn: capture,
  debug: capture,
  verbose: capture,
  fatal: capture,
};

const apps: INestApplication[] = [];
const configs: ConfigService[] = [];
const clients = [randomUUID(), randomUUID()];
const credentials = [randomUUID(), randomUUID()];
const secrets = [
  randomBytes(32).toString('base64url'),
  randomBytes(32).toString('base64url'),
];
const tokens: string[] = [];
let zoneId = '';
/** Evidencia sanitizada del CHECK; sólo conteos, hashes y observaciones. */
const evidence: Record<string, unknown> = { barriers: [] };
const note = (id: string, title: string, ...detail: unknown[]) =>
  void (evidence.barriers as unknown[]).push({ id, title, detail });

const api = (i = 0) => request(apps[i].getHttpServer());
const key = (label: string) => `b4-${label}-${randomUUID()}`;
const issue = (k = key('issue'), i = 0, t = tokens[0]) =>
  api(i)
    .post('/api/v1/delivery-prequotes')
    .auth(t, bearer)
    .set('Idempotency-Key', k)
    .send(conditions);
const readPrequote = (publicId: string, i = 0, t = tokens[0]) =>
  api(i).get(`/api/v1/delivery-prequotes/${publicId}`).auth(t, bearer);

const confirmation = (suffix = randomUUID().slice(0, 8)) => ({
  goodsPaymentStatus: 'CONFIRMED_BY_MERCHANT',
  goodsPaymentReference: `merchant-receipt-${suffix}`,
  goodsPaymentConfirmedAt: new Date(Date.now() - 60_000).toISOString(),
  orderAcceptanceStatus: 'ACCEPTED_BY_MERCHANT',
  orderAcceptanceReference: `merchant-order-${suffix}`,
  orderAcceptedAt: new Date(Date.now() - 30_000).toISOString(),
});
const conversionBody = (over: Record<string, unknown> = {}) => ({
  conditionsVersion: 1,
  deliveryRequest: {
    serviceType: 'LOCAL_DELIVERY',
    externalReference: `order-b4-${randomUUID().slice(0, 8)}`,
    stops: conditions.stops.map((s) => ({
      ...s,
      address: `Sintética B4 ${s.sequence}`,
      contactName: 'Contacto de prueba',
      contactPhone: '0000000000',
      instructions: null,
    })),
    packages: [
      {
        category: 'FOOD',
        description: 'Paquete de comida sintético',
        quantity: 1,
        weightKg: null,
        lengthCm: null,
        widthCm: null,
        heightCm: null,
        isFragile: false,
        handlingInstructions: null,
      },
    ],
    financialContext: {
      goodsPaymentMode: 'PREPAID',
      goodsValue: '150.00',
      currency: 'MXN',
    },
  },
  merchantConfirmation: confirmation(),
  deliveryCollectionInstruction: {
    payer: 'RECIPIENT',
    method: 'CASH',
    dueAt: 'DELIVERY',
    components: ['DELIVERY_FEE'],
  },
  ...over,
});
const convert = (
  publicId: string,
  body: object = conversionBody(),
  k = key('convert'),
  i = 0,
  t = tokens[0],
) =>
  api(i)
    .post(`/api/v1/delivery-prequotes/${publicId}/convert`)
    .auth(t, bearer)
    .set('Idempotency-Key', k)
    .send(body);

/** Conteos globales de recursos que la conversión nunca debe tocar. */
const untouched = async () => ({
  dispatches: await p.dispatch.count(),
  assignments: await p.deliveryAssignment.count(),
  ledger: await p.creditLedgerEntry.count(),
  outbox: await p.b2bOutboxEvent.count(),
  snapshots: await p.dispatchCreditSnapshot.count(),
});
const permits = (clientId: string) =>
  p.prequoteConsumptionPermit.findMany({
    where: { integrationClientId: clientId },
    orderBy: { reservedAt: 'asc' },
  });
const executions = () => p.apiIdempotencyExecution.count();
const hashOf = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function fingerprintPolicy() {
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(LIMITS))
    .digest('hex');
  // Reemplazo coordinado de política, exclusivo de pruebas: no borra ni reinicia filas de uso.
  await p.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(1313,5)::text`;
    await tx.prequoteConsumptionPolicy.upsert({
      where: { id: 1 },
      create: { id: 1, fingerprint },
      update: { fingerprint },
    });
  });
}
function applyConfig(conversionEnabled = true) {
  for (const config of configs) {
    config.set('PREQUOTE_ENABLED', true);
    config.set('PREQUOTE_CONVERSION_ENABLED', conversionEnabled);
    for (const [k, v] of Object.entries(LIMITS))
      config.set(CONFIG_KEYS[k as keyof typeof LIMITS], v);
  }
}
/** Emite una MPQ con consumo durable real y devuelve su proyección pública. */
async function freshPrequote(i = 0) {
  const response = await issue(key('issue'), i, tokens[i]).expect(201);
  return response.body as { publicId: string; expiresAt: string };
}

beforeAll(async () => {
  const { AppModule } = await import('../dist/app.module.js');
  const { setup } = await import('../dist/setup.js');
  const { ROUTING_PROVIDER } = await import('../dist/routing/routing.types.js');
  // Dos instancias Nest con pools independientes; sin doble de consumo, idempotencia ni auth.
  for (let i = 0; i < 2; i += 1) {
    const ref = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ROUTING_PROVIDER)
      .useValue(routings[i])
      .setLogger(logger)
      .compile();
    const app = ref.createNestApplication({ logger, bodyParser: false });
    setup(app);
    await app.init();
    apps.push(app);
    configs.push(app.get(ConfigService));
  }
  await fingerprintPolicy();
  applyConfig();

  await p.integrationClient.createMany({
    data: clients.map((id, i) => ({
      id,
      code: `B4_${run}_${i}`,
      name: 'B4 CHECK fixture',
    })),
  });
  await p.integrationCredential.createMany({
    data: credentials.map((id, i) => ({
      id,
      clientId: clients[i],
      secretHash: createHash('sha256').update(secrets[i]).digest('hex'),
      scopes: SCOPES,
    })),
  });
  // Token real por el endpoint de credenciales, no firmado a mano.
  for (let i = 0; i < 2; i += 1) {
    const response = await api(i)
      .post('/api/v1/integrations/token')
      .send({ clientId: credentials[i], clientSecret: secrets[i] })
      .expect(200);
    tokens.push(response.body.accessToken as string);
  }

  const zone = await p.serviceZone.create({
    data: {
      code: `B4_${run}`,
      name: 'B4 zone',
      status: 'ACTIVE',
      currency: 'MXN',
      boundary: {
        type: 'Polygon',
        coordinates: [
          [
            [LNG, lat],
            [LNG + 0.00001, lat],
            [LNG + 0.00001, at(0.00001)],
            [LNG, at(0.00001)],
            [LNG, lat],
          ],
        ],
      },
      minLatitude: lat,
      maxLatitude: at(0.00001),
      minLongitude: LNG,
      maxLongitude: LNG + 0.00001,
    },
  });
  zoneId = zone.id;
  const plan = await p.ratePlan.create({
    data: {
      serviceZoneId: zone.id,
      serviceType: 'LOCAL_DELIVERY',
      version: 1,
      status: 'DRAFT',
      quoteValidityMinutes: 15,
      currency: 'MXN',
      bands: {
        create: {
          minDistanceMeters: 0,
          maxDistanceMeters: 10000,
          amount: '31.50',
          currency: 'MXN',
        },
      },
    },
  });
  await p.ratePlan.update({
    where: { id: plan.id },
    data: { status: 'ACTIVE', activatedAt: new Date() },
  });
}, 180000);

afterAll(async () => {
  // Fixtures propios desactivados/revocados; no se borra historia ni bases.
  await p.integrationCredential.updateMany({
    where: { id: { in: credentials } },
    data: { status: 'REVOKED', revokedAt: new Date() },
  });
  await p.integrationClient.updateMany({
    where: { id: { in: clients } },
    data: { status: 'REVOKED' },
  });
  if (zoneId)
    await p.serviceZone.update({
      where: { id: zoneId },
      data: { status: 'INACTIVE' },
    });
  evidence.logLines = logs.length;
  writeFileSync(
    process.env.B4_EVIDENCE_PATH ?? '.tmp/b4/focused-evidence.json',
    JSON.stringify(evidence, null, 2),
  );
  for (const app of apps) await app.close();
  await p.$disconnect();
}, 180000);

describe('CHECK B4 §2 recorrido integral con componentes reales', () => {
  it('emite con consumo durable real, convierte una vez y nada más se mueve', async () => {
    const before = await untouched();
    const permitsBefore = await permits(clients[0]);
    routings[0].calculateRoute.mockClear();

    // 1. Emitir MPQ con consumo durable real.
    const prequote = await freshPrequote(0);
    expect(prequote.publicId).toMatch(/^MPQ-\d{6}$/);
    const permitsAfterIssue = await permits(clients[0]);
    // Emitir sí crea su propia ejecución durable A3; el punto de referencia para la conversión es
    // este, después de emitir.
    const executionsAfterIssue = await executions();
    // A5 promete una marca durable por emisión, no más y no menos.
    expect(permitsAfterIssue.length).toBe(permitsBefore.length + 1);
    const permit = permitsAfterIssue.at(-1)!;
    expect(permit.state).toBe('FINISHED');
    expect(permit.startedAt).not.toBeNull();
    expect(routings[0].calculateRoute).toHaveBeenCalledTimes(1);

    // 2. Consultar y repetir la emisión: replay sin consumir otra vez.
    const read = await readPrequote(prequote.publicId).expect(200);
    expect(read.body).toMatchObject({
      publicId: prequote.publicId,
      status: 'OFFERED',
      convertedAt: null,
      deliveryRequestPublicId: null,
      deliveryQuotePublicId: null,
      availabilityGuaranteed: false,
    });

    // 3. Convertir con confirmaciones declaradas válidas.
    routings[0].calculateRoute.mockClear();
    const body = conversionBody();
    const convertKey = key('integral');
    const created = await convert(prequote.publicId, body, convertKey).expect(
      201,
    );
    expect(created.headers['idempotent-replayed']).toBe('false');
    expect(created.headers.location).toBe(
      `/api/v1/delivery-requests/${created.body.deliveryRequestPublicId}`,
    );
    expect(created.headers['cache-control']).toContain('no-store');
    expect(created.headers['x-request-id']).toBeTruthy();
    expect(created.body).toMatchObject({
      prequotePublicId: prequote.publicId,
      deliveryRequestStatus: 'CREATED',
      externalReference: body.deliveryRequest.externalReference,
      availabilityGuaranteed: false,
      deliveryCollectionInstruction: {
        payer: 'RECIPIENT',
        method: 'CASH',
        dueAt: 'DELIVERY',
        components: ['DELIVERY_FEE'],
      },
    });
    expect(created.body.quote).toMatchObject({
      status: 'OFFERED',
      currency: 'MXN',
      serviceType: 'LOCAL_DELIVERY',
    });
    // Convertir no calcula ruta ni consume nada.
    expect(routings[0].calculateRoute).not.toHaveBeenCalled();
    expect((await permits(clients[0])).length).toBe(permitsAfterIssue.length);
    expect(await executions()).toBe(executionsAfterIssue);

    // 4. Snapshot copiado exactamente desde la MPQ, con fechas propias de conversión.
    const stored = await p.deliveryPrequote.findUniqueOrThrow({
      where: { publicId: prequote.publicId },
    });
    const quote = await p.deliveryQuote.findUniqueOrThrow({
      where: { publicId: created.body.quote.publicId },
    });
    expect({
      amount: quote.amount.toFixed(2),
      currency: quote.currency,
      distance: quote.distanceMeters,
      duration: quote.durationSeconds,
      provider: quote.routingProvider,
      plan: quote.ratePlanId,
      band: quote.rateBandId,
      zone: quote.serviceZoneId,
      expires: quote.expiresAt.toISOString(),
      calculated: quote.routeCalculatedAt.toISOString(),
    }).toEqual({
      amount: stored.amount.toFixed(2),
      currency: stored.currency,
      distance: stored.distanceMeters,
      duration: stored.durationSeconds,
      provider: stored.routingProvider,
      plan: stored.ratePlanId,
      band: stored.rateBandId,
      zone: stored.serviceZoneId,
      expires: stored.expiresAt.toISOString(),
      calculated: stored.routeCalculatedAt.toISOString(),
    });
    const conversion = await p.prequoteConversion.findUniqueOrThrow({
      where: { prequoteId: stored.id },
    });
    const mdr = await p.deliveryRequest.findUniqueOrThrow({
      where: { publicId: created.body.deliveryRequestPublicId },
    });
    // createdAt/requestedAt de MDR y createdAt de MQ son el instante de conversión, no el de emisión.
    expect(mdr.createdAt.toISOString()).toBe(
      conversion.convertedAt.toISOString(),
    );
    expect(mdr.requestedAt.toISOString()).toBe(
      conversion.convertedAt.toISOString(),
    );
    expect(quote.createdAt.toISOString()).toBe(
      conversion.convertedAt.toISOString(),
    );
    expect(conversion.convertedAt.getTime()).toBeGreaterThan(
      stored.issuedAt.getTime(),
    );

    // 5. MPQ pasa a CONVERTED y publica sus vínculos.
    const converted = await readPrequote(prequote.publicId).expect(200);
    expect(converted.body).toMatchObject({
      status: 'CONVERTED',
      deliveryRequestPublicId: created.body.deliveryRequestPublicId,
      deliveryQuotePublicId: created.body.quote.publicId,
    });
    expect(converted.body.convertedAt).toBeTruthy();

    // 6. MDR y MQ legibles por su propio dueño.
    const mdrView = await api()
      .get(`/api/v1/delivery-requests/${created.body.deliveryRequestPublicId}`)
      .auth(tokens[0], bearer)
      .expect(200);
    expect(mdrView.body).toMatchObject({ status: 'CREATED' });
    const quoteView = await api()
      .get(`/api/v1/delivery-quotes/${created.body.quote.publicId}`)
      .auth(tokens[0], bearer)
      .expect(200);
    expect(quoteView.body).toMatchObject({ status: 'OFFERED' });

    // 7. Accept y recotización legacy: ambos bloqueados por aplicación.
    const accept = await api()
      .post(`/api/v1/delivery-quotes/${created.body.quote.publicId}/accept`)
      .auth(tokens[0], bearer)
      .send({});
    expect([accept.status, accept.body.code]).toEqual([
      409,
      'AUTHORIZED_ACCEPT_REQUIRED',
    ]);
    const requote = await api()
      .post(
        `/api/v1/delivery-requests/${created.body.deliveryRequestPublicId}/quotes`,
      )
      .auth(tokens[0], bearer)
      .send({});
    expect([requote.status, requote.body.code]).toEqual([
      409,
      'PREQUOTE_REQUOTE_NOT_ALLOWED',
    ]);
    expect(
      await p.deliveryQuote.count({ where: { deliveryRequestId: mdr.id } }),
    ).toBe(1);

    // 8. Cancelar la MDR convertida sigue permitido y no libera la MPQ.
    const cancelled = await api()
      .post(
        `/api/v1/delivery-requests/${created.body.deliveryRequestPublicId}/cancel`,
      )
      .auth(tokens[0], bearer)
      .send({ reason: 'B4 CHECK' })
      .expect(200);
    expect(cancelled.body.status).toBe('CANCELLED');

    // 9. Repetir la conversión: mismos vínculos, estados actuales.
    const replay = await convert(prequote.publicId, body, convertKey).expect(
      200,
    );
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.headers.location).toBeUndefined();
    expect(replay.body).toMatchObject({
      prequotePublicId: prequote.publicId,
      deliveryRequestPublicId: created.body.deliveryRequestPublicId,
      convertedAt: created.body.convertedAt,
      deliveryRequestStatus: 'CANCELLED',
    });
    expect(replay.body.quote.publicId).toBe(created.body.quote.publicId);
    expect(replay.body.quote.status).toBe('CANCELLED');
    expect(replay.body.quote.expiresAt).toBe(created.body.quote.expiresAt);

    // 10. Otra key sobre la misma MPQ: consumida de forma permanente, sin recursos nuevos.
    const second = await convert(
      prequote.publicId,
      conversionBody(),
      key('second'),
    );
    expect([second.status, second.body.code]).toEqual([
      409,
      'PREQUOTE_ALREADY_CONVERTED',
    ]);
    expect(
      await p.prequoteConversion.count({ where: { prequoteId: stored.id } }),
    ).toBe(1);
    // La MPQ sigue CONVERTED aunque su MDR esté cancelada.
    expect(
      (await readPrequote(prequote.publicId).expect(200)).body.status,
    ).toBe('CONVERTED');

    // Nada de despacho, asignación, crédito ni evento de entrega nació de convertir.
    expect(await untouched()).toEqual(before);
    note(
      '§2',
      'recorrido integral con consumo durable real',
      'emitir crea exactamente un permiso FINISHED y una llamada de routing',
      'emitir crea su ejecución durable A3; convertir no crea permisos, ni ejecución, ni llamada de routing',
      'snapshot idéntico a la MPQ; fechas de MDR/MQ son convertedAt',
      'accept 409 AUTHORIZED_ACCEPT_REQUIRED y requote 409 PREQUOTE_REQUOTE_NOT_ALLOWED',
      'cancelar no libera la MPQ; replay devuelve estados actuales y otra key 409',
      `Dispatch/asignación/ledger/Outbox/snapshots sin cambio: ${JSON.stringify(before)}`,
    );
  }, 180000);

  it('la emisión repetida con la misma key no consume dos veces', async () => {
    const k = key('replay-issue');
    routings[0].calculateRoute.mockClear();
    const permitsBefore = (await permits(clients[0])).length;
    const first = await issue(k).expect(201);
    const second = await issue(k).expect(200);
    expect(second.body.publicId).toBe(first.body.publicId);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(routings[0].calculateRoute).toHaveBeenCalledTimes(1);
    expect((await permits(clients[0])).length).toBe(permitsBefore + 1);
    note(
      '§2',
      'replay de emisión no duplica consumo',
      'una sola llamada de routing y un solo permiso durable para la misma key',
    );
  }, 120000);
});

describe('CHECK B4 §3 contrato y aislamiento', () => {
  it('exige los tres scopes y no los otorga implícitamente', async () => {
    const required = [
      'prequotes:convert',
      'deliveries:create',
      'quotes:create',
    ];
    const prequote = await freshPrequote(0);
    const results: Record<string, number> = {};
    for (const missing of required) {
      const token = await new JwtService().signAsync(
        {
          sub: clients[0],
          credentialId: credentials[0],
          principalType: 'integration',
          type: 'integration_access',
          scopes: SCOPES.filter((s) => s !== missing),
        },
        {
          secret: process.env.INTEGRATION_JWT_SECRET,
          expiresIn: 3600,
          issuer: 'mandaria',
          audience: 'mandaria-integrations',
          algorithm: 'HS256',
        },
      );
      results[missing] = (
        await convert(
          prequote.publicId,
          conversionBody(),
          key('scope'),
          0,
          token,
        )
      ).status;
    }
    expect(results).toEqual({
      'prequotes:convert': 403,
      'deliveries:create': 403,
      'quotes:create': 403,
    });
    // Con los tres, la misma MPQ convierte.
    await convert(prequote.publicId).expect(201);
    note(
      '§3',
      'tres scopes obligatorios',
      'quitar cualquiera de los tres responde 403; con los tres, 201',
    );
  }, 180000);

  it('una MPQ ajena responde exactamente como una inexistente', async () => {
    const mine = await freshPrequote(0);
    const foreign = await convert(
      mine.publicId,
      conversionBody(),
      key('foreign'),
      1,
      tokens[1],
    );
    const missing = await convert(
      'MPQ-999999',
      conversionBody(),
      key('missing'),
      1,
      tokens[1],
    );
    expect([foreign.status, missing.status]).toEqual([404, 404]);
    const normalise = (b: Record<string, unknown>) => ({
      ...b,
      requestId: '<id>',
      timestamp: '<ts>',
      path: '<path>',
    });
    expect(normalise(foreign.body)).toEqual(normalise(missing.body));
    // El envelope repite el path solicitado por el llamante: el publicId aparece ahí por
    // construcción. Lo que no debe filtrarse es ningún dato de la MPQ ajena.
    const { path: foreignPath, ...foreignRest } = foreign.body as Record<
      string,
      unknown
    >;
    expect(String(foreignPath)).toContain(mine.publicId);
    expect(JSON.stringify(foreignRest)).not.toContain(mine.publicId);
    // Y nada se creó por el intento ajeno.
    expect(
      await p.prequoteConversion.count({
        where: { integrationClientId: clients[1] },
      }),
    ).toBe(0);
    note(
      '§3',
      'ownership: ajena e inexistente son indistinguibles',
      'ambos 404 con envelope idéntico salvo requestId/timestamp/path',
    );
  }, 120000);

  it('un token humano no entra y la revocación/suspensión/expiración cierran incluso el replay', async () => {
    const prequote = await freshPrequote(0);
    const k = key('revocation');
    // El mismo cuerpo exacto en cada repetición: un cuerpo nuevo con la misma key es, con razón,
    // un conflicto de intención y no un replay.
    const body = conversionBody();
    const created = await convert(prequote.publicId, body, k).expect(201);

    // Token humano: no es principal de integración.
    const human = await new JwtService().signAsync(
      { sub: randomUUID(), role: 'SUPER_ADMIN', type: 'access' },
      {
        secret: process.env.JWT_ACCESS_SECRET,
        expiresIn: 3600,
        issuer: 'mandaria',
        audience: 'mandaria',
        algorithm: 'HS256',
      },
    );
    expect(
      (await convert(prequote.publicId, body, key('human'), 0, human)).status,
    ).toBe(401);

    // Credencial revocada: el replay autorizado deja de estar disponible.
    await p.integrationCredential.update({
      where: { id: credentials[0] },
      data: { status: 'REVOKED', revokedAt: new Date() },
    });
    expect((await convert(prequote.publicId, body, k)).status).toBe(401);
    await p.integrationCredential.update({
      where: { id: credentials[0] },
      data: { status: 'ACTIVE', revokedAt: null },
    });
    expect((await convert(prequote.publicId, body, k)).status).toBe(200);

    // Integración suspendida.
    await p.integrationClient.update({
      where: { id: clients[0] },
      data: { status: 'SUSPENDED' },
    });
    expect((await convert(prequote.publicId, body, k)).status).toBe(401);
    await p.integrationClient.update({
      where: { id: clients[0] },
      data: { status: 'ACTIVE' },
    });

    // Credencial vencida.
    await p.integrationCredential.update({
      where: { id: credentials[0] },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await convert(prequote.publicId, body, k)).status).toBe(401);
    await p.integrationCredential.update({
      where: { id: credentials[0] },
      data: { expiresAt: null },
    });
    const restored = await convert(prequote.publicId, body, k).expect(200);
    expect(restored.body.deliveryRequestPublicId).toBe(
      created.body.deliveryRequestPublicId,
    );
    note(
      '§3',
      'autenticación y autorización del replay',
      'token humano 401; credencial revocada, integración suspendida y credencial vencida cierran el replay con 401',
      'restablecido el principal, el replay devuelve el mismo ganador',
    );
  }, 180000);
});

describe('CHECK B4 §3 validación, confirmaciones y privacidad', () => {
  it('rechaza el cuerpo inválido antes de tocar la MPQ o crear la key', async () => {
    const prequote = await freshPrequote(0);
    const before = {
      conversions: await p.prequoteConversion.count(),
      records: await p.apiIdempotencyRecord.count(),
      requests: await p.deliveryRequest.count(),
    };
    const cases: Record<string, unknown> = {
      campoDesconocido: conversionBody({ unexpected: 'x' }),
      confirmacionExtra: conversionBody({
        merchantConfirmation: { ...confirmation(), bankAccount: '0000' },
      }),
      versionIncorrecta: conversionBody({ conditionsVersion: 2 }),
      estadoInventado: conversionBody({
        merchantConfirmation: {
          ...confirmation(),
          goodsPaymentStatus: 'PENDING',
        },
      }),
      referenciaVacia: conversionBody({
        merchantConfirmation: {
          ...confirmation(),
          goodsPaymentReference: '   ',
        },
      }),
      referenciaLarga: conversionBody({
        merchantConfirmation: {
          ...confirmation(),
          orderAcceptanceReference: 'x'.repeat(101),
        },
      }),
      fechaSinZona: conversionBody({
        merchantConfirmation: {
          ...confirmation(),
          orderAcceptedAt: '2026-09-28T04:49:10',
        },
      }),
      fechaInvalida: conversionBody({
        merchantConfirmation: {
          ...confirmation(),
          goodsPaymentConfirmedAt: 'ayer',
        },
      }),
      fechaFutura: conversionBody({
        merchantConfirmation: {
          ...confirmation(),
          orderAcceptedAt: new Date(Date.now() + 3_600_000).toISOString(),
        },
      }),
      cobroAjeno: conversionBody({
        deliveryCollectionInstruction: {
          payer: 'SENDER',
          method: 'CASH',
          dueAt: 'DELIVERY',
          components: ['DELIVERY_FEE'],
        },
      }),
      componenteAjeno: conversionBody({
        deliveryCollectionInstruction: {
          payer: 'RECIPIENT',
          method: 'CASH',
          dueAt: 'DELIVERY',
          components: ['GOODS'],
        },
      }),
      importeDeCobro: conversionBody({
        deliveryCollectionInstruction: {
          payer: 'RECIPIENT',
          method: 'CASH',
          dueAt: 'DELIVERY',
          components: ['DELIVERY_FEE'],
          amount: '31.50',
        },
      }),
    };
    const observed: Record<string, number> = {};
    for (const [name, body] of Object.entries(cases))
      observed[name] = (
        await convert(prequote.publicId, body as object, key(`invalid-${name}`))
      ).status;
    for (const [name, status] of Object.entries(observed))
      expect([name, status]).toEqual([name, 400]);
    // Ninguna key, conversión ni solicitud nació de un cuerpo inválido.
    expect({
      conversions: await p.prequoteConversion.count(),
      records: await p.apiIdempotencyRecord.count(),
      requests: await p.deliveryRequest.count(),
    }).toEqual(before);
    note(
      '§3',
      'validación anidada estricta',
      `${Object.keys(cases).length} cuerpos inválidos rechazados con 400 antes de crear la key`,
      Object.keys(cases).join(', '),
    );
  }, 180000);

  it('exige PREPAID, MXN, FOOD y LOCAL_DELIVERY y trata goodsValue como opcional', async () => {
    const rejected: Record<string, number> = {};
    for (const [name, body] of Object.entries({
      cobroContraEntrega: conversionBody({
        deliveryRequest: {
          ...conversionBody().deliveryRequest,
          financialContext: {
            goodsPaymentMode: 'COURIER_ADVANCE',
            goodsValue: '150.00',
            currency: 'MXN',
          },
        },
      }),
      monedaAjena: conversionBody({
        deliveryRequest: {
          ...conversionBody().deliveryRequest,
          financialContext: {
            goodsPaymentMode: 'PREPAID',
            goodsValue: '150.00',
            currency: 'USD',
          },
        },
      }),
      categoriaAjena: conversionBody({
        deliveryRequest: {
          ...conversionBody().deliveryRequest,
          packages: [
            {
              category: 'DOCUMENTS',
              description: 'No comida',
              quantity: 1,
              weightKg: null,
              lengthCm: null,
              widthCm: null,
              heightCm: null,
              isFragile: false,
              handlingInstructions: null,
            },
          ],
        },
      }),
      importeNegativo: conversionBody({
        deliveryRequest: {
          ...conversionBody().deliveryRequest,
          financialContext: {
            goodsPaymentMode: 'PREPAID',
            goodsValue: '-1.00',
            currency: 'MXN',
          },
        },
      }),
    })) {
      const prequote = await freshPrequote(0);
      rejected[name] = (
        await convert(prequote.publicId, body as object, key(`ctx-${name}`))
      ).status;
    }
    expect(rejected).toEqual({
      cobroContraEntrega: 400,
      monedaAjena: 400,
      categoriaAjena: 400,
      importeNegativo: 400,
    });

    // goodsValue omitido y null son válidos y se distinguen del envío.
    const accepted: Record<string, number> = {};
    for (const [name, financialContext] of Object.entries({
      omitido: { goodsPaymentMode: 'PREPAID', currency: 'MXN' },
      nulo: { goodsPaymentMode: 'PREPAID', goodsValue: null, currency: 'MXN' },
      positivo: {
        goodsPaymentMode: 'PREPAID',
        goodsValue: '99.99',
        currency: 'MXN',
      },
    })) {
      const prequote = await freshPrequote(0);
      const base = conversionBody();
      const response = await convert(
        prequote.publicId,
        {
          ...base,
          deliveryRequest: { ...base.deliveryRequest, financialContext },
        },
        key(`goods-${name}`),
      );
      accepted[name] = response.status;
      if (response.status === 201) {
        const context = await p.deliveryFinancialContext.findFirstOrThrow({
          where: {
            deliveryRequest: {
              publicId: response.body.deliveryRequestPublicId,
            },
          },
        });
        // El importe de mercancía nunca se mezcla con el de envío.
        expect(context.goodsValue?.toFixed(2) ?? null).toBe(
          name === 'positivo' ? '99.99' : null,
        );
        expect(response.body.quote.amount).not.toBe('99.99');
      }
    }
    expect(accepted).toEqual({ omitido: 201, nulo: 201, positivo: 201 });
    note(
      '§3',
      'contexto financiero restringido',
      'COURIER_ADVANCE, USD, categoría distinta de FOOD e importe negativo → 400',
      'goodsValue omitido/null/positivo aceptados; el importe de mercancía no se suma al envío',
    );
  }, 300000);

  it('no expone confirmaciones, manifiesto, UUID internos ni proveedor de routing', async () => {
    const prequote = await freshPrequote(0);
    const body = conversionBody();
    const created = await convert(
      prequote.publicId,
      body,
      key('privacy'),
    ).expect(201);
    const conversion = await p.prequoteConversion.findFirstOrThrow({
      where: {
        deliveryRequest: { publicId: created.body.deliveryRequestPublicId },
      },
    });
    const surfaces = {
      conversion: created.body,
      prequote: (await readPrequote(prequote.publicId).expect(200)).body,
      request: (
        await api()
          .get(
            `/api/v1/delivery-requests/${created.body.deliveryRequestPublicId}`,
          )
          .auth(tokens[0], bearer)
          .expect(200)
      ).body,
      quote: (
        await api()
          .get(`/api/v1/delivery-quotes/${created.body.quote.publicId}`)
          .auth(tokens[0], bearer)
          .expect(200)
      ).body,
    };
    const secretsInResponses = [
      body.merchantConfirmation.goodsPaymentReference,
      body.merchantConfirmation.orderAcceptanceReference,
      conversion.id,
      conversion.prequoteId,
      conversion.deliveryRequestId,
      conversion.deliveryQuoteId,
      conversion.idempotencyRecordId,
      ...conversion.stopIds,
      ...conversion.packageIds,
      conversion.financialContextId,
      'b4-controlled',
    ];
    const leaks: string[] = [];
    for (const [name, value] of Object.entries(surfaces)) {
      const text = JSON.stringify(value);
      for (const needle of secretsInResponses)
        if (text.includes(String(needle))) leaks.push(`${name}:${needle}`);
      for (const field of [
        'stopIds',
        'packageIds',
        'financialContextId',
        'goodsPaymentReference',
        'orderAcceptanceReference',
        'idempotencyRecordId',
        'routingProvider',
        'ratePlanId',
        'rateBandId',
        'prequoteConversion',
      ])
        if (text.includes(field)) leaks.push(`${name}:campo ${field}`);
    }
    // Y tampoco en los registros de la aplicación.
    const written = logs.join('\n');
    for (const needle of [
      body.merchantConfirmation.goodsPaymentReference,
      body.merchantConfirmation.orderAcceptanceReference,
      ...conversion.stopIds,
      tokens[0],
      secrets[0],
    ])
      if (written.includes(String(needle))) leaks.push(`logs:${needle}`);
    expect(leaks).toEqual([]);
    // Las proyecciones son explícitas: sólo los campos publicados.
    expect(Object.keys(created.body).sort()).toEqual([
      'availabilityGuaranteed',
      'convertedAt',
      'deliveryCollectionInstruction',
      'deliveryRequestPublicId',
      'deliveryRequestStatus',
      'externalReference',
      'prequotePublicId',
      'quote',
    ]);
    note(
      '§3',
      'referencias opacas y proyecciones explícitas',
      `${Object.keys(surfaces).length} superficies y los logs revisados: 0 fugas`,
      'sin manifiesto, confirmaciones, UUID internos, proveedor de routing ni relación cruda',
    );
  }, 180000);

  it('con el flag apagado no nacen conversiones nuevas y el replay autorizado sigue disponible', async () => {
    const prequote = await freshPrequote(0);
    const body = conversionBody();
    const k = key('flag');
    const created = await convert(prequote.publicId, body, k).expect(201);
    const counts = {
      conversions: await p.prequoteConversion.count(),
      requests: await p.deliveryRequest.count(),
      quotes: await p.deliveryQuote.count(),
    };
    applyConfig(false);
    try {
      const fresh = await freshPrequote(0);
      const blocked = await convert(
        fresh.publicId,
        conversionBody(),
        key('off'),
      );
      expect([blocked.status, blocked.body.code]).toEqual([
        503,
        'PREQUOTE_CONVERSION_DISABLED',
      ]);
      // El replay autorizado no depende del flag.
      const replay = await convert(prequote.publicId, body, k).expect(200);
      expect(replay.body.deliveryRequestPublicId).toBe(
        created.body.deliveryRequestPublicId,
      );
      expect({
        conversions: await p.prequoteConversion.count(),
        requests: await p.deliveryRequest.count(),
        quotes: await p.deliveryQuote.count(),
      }).toEqual(counts);
    } finally {
      applyConfig(true);
    }
    note(
      '§3',
      'flag independiente de conversión',
      'apagado: nuevas conversiones 503 PREQUOTE_CONVERSION_DISABLED y ningún recurso creado',
      'el replay de una conversión existente sigue devolviendo 200 con sus mismos vínculos',
    );
  }, 180000);
});

describe('CHECK B4 §4 concurrencia, idempotencia y recuperación con dos instancias', () => {
  it('la misma key y cuerpo en dos instancias dejan un solo ganador', async () => {
    const prequote = await freshPrequote(0);
    const body = conversionBody();
    const k = key('race-same');
    const [a, b] = await Promise.all([
      convert(prequote.publicId, body, k, 0),
      convert(prequote.publicId, body, k, 1),
    ]);
    // Una crea y la otra recupera, o espera y recupera: nunca dos resultados distintos.
    const statuses = [a.status, b.status];
    expect([...statuses].sort()).toEqual([200, 201]);
    expect(a.body.deliveryRequestPublicId).toBe(b.body.deliveryRequestPublicId);
    expect(a.body.quote.publicId).toBe(b.body.quote.publicId);
    const winner = a.status === 201 ? a : b;
    const stored = await p.deliveryPrequote.findUniqueOrThrow({
      where: { publicId: prequote.publicId },
    });
    expect(
      await p.prequoteConversion.count({ where: { prequoteId: stored.id } }),
    ).toBe(1);
    expect(
      await p.apiIdempotencyRecord.count({
        where: { integrationClientId: clients[0], key: k },
      }),
    ).toBe(1);
    expect(
      await p.deliveryQuote.count({
        where: {
          deliveryRequest: { publicId: winner.body.deliveryRequestPublicId },
        },
      }),
    ).toBe(1);
    note(
      '§4',
      'misma key y cuerpo desde dos instancias',
      `respuestas ${JSON.stringify([a.status, b.status])}: una conversión, una key y una MQ`,
    );
  }, 180000);

  it('la misma key con otro cuerpo, otra MPQ u otra operación entra en conflicto', async () => {
    const prequote = await freshPrequote(0);
    const other = await freshPrequote(0);
    const body = conversionBody();
    const k = key('race-conflict');
    await convert(prequote.publicId, body, k).expect(201);
    const observed = {
      otroCuerpo: (await convert(prequote.publicId, conversionBody(), k))
        .status,
      otraMpq: (await convert(other.publicId, body, k)).status,
      otraOperacion: (
        await api()
          .post('/api/v1/delivery-prequotes')
          .auth(tokens[0], bearer)
          .set('Idempotency-Key', k)
          .send(conditions)
      ).status,
    };
    expect(observed).toEqual({
      otroCuerpo: 409,
      otraMpq: 409,
      otraOperacion: 409,
    });
    // La MPQ ajena a esa key sigue disponible y sin recursos.
    const stored = await p.deliveryPrequote.findUniqueOrThrow({
      where: { publicId: other.publicId },
    });
    expect(
      await p.prequoteConversion.count({ where: { prequoteId: stored.id } }),
    ).toBe(0);
    note(
      '§4',
      'la key pertenece a una intención',
      'cuerpo distinto, MPQ distinta y operación distinta con la misma key: 409 en los tres',
    );
  }, 180000);

  it('varias keys compiten por una MPQ y sólo una persiste', async () => {
    const prequote = await freshPrequote(0);
    const keys = Array.from({ length: 8 }, (_, i) => key(`compete-${i}`));
    const responses = await Promise.all(
      keys.map((k, i) =>
        convert(prequote.publicId, conversionBody(), k, i % 2),
      ),
    );
    const winners = responses.filter((r) => r.status === 201);
    const losers = responses.filter((r) => r.status !== 201);
    expect(winners).toHaveLength(1);
    for (const loser of losers)
      expect([loser.status, loser.body.code]).toEqual([
        409,
        'PREQUOTE_ALREADY_CONVERTED',
      ]);
    const stored = await p.deliveryPrequote.findUniqueOrThrow({
      where: { publicId: prequote.publicId },
    });
    expect(
      await p.prequoteConversion.count({ where: { prequoteId: stored.id } }),
    ).toBe(1);
    // Sólo la key ganadora quedó persistida; las perdedoras no dejan huérfanas.
    const records = await p.apiIdempotencyRecord.findMany({
      where: { integrationClientId: { in: clients }, key: { in: keys } },
      select: { key: true, resourceId: true },
    });
    expect(records).toHaveLength(1);
    expect(
      await p.prequoteConversion.count({
        where: { id: records[0].resourceId },
      }),
    ).toBe(1);
    note(
      '§4',
      'ocho keys sobre una MPQ',
      `un 201 y ${losers.length} conflictos; una sola key persistida y sin huérfanas`,
      `códigos: ${JSON.stringify(responses.map((r) => r.status))}`,
    );
  }, 300000);

  it('el mismo texto de key en dos integraciones son intenciones independientes', async () => {
    const shared = key('namespace');
    const mine = await freshPrequote(0);
    const theirs = await freshPrequote(1);
    const [a, b] = await Promise.all([
      convert(mine.publicId, conversionBody(), shared, 0, tokens[0]),
      convert(theirs.publicId, conversionBody(), shared, 1, tokens[1]),
    ]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body.deliveryRequestPublicId).not.toBe(
      b.body.deliveryRequestPublicId,
    );
    expect(await p.apiIdempotencyRecord.count({ where: { key: shared } })).toBe(
      2,
    );
    for (const [i, response] of [a, b].entries())
      expect(
        await p.prequoteConversion.count({
          where: {
            integrationClientId: clients[i],
            deliveryRequest: {
              publicId: response.body.deliveryRequestPublicId,
            },
          },
        }),
      ).toBe(1);
    note(
      '§4',
      'namespace por integración',
      'el mismo texto de key en dos integraciones produce dos resultados propios',
    );
  }, 180000);

  it('una respuesta perdida después del commit se recupera sin duplicar', async () => {
    const prequote = await freshPrequote(0);
    const body = conversionBody();
    const k = key('lost');
    const service = apps[0].get(
      (
        await import('../dist/delivery-prequotes/prequote-conversion.service.js')
      ).PrequoteConversionService,
    ) as { load?: unknown };
    // Se rompe exclusivamente la carga de la respuesta, después de que la transacción comprometió.
    const original = Reflect.get(service, 'load') as (
      ...a: unknown[]
    ) => unknown;
    let broken = true;
    Reflect.set(
      service,
      'load',
      async function (this: unknown, ...args: unknown[]) {
        if (broken) {
          broken = false;
          throw Error('B4: pérdida simulada de la respuesta tras el commit');
        }
        return original.apply(this, args);
      },
    );
    let lost: number;
    try {
      lost = (await convert(prequote.publicId, body, k, 0)).status;
    } finally {
      Reflect.set(service, 'load', original);
    }
    expect(lost).toBe(500);
    // El resultado quedó comprometido: la otra instancia lo recupera por replay.
    const recovered = await convert(prequote.publicId, body, k, 1).expect(200);
    expect(recovered.headers['idempotent-replayed']).toBe('true');
    const stored = await p.deliveryPrequote.findUniqueOrThrow({
      where: { publicId: prequote.publicId },
    });
    expect(
      await p.prequoteConversion.count({ where: { prequoteId: stored.id } }),
    ).toBe(1);
    expect(
      await p.deliveryRequest.count({
        where: { publicId: recovered.body.deliveryRequestPublicId },
      }),
    ).toBe(1);
    note(
      '§4',
      'respuesta perdida después del commit',
      'el fallo se induce sólo en la carga de la respuesta: 500 y un resultado ya durable',
      'la otra instancia recupera el mismo ganador por replay, sin duplicar recursos',
      'no se afirma un corte TCP real',
    );
  }, 180000);

  it('la cancelación concurrente y las lecturas dan pares coherentes', async () => {
    const prequote = await freshPrequote(0);
    const body = conversionBody();
    const k = key('cancel-race');
    const created = await convert(prequote.publicId, body, k).expect(201);
    const [cancel, replay, read] = await Promise.all([
      api(0)
        .post(
          `/api/v1/delivery-requests/${created.body.deliveryRequestPublicId}/cancel`,
        )
        .auth(tokens[0], bearer)
        .send({ reason: 'B4 concurrente' }),
      convert(prequote.publicId, body, k, 1),
      readPrequote(prequote.publicId, 1),
    ]);
    expect(cancel.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(read.status).toBe(200);
    // Cada lectura es coherente consigo misma: nunca una MDR cancelada con su MQ ofertada.
    const pair = [replay.body.deliveryRequestStatus, replay.body.quote.status];
    expect([
      JSON.stringify(['CREATED', 'OFFERED']),
      JSON.stringify(['CANCELLED', 'CANCELLED']),
    ]).toContain(JSON.stringify(pair));
    expect(read.body.status).toBe('CONVERTED');
    const final = await convert(prequote.publicId, body, k).expect(200);
    expect(final.body.deliveryRequestStatus).toBe('CANCELLED');
    expect(final.body.quote.status).toBe('CANCELLED');
    // Y la MPQ sigue consumida: otra key no la recupera.
    expect(
      (await convert(prequote.publicId, conversionBody(), key('after-cancel')))
        .body.code,
    ).toBe('PREQUOTE_ALREADY_CONVERTED');
    note(
      '§4',
      'cancelación y lecturas concurrentes',
      `par observado ${JSON.stringify(pair)}; nunca una combinación imposible`,
      'la MPQ queda consumida de forma permanente aun cancelada',
    );
  }, 180000);
});

/**
 * Crea una zona aislada con su plan ACTIVE y devuelve las condiciones que caen dentro de ella.
 * Sirve para los casos que retiran una tarifa: un plan INACTIVE no puede volver a ACTIVE, así que
 * no deben tocar la zona compartida del fixture.
 */
async function isolatedZone(amount: string, lngBase: number) {
  const base = 40 + randomInt(0, 100000) / 10000;
  const top = Number((base + 0.00001).toFixed(6));
  const zone = await p.serviceZone.create({
    data: {
      code: `B4Z_${run}_${lngBase}`,
      name: `B4 zona aislada ${lngBase}`,
      status: 'ACTIVE',
      currency: 'MXN',
      boundary: {
        type: 'Polygon',
        coordinates: [
          [
            [lngBase, base],
            [lngBase + 0.00001, base],
            [lngBase + 0.00001, top],
            [lngBase, top],
            [lngBase, base],
          ],
        ],
      },
      minLatitude: base,
      maxLatitude: top,
      minLongitude: lngBase,
      maxLongitude: lngBase + 0.00001,
    },
  });
  const plan = await p.ratePlan.create({
    data: {
      serviceZoneId: zone.id,
      serviceType: 'LOCAL_DELIVERY',
      version: 1,
      status: 'DRAFT',
      quoteValidityMinutes: 15,
      currency: 'MXN',
      bands: {
        create: {
          minDistanceMeters: 0,
          maxDistanceMeters: 10000,
          amount,
          currency: 'MXN',
        },
      },
    },
  });
  await p.ratePlan.update({
    where: { id: plan.id },
    data: { status: 'ACTIVE', activatedAt: new Date() },
  });
  const inside = {
    conditionsVersion: 1,
    serviceType: 'LOCAL_DELIVERY',
    stops: [
      {
        type: 'PICKUP',
        sequence: 1,
        latitude: Number((base + 0.000002).toFixed(6)),
        longitude: Number((lngBase + 0.000002).toFixed(6)),
      },
      {
        type: 'DROPOFF',
        sequence: 2,
        latitude: Number((base + 0.000008).toFixed(6)),
        longitude: Number((lngBase + 0.000008).toFixed(6)),
      },
    ],
    packages: [{ category: 'FOOD', quantity: 1 }],
  };
  return { zoneId: zone.id, planId: plan.id, conditions: inside };
}

describe('CHECK B4 §5 snapshot, tiempo y límite SQL', () => {
  it('una tarifa reemplazada o inactivada no reprecifica la conversión', async () => {
    // Zona y plan propios: retirar una tarifa es irreversible, así que este caso no toca la zona
    // compartida del fixture.
    const own = await isolatedZone('31.50', 66);
    const issued = await api()
      .post('/api/v1/delivery-prequotes')
      .auth(tokens[0], bearer)
      .set('Idempotency-Key', key('rate-issue'))
      .send(own.conditions)
      .expect(201);
    const stored = await p.deliveryPrequote.findUniqueOrThrow({
      where: { publicId: issued.body.publicId },
    });
    expect(stored.amount.toFixed(2)).toBe('31.50');

    // La tarifa vigente se retira y otra la reemplaza con un importe distinto.
    await p.ratePlan.update({
      where: { id: own.planId },
      data: { status: 'INACTIVE', deactivatedAt: new Date() },
    });
    const replacement = await p.ratePlan.create({
      data: {
        serviceZoneId: own.zoneId,
        serviceType: 'LOCAL_DELIVERY',
        version: 2,
        status: 'DRAFT',
        quoteValidityMinutes: 15,
        currency: 'MXN',
        bands: {
          create: {
            minDistanceMeters: 0,
            maxDistanceMeters: 10000,
            amount: '999.00',
            currency: 'MXN',
          },
        },
      },
    });
    await p.ratePlan.update({
      where: { id: replacement.id },
      data: { status: 'ACTIVE', activatedAt: new Date() },
    });

    const base = conversionBody();
    const created = await convert(
      issued.body.publicId,
      {
        ...base,
        deliveryRequest: {
          ...base.deliveryRequest,
          stops: own.conditions.stops.map((stop) => ({
            ...stop,
            address: `Sintética tarifa ${stop.sequence}`,
            contactName: 'Contacto de prueba',
            contactPhone: '0000000000',
            instructions: null,
          })),
        },
      },
      key('rate'),
    ).expect(201);
    // El precio y las referencias siguen siendo los de la MPQ, no los de la tarifa nueva.
    expect(created.body.quote.amount).toBe('31.50');
    expect(created.body.quote.amount).not.toBe('999.00');
    const quote = await p.deliveryQuote.findUniqueOrThrow({
      where: { publicId: created.body.quote.publicId },
    });
    expect(quote.ratePlanId).toBe(stored.ratePlanId);
    expect(quote.rateBandId).toBe(stored.rateBandId);
    expect(quote.ratePlanId).toBe(own.planId);
    expect(quote.ratePlanId).not.toBe(replacement.id);
    note(
      '§5',
      'tarifa reemplazada o inactivada no reprecifica',
      'la tarifa vigente se retira y otra de 999.00 la reemplaza antes de convertir',
      `importe conservado ${created.body.quote.amount}; plan y banda siguen siendo los de la MPQ`,
    );
  }, 180000);

  it('la metadata de zona queda congelada en la proyección convertida', async () => {
    const prequote = await freshPrequote(0);
    const stored = await p.deliveryPrequote.findUniqueOrThrow({
      where: { publicId: prequote.publicId },
    });
    const created = await convert(
      prequote.publicId,
      conversionBody(),
      key('zone-meta'),
    ).expect(201);
    expect(created.body.quote.serviceZone).toEqual({
      code: stored.zoneCode,
      name: stored.zoneName,
    });
    // La zona cambia de nombre y código después de convertir.
    await p.serviceZone.update({
      where: { id: zoneId },
      data: { code: `B4_${run}_MOVED`, name: 'Zona renombrada' },
    });
    try {
      const quoteView = await api()
        .get(`/api/v1/delivery-quotes/${created.body.quote.publicId}`)
        .auth(tokens[0], bearer)
        .expect(200);
      // La evidencia original se conserva: no se lee el join mutable.
      expect(quoteView.body.serviceZone).toEqual({
        code: stored.zoneCode,
        name: stored.zoneName,
      });
      const prequoteView = await readPrequote(prequote.publicId).expect(200);
      expect(prequoteView.body.serviceZone).toEqual({
        code: stored.zoneCode,
        name: stored.zoneName,
      });
      note(
        '§5',
        'metadata congelada en proyecciones convertidas',
        'renombrar zona y cambiar su código no altera lo que publican MQ convertida ni MPQ',
      );
    } finally {
      await p.serviceZone.update({
        where: { id: zoneId },
        data: { code: `B4_${run}`, name: 'B4 zone' },
      });
    }
  }, 180000);

  it('una zona INACTIVE bloquea una conversión nueva pero no el replay', async () => {
    const converted = await freshPrequote(0);
    const body = conversionBody();
    const k = key('zone-inactive');
    const created = await convert(converted.publicId, body, k).expect(201);
    const pending = await freshPrequote(0);
    await p.serviceZone.update({
      where: { id: zoneId },
      data: { status: 'INACTIVE' },
    });
    try {
      const blocked = await convert(
        pending.publicId,
        conversionBody(),
        key('inactive'),
      );
      expect([blocked.status, blocked.body.code]).toEqual([
        409,
        'PREQUOTE_SERVICE_UNAVAILABLE',
      ]);
      const stored = await p.deliveryPrequote.findUniqueOrThrow({
        where: { publicId: pending.publicId },
      });
      expect(
        await p.prequoteConversion.count({ where: { prequoteId: stored.id } }),
      ).toBe(0);
      // El replay de una conversión ya existente no vuelve a evaluar la zona.
      const replay = await convert(converted.publicId, body, k).expect(200);
      expect(replay.body.deliveryRequestPublicId).toBe(
        created.body.deliveryRequestPublicId,
      );
      note(
        '§5',
        'zona INACTIVE',
        'bloquea una conversión nueva con 409 PREQUOTE_SERVICE_UNAVAILABLE y no crea nada',
        'el replay autorizado sigue devolviendo su mismo resultado',
      );
    } finally {
      await p.serviceZone.update({
        where: { id: zoneId },
        data: { status: 'ACTIVE' },
      });
    }
  }, 180000);

  it('ni un escritor directo puede mover el vencimiento de una MPQ', async () => {
    const prequote = await freshPrequote(0);
    const stored = await p.deliveryPrequote.findUniqueOrThrow({
      where: { publicId: prequote.publicId },
    });
    const attempts: Record<string, string> = {};
    for (const [name, sql] of [
      [
        'acortar',
        `UPDATE "DeliveryPrequote" SET "expiresAt" = (now() AT TIME ZONE 'UTC') - interval '1 second' WHERE id = '${stored.id}'::uuid`,
      ],
      [
        'ampliar',
        `UPDATE "DeliveryPrequote" SET "expiresAt" = "expiresAt" + interval '1 day' WHERE id = '${stored.id}'::uuid`,
      ],
      [
        'borrar',
        `DELETE FROM "DeliveryPrequote" WHERE id = '${stored.id}'::uuid`,
      ],
    ] as [string, string][])
      attempts[name] = await p.$executeRawUnsafe(sql).then(
        () => 'ACEPTADO',
        (error: unknown) =>
          (/ERROR: ([A-Z0-9_]+)/.exec(String((error as Error).message)) ?? [
            '',
            'RECHAZADO',
          ])[1],
      );
    expect(attempts).toEqual({
      acortar: 'PREQUOTE_IMMUTABLE',
      ampliar: 'PREQUOTE_IMMUTABLE',
      borrar: 'PREQUOTE_IMMUTABLE',
    });
    expect(
      (
        await p.deliveryPrequote.findUniqueOrThrow({ where: { id: stored.id } })
      ).expiresAt.toISOString(),
    ).toBe(stored.expiresAt.toISOString());
    note(
      '§5',
      'el vencimiento de una MPQ es inmutable incluso en SQL',
      'acortar, ampliar y borrar rechazados con PREQUOTE_IMMUTABLE; expiresAt sin cambio',
      'por eso la frontera temporal se prueba acortando la vigencia por configuración antes de emitir',
    );
  }, 120000);

  it('antes del vencimiento convierte y después lo rechaza sin renovar el expiry', async () => {
    const valid = await freshPrequote(0);
    await convert(valid.publicId, conversionBody(), key('before')).expect(201);

    // Vigencia mínima por configuración: es el único camino legítimo para acortarla.
    for (const config of configs) config.set('PREQUOTE_VALIDITY_MS', 1200);
    try {
      const short = await freshPrequote(0);
      const stored = await p.deliveryPrequote.findUniqueOrThrow({
        where: { publicId: short.publicId },
      });
      // Espera real breve hasta pasar el vencimiento, medida contra el reloj de la base.
      const [{ ms }] = await p.$queryRawUnsafe<{ ms: number }[]>(
        `SELECT greatest(0, extract(epoch from ("expiresAt" - (clock_timestamp() AT TIME ZONE 'UTC'))) * 1000 + 250)::float8 AS ms FROM "DeliveryPrequote" WHERE id = '${stored.id}'::uuid`,
      );
      await new Promise((r) => setTimeout(r, Math.ceil(ms)));
      const rejected = await convert(
        short.publicId,
        conversionBody(),
        key('after'),
      );
      expect([rejected.status, rejected.body.code]).toEqual([
        409,
        'PREQUOTE_EXPIRED',
      ]);
      // Ni conversión, ni MDR, ni key, ni expiry renovado.
      expect(
        await p.prequoteConversion.count({ where: { prequoteId: stored.id } }),
      ).toBe(0);
      expect(
        (
          await p.deliveryPrequote.findUniqueOrThrow({
            where: { id: stored.id },
          })
        ).expiresAt.toISOString(),
      ).toBe(stored.expiresAt.toISOString());
      expect(
        await p.apiIdempotencyRecord.count({
          where: {
            integrationClientId: clients[0],
            key: { startsWith: 'b4-after' },
          },
        }),
      ).toBe(0);
      // Y la proyección pública la reporta vencida, no convertida.
      expect((await readPrequote(short.publicId).expect(200)).body.status).toBe(
        'EXPIRED',
      );
      note(
        '§5',
        'frontera de vencimiento por HTTP',
        'antes convierte; después 409 PREQUOTE_EXPIRED sin crear recursos ni renovar expiresAt',
        'la vigencia se acorta por configuración antes de emitir; no se manipulan relojes ni filas',
      );
    } finally {
      for (const config of configs) config.set('PREQUOTE_VALIDITY_MS', 900000);
    }
  }, 180000);

  it('una espera de lock que cruza el vencimiento termina en rechazo y rollback', async () => {
    for (const config of configs) config.set('PREQUOTE_VALIDITY_MS', 1500);
    let storedId = '';
    try {
      const prequote = await freshPrequote(0);
      const stored = await p.deliveryPrequote.findUniqueOrThrow({
        where: { publicId: prequote.publicId },
      });
      storedId = stored.id;
      // Otra sesión retiene la fila más que la vigencia: la conversión espera el lock real y, al
      // obtenerlo, el reloj de la base ya pasó el vencimiento.
      const holder = p.$transaction(
        async (tx) => {
          await tx.$queryRawUnsafe(
            `SELECT id FROM "DeliveryPrequote" WHERE id = '${stored.id}'::uuid FOR UPDATE`,
          );
          await tx.$queryRawUnsafe(`SELECT pg_sleep(2.6)::text`);
        },
        { timeout: 30000 },
      );
      await new Promise((r) => setTimeout(r, 120));
      const attempt = convert(
        prequote.publicId,
        conversionBody(),
        key('lock-cross'),
      );
      const [, blocked] = await Promise.all([holder, attempt]);
      expect([blocked.status, blocked.body.code]).toEqual([
        409,
        'PREQUOTE_EXPIRED',
      ]);
      expect(
        await p.prequoteConversion.count({ where: { prequoteId: stored.id } }),
      ).toBe(0);
      expect(
        await p.apiIdempotencyRecord.count({
          where: {
            integrationClientId: clients[0],
            key: { startsWith: 'b4-lock-cross' },
          },
        }),
      ).toBe(0);
      note(
        '§5',
        'cruce del vencimiento durante la espera de lock',
        'la conversión espera un lock real de 2,6 s sobre una MPQ de 1,5 s de vigencia',
        'al obtenerlo responde 409 PREQUOTE_EXPIRED con rollback completo: sin conversión y sin key',
      );
    } finally {
      for (const config of configs) config.set('PREQUOTE_VALIDITY_MS', 900000);
      if (storedId)
        expect(
          await p.prequoteConversion.count({ where: { prequoteId: storedId } }),
        ).toBe(0);
    }
  }, 180000);
});

describe('CHECK B4 §6 catálogo, guardas y límite temporal del escritor directo', () => {
  it('las guardas de integridad y las FKs diferidas están activas en el catálogo', async () => {
    const triggers = await p.$queryRawUnsafe<
      { tgname: string; relname: string; tgenabled: string }[]
    >(`SELECT t.tgname, c.relname, t.tgenabled FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
        WHERE NOT t.tgisinternal
          AND c.relname IN ('DeliveryPrequote','PrequoteConversion','DeliveryRequest',
                            'DeliveryQuote','DeliveryStop','DeliveryPackage',
                            'DeliveryFinancialContext','Dispatch','ApiIdempotencyRecord')
        ORDER BY c.relname, t.tgname`);
    expect(triggers.length).toBeGreaterThan(0);
    // Ninguna guarda deshabilitada y ningún trigger de fallo dejado por una prueba.
    expect(triggers.filter((t) => t.tgenabled !== 'O')).toEqual([]);
    expect(
      triggers.filter((t) => /fault|fail|b2_|b3_|b4_/i.test(t.tgname)),
    ).toEqual([]);
    const deferred = await p.$queryRawUnsafe<
      { conname: string; condeferred: boolean }[]
    >(`SELECT conname, condeferred FROM pg_constraint
        WHERE conrelid = '"PrequoteConversion"'::regclass AND contype = 'f'
          AND condeferrable = true ORDER BY conname`);
    // Las FKs de MDR y MQ deben ser diferidas para que el origen se inserte primero.
    expect(deferred.length).toBeGreaterThanOrEqual(2);
    expect(deferred.every((d) => d.condeferred)).toBe(true);
    note(
      '§6',
      'catálogo de guardas',
      `${triggers.length} triggers de integridad activos en 9 tablas, ninguno deshabilitado`,
      `${deferred.length} FKs DEFERRABLE INITIALLY DEFERRED en PrequoteConversion`,
      'sin triggers de fallo residuales de B2/B3/B4',
    );
  }, 120000);

  it('un escritor directo no puede reutilizar, reprecificar, adoptar hijos ni despachar', async () => {
    const prequote = await freshPrequote(0);
    const created = await convert(
      prequote.publicId,
      conversionBody(),
      key('sql'),
    ).expect(201);
    const stored = await p.deliveryPrequote.findUniqueOrThrow({
      where: { publicId: prequote.publicId },
    });
    const conversion = await p.prequoteConversion.findUniqueOrThrow({
      where: { prequoteId: stored.id },
    });
    const quote = await p.deliveryQuote.findUniqueOrThrow({
      where: { publicId: created.body.quote.publicId },
    });
    const rejection = (work: Promise<unknown>) =>
      work.then(
        () => 'ACEPTADO',
        (error: unknown) => {
          const failure = error as { code?: string; meta?: { code?: string } };
          if (failure.code !== 'P2010' || failure.meta?.code !== 'P0001')
            return 'UNEXPECTED_SQL_ERROR';
          const message = String((error as Error).message);
          const match = /ERROR: ([A-Z0-9_]+)/.exec(message);
          return match ? match[1] : 'RECHAZADO';
        },
      );
    const attacks: Record<string, string> = {};
    const cases: [string, string][] = [
      [
        'segunda conversión con key de resultado anterior (key incompatible)',
        `INSERT INTO "PrequoteConversion" ("id","prequoteId","deliveryRequestId","deliveryQuoteId","idempotencyRecordId","integrationClientId","goodsPaymentStatus","goodsPaymentReference","goodsPaymentConfirmedAt","orderAcceptanceStatus","orderAcceptanceReference","orderAcceptedAt","collectionPayer","collectionMethod","collectionDueAt","collectionComponent","stopIds","packageIds","financialContextId") SELECT gen_random_uuid(),"prequoteId",gen_random_uuid(),gen_random_uuid(),"idempotencyRecordId","integrationClientId","goodsPaymentStatus","goodsPaymentReference","goodsPaymentConfirmedAt","orderAcceptanceStatus","orderAcceptanceReference","orderAcceptedAt","collectionPayer","collectionMethod","collectionDueAt","collectionComponent","stopIds","packageIds","financialContextId" FROM "PrequoteConversion" WHERE id='${conversion.id}'::uuid`,
      ],
      [
        'mover la conversión a otro dueño',
        `UPDATE "PrequoteConversion" SET "integrationClientId"='${clients[1]}'::uuid WHERE id='${conversion.id}'::uuid`,
      ],
      [
        'reescribir el manifiesto',
        `UPDATE "PrequoteConversion" SET "stopIds"=ARRAY[gen_random_uuid()]::uuid[] WHERE id='${conversion.id}'::uuid`,
      ],
      [
        'adelantar convertedAt',
        `UPDATE "PrequoteConversion" SET "convertedAt"="convertedAt" - interval '1 day' WHERE id='${conversion.id}'::uuid`,
      ],
      [
        'borrar la conversión',
        `DELETE FROM "PrequoteConversion" WHERE id='${conversion.id}'::uuid`,
      ],
      [
        'modificar la MPQ consumida',
        `UPDATE "DeliveryPrequote" SET "amount"='1.00' WHERE id='${stored.id}'::uuid`,
      ],
      [
        'borrar la MPQ consumida',
        `DELETE FROM "DeliveryPrequote" WHERE id='${stored.id}'::uuid`,
      ],
      [
        'reprecificar la MQ convertida',
        `UPDATE "DeliveryQuote" SET "amount"='1.00' WHERE id='${quote.id}'::uuid`,
      ],
      [
        'ampliar el expiry de la MQ convertida',
        `UPDATE "DeliveryQuote" SET "expiresAt"="expiresAt" + interval '1 day' WHERE id='${quote.id}'::uuid`,
      ],
      [
        'forjar ACCEPTED sin autorización',
        `UPDATE "DeliveryQuote" SET "status"='ACCEPTED', "acceptedAt"=now() WHERE id='${quote.id}'::uuid`,
      ],
      [
        'segunda MQ para la MDR convertida',
        `INSERT INTO "DeliveryQuote" ("id","publicId","deliveryRequestId","serviceType","serviceZoneId","ratePlanId","rateBandId","distanceMeters","durationSeconds","amount","currency","routingProvider","routeCalculatedAt","expiresAt") SELECT gen_random_uuid(),'MQ-999901',"deliveryRequestId","serviceType","serviceZoneId","ratePlanId","rateBandId","distanceMeters","durationSeconds","amount","currency","routingProvider","routeCalculatedAt","expiresAt" FROM "DeliveryQuote" WHERE id='${quote.id}'::uuid`,
      ],
      [
        'hijo extra después del commit',
        `INSERT INTO "DeliveryStop" ("id","deliveryRequestId","type","sequence","address","latitude","longitude") VALUES (gen_random_uuid(),'${conversion.deliveryRequestId}'::uuid,'DROPOFF',3,'Intruso',${conditions.stops[1].latitude},${conditions.stops[1].longitude})`,
      ],
      [
        'reparentar un hijo autorizado',
        `UPDATE "DeliveryStop" SET "deliveryRequestId"=gen_random_uuid() WHERE id='${conversion.stopIds[0]}'::uuid`,
      ],
      [
        'borrar el contexto financiero',
        `DELETE FROM "DeliveryFinancialContext" WHERE id='${conversion.financialContextId}'::uuid`,
      ],
      [
        'abrir Dispatch para la MQ convertida',
        `INSERT INTO "Dispatch" ("id","deliveryRequestId","deliveryQuoteId","status","openedAt","expiresAt","updatedAt") VALUES (gen_random_uuid(),'${conversion.deliveryRequestId}'::uuid,'${quote.id}'::uuid,'OPEN',now(),now() + interval '10 minutes',now())`,
      ],
      [
        'dejar la key huérfana',
        `UPDATE "ApiIdempotencyRecord" SET "resourceId"=NULL WHERE id='${conversion.idempotencyRecordId}'::uuid`,
      ],
    ];
    for (const [name, sql] of cases)
      attacks[name] = await rejection(p.$executeRawUnsafe(sql));
    const expectedCodes = [
      'CONVERSION_KEY_INVALID',
      'CONVERSION_IMMUTABLE',
      'CONVERSION_IMMUTABLE',
      'CONVERSION_IMMUTABLE',
      'CONVERSION_IMMUTABLE',
      'PREQUOTE_IMMUTABLE',
      'PREQUOTE_IMMUTABLE',
      'DELIVERY_QUOTE_IMMUTABLE',
      'DELIVERY_QUOTE_IMMUTABLE',
      'AUTHORIZED_ACCEPT_REQUIRED',
      'PREQUOTE_REQUOTE_NOT_ALLOWED',
      'CONVERSION_CONTENT_IMMUTABLE',
      'CONVERSION_CONTENT_IMMUTABLE',
      'CONVERSION_CONTENT_IMMUTABLE',
      'AUTHORIZED_ACCEPT_REQUIRED',
      'CONVERSION_KEY_IMMUTABLE',
    ];
    for (let i = 0; i < cases.length; i++)
      expect(attacks[cases[i][0]], cases[i][0]).toBe(expectedCodes[i]);

    // Constraints inmediatas sobre el conjunto ya comprometido: sigue siendo válido y los ataques
    // posteriores siguen fallando. El commit tardío de un escritor directo —el límite temporal que
    // B1/B2 documentan— se reverifica al reejecutar la suite B3, que lo construye en SQL; aquí no
    // puede reproducirse acortando la vigencia, porque la fila MPQ rechaza todo UPDATE.
    await p.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET CONSTRAINTS ALL IMMEDIATE`);
      const [{ n: manifest }] = await tx.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*)::bigint AS n FROM "DeliveryStop" WHERE "deliveryRequestId" = '${conversion.deliveryRequestId}'::uuid`,
      );
      expect(Number(manifest)).toBe(conversion.stopIds.length);
    });
    expect(
      await rejection(
        p.$executeRawUnsafe(
          `UPDATE "DeliveryPrequote" SET "expiresAt"="expiresAt" + interval '1 day' WHERE id='${stored.id}'::uuid`,
        ),
      ),
    ).toBe('PREQUOTE_IMMUTABLE');
    expect(
      await p.prequoteConversion.count({ where: { prequoteId: stored.id } }),
    ).toBe(1);
    note(
      '§6',
      'escritor directo en SQL',
      `${cases.length} escrituras forjadas, ninguna aceptada`,
      Object.entries(attacks)
        .map(([k, v]) => `${k} → ${v}`)
        .join('; '),
      'con SET CONSTRAINTS ALL IMMEDIATE el conjunto comprometido sigue siendo válido y los ataques posteriores siguen fallando',
      'el vencimiento de la MPQ no se puede ampliar ni en SQL; el commit tardío directo se reverifica en la suite B3',
    );
  }, 240000);
});

describe('CHECK B4 §8 preservación económica y legacy con fixtures no vacíos', () => {
  it('convertir sólo agrega sus propios recursos y no toca créditos, despacho ni legacy', async () => {
    const { hash } = await import('argon2');
    const { ensureTestCreditPolicies } =
      await import('./support/credit-policies.js');
    const { fundProvider } = await import('./support/credits.js');
    const { DispatchService } =
      await import('../dist/dispatch/dispatch.service.js');
    const { DeliveryAssignmentsService } =
      await import('../dist/delivery-assignments/delivery-assignments.service.js');
    await ensureTestCreditPolicies(p);

    // Flujo legacy real y completo: solicitud, cotización, aceptación, claim, asignación, cierre.
    const legacyBody = (mode: string) => ({
      serviceType: 'LOCAL_DELIVERY',
      stops: conditions.stops.map((s) => ({
        ...s,
        address: `Legacy B4 ${s.sequence}`,
        contactName: 'Fixture',
        contactPhone: '0000000000',
      })),
      packages: [{ category: 'FOOD', quantity: 1, description: 'Legacy' }],
      financialContext: {
        goodsPaymentMode: mode,
        goodsValue: '450.00',
        currency: 'MXN',
      },
    });
    const legacy: Record<string, { request: string; quote: string }> = {};
    for (const mode of ['PREPAID', 'COURIER_ADVANCE']) {
      const req = await api()
        .post('/api/v1/delivery-requests')
        .auth(tokens[0], bearer)
        .set('Idempotency-Key', key(`legacy-${mode}`))
        .send(legacyBody(mode))
        .expect(201);
      const quote = await api()
        .post(`/api/v1/delivery-requests/${req.body.publicId}/quotes`)
        .auth(tokens[0], bearer)
        .send({})
        .expect(201);
      legacy[mode] = { request: req.body.publicId, quote: quote.body.publicId };
    }
    // Sólo la PREPAID se acepta, para que exista Dispatch, crédito y cierre reales.
    await api()
      .post(`/api/v1/delivery-quotes/${legacy.PREPAID.quote}/accept`)
      .auth(tokens[0], bearer)
      .send({})
      .expect(200);
    const provider = await p.deliveryProvider.create({
      data: {
        name: 'B4 preservación',
        code: `B4P_${run}`,
        type: 'FLEET',
        status: 'ACTIVE',
        maxDrivers: 1,
        maxVehicles: 1,
      },
    });
    await p.providerServiceCoverage.create({
      data: {
        providerId: provider.id,
        serviceZoneId: zoneId,
        serviceType: 'LOCAL_DELIVERY',
      },
    });
    await fundProvider(p, provider.id, 40);
    const user = await p.user.create({
      data: {
        email: `b4-driver-${run}@fixture.test`,
        role: 'DRIVER',
        active: true,
        passwordHash: await hash(randomBytes(32).toString('hex')),
      },
    });
    const driver = await p.driver.create({
      data: {
        providerId: provider.id,
        userId: user.id,
        name: 'Sintético B4',
        status: 'ACTIVE',
        availability: 'AVAILABLE',
      },
    });
    const vehicle = await p.vehicle.create({
      data: {
        providerId: provider.id,
        identifier: `B4-${run}`,
        type: 'MOTORCYCLE',
      },
    });
    const acceptedQuote = await p.deliveryQuote.findUniqueOrThrow({
      where: { publicId: legacy.PREPAID.quote },
    });
    const dispatch = await p.dispatch.findUniqueOrThrow({
      where: { deliveryQuoteId: acceptedQuote.id },
    });
    await p.dispatchCandidate.create({
      data: {
        dispatchId: dispatch.id,
        providerId: provider.id,
        offeredAt: new Date(),
      },
    });
    await apps[0].get(DispatchService).claim(dispatch.id, provider.id, user.id);
    await apps[0]
      .get(DeliveryAssignmentsService)
      .create(
        dispatch.id,
        { driverId: driver.id, vehicleId: vehicle.id },
        { providerId: provider.id, userId: user.id },
      );
    await apps[0]
      .get(DispatchService)
      .complete(dispatch.id, provider.id, user.id);

    // Punto de referencia: inmediatamente antes de convertir, con las tablas ya no vacías.
    const digest = async () => {
      const out: Record<string, { count: number; hash: string }> = {};
      const tables = {
        CreditAccount: () =>
          p.creditAccount.findMany({ orderBy: { id: 'asc' } }),
        CreditLedgerEntry: () =>
          p.creditLedgerEntry.findMany({ orderBy: { id: 'asc' } }),
        Dispatch: () => p.dispatch.findMany({ orderBy: { id: 'asc' } }),
        DeliveryAssignment: () =>
          p.deliveryAssignment.findMany({ orderBy: { id: 'asc' } }),
        B2bOutboxEvent: () =>
          p.b2bOutboxEvent.findMany({ orderBy: { id: 'asc' } }),
        DispatchCreditSnapshot: () =>
          p.dispatchCreditSnapshot.findMany({ orderBy: { id: 'asc' } }),
        ApiIdempotencyExecution: () =>
          p.apiIdempotencyExecution.findMany({ orderBy: { recordId: 'asc' } }),
        PrequoteConsumptionPermit: () =>
          p.prequoteConsumptionPermit.findMany({ orderBy: { id: 'asc' } }),
      };
      for (const [name, read] of Object.entries(tables)) {
        const rows = (await read()) as unknown[];
        out[name] = { count: rows.length, hash: hashOf(rows) };
      }
      return out;
    };
    // Las tres MPQ se emiten ANTES de fotografiar: emitir consume por diseño y atribuirlo a la
    // conversión sería confundir la preparación del fixture con el flujo medido.
    const pending: string[] = [];
    for (let i = 0; i < 3; i += 1)
      pending.push((await freshPrequote(0)).publicId);

    const before = await digest();
    for (const name of [
      'CreditAccount',
      'CreditLedgerEntry',
      'Dispatch',
      'DeliveryAssignment',
      'B2bOutboxEvent',
      'DispatchCreditSnapshot',
      'PrequoteConsumptionPermit',
    ])
      expect([name, before[name].count > 0]).toEqual([name, true]);
    const legacyBefore = hashOf([
      await p.deliveryRequest.findMany({
        where: {
          publicId: {
            in: [legacy.PREPAID.request, legacy.COURIER_ADVANCE.request],
          },
        },
        orderBy: { publicId: 'asc' },
      }),
      await p.deliveryQuote.findMany({
        where: {
          publicId: {
            in: [legacy.PREPAID.quote, legacy.COURIER_ADVANCE.quote],
          },
        },
        orderBy: { publicId: 'asc' },
      }),
    ]);

    // Tres conversiones reales, y nada más, entre las dos fotografías.
    const created: string[] = [];
    for (const [i, publicId] of pending.entries()) {
      const response = await convert(
        publicId,
        conversionBody(),
        key(`preserve-${i}`),
      ).expect(201);
      created.push(response.body.deliveryRequestPublicId);
    }

    const after = await digest();
    // Ni un asiento, despacho, asignación, evento, snapshot, ejecución o permiso nuevo.
    expect(after).toEqual(before);
    // Y el legacy seleccionado no cambió.
    expect(
      hashOf([
        await p.deliveryRequest.findMany({
          where: {
            publicId: {
              in: [legacy.PREPAID.request, legacy.COURIER_ADVANCE.request],
            },
          },
          orderBy: { publicId: 'asc' },
        }),
        await p.deliveryQuote.findMany({
          where: {
            publicId: {
              in: [legacy.PREPAID.quote, legacy.COURIER_ADVANCE.quote],
            },
          },
          orderBy: { publicId: 'asc' },
        }),
      ]),
    ).toBe(legacyBefore);

    // El legacy sigue funcionando después de convertir: accept idempotente, recotización y cancelación.
    await api()
      .post(`/api/v1/delivery-quotes/${legacy.PREPAID.quote}/accept`)
      .auth(tokens[0], bearer)
      .send({})
      .expect(200);
    const requote = await api()
      .post(
        `/api/v1/delivery-requests/${legacy.COURIER_ADVANCE.request}/quotes`,
      )
      .auth(tokens[0], bearer)
      .send({});
    expect([200, 201]).toContain(requote.status);
    await api()
      .post(
        `/api/v1/delivery-requests/${legacy.COURIER_ADVANCE.request}/cancel`,
      )
      .auth(tokens[0], bearer)
      .send({ reason: 'B4 legacy' })
      .expect(200);
    // Las MDR convertidas siguen sin poder aceptarse ni recotizarse.
    for (const publicId of created) {
      const blocked = await api()
        .post(`/api/v1/delivery-requests/${publicId}/quotes`)
        .auth(tokens[0], bearer)
        .send({});
      expect([blocked.status, blocked.body.code]).toEqual([
        409,
        'PREQUOTE_REQUOTE_NOT_ALLOWED',
      ]);
    }
    note(
      '§8',
      'preservación con fixtures no vacíos',
      'ocho tablas comparadas por hash antes y después de tres conversiones: idénticas',
      'las MPQ se emitieron antes de la fotografía, porque emitir sí consume y convertir no',
      `conteos de referencia: ${JSON.stringify(
        Object.fromEntries(
          Object.entries(before).map(([k, v]) => [k, v.count]),
        ),
      )}`,
      'MDR/MQ legacy PREPAID y COURIER_ADVANCE intactas; accept idempotente, recotización y cancelación legacy conservados',
      'las MDR convertidas siguen bloqueadas para accept y recotización',
    );
  }, 300000);
});
