import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { lastValueFrom, of } from 'rxjs';
import {
  CreatePartnerApplicationDto,
  ChangePartnerApplicationStatusDto,
  LinkPartnerApplicationDto,
  PartnerApplicationListQueryDto,
} from '../dist/partner-applications/partner-applications.dto.js';
import {
  PARTNER_APPLICATION_STATUSES,
  PARTNER_APPLICATION_TRANSITIONS,
  assertLinks,
  assertTransition,
  decoyReference,
  isHoneypotFilled,
  normalizeReference,
} from '../dist/partner-applications/partner-application-policy.js';
import { PartnerApplicationsService } from '../dist/partner-applications/partner-applications.service.js';
import { HoneypotInterceptor } from '../dist/partner-applications/honeypot.interceptor.js';
import { renderPartnerApplicationNotice } from '../dist/mail/mail-templates.js';
import { validateEnvironment } from '../src/config/environment.js';
import type { PrismaService } from '../dist/prisma/prisma.service.js';

/** Same options as the global pipe in setup.ts. */
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  validationError: { target: false, value: false },
});
const validateAs = async (metatype: unknown, value: unknown) => {
  try {
    return {
      value: (await pipe.transform(value, {
        type: 'body',
        metatype: metatype as never,
      })) as Record<string, unknown>,
      errors: [] as string[],
    };
  } catch (error) {
    if (!(error instanceof BadRequestException)) throw error;
    return {
      value: null,
      errors: (error.getResponse() as { message: string[] }).message,
    };
  }
};
const submit = (value: unknown) =>
  validateAs(CreatePartnerApplicationDto, value);

const individual = {
  type: 'INDIVIDUAL',
  contactName: 'Ana López',
  phone: '9611234567',
  email: 'ana@example.com',
  city: 'Tuxtla Gutiérrez',
  vehicleType: 'MOTORCYCLE',
  privacyAccepted: true,
  privacyNoticeVersion: '2026-10',
};
const fleet = {
  ...individual,
  type: 'FLEET',
  vehicleType: 'CAR',
  fleetName: 'Mensajería del Sur',
  fleetUnits: 5,
};

