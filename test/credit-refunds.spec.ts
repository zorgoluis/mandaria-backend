import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

const { refundDispatchAward, refundLogFields } =
  await import('../dist/credits/service-refund.js');

/**
 * V1.10-E unit rules: the refund is the exact opposite of the award that was really charged, and
 * of nothing else. The transaction double has no credit policy and no snapshot, so a refund that
 * tried to recompute a price could not even run here.
 */
type Entry = { id: string; amount: number; creditAccountId: string } | null;
function txDouble(options: {
  account?: { id: string } | null;
  award?: Entry;
  refund?: { id: string; amount: number } | null;
  balance?: number;
  onCreate?: () => unknown;
}) {
  const created: Record<string, unknown>[] = [];
  const locked: string[] = [];
  const tx = {
    creditAccount: {
      findUnique: vi.fn(async () =>
        options.account === undefined ? { id: 'account-1' } : options.account,
      ),
    },
    creditLedgerEntry: {
      findFirst: vi.fn(async ({ where }: { where: { type: string } }) =>
        where.type === 'SERVICE_AWARD'
          ? (options.award ?? null)
          : (options.refund ?? null),
      ),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        if (options.onCreate) options.onCreate();
        return {
          id: 'refund-1',
          sequence: 77,
          balanceBefore: data.balanceBefore,
          balanceAfter: data.balanceAfter,
        };
      }),
    },
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
      locked.push(strings.join('?'));
      return options.balance === undefined
        ? []
        : [{ balance: options.balance }];
    }),
  } as unknown as Parameters<typeof refundDispatchAward>[0];
  return { tx, created, locked };
}
const award = { id: 'award-1', amount: -7, creditAccountId: 'account-1' };
const provider = { actorType: 'PROVIDER' as const, providerId: 'provider-1' };
const monetized = {
  id: 'dispatch-1',
  creditMode: 'MONETIZED' as const,
  claimedAt: new Date('2026-09-23T10:00:00.000Z'),
  preEnforcementAwards: [],
};

