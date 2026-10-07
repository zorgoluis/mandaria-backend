import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AuthorizedAcceptanceService } from '../src/delivery-quotes/authorized-acceptance.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { IdempotencyService } from '../src/idempotency/idempotency.service.js';
import { DeliveryQuotesService } from '../src/delivery-quotes/delivery-quotes.service.js';
import type { IntegrationRequest } from '../src/integrations/integration.guard.js';

describe('C3 exact clock boundaries (simulated DB clock, not physical synchronization)', () => {
  it.each(['quote', 'token', 'credential'] as const)(
    '%s expires exactly at DB now: rejects before evidence',
    async (boundary) => {
      const now = new Date('2026-09-29T00:00:00.000Z'),
        future = new Date(now.getTime() + 60000);
      const create = vi.fn();
      const tx = {
        $queryRaw: vi
          .fn()
          .mockResolvedValueOnce([{ status: 'ACTIVE' }])
          .mockResolvedValueOnce([
            {
              clientId: 'owner',
              status: 'ACTIVE',
              revokedAt: null,
              expiresAt: boundary === 'credential' ? now : future,
              scopes: ['quotes:accept'],
            },
          ])
          .mockResolvedValueOnce([{ status: 'CREATED' }])
          .mockResolvedValueOnce([{ id: 'quote' }])
          .mockResolvedValueOnce([{ status: 'ACTIVE' }])
          .mockResolvedValueOnce([{ now }]),
        deliveryQuote: {
          findUniqueOrThrow: vi.fn().mockResolvedValue({
            id: 'quote',
            status: 'OFFERED',
            expiresAt: boundary === 'quote' ? now : future,
          }),
        },
        authorizedQuoteAcceptance: {
          findUnique: vi.fn().mockResolvedValue(null),
          create,
        },
      };
      const principal: IntegrationRequest['integration'] = {
        id: 'owner',
        name: 'fixture',
        code: 'C3',
        status: 'ACTIVE',
        createdAt: now,
        updatedAt: now,
        scopes: ['quotes:accept'],
        authentication: {
          credentialId: 'credential',
          tokenExpiresAt: boundary === 'token' ? now : future,
          tokenScopes: ['quotes:accept'],
        },
      };
      const module = await Test.createTestingModule({
        providers: [
          AuthorizedAcceptanceService,
          {
            provide: PrismaService,
            useValue: {
              deliveryShippingTerms: { findUnique: async () => null },
            },
          },
          { provide: ConfigService, useValue: { get: () => true } },
          {
            provide: DeliveryQuotesService,
            useValue: {
              getOwned: async () => ({
                prequoteConversion: {},
                deliveryRequestId: 'request',
                id: 'quote',
              }),
            },
          },
          {
            provide: IdempotencyService,
            useValue: {
              execute: async (
                _scope: unknown,
                _payload: unknown,
                callback: (t: typeof tx, id: string) => Promise<void>,
              ) => callback(tx, 'evidence'),
            },
          },
        ],
      }).compile();
      try {
        const service = module.get(AuthorizedAcceptanceService);
        const call = service.accept('MQ-000001', principal, 'c3-boundary-key', {
          customerAuthorization: {
            version: 1,
            status: 'AUTHORIZED_BY_CUSTOMER',
            reference: 'fixture',
            authorizedAt: now.toISOString(),
            quotePublicId: 'MQ-000001',
            amount: '25.00',
            currency: 'MXN',
            expiresAt: now.toISOString(),
          },
        });
        if (boundary === 'quote')
          await expect(call).rejects.toMatchObject({ code: 'QUOTE_EXPIRED' });
        else await expect(call).rejects.toMatchObject({ status: 401 });
        expect(create).not.toHaveBeenCalled();
      } finally {
        await module.close();
      }
    },
  );
});