describe('CreatePartnerApplicationDto', () => {
  it('accepts a valid INDIVIDUAL and a valid FLEET application', async () => {
    expect((await submit(individual)).errors).toEqual([]);
    expect((await submit(fleet)).errors).toEqual([]);
  });

  it('trims text, normalizes the email and treats a blank honeypot as empty', async () => {
    const { value } = await submit({
      ...fleet,
      contactName: '  Ana López ',
      email: '  Ana@Example.COM ',
      city: ' Tuxtla ',
      fleetName: ' Flota ',
      privacyNoticeVersion: ' 2026-10 ',
      website: '   ',
    });
    expect(value).toMatchObject({
      contactName: 'Ana López',
      email: 'ana@example.com',
      city: 'Tuxtla',
      fleetName: 'Flota',
      privacyNoticeVersion: '2026-10',
      website: '',
    });
  });

  it.each([
    ['type missing', { type: undefined }, 'type'],
    ['type unknown', { type: 'COMPANY' }, 'type'],
    ['contactName too short', { contactName: ' A ' }, 'contactName'],
    ['contactName too long', { contactName: 'a'.repeat(101) }, 'contactName'],
    ['phone with 9 digits', { phone: '961123456' }, 'phone'],
    ['phone with 11 digits', { phone: '52961123456' }, 'phone'],
    ['phone with symbols', { phone: '961-123-45' }, 'phone'],
    ['phone as number', { phone: 9611234567 }, 'phone'],
    ['email invalid', { email: 'ana@' }, 'email'],
    ['email too long', { email: `${'a'.repeat(250)}@x.mx` }, 'email'],
    ['city too short', { city: 'T' }, 'city'],
    ['city too long', { city: 'c'.repeat(81) }, 'city'],
    ['vehicleType VAN (not offered)', { vehicleType: 'VAN' }, 'vehicleType'],
    ['vehicleType OTHER', { vehicleType: 'OTHER' }, 'vehicleType'],
    ['privacyAccepted false', { privacyAccepted: false }, 'privacyAccepted'],
    [
      'privacyAccepted "true" string',
      { privacyAccepted: 'true' },
      'privacyAccepted',
    ],
    [
      'privacyAccepted missing',
      { privacyAccepted: undefined },
      'privacyAccepted',
    ],
    [
      'privacyNoticeVersion too long',
      { privacyNoticeVersion: 'v'.repeat(21) },
      'privacyNoticeVersion',
    ],
    [
      'privacyNoticeVersion empty',
      { privacyNoticeVersion: ' ' },
      'privacyNoticeVersion',
    ],
    ['unknown field', { role: 'SUPER_ADMIN' }, 'role'],
    ['honeypot filled', { website: 'https://spam.example' }, 'website'],
  ])('rejects %s', async (_name, patch, field) => {
    const { errors } = await submit({ ...individual, ...patch });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toContain(field);
  });

  it('forbids fleet fields with INDIVIDUAL but tolerates explicit nulls', async () => {
    expect(
      (await submit({ ...individual, fleetName: 'Flota' })).errors.join(' '),
    ).toContain('fleetName is only allowed with type FLEET');
    expect(
      (await submit({ ...individual, fleetUnits: 3 })).errors.join(' '),
    ).toContain('fleetUnits is only allowed with type FLEET');
    expect(
      (await submit({ ...individual, fleetName: null, fleetUnits: null }))
        .errors,
    ).toEqual([]);
  });

  it.each([
    ['fleetName missing', { fleetName: undefined }, 'fleetName'],
    ['fleetName too short', { fleetName: 'F' }, 'fleetName'],
    ['fleetName too long', { fleetName: 'f'.repeat(101) }, 'fleetName'],
    ['fleetUnits missing', { fleetUnits: undefined }, 'fleetUnits'],
    ['fleetUnits 1', { fleetUnits: 1 }, 'fleetUnits'],
    ['fleetUnits 10001', { fleetUnits: 10001 }, 'fleetUnits'],
    ['fleetUnits decimal', { fleetUnits: 2.5 }, 'fleetUnits'],
    ['fleetUnits as string', { fleetUnits: '5' }, 'fleetUnits'],
  ])('FLEET rejects %s', async (_name, patch, field) => {
    const { errors } = await submit({ ...fleet, ...patch });
    expect(errors.join(' ')).toContain(field);
  });

  it('accepts the fleetUnits bounds 2 and 10000', async () => {
    for (const fleetUnits of [2, 10000])
      expect((await submit({ ...fleet, fleetUnits })).errors).toEqual([]);
  });
});

describe('admin DTOs', () => {
  it('validates list filters, status changes and links', async () => {
    expect(
      (
        await validateAs(PartnerApplicationListQueryDto, {
          status: 'RECEIVED',
          type: 'FLEET',
          q: ' ana ',
        })
      ).value,
    ).toMatchObject({ q: 'ana', page: 1, pageSize: 20 });
    expect(
      (await validateAs(PartnerApplicationListQueryDto, { status: 'OPEN' }))
        .errors,
    ).not.toEqual([]);
    expect(
      (
        await validateAs(ChangePartnerApplicationStatusDto, {
          status: 'APPROVED',
          reviewNote: 'x'.repeat(501),
        })
      ).errors.join(' '),
    ).toContain('reviewNote');
    expect(
      (await validateAs(LinkPartnerApplicationDto, { providerId: 'nope' }))
        .errors,
    ).not.toEqual([]);
  });
});

