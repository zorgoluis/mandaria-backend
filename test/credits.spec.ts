import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CREDIT_ERRORS,
  MAX_CREDIT_BALANCE,
  MAX_CREDIT_MOVEMENT,
  isLedgerRejection,
  nextBalance,
  signAllowed,
} from '../dist/credits/credit-policy.js';
import {
  AdjustCreditsDto,
  RechargeCreditsDto,
} from '../dist/credits/credits.dto.js';
import { readIdempotencyKey } from '../dist/credits/credits.http.js';
import { CreditAccountsService } from '../dist/credits/credit-accounts.service.js';
import { fingerprint } from '../dist/idempotency/idempotency.service.js';
import {
  adminEntryView,
  ownerEntryView,
} from '../dist/credits/credits.select.js';
import type { PrismaService } from '../dist/prisma/prisma.service.js';

const errorsOf = async (cls: new () => object, body: object) =>
  (
    await validate(plainToInstance(cls, body), {
      whitelist: true,
      forbidNonWhitelisted: true,
    })
  ).map((e) => e.property);

describe('V1.10-A credit rules', () => {
  it('keeps every reachable sum inside a 32-bit INTEGER', () => {
    // The DB columns are INTEGER: the worst case balanceBefore + amount must not overflow.
    expect(MAX_CREDIT_BALANCE + MAX_CREDIT_MOVEMENT).toBeLessThan(2 ** 31 - 1);
    expect(Number.isSafeInteger(MAX_CREDIT_BALANCE)).toBe(true);
  });

  it('applies one sign convention per ledger type', () => {
    expect(signAllowed('RECHARGE', 500)).toBe(true);
    expect(signAllowed('RECHARGE', -500)).toBe(false);
    expect(signAllowed('SERVICE_REFUND', 7)).toBe(true);
    expect(signAllowed('SERVICE_REFUND', -7)).toBe(false);
    expect(signAllowed('SERVICE_AWARD', -7)).toBe(true);
    expect(signAllowed('SERVICE_AWARD', 7)).toBe(false);
    expect(signAllowed('ADMIN_ADJUSTMENT', 50)).toBe(true);
    expect(signAllowed('ADMIN_ADJUSTMENT', -20)).toBe(true);
    for (const type of [
      'RECHARGE',
      'SERVICE_AWARD',
      'SERVICE_REFUND',
      'ADMIN_ADJUSTMENT',
    ] as const) {
      expect(signAllowed(type, 0)).toBe(false);
      expect(signAllowed(type, 1.5)).toBe(false);
    }
  });

  it('never lets a balance go negative or past the maximum', () => {
    expect(nextBalance(10, -8)).toEqual({ balanceAfter: 2 });
    expect(nextBalance(2, -8)).toEqual({ rejection: 'INSUFFICIENT_CREDITS' });
    expect(nextBalance(0, -1)).toEqual({ rejection: 'INSUFFICIENT_CREDITS' });
    expect(nextBalance(MAX_CREDIT_BALANCE, 1)).toEqual({
      rejection: 'CREDIT_BALANCE_LIMIT',
    });
    expect(nextBalance(MAX_CREDIT_BALANCE - 1, 1)).toEqual({
      balanceAfter: MAX_CREDIT_BALANCE,
    });
  });

  it('reports every credit conflict as 409 and a missing account as 404', () => {
    const { CREDIT_ACCOUNT_NOT_FOUND, ...conflicts } = CREDIT_ERRORS;
    expect(CREDIT_ACCOUNT_NOT_FOUND).toBe(404);
    expect(new Set(Object.values(conflicts))).toEqual(new Set([409]));
  });

  it('recognizes a PostgreSQL ledger guard or CHECK, not an ordinary failure', () => {
    expect(isLedgerRejection({ message: 'P0001 CREDIT_LEDGER_STALE' })).toBe(
      true,
    );
    expect(
      isLedgerRejection({
        message: 'violates check constraint "CreditAccount_balance_check"',
      }),
    ).toBe(true);
    expect(isLedgerRejection({ message: 'connection reset' })).toBe(false);
    expect(isLedgerRejection(undefined)).toBe(false);
  });
});

