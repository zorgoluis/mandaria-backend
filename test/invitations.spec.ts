import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import {
  assertActivatable,
  canInvite,
  effectiveInvitationStatus,
  INVITATION_ERRORS,
  invitationExpiry,
  newInvitationToken,
  userAccountStatus,
} from '../dist/invitations/invitation-policy.js';
import { InvitationsService } from '../dist/invitations/invitations.service.js';
import {
  buildActivationUrl,
  renderUserInvitation,
} from '../dist/mail/mail-templates.js';
import { LocalOutboxMailProvider } from '../dist/mail/local-outbox-mail.provider.js';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from '../dist/common/password-policy.js';
import { validateEnvironment } from '../src/config/environment.js';
import type { PrismaService } from '../dist/prisma/prisma.service.js';

const mail = {
  to: 'repartidor@example.com',
  role: 'DRIVER' as const,
  providerName: 'Rápidos <de> "Coita"',
  activationUrl: 'https://web.example.com/activate-account?token=abc_DEF-123',
  expiresAt: new Date('2026-09-17T18:30:00Z'),
};
const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return {
      code: (error as { code?: string }).code,
      status: (error as { getStatus?: () => number }).getStatus?.(),
    };
  }
  return null;
};

describe('invitation token', () => {
  it('is 256 random bits in base64url, unique, and stored only as its SHA-256', () => {
    const tokens = Array.from({ length: 50 }, () => newInvitationToken());
    for (const { token, tokenHash } of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(token, 'base64url')).toHaveLength(32);
      expect(tokenHash).toBe(createHash('sha256').update(token).digest('hex'));
      expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(tokenHash).not.toContain(token);
    }
    expect(new Set(tokens.map((t) => t.token)).size).toBe(50);
  });
});

describe('invitation expiration and state', () => {
  const issued = new Date('2026-09-16T10:00:00Z');
  const expiresAt = invitationExpiry(issued, 24);
  it('expires exactly TTL hours after issuing, with now >= expiresAt already expired', () => {
    expect(expiresAt.toISOString()).toBe('2026-09-17T10:00:00.000Z');
    const pending = { status: 'PENDING' as const, expiresAt };
    expect(
      effectiveInvitationStatus(pending, new Date(expiresAt.getTime() - 1)),
    ).toBe('PENDING');
    expect(effectiveInvitationStatus(pending, expiresAt)).toBe('EXPIRED');
    expect(
      effectiveInvitationStatus(
        { status: 'ACCEPTED', expiresAt },
        new Date(expiresAt.getTime() + 1),
      ),
    ).toBe('ACCEPTED');
    expect(
      effectiveInvitationStatus({ status: 'REVOKED', expiresAt }, issued),
    ).toBe('REVOKED');
  });
  it('maps every non-activatable state to a stable domain error', () => {
    const at = (status: 'PENDING' | 'ACCEPTED' | 'REVOKED', now: Date) =>
      codeOf(() => assertActivatable({ status, expiresAt }, now));
    expect(codeOf(() => assertActivatable(null))).toEqual({
      code: 'INVITATION_TOKEN_INVALID',
      status: 400,
    });
    expect(at('PENDING', issued)).toBeNull();
    expect(at('PENDING', expiresAt)).toEqual({
      code: 'INVITATION_EXPIRED',
      status: 410,
    });
    expect(at('REVOKED', issued)).toEqual({
      code: 'INVITATION_REVOKED',
      status: 410,
    });
    expect(at('ACCEPTED', issued)).toEqual({
      code: 'INVITATION_ALREADY_ACCEPTED',
      status: 409,
    });
    expect(INVITATION_ERRORS.INVITATION_RESEND_COOLDOWN).toBe(429);
  });
  it('derives INVITED/ACTIVE/DISABLED without a status column', () => {
    expect(userAccountStatus({ active: true, hasPassword: true })).toBe(
      'ACTIVE',
    );
    expect(userAccountStatus({ active: false, hasPassword: false })).toBe(
      'INVITED',
    );
    expect(userAccountStatus({ active: false, hasPassword: true })).toBe(
      'DISABLED',
    );
  });
});

describe('invitation role policy', () => {
  it('lets SUPER_ADMIN invite PROVIDER_ADMIN/DRIVER, PROVIDER_ADMIN only DRIVER, and nobody else', () => {
    expect(canInvite('SUPER_ADMIN', 'PROVIDER_ADMIN')).toBe(true);
    expect(canInvite('SUPER_ADMIN', 'DRIVER')).toBe(true);
    expect(canInvite('PROVIDER_ADMIN', 'DRIVER')).toBe(true);
    expect(canInvite('PROVIDER_ADMIN', 'PROVIDER_ADMIN')).toBe(false);
    expect(canInvite('DRIVER', 'DRIVER')).toBe(false);
    expect(canInvite('INTEGRATION', 'DRIVER')).toBe(false);
    expect(canInvite('SUPER_ADMIN', 'SUPER_ADMIN' as never)).toBe(false);
  });
  it('reuses the bootstrap password policy', () => {
    expect([PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH]).toEqual([16, 128]);
  });
});