describe('honeypot', () => {
  it('detects only non-empty values', () => {
    expect(isHoneypotFilled({})).toBe(false);
    expect(isHoneypotFilled({ website: '' })).toBe(false);
    expect(isHoneypotFilled({ website: '  ' })).toBe(false);
    expect(isHoneypotFilled({ website: null })).toBe(false);
    expect(isHoneypotFilled(undefined)).toBe(false);
    expect(isHoneypotFilled({ website: 'x' })).toBe(true);
    expect(isHoneypotFilled({ website: 1 })).toBe(true);
    expect(isHoneypotFilled({ website: ['x'] })).toBe(true);
  });

  it('decoy references have the public format', () => {
    for (let i = 0; i < 50; i++)
      expect(decoyReference()).toMatch(/^SOC-\d{6}$/);
  });

  it('answers a filled honeypot before validation, without reaching the handler', async () => {
    const service = { logHoneypot: vi.fn() };
    const interceptor = new HoneypotInterceptor(service as never);
    const next = { handle: vi.fn(() => of('handler')) };
    const context = (body: unknown) =>
      ({
        switchToHttp: () => ({
          getRequest: () => ({ body }),
          getResponse: () => ({ locals: { requestId: 'req-1' } }),
        }),
      }) as never;
    const answer = await lastValueFrom(
      interceptor.intercept(
        context({ website: 'spam', phone: 'bad' }),
        next as never,
      ),
    );
    expect(answer).toMatchObject({ status: 'RECEIVED' });
    expect((answer as { reference: string }).reference).toMatch(/^SOC-\d{6}$/);
    expect(next.handle).not.toHaveBeenCalled();
    // Only the decoy reference and the request id are logged, never the body.
    expect(service.logHoneypot).toHaveBeenCalledWith(
      (answer as { reference: string }).reference,
      'req-1',
    );
    expect(
      await lastValueFrom(
        interceptor.intercept(context({ website: '' }), next as never),
      ),
    ).toBe('handler');
  });
});

describe('state machine', () => {
  const state = (status: string, extra: object = {}) =>
    ({
      status,
      reviewNote: null,
      providerId: null,
      invitationId: null,
      ...extra,
    }) as never;
  const codeOf = (fn: () => unknown) => {
    try {
      fn();
    } catch (error) {
      return (error as { code?: string }).code;
    }
    return undefined;
  };

  it('allows exactly the contract transitions', () => {
    const allowed = new Set(
      Object.entries(PARTNER_APPLICATION_TRANSITIONS).flatMap(([from, tos]) =>
        tos.map((to) => `${from}->${to}`),
      ),
    );
    expect([...allowed].sort()).toEqual(
      [
        'RECEIVED->CONTACTED',
        'RECEIVED->REJECTED',
        'RECEIVED->DISCARDED',
        'CONTACTED->APPROVED',
        'CONTACTED->REJECTED',
        'CONTACTED->DISCARDED',
        'APPROVED->REJECTED',
      ].sort(),
    );
    for (const from of PARTNER_APPLICATION_STATUSES)
      for (const to of PARTNER_APPLICATION_STATUSES) {
        const code = codeOf(() =>
          assertTransition(state(from), to, 'nota interna'),
        );
        expect(code, `${from}->${to}`).toBe(
          allowed.has(`${from}->${to}`)
            ? undefined
            : 'PARTNER_APPLICATION_INVALID_TRANSITION',
        );
      }
  });

  it('APPROVED needs a note (new or kept) or a link', () => {
    expect(
      codeOf(() => assertTransition(state('CONTACTED'), 'APPROVED', undefined)),
    ).toBe('PARTNER_APPLICATION_INVALID_TRANSITION');
    expect(assertTransition(state('CONTACTED'), 'APPROVED', 'Llamada ok')).toBe(
      'Llamada ok',
    );
    expect(
      assertTransition(
        state('CONTACTED', { reviewNote: 'previa' }),
        'APPROVED',
        undefined,
      ),
    ).toBe('previa');
  });

  it('APPROVED -> REJECTED requires a new note', () => {
    const approved = state('APPROVED', { reviewNote: 'ok' });
    expect(
      codeOf(() => assertTransition(approved, 'REJECTED', undefined)),
    ).toBe('PARTNER_APPLICATION_INVALID_TRANSITION');
    expect(assertTransition(approved, 'REJECTED', 'Documentos falsos')).toBe(
      'Documentos falsos',
    );
  });

  it('normalizes references', () => {
    expect(normalizeReference('soc-000123')).toBe('SOC-000123');
    expect(normalizeReference('SOC-12')).toBeNull();
    expect(normalizeReference('MDR-000001')).toBeNull();
  });
});