describe('V1.10-A request validation', () => {
  it('accepts whole credits only, within limits, and never as text', async () => {
    const ok = { credits: 500, method: 'TRANSFER' };
    expect(await errorsOf(RechargeCreditsDto, ok)).toEqual([]);
    for (const credits of [
      0,
      -5,
      1.5,
      7.25,
      0.01,
      '10',
      MAX_CREDIT_MOVEMENT + 1,
      null,
      true,
    ])
      expect(await errorsOf(RechargeCreditsDto, { ...ok, credits })).toContain(
        'credits',
      );
    expect(
      await errorsOf(RechargeCreditsDto, {
        ...ok,
        credits: MAX_CREDIT_MOVEMENT,
      }),
    ).toEqual([]);
  });

  it('requires a reason only when the recharge method is OTHER', async () => {
    expect(
      await errorsOf(RechargeCreditsDto, { credits: 5, method: 'CASH' }),
    ).toEqual([]);
    expect(
      await errorsOf(RechargeCreditsDto, { credits: 5, method: 'OTHER' }),
    ).toContain('reason');
    expect(
      await errorsOf(RechargeCreditsDto, {
        credits: 5,
        method: 'OTHER',
        reason: 'Pago en especie',
      }),
    ).toEqual([]);
    expect(
      await errorsOf(RechargeCreditsDto, { credits: 5, method: 'PAYPAL' }),
    ).toContain('method');
  });

  it('rejects control characters that could forge log lines', async () => {
    const newline = String.fromCharCode(10);
    expect(
      await errorsOf(RechargeCreditsDto, {
        credits: 5,
        method: 'TRANSFER',
        externalReference: `SPEI${newline}{"event":"FAKE"}`,
      }),
    ).toContain('externalReference');
    expect(
      await errorsOf(AdjustCreditsDto, {
        amount: 5,
        reason: `ok${String.fromCharCode(0)}x`,
      }),
    ).toContain('reason');
  });

  it('adjustments are signed, never zero, and always explain themselves', async () => {
    expect(
      await errorsOf(AdjustCreditsDto, { amount: -20, reason: 'Correccion' }),
    ).toEqual([]);
    expect(
      await errorsOf(AdjustCreditsDto, { amount: 50, reason: 'Bonificacion' }),
    ).toEqual([]);
    for (const amount of [0, -0, 1.5, '5', MAX_CREDIT_MOVEMENT + 1])
      expect(
        await errorsOf(AdjustCreditsDto, { amount, reason: 'Correccion' }),
      ).toContain('amount');
    expect(await errorsOf(AdjustCreditsDto, { amount: 5 })).toContain('reason');
    expect(
      await errorsOf(AdjustCreditsDto, { amount: 5, reason: 'x' }),
    ).toContain('reason');
  });

  it('rejects any attempt to name the account, its owner or its balance', async () => {
    for (const forged of [
      { ownerType: 'PROVIDER' },
      { providerId: '6c1f2f7e-2a0d-4c55-9a3b-7d1c9e0f4b21' },
      { creditAccountId: '6c1f2f7e-2a0d-4c55-9a3b-7d1c9e0f4b21' },
      { balance: 1000000 },
      { createdByUserId: '6c1f2f7e-2a0d-4c55-9a3b-7d1c9e0f4b21' },
    ]) {
      const errors = await errorsOf(RechargeCreditsDto, {
        credits: 5,
        method: 'CASH',
        ...forged,
      });
      expect(errors).toContain(Object.keys(forged)[0]);
    }
  });

  it('requires a well-formed Idempotency-Key and refuses repeated headers', () => {
    expect(readIdempotencyKey('6c1f2f7e-2a0d-4c55-9a3b')).toBe(
      '6c1f2f7e-2a0d-4c55-9a3b',
    );
    for (const bad of [
      undefined,
      '',
      'short',
      'has space in it',
      'a'.repeat(256),
      ['key-one-aaaa', 'key-two-bbbb'],
    ])
      expect(() => readIdempotencyKey(bad as never)).toThrow();
  });
});

