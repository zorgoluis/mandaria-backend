import 'reflect-metadata';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { Test } from '@nestjs/testing';
import type { ExecutionContext, INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { DeliveryQuotesService } from '../dist/delivery-quotes/delivery-quotes.service.js';
import { DeliveryQuotesController } from '../dist/delivery-quotes/delivery-quotes.controller.js';
import { IntegrationGuard } from '../dist/integrations/integration.guard.js';
import { setup } from '../dist/setup.js';

const integrationId = 'fd9312fc-500a-44bb-912f-5d69e5efed91';
const instant = new Date('2026-09-28T04:48:51.060Z');
const secret = 'DO_NOT_LOG_TEST_SECRET';
type State = {
  status: string;
  requestStatus: string;
  expiresAt: Date;
  dispatches: number;
  snapshots: number;
};
let state: State;
let missing: string | null;
let persistence: string | null;
let commitFailure: boolean;
let scopes: string[];
let captured: unknown[];
let app: INestApplication;
let transactionCalls: number;
const policy = (actorType: string) => ({
  id: `p-${actorType}`,
  actorType,
  serviceType: 'LOCAL_DELIVERY',
  version: 1,
  calculationType: 'FLAT',
  flatCredits: 7,
  creditsPerKm: null,
  minimumCredits: null,
  ranges: [],
});
const persistenceError = () =>
  new Prisma.PrismaClientKnownRequestError(secret, {
    code: persistence!,
    clientVersion: 'test',
    meta: { unsafe: secret },
  });
// This is a transaction DOUBLE, not a PostgreSQL test. Only explicit commit publishes the draft.
const db = {
  $transaction: async (work: (tx: unknown) => Promise<unknown>) => {
    transactionCalls++;
    const draft = structuredClone(state);
    let selected = 'MQ-000004';
    const row = () => ({
      id: selected,
      publicId: selected,
      deliveryRequestId: 'request',
      status: selected === 'MQ-000003' ? 'EXPIRED' : draft.status,
      expiresAt: draft.expiresAt,
      serviceType: 'LOCAL_DELIVERY',
      distanceMeters: 1000,
      serviceZoneId: 'zone',
      amount: new Prisma.Decimal('25.00'),
      currency: 'MXN',
      deliveryRequest: {
        publicId: 'MDR-000002',
        integrationClientId: integrationId,
        status: draft.requestStatus,
      },
      serviceZone: { code: 'ZONE', name: 'Zone' },
      acceptedAt: draft.status === 'ACCEPTED' ? instant : null,
    });
    const tx = {
      $queryRaw: async (parts: TemplateStringsArray, ...values: unknown[]) => {
        const sql = parts.join('?');
        if (sql.includes('FROM "DeliveryQuote"')) {
          selected = String(values[0]);
          return [{ id: selected, deliveryRequestId: 'request' }];
        }
        if (sql.includes('FROM "DeliveryRequest"'))
          return [{ status: draft.requestStatus }];
        return []; // advisory lock / zero eligible providers
      },
      deliveryQuote: {
        findUniqueOrThrow: async () => row(),
        update: async ({ data }: { data: { status: string } }) => {
          draft.status = data.status;
          return row();
        },
      },
      dispatch: {
        create: async () => {
          if (persistence && !commitFailure) throw persistenceError();
          draft.dispatches++;
          return {
            id: 'dispatch',
            expiresAt: new Date('2026-09-28T05:48:51Z'),
          };
        },
      },
      creditPolicy: {
        findFirst: async ({ where }: { where: { actorType: string } }) =>
          where.actorType === missing ? null : policy(where.actorType),
      },
      dispatchCreditSnapshot: {
        create: async ({ data }: { data: object }) => {
          draft.snapshots++;
          return data;
        },
      },
      dispatchCandidate: {
        createMany: vi.fn(() => {
          throw Error('zero providers must not create candidates');
        }),
      },
    };
    // No accounts, balances, ledger or routing delegates exist: accidental access fails.
    const result = await work(tx);
    if (commitFailure) throw persistenceError();
    state = draft;
    return result;
  },
};

beforeAll(async () => {
  const config = new ConfigService({
    GOOGLE_ROUTES_TIMEOUT_MS: 1000,
    GOOGLE_ROUTES_MAX_RETRIES: 0,
    DISPATCH_TTL_MINUTES: 60,
    CORS_ORIGINS: 'http://localhost',
  });
  const service = new DeliveryQuotesService(
    db as never,
    {} as never,
    {} as never,
    {} as never,
    config,
  );
  const module = await Test.createTestingModule({
    controllers: [DeliveryQuotesController],
    providers: [
      { provide: DeliveryQuotesService, useValue: service },
      { provide: ConfigService, useValue: config },
    ],
  })
    .overrideGuard(IntegrationGuard)
    .useValue({
      canActivate: (ctx: ExecutionContext) => {
        ctx.switchToHttp().getRequest().integration = {
          id: integrationId,
          scopes,
        };
        return true;
      },
    })
    .compile();
  app = module.createNestApplication();
  const capture = (...args: unknown[]) => captured?.push(args);
  app.useLogger({
    log: capture,
    warn: capture,
    error: capture,
    debug: capture,
    verbose: capture,
    fatal: capture,
  });
  setup(app);
  await app.init();
});
afterAll(async () => {
  vi.useRealTimers();
  await app?.close();
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(instant);
  state = {
    status: 'OFFERED',
    requestStatus: 'CREATED',
    expiresAt: new Date('2026-09-28T05:03:50.501Z'),
    dispatches: 0,
    snapshots: 0,
  };
  missing = null;
  persistence = null;
  commitFailure = false;
  scopes = ['quotes:accept'];
  captured = [];
  transactionCalls = 0;
});
const accept = (id = 'MQ-000004') =>
  request(app.getHttpServer())
    .post('/api/v1/delivery-quotes/' + id + '/accept')
    .set('Authorization', 'Bearer ' + secret)
    .set('X-Request-Id', secret)
    .send({ token: secret });

describe('accept 409 investigation: real controller/service/filter, transaction double', () => {
  for (const actor of ['PROVIDER', 'INDEPENDENT_DRIVER'])
    it(
      'unexpired replacement rejects missing ' +
        actor +
        ' policy and preserves error code',
      async () => {
        missing = actor;
        const before = structuredClone(state);
        const r = await accept().expect(409);
        expect(r.body.code).toBe('CREDIT_POLICY_UNAVAILABLE');
        expect(state).toEqual(before);
        expect(r.body.requestId).toMatch(/^[0-9a-f-]{36}$/);
        expect(r.headers['x-request-id']).toBe(r.body.requestId);
        const logs = JSON.stringify(captured);
        expect(logs).toContain('DELIVERY_QUOTE_ACCEPT_FAILED');
        expect(logs).toContain('MQ-000004');
        expect(logs).toContain(integrationId);
        expect(logs).toContain(r.body.requestId);
        expect(logs).not.toContain(secret);
      },
    );
  it('valid policies and zero candidates accept without balance checks; retry is idempotent', async () => {
    const r = await accept().expect(200);
    expect(r.body.publicId).toBe('MQ-000004');
    expect(state).toMatchObject({
      status: 'ACCEPTED',
      dispatches: 1,
      snapshots: 2,
    });
    missing = 'PROVIDER';
    await accept().expect(200);
    expect(state).toMatchObject({ dispatches: 1, snapshots: 2 });
  });
  it('old expired identifier differs from fresh replacement', async () => {
    const r = await accept('MQ-000003').expect(409);
    expect(r.body.code).toBe('QUOTE_EXPIRED');
    expect(state.status).toBe('OFFERED');
    await accept().expect(200);
  });
  it('exact expiry persists EXPIRED, no dispatch', async () => {
    vi.setSystemTime(state.expiresAt);
    const r = await accept().expect(409);
    expect(r.body.code).toBe('QUOTE_EXPIRED');
    expect(state).toMatchObject({
      status: 'EXPIRED',
      dispatches: 0,
      snapshots: 0,
    });
  });
  for (const target of ['quote', 'request'])
    it('cancelled ' + target + ' returns QUOTE_NOT_ACCEPTABLE', async () => {
      if (target === 'quote') state.status = 'CANCELLED';
      else state.requestStatus = 'CANCELLED';
      const r = await accept().expect(409);
      expect(r.body.code).toBe('QUOTE_NOT_ACCEPTABLE');
      expect(state.dispatches).toBe(0);
    });
  for (const code of ['P2002', 'P2003', 'P2010', 'P2034', 'P2028'])
    it(
      'raw persistence ' + code + ' is sanitized 500, not a domain 409',
      async () => {
        persistence = code;
        const before = structuredClone(state);
        const r = await accept().expect(500);
        expect(r.body.code).toBe('HTTP_500');
        expect(r.body.message).toBe('Service unavailable');
        expect(state).toEqual(before);
        expect(JSON.stringify(captured)).not.toContain(secret);
        expect(JSON.stringify(r.body)).not.toContain(secret);
      },
    );
  it('deferred commit failure does not publish accepted state in transaction double', async () => {
    persistence = 'P2010';
    commitFailure = true;
    const before = structuredClone(state);
    await accept().expect(500);
    expect(state).toEqual(before);
    expect(JSON.stringify(captured)).not.toContain('DELIVERY_QUOTE_ACCEPTED');
  });
  it('missing exact scope returns 403 before the transaction', async () => {
    scopes = ['quotes:create', 'quotes:read'];
    const r = await accept().expect(403);
    expect(r.body.code).toBe('HTTP_403');
    expect(transactionCalls).toBe(0);
  });
  it('literal double slash does not invoke accept', async () => {
    await accept('').expect(404);
    expect(transactionCalls).toBe(0);
  });
});