describe('links', () => {
  const app = (extra: object = {}) =>
    ({
      type: 'FLEET',
      status: 'APPROVED',
      email: 'ana@example.com',
      providerId: null,
      invitationId: null,
      ...extra,
    }) as never;
  const providerFleet = { id: 'p1', type: 'FLEET' };
  const invitation = { id: 'i1', email: 'ana@example.com', providerId: 'p1' };
  const codeOf = (fn: () => unknown) => {
    try {
      fn();
    } catch (error) {
      return (error as { code?: string; message: string }).message;
    }
    return undefined;
  };

  it('records coherent links', () => {
    expect(
      assertLinks(
        app(),
        { providerId: 'p1', invitationId: 'i1' },
        providerFleet,
        invitation,
      ),
    ).toEqual({ providerId: 'p1', invitationId: 'i1' });
    expect(
      assertLinks(
        app({ type: 'INDIVIDUAL' }),
        { invitationId: 'i1' },
        null,
        invitation,
      ),
    ).toEqual({ providerId: null, invitationId: 'i1' });
    // A later provider link keeps the earlier invitation.
    expect(
      assertLinks(
        app({ invitationId: 'i1' }),
        { providerId: 'p1' },
        providerFleet,
        invitation,
      ),
    ).toEqual({ providerId: 'p1', invitationId: 'i1' });
  });

  it.each([
    [
      'not APPROVED',
      app({ status: 'CONTACTED' }),
      { invitationId: 'i1' },
      null,
      invitation,
      'APPROVED',
    ],
    [
      'provider on INDIVIDUAL',
      app({ type: 'INDIVIDUAL' }),
      { providerId: 'p1' },
      providerFleet,
      null,
      'Only FLEET',
    ],
    [
      'missing provider',
      app(),
      { providerId: 'p1' },
      null,
      null,
      'Provider does not exist',
    ],
    [
      'INDEPENDENT provider',
      app(),
      { providerId: 'p1' },
      { id: 'p1', type: 'INDEPENDENT' },
      null,
      'type FLEET',
    ],
    [
      'missing invitation',
      app(),
      { invitationId: 'i1' },
      null,
      null,
      'Invitation does not exist',
    ],
    [
      'other email',
      app(),
      { invitationId: 'i1' },
      null,
      { ...invitation, email: 'otro@example.com' },
      'email does not match',
    ],
    [
      'invitation of another provider',
      app(),
      { providerId: 'p2', invitationId: 'i1' },
      { id: 'p2', type: 'FLEET' },
      invitation,
      'different provider',
    ],
    [
      'earlier invitation of another provider',
      app({ invitationId: 'i1' }),
      { providerId: 'p2' },
      { id: 'p2', type: 'FLEET' },
      invitation,
      'different provider',
    ],
  ])('rejects %s', (_name, target, requested, provider, inv, message) => {
    expect(
      codeOf(() => assertLinks(target, requested, provider as never, inv)),
    ).toContain(message);
  });
});

