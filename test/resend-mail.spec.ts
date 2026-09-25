import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MailModule } from '../src/mail/mail.module.js';
import { MAIL_PROVIDER } from '../src/mail/mail.types.js';
import { ResendMailProvider } from '../src/mail/resend-mail.provider.js';

const mail = {
  to: 'recipient@example.com',
  role: 'DRIVER' as const,
  providerName: 'Fleet',
  activationUrl: 'https://example.com/activate-account?token=private-token',
  expiresAt: new Date('2026-10-01T00:00:00Z'),
};
const settings = {
  apiKey: 'private-api-key',
  from: 'Mandaria <sender@example.com>',
};
afterEach(() => vi.restoreAllMocks());
describe('Resend HTTPS mail', () => {
  it('binds Resend in production without requiring SMTP settings', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          ignoreEnvVars: true,
        }),
        MailModule,
      ],
    })
      .overrideProvider(ConfigService)
      .useValue(
        new ConfigService({
          NODE_ENV: 'production',
          MAIL_PROVIDER: 'resend',
          RESEND_API_KEY: settings.apiKey,
          MAIL_FROM: settings.from,
        }),
      )
      .compile();
    try {
      expect(module.get(MAIL_PROVIDER)).toBeInstanceOf(ResendMailProvider);
    } finally {
      await module.close();
    }
  });
  it.each(['smtp', 'local_outbox'])(
    'never falls back to %s in production',
    async (provider) => {
      await expect(
        Test.createTestingModule({
          imports: [
            ConfigModule.forRoot({
              isGlobal: true,
              ignoreEnvFile: true,
              ignoreEnvVars: true,
            }),
            MailModule,
          ],
        })
          .overrideProvider(ConfigService)
          .useValue(
            new ConfigService({
              NODE_ENV: 'production',
              MAIL_PROVIDER: provider,
            }),
          )
          .compile(),
      ).rejects.toThrow(
        provider === 'smtp'
          ? 'Unsupported mail provider'
          : 'local_outbox mail is not allowed in production',
      );
    },
  );
  it('sends the existing template over HTTPS and requires provider acceptance', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ id: 'email-id' }));
    await new ResendMailProvider(settings, request).sendUserInvitation(mail);
    expect(request).toHaveBeenCalledTimes(1);
    const [url, init] = request.mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: {
        Authorization: 'Bearer private-api-key',
        'Content-Type': 'application/json',
      },
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init?.body))).toMatchObject({
      from: settings.from,
      to: [mail.to],
      subject: 'Has sido invitado a Mandaria',
      html: expect.stringContaining(mail.activationUrl),
      text: expect.stringContaining(mail.activationUrl),
    });
  });
  it.each([302, 400, 401, 403, 422, 429, 500, 503])(
    'classifies HTTP %s without leaking response details or retrying',
    async (status) => {
      const request = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response('private-api-key private-token', { status }),
        );
      await expect(
        new ResendMailProvider(settings, request).sendUserInvitation(mail),
      ).rejects.toMatchObject({
        reason: `RESEND_HTTP_${status}`,
        message: `MAIL_DELIVERY_FAILED: RESEND_HTTP_${status}`,
      });
      expect(request).toHaveBeenCalledTimes(1);
    },
  );
  it.each(['not-json', '{}', '{"id":""}', '{"id":12}', 'null'])(
    'rejects invalid acceptance response %s',
    async (body) => {
      const request = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(body));
      await expect(
        new ResendMailProvider(settings, request).sendUserInvitation(mail),
      ).rejects.toMatchObject({ reason: 'RESEND_INVALID_RESPONSE' });
    },
  );
  it('sanitizes network failures', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error('private-api-key private-token'));
    await expect(
      new ResendMailProvider(settings, request).sendUserInvitation(mail),
    ).rejects.toMatchObject({
      message: 'MAIL_DELIVERY_FAILED: RESEND_NETWORK',
    });
  });
  it('bounds the entire request, including reading the response', async () => {
    const controller = new AbortController();
    const timeout = vi
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValue(controller.signal);
    const request = vi
      .fn<typeof fetch>()
      .mockImplementation(async (_url, init) => {
        const stream = new ReadableStream({
          start(c) {
            init?.signal?.addEventListener('abort', () =>
              c.error(new Error('sensitive response')),
            );
          },
        });
        return new Response(stream);
      });
    const sending = new ResendMailProvider(
      settings,
      request,
    ).sendUserInvitation(mail);
    const assertion = expect(sending).rejects.toMatchObject({
      reason: 'RESEND_TIMEOUT',
    });
    controller.abort();
    await assertion;
    expect(timeout).toHaveBeenCalledWith(20_000);
  });
});