describe('V1.10-E refund of a dispatch award', () => {
  it('returns exactly what the award charged, pointing at it and never touching it', async () => {
    const { tx, created } = txDouble({ award, balance: 13 });
    const outcome = await refundDispatchAward(
      tx,
      monetized,
      provider,
      'provider-1',
      'PROVIDER_RELEASE',
      'user-1',
    );
    expect(outcome).toMatchObject({
      kind: 'refunded',
      credits: 7,
      awardEntryId: 'award-1',
      balanceBefore: 13,
      balanceAfter: 20,
      reason: 'PROVIDER_RELEASE',
    });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      type: 'SERVICE_REFUND',
      amount: 7,
      balanceBefore: 13,
      balanceAfter: 20,
      referenceType: 'DISPATCH',
      referenceId: 'dispatch-1',
      reversesEntryId: 'award-1',
      refundReason: 'PROVIDER_RELEASE',
      createdByUserId: 'user-1',
    });
  });

  it('takes the amount from the award, not from any current price', async () => {
    // The award charged 21 when the dispatch was claimed; today's policy is irrelevant here.
    const { tx, created } = txDouble({
      award: { ...award, amount: -21 },
      balance: 0,
    });
    const outcome = await refundDispatchAward(
      tx,
      monetized,
      provider,
      'provider-1',
      'DELIVERY_CANCELLED',
      null,
    );
    expect(outcome).toMatchObject({ kind: 'refunded', credits: 21 });
    expect(created[0]).toMatchObject({ amount: 21, balanceAfter: 21 });
  });

  it('locks the account before crediting it', async () => {
    const { tx, locked } = txDouble({ award, balance: 5 });
    await refundDispatchAward(
      tx,
      monetized,
      provider,
      'provider-1',
      'PROVIDER_RELEASE',
      'user-1',
    );
    expect(locked.join()).toContain('FOR UPDATE');
  });

  it('returns nothing twice: an award already refunded stays refunded once', async () => {
    const { tx, created } = txDouble({
      award,
      refund: { id: 'refund-0', amount: 7 },
      balance: 20,
    });
    const outcome = await refundDispatchAward(
      tx,
      monetized,
      provider,
      'provider-1',
      'PROVIDER_RELEASE',
      'user-1',
    );
    expect(outcome).toEqual({
      kind: 'already',
      entryId: 'refund-0',
      credits: 7,
    });
    expect(created).toHaveLength(0);
  });

  it('gives nothing back for a legacy dispatch and invents no award', async () => {
    const { tx, created } = txDouble({ award: null, balance: 0 });
    const outcome = await refundDispatchAward(
      tx,
      { ...monetized, creditMode: 'LEGACY' },
      provider,
      'provider-1',
      'PROVIDER_RELEASE',
      'user-1',
    );
    expect(outcome).toEqual({ kind: 'none', boundary: 'LEGACY' });
    expect(created).toHaveLength(0);
  });

  it('gives nothing back for a claim that predates enforcement', async () => {
    const claimedAt = new Date('2026-09-23T10:00:00.000Z');
    const { tx, created } = txDouble({ award: null, balance: 0 });
    const outcome = await refundDispatchAward(
      tx,
      {
        ...monetized,
        claimedAt,
        preEnforcementAwards: [
          {
            actorType: 'PROVIDER',
            actorId: 'provider-1',
            awardedAt: claimedAt,
          },
        ],
      },
      provider,
      'provider-1',
      'PROVIDER_RELEASE',
      'user-1',
    );
    expect(outcome).toEqual({
      kind: 'none',
      boundary: 'PRE_ENFORCEMENT_AWARD',
    });
    expect(created).toHaveLength(0);
  });

  it('fails closed when an enforced award is missing instead of passing as free', async () => {
    const { tx, created } = txDouble({ award: null, balance: 0 });
    await expect(
      refundDispatchAward(
        tx,
        monetized,
        provider,
        'provider-1',
        'PROVIDER_RELEASE',
        'user-1',
      ),
    ).rejects.toMatchObject({ code: 'CREDIT_REFUND_INTEGRITY_ERROR' });
    expect(created).toHaveLength(0);
  });

  it('fails closed when the account that paid is gone', async () => {
    const { tx } = txDouble({ account: null, award: null, balance: 0 });
    await expect(
      refundDispatchAward(
        tx,
        monetized,
        provider,
        'provider-1',
        'PROVIDER_RELEASE',
        'user-1',
      ),
    ).rejects.toMatchObject({ code: 'CREDIT_REFUND_INTEGRITY_ERROR' });
  });

  it('turns a raced duplicate into a conflict, never a second credit', async () => {
    const { tx } = txDouble({
      award,
      balance: 13,
      onCreate: () => {
        throw new Prisma.PrismaClientKnownRequestError(
          'Unique constraint failed on the fields: (`reversesEntryId`)',
          {
            code: 'P2002',
            clientVersion: Prisma.prismaVersion.client,
            meta: { target: ['reversesEntryId'] },
          },
        );
      },
    });
    await expect(
      refundDispatchAward(
        tx,
        monetized,
        provider,
        'provider-1',
        'PROVIDER_RELEASE',
        'user-1',
      ),
    ).rejects.toMatchObject({ code: 'CREDIT_MOVEMENT_CONFLICT' });
  });

  it('describes each outcome for the audit log', () => {
    expect(
      refundLogFields({
        kind: 'refunded',
        actorType: 'PROVIDER',
        creditAccountId: 'a',
        credits: 7,
        awardEntryId: 'award-1',
        entryId: 'refund-1',
        sequence: 1,
        balanceBefore: 0,
        balanceAfter: 7,
        reason: 'PROVIDER_RELEASE',
      }),
    ).toMatchObject({ event: 'SERVICE_REFUND_ISSUED', credits: 7 });
    expect(
      refundLogFields({ kind: 'already', entryId: 'r', credits: 7 }),
    ).toMatchObject({ event: 'SERVICE_REFUND_ALREADY_APPLIED' });
    expect(refundLogFields({ kind: 'none', boundary: 'LEGACY' })).toEqual({
      event: 'SERVICE_REFUND_SKIPPED_LEGACY',
    });
    expect(
      refundLogFields({ kind: 'none', boundary: 'PRE_ENFORCEMENT_AWARD' }),
    ).toEqual({ event: 'SERVICE_REFUND_SKIPPED_PRE_ENFORCEMENT' });
  });
});