describe('PartnerApplicationsService.submit deduplication', () => {
  const dto = {
    ...individual,
    email: 'ana@example.com',
  } as never as CreatePartnerApplicationDto;
  const build = (existing: { id: string } | null, notifyEmail?: string) => {
    const locks: string[] = [];
    const tx = {
      $queryRaw: vi.fn(
        (strings: TemplateStringsArray, ...values: unknown[]) => {
          locks.push(String(values[1]));
          return Promise.resolve([{ '?column?': 1 }]);
        },
      ),
      $queryRawUnsafe: vi.fn(() => Promise.resolve([{ value: 42n }])),
      partnerApplication: {
        findFirst: vi.fn(() => Promise.resolve(existing)),
        update: vi.fn(() =>
          Promise.resolve({ publicId: 'SOC-000007', submissionCount: 2 }),
        ),
        create: vi.fn(() =>
          Promise.resolve({ publicId: 'SOC-000042', submissionCount: 1 }),
        ),
      },
    };
    const prisma = {
      $transaction: vi.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
    } as unknown as PrismaService;
    const mail = {
      name: 'fake',
      sendUserInvitation: vi.fn(),
      sendPartnerApplicationNotice: vi.fn(() =>
        Promise.reject(new Error('down')),
      ),
    };
    const config = new ConfigService(
      notifyEmail ? { PARTNER_APPLICATIONS_NOTIFY_EMAIL: notifyEmail } : {},
    );
    return {
      service: new PartnerApplicationsService(prisma, config, mail as never),
      tx,
      mail,
      locks,
    };
  };

  it('creates a new SOC reference when nothing open matches', async () => {
    const { service, tx, locks } = build(null);
    expect(await service.submit(dto, 'req')).toEqual({
      reference: 'SOC-000042',
      status: 'RECEIVED',
    });
    expect(locks).toEqual(['email:ana@example.com', 'phone:9611234567']);
    expect(tx.$queryRawUnsafe).toHaveBeenCalledWith(
      `SELECT nextval('"PartnerApplication_publicId_seq"') AS value`,
    );
    const where = tx.partnerApplication.findFirst.mock.calls[0][0].where;
    expect(where.status).toEqual({ in: ['RECEIVED', 'CONTACTED'] });
    expect(where.OR).toEqual([
      { phone: '9611234567' },
      { email: 'ana@example.com' },
    ]);
    const days = (Date.now() - where.createdAt.gte.getTime()) / 86_400_000;
    expect(days).toBeCloseTo(30, 2);
    expect(tx.partnerApplication.create.mock.calls[0][0].data).toMatchObject({
      fleetName: null,
      fleetUnits: null,
    });
  });

  it('absorbs a duplicate: same reference, count incremented, no sequence, no notice', async () => {
    const { service, tx, mail } = build({ id: 'existing' }, 'ops@example.com');
    expect(await service.submit(dto, 'req')).toEqual({
      reference: 'SOC-000007',
      status: 'RECEIVED',
    });
    expect(tx.partnerApplication.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'existing' },
        data: expect.objectContaining({ submissionCount: { increment: 1 } }),
      }),
    );
    expect(tx.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(tx.partnerApplication.create).not.toHaveBeenCalled();
    expect(mail.sendPartnerApplicationNotice).not.toHaveBeenCalled();
  });

  it('a failing notice never fails the submission and carries no personal data', async () => {
    const { service, mail } = build(null, 'ops@example.com');
    await expect(service.submit(dto, 'req')).resolves.toMatchObject({
      reference: 'SOC-000042',
    });
    await new Promise((r) => setImmediate(r));
    expect(mail.sendPartnerApplicationNotice).toHaveBeenCalledWith({
      to: 'ops@example.com',
      reference: 'SOC-000042',
      type: 'INDIVIDUAL',
      city: 'Tuxtla Gutiérrez',
    });
  });
});

