import { describe, it, expect } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Prisma } from '@prisma/client';
import { AcceptDeliveryQuoteDto } from '../src/delivery-quotes/authorized-acceptance.dto.js';
import { mapAuthorizedAcceptanceError } from '../src/delivery-quotes/authorized-acceptance.service.js';
const valid = {
  customerAuthorization: {
    version: 1,
    status: 'AUTHORIZED_BY_CUSTOMER',
    reference: 'consent',
    authorizedAt: '2026-09-29T00:00:00.000Z',
    quotePublicId: 'MQ-000123',
    amount: '25.00',
    currency: 'MXN',
    expiresAt: '2026-09-29T00:15:00.000Z',
  },
};
const errors = (value: object) =>
  validate(plainToInstance(AcceptDeliveryQuoteDto, value), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
describe('authorized quote acceptance contract', () => {
  it('keeps legacy empty payload and validates exact attestation structure', async () => {
    expect(await errors({})).toEqual([]);
    expect(await errors(valid)).toEqual([]);
  });
  it.each([
    { customerAuthorization: null },
    { customerAuthorization: { ...valid.customerAuthorization, amount: 25 } },
    {
      customerAuthorization: {
        ...valid.customerAuthorization,
        authorizedAt: '2026-09-29',
      },
    },
    { customerAuthorization: { ...valid.customerAuthorization, version: '1' } },
    { ...valid, authenticatedTokenExpiresAt: '2099-01-01' },
    {
      customerAuthorization: {
        ...valid.customerAuthorization,
        credentialId: 'forged',
      },
    },
  ])('rejects malformed/untrusted input %#', async (body) => {
    expect((await errors(body)).length).toBeGreaterThan(0);
  });
  it('only maps exact recognized SQL business errors', () => {
    const error = new Prisma.PrismaClientUnknownRequestError(
      'Error in connector: Error querying the database: ERROR: QUOTE_EXPIRED\n',
      { clientVersion: 'test' },
    );
    expect(mapAuthorizedAcceptanceError(error)).toMatchObject({
      code: 'QUOTE_EXPIRED',
    });
    const unknown = new Prisma.PrismaClientUnknownRequestError(
      'some error containing QUOTE_EXPIRED in a parameter',
      { clientVersion: 'test' },
    );
    expect(mapAuthorizedAcceptanceError(unknown)).toBe(unknown);
    const unique = new Prisma.PrismaClientKnownRequestError('unique failed', {
      code: 'P2002',
      clientVersion: 'test',
    });
    expect(mapAuthorizedAcceptanceError(unique)).toBe(unique);
  });
  it('maps known transaction timeout, not arbitrary database failure, to retryable service error', () => {
    expect(
      mapAuthorizedAcceptanceError(
        new Prisma.PrismaClientKnownRequestError('tx timeout', {
          code: 'P2028',
          clientVersion: 'test',
        }),
      ),
    ).toMatchObject({ code: 'AUTHORIZED_ACCEPT_UNAVAILABLE' });
    const error = new Error('query failed');
    expect(mapAuthorizedAcceptanceError(error)).toBe(error);
  });
});