describe('V1.10-A views', () => {
  const entry = {
    id: 'e',
    sequence: 7,
    creditAccountId: 'acc',
    type: 'RECHARGE' as const,
    amount: 500,
    balanceBefore: 0,
    balanceAfter: 500,
    rechargeMethod: 'TRANSFER' as const,
    externalReference: 'SPEI 1',
    reason: null,
    referenceType: null,
    referenceId: null,
    createdByUserId: 'admin',
    idempotencyKey: 'key-12345678',
    requestHash: 'h'.repeat(64),
    createdAt: new Date(),
  };
  it('never exposes the request fingerprint, and hides admin internals from owners', () => {
    const owner = ownerEntryView(entry);
    const admin = adminEntryView(entry);
    expect(owner).not.toHaveProperty('requestHash');
    expect(admin).not.toHaveProperty('requestHash');
    expect(owner).not.toHaveProperty('createdByUserId');
    expect(owner).not.toHaveProperty('idempotencyKey');
    expect(admin).toMatchObject({
      createdByUserId: 'admin',
      idempotencyKey: 'key-12345678',
    });
    // Credits are integers with no currency anywhere.
    expect(JSON.stringify(admin)).not.toMatch(/currency|MXN|"\d+\.\d+"/);
  });
});

/** Transaction double: $queryRaw returns queued rows; the ledger model is scripted per test. */
function service(options: {
  balance: number | null;
  byKey?: unknown[];
  create?: () => unknown;
}) {
  const byKey = vi.fn();
  for (const value of options.byKey ?? []) byKey.mockResolvedValueOnce(value);
  byKey.mockResolvedValue(null);
  const create = vi.fn<(args: { data: Record<string, unknown> }) => unknown>(
    options.create ??
      ((args: { data: Record<string, unknown> }) => ({
        id: 'new',
        sequence: 1,
        ...args.data,
      })),
  );
  const client = {
    $queryRaw: vi.fn(async () =>
      options.balance === null ? [] : [{ balance: options.balance }],
    ),
    creditLedgerEntry: { findUnique: byKey, create },
    creditAccount: {
      findUniqueOrThrow: vi.fn().mockResolvedValue({
        id: 'acc',
        ownerType: 'PROVIDER',
        providerId: 'p',
        independentDriverProfileId: null,
        balance: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    },
  };
  const prisma = {
    ...client,
    $transaction: (fn: (t: typeof client) => unknown) => fn(client),
  } as unknown as PrismaService;
  return { svc: new CreditAccountsService(prisma), create };
}

describe('V1.10-A movements', () => {
  const actor = { userId: 'admin' };

  it('refuses a debit that would leave a negative balance, writing nothing', async () => {
    const { svc, create } = service({ balance: 2 });
    await expect(
      svc.adjust(
        'acc',
        { amount: -8, reason: 'Correccion' },
        'key-1234',
        actor,
      ),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'INSUFFICIENT_CREDITS' },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('writes balanceBefore from the locked row and balanceAfter from the arithmetic', async () => {
    const { svc, create } = service({ balance: 10 });
    const result = await svc.recharge(
      'acc',
      { credits: 5, method: 'CASH' },
      'key-1234',
      actor,
    );
    expect(result.replayed).toBe(false);
    expect(create.mock.lastCall![0].data).toMatchObject({
      type: 'RECHARGE',
      amount: 5,
      balanceBefore: 10,
      balanceAfter: 15,
      rechargeMethod: 'CASH',
      createdByUserId: 'admin',
      idempotencyKey: 'key-1234',
    });
  });

  it('replays the original entry for the same key and request, without writing', async () => {
    const payload = {
      type: 'RECHARGE',
      amount: 5,
      rechargeMethod: 'CASH',
      externalReference: null,
      reason: null,
    };
    const original = {
      id: 'orig',
      requestHash: fingerprint('credits.recharge', payload),
    };
    const { svc, create } = service({ balance: 10, byKey: [original] });
    const result = await svc.recharge(
      'acc',
      { credits: 5, method: 'CASH' },
      'key-1234',
      actor,
    );
    expect(result.replayed).toBe(true);
    expect(result.entry.id).toBe('orig');
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects the same key with a different request', async () => {
    const { svc, create } = service({
      balance: 10,
      byKey: [{ id: 'orig', requestHash: 'x'.repeat(64) }],
    });
    await expect(
      svc.recharge('acc', { credits: 6, method: 'CASH' }, 'key-1234', actor),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'CREDIT_IDEMPOTENCY_CONFLICT' },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('turns a ledger guard firing into a 409 conflict, never a 500', async () => {
    const { svc } = service({
      balance: 10,
      create: () => {
        throw new Error(
          'Raw query failed. Code: `P0001`. Message: `ERROR: CREDIT_LEDGER_STALE: balanceBefore does not match`',
        );
      },
    });
    await expect(
      svc.recharge('acc', { credits: 5, method: 'CASH' }, 'key-1234', actor),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'CREDIT_MOVEMENT_CONFLICT' },
    });
  });
});