describe('notice template and configuration', () => {
  it('renders only reference, type and city, escaped', () => {
    const rendered = renderPartnerApplicationNotice({
      to: 'ops@example.com',
      reference: 'SOC-000001',
      type: 'FLEET',
      city: '<Tuxtla>',
    });
    expect(rendered.subject).toBe('Nueva solicitud de socio SOC-000001');
    expect(rendered.text).toContain('Tipo: Flotilla');
    expect(rendered.html).toContain('&lt;Tuxtla&gt;');
    expect(rendered.text).not.toContain('ops@example.com');
  });

  const base = {
    DATABASE_URL: 'postgresql://localhost/mandaria',
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    JWT_REFRESH_SECRET: 'b'.repeat(32),
    INTEGRATION_JWT_SECRET: 'c'.repeat(32),
  };
  it('TRUST_PROXY_HOPS defaults to 0 and is bounded; the notify email is optional', () => {
    expect(validateEnvironment(base)).toMatchObject({ TRUST_PROXY_HOPS: 0 });
    expect(
      validateEnvironment({ ...base, TRUST_PROXY_HOPS: '1' }),
    ).toMatchObject({ TRUST_PROXY_HOPS: 1 });
    expect(() =>
      validateEnvironment({ ...base, TRUST_PROXY_HOPS: '4' }),
    ).toThrow(/TRUST_PROXY_HOPS/);
    expect(
      validateEnvironment({ ...base, PARTNER_APPLICATIONS_NOTIFY_EMAIL: '' })
        .PARTNER_APPLICATIONS_NOTIFY_EMAIL,
    ).toBeUndefined();
    expect(() =>
      validateEnvironment({
        ...base,
        PARTNER_APPLICATIONS_NOTIFY_EMAIL: 'nope',
      }),
    ).toThrow(/PARTNER_APPLICATIONS_NOTIFY_EMAIL/);
  });
});

describe('status list filter', () => {
  const list = (status: unknown) =>
    validateAs(PartnerApplicationListQueryDto, { status });

  it.each([
    ['one status', 'RECEIVED', ['RECEIVED']],
    ['two statuses', 'RECEIVED,CONTACTED', ['RECEIVED', 'CONTACTED']],
    [
      'spaces and lowercase',
      ' received , Contacted ',
      ['RECEIVED', 'CONTACTED'],
    ],
    ['duplicates ignored', 'RECEIVED,received, RECEIVED', ['RECEIVED']],
    [
      'all five',
      'RECEIVED,CONTACTED,APPROVED,REJECTED,DISCARDED',
      ['RECEIVED', 'CONTACTED', 'APPROVED', 'REJECTED', 'DISCARDED'],
    ],
    [
      'five plus duplicates',
      'RECEIVED,CONTACTED,APPROVED,REJECTED,DISCARDED,received',
      ['RECEIVED', 'CONTACTED', 'APPROVED', 'REJECTED', 'DISCARDED'],
    ],
    [
      'repeated parameter',
      ['RECEIVED', 'contacted'],
      ['RECEIVED', 'CONTACTED'],
    ],
  ])('accepts %s', async (_name, status, expected) => {
    const { value, errors } = await list(status);
    expect(errors).toEqual([]);
    expect(value?.status).toEqual(expected);
  });

  it('omitted status does not filter', async () => {
    const { value, errors } = await list(undefined);
    expect(errors).toEqual([]);
    expect(value?.status).toBeUndefined();
  });

  it.each([
    ['unknown value', 'RECEIVED,OPEN', 'status must be a comma-separated list'],
    ['trailing comma', 'RECEIVED,', 'status must be a comma-separated list'],
    ['only a comma', ',', 'status must be a comma-separated list'],
    ['empty string', '', 'status must be a comma-separated list'],
    [
      'more than 5 values',
      'RECEIVED,CONTACTED,APPROVED,REJECTED,DISCARDED,OPEN',
      'status must contain no more than 5 elements',
    ],
    ['non-string', 5, 'status must be a comma-separated list'],
  ])('rejects %s', async (_name, status, message) => {
    expect((await list(status)).errors.join(' ')).toContain(message);
  });
});