describe('InvitationsService guards before touching the database', () => {
  const service = (
    env: Record<string, unknown> = {
      MANDARIA_WEB_URL: 'https://web.example.com',
    },
  ) => {
    const prisma = {
      $transaction: vi.fn(),
      userInvitation: { findUnique: vi.fn().mockResolvedValue(null) },
    };
    const sender = { name: 'fake', sendUserInvitation: vi.fn() };
    return {
      prisma,
      sender,
      service: new InvitationsService(
        prisma as unknown as PrismaService,
        new ConfigService({ USER_INVITATION_TTL_HOURS: 24, ...env }),
        sender,
      ),
    };
  };
  const reject = async (promise: Promise<unknown>) =>
    promise.then(
      () => {
        throw new Error('expected rejection');
      },
      (error: { code?: string; getStatus: () => number }) => ({
        code: error.code,
        status: error.getStatus(),
      }),
    );
  it('refuses role escalation even if a caller bypasses the controller DTO', async () => {
    const { service: s, prisma } = service();
    for (const [actor, role] of [
      ['PROVIDER_ADMIN', 'PROVIDER_ADMIN'],
      ['DRIVER', 'DRIVER'],
      ['SUPER_ADMIN', 'SUPER_ADMIN'],
    ])
      expect(
        await reject(
          s.invite(
            'p',
            {
              email: 'x@example.com',
              role: role as 'DRIVER',
              driverName: 'X',
            },
            { id: 'u', role: actor },
          ),
        ),
      ).toMatchObject({ status: 403 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it('requires role-specific fields and a configured activation URL', async () => {
    const { service: s, prisma } = service();
    const actor = { id: 'u', role: 'SUPER_ADMIN' };
    for (const input of [
      { email: 'x@example.com', role: 'PROVIDER_ADMIN' as const },
      {
        email: 'x@example.com',
        role: 'PROVIDER_ADMIN' as const,
        membershipRole: 'ADMIN' as const,
        driverName: 'X',
      },
      { email: 'x@example.com', role: 'DRIVER' as const },
      {
        email: 'x@example.com',
        role: 'DRIVER' as const,
        driverName: 'X',
        membershipRole: 'OWNER' as const,
      },
    ])
      expect(await reject(s.invite('p', input, actor))).toMatchObject({
        status: 400,
      });
    // ConfigService falls back to process.env: keep a developer MANDARIA_WEB_URL out.
    vi.stubEnv('MANDARIA_WEB_URL', '');
    const unconfigured = service({});
    expect(
      await reject(
        unconfigured.service.invite(
          'p',
          { email: 'x@example.com', role: 'DRIVER', driverName: 'X' },
          actor,
        ),
      ),
    ).toEqual({ code: 'MAIL_NOT_CONFIGURED', status: 503 });
    vi.unstubAllEnvs();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(unconfigured.prisma.$transaction).not.toHaveBeenCalled();
  });
  it('rejects unknown tokens before opening a transaction', async () => {
    const { service: s, prisma } = service();
    expect(await reject(s.activate('unknown-token', 'x'.repeat(20)))).toEqual({
      code: 'INVITATION_TOKEN_INVALID',
      status: 400,
    });
    expect(prisma.userInvitation.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tokenHash: createHash('sha256').update('unknown-token').digest('hex'),
        },
      }),
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('invitation email', () => {
  it('builds {MANDARIA_WEB_URL}/activate-account?token=… keeping base paths and encoding the token', () => {
    expect(buildActivationUrl('https://web.example.com', 'a_b-C')).toBe(
      'https://web.example.com/activate-account?token=a_b-C',
    );
    expect(buildActivationUrl('https://example.com/mandaria/', 'tok')).toBe(
      'https://example.com/mandaria/activate-account?token=tok',
    );
    expect(buildActivationUrl('http://localhost:5173', 'a+b/c=')).toBe(
      'http://localhost:5173/activate-account?token=a%2Bb%2Fc%3D',
    );
  });
  it('renders role, link and expiry, escapes HTML and never mentions a password value', () => {
    const message = renderUserInvitation(mail);
    expect(message.subject).toBe('Has sido invitado a Mandaria');
    expect(message.text).toContain('Rol: Repartidor');
    expect(message.text).toContain(mail.activationUrl);
    expect(message.text).toMatch(/expira el 17 de septiembre de 2026/);
    expect(message.html).toContain('Activar cuenta');
    expect(message.html).toContain('Rápidos &lt;de&gt; &quot;Coita&quot;');
    expect(message.html).not.toContain('<de>');
    expect(
      renderUserInvitation({ ...mail, role: 'PROVIDER_ADMIN' }).text,
    ).toContain('Rol: Administrador de proveedor');
    expect(`${message.text}${message.html}`).not.toMatch(/contraseña:/i);
  });
  it('local outbox writes one private JSON file per message', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'mandaria-outbox-')), 'box');
    try {
      await new LocalOutboxMailProvider(dir).sendUserInvitation(mail);
      const files = await readdir(dir);
      expect(files).toHaveLength(1);
      const saved = JSON.parse(await readFile(join(dir, files[0]), 'utf8'));
      expect(saved).toMatchObject({
        kind: 'USER_INVITATION',
        to: mail.to,
        activationUrl: mail.activationUrl,
        subject: 'Has sido invitado a Mandaria',
      });
      if (process.platform !== 'win32')
        expect((await stat(join(dir, files[0]))).mode & 0o077).toBe(0);
    } finally {
      await rm(join(dir, '..'), { recursive: true, force: true });
    }
  });
});

describe('V1.6.1 configuration', () => {
  const base = {
    DATABASE_URL: 'postgresql://localhost/mandaria',
    JWT_ACCESS_SECRET: 'a'.repeat(40),
    JWT_REFRESH_SECRET: 'b'.repeat(40),
    INTEGRATION_JWT_SECRET: 'c'.repeat(40),
  };
  const production = {
    ...base,
    NODE_ENV: 'production',
    GOOGLE_ROUTES_API_KEY: 'k'.repeat(30),
    MAIL_PROVIDER: 'resend',
    RESEND_API_KEY: 'test-resend-key',
    MAIL_FROM: 'Mandaria <no-reply@example.com>',
    MANDARIA_WEB_URL: 'https://app.example.com/',
    B2B_WEBHOOK_SECRET_KEY: 'k'.repeat(64),
  };
  it('defaults to 24 h TTL, 60 s resend cooldown and the local outbox outside production', () => {
    expect(validateEnvironment(base)).toMatchObject({
      USER_INVITATION_TTL_HOURS: 24,
      USER_INVITATION_RESEND_COOLDOWN_SECONDS: 60,
      MAIL_PROVIDER: 'local_outbox',
    });
    expect(
      validateEnvironment({ ...base, MANDARIA_WEB_URL: '' }).MANDARIA_WEB_URL,
    ).toBeUndefined();
  });
  it('accepts a complete production mail setup and normalizes the web URL', () => {
    expect(validateEnvironment(production)).toMatchObject({
      MAIL_PROVIDER: 'resend',
      MANDARIA_WEB_URL: 'https://app.example.com',
    });
  });
  it('forbids the local outbox, missing Resend settings and non-https links in production', () => {
    const fails = (overrides: Record<string, unknown>, message: RegExp) =>
      expect(() =>
        validateEnvironment({ ...production, ...overrides }),
      ).toThrow(message);
    fails({ MAIL_PROVIDER: 'local_outbox' }, /MAIL_PROVIDER=resend/);
    fails({ MAIL_PROVIDER: undefined }, /MAIL_PROVIDER=resend/);
    fails({ RESEND_API_KEY: '' }, /RESEND_API_KEY/);
    fails({ MAIL_PROVIDER: 'smtp' }, /Invalid environment/);
    fails({ MAIL_FROM: undefined }, /MAIL_FROM/);
    fails({ MANDARIA_WEB_URL: 'http://app.example.com' }, /https/);
    fails({ MANDARIA_WEB_URL: undefined }, /https/);
  });
  it('rejects invalid ranges and web URLs with query, fragment or credentials', () => {
    for (const bad of [
      { USER_INVITATION_TTL_HOURS: 0 },
      { USER_INVITATION_TTL_HOURS: 169 },
      { USER_INVITATION_RESEND_COOLDOWN_SECONDS: -1 },
      { MAIL_PROVIDER: 'sendgrid' },
      { MANDARIA_WEB_URL: 'https://app.example.com/?token=x' },
      { MANDARIA_WEB_URL: 'https://app.example.com/#x' },
      { MANDARIA_WEB_URL: 'https://user:pass@app.example.com' },
      { MANDARIA_WEB_URL: 'ftp://app.example.com' },
    ])
      expect(() => validateEnvironment({ ...base, ...bad })).toThrow();
  });
});
