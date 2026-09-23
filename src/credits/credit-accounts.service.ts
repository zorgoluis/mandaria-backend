import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CreditAccountOwnerType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { pageResult } from '../common/pagination.dto.js';
import { fingerprint } from '../idempotency/idempotency.service.js';
import { isUniqueViolation } from '../providers/provider-capacity.js';
import { DomainException } from '../common/domain-error.js';
import {
  creditError,
  isLedgerRejection,
  nextBalance,
} from './credit-policy.js';
import type { HumanMovement } from './credit-policy.js';
import {
  adminEntryView,
  creditAccountSelect,
  creditEntrySelect,
  ownerEntryView,
} from './credits.select.js';
import type {
  CreditAccountRecord,
  CreditEntryRecord,
} from './credits.select.js';

type Actor = { userId: string };
type LedgerQuery = { page: number; pageSize: number };
/** Who is reading a ledger decides which fields it sees (see credits.select.ts). */
type Audience = 'ADMIN' | 'OWNER';

const NO_PERSONAL_ACCOUNT =
  'This driver has no personal credit account: fleet drivers operate on their provider account, and an independent driver gets one once approved';

@Injectable()
export class CreditAccountsService {
  private readonly logger = new Logger(CreditAccountsService.name);
  constructor(private readonly prisma: PrismaService) {}

  // ------------------------------------------------------------------ resolution
  // Every account is resolved from an owner the caller is authorized for (route + guards), never
  // from an account id or an ownerType sent by the client.

  async accountIdForProvider(providerId: string) {
    const provider = await this.prisma.deliveryProvider.findUnique({
      where: { id: providerId },
      select: { creditAccount: { select: { id: true } } },
    });
    if (!provider) throw new NotFoundException('Provider not found');
    // Created with the provider (trigger) and backfilled by the migration; missing means corruption.
    if (!provider.creditAccount)
      throw creditError(
        'CREDIT_ACCOUNT_NOT_FOUND',
        'Provider has no credit account',
      );
    return provider.creditAccount.id;
  }

  /** SUPER_ADMIN path, mirroring /admin/drivers/:driverId/independent. */
  async accountIdForIndependentDriver(driverId: string) {
    const driver = await this.prisma.driver.findUnique({
      where: { id: driverId },
      select: {
        independentProfile: {
          select: { creditAccount: { select: { id: true } } },
        },
      },
    });
    if (!driver) throw new NotFoundException('Driver not found');
    if (!driver.independentProfile)
      throw new NotFoundException('Independent driver profile not found');
    if (!driver.independentProfile.creditAccount)
      throw creditError('CREDIT_ACCOUNT_NOT_FOUND', NO_PERSONAL_ACCOUNT);
    return driver.independentProfile.creditAccount.id;
  }

  /**
   * DRIVER self path. Reading does not require the profile to be APPROVED today: a suspended or
   * rejected independent keeps its balance and history (§27) and may still see them. Operating on
   * them is a separate question, decided when credits are consumed (V1.10-D).
   */
  async accountIdForDriverUser(userId: string) {
    const driver = await this.prisma.driver.findUnique({
      where: { userId },
      select: {
        independentProfile: {
          select: { creditAccount: { select: { id: true } } },
        },
      },
    });
    if (!driver) throw new NotFoundException('Driver profile not found');
    const accountId = driver.independentProfile?.creditAccount?.id;
    if (!accountId)
      throw creditError('CREDIT_ACCOUNT_NOT_FOUND', NO_PERSONAL_ACCOUNT);
    return accountId;
  }

  // ------------------------------------------------------------------ reads

  async account(accountId: string) {
    const account = await this.prisma.creditAccount.findUniqueOrThrow({
      where: { id: accountId },
      select: creditAccountSelect,
    });
    return accountView(account);
  }

  /** Newest first, paginated; ordered by sequence, the order movements were really applied in. */
  async ledger(accountId: string, query: LedgerQuery, audience: Audience) {
    const where: Prisma.CreditLedgerEntryWhereInput = {
      creditAccountId: accountId,
    };
    const [items, total] = await this.prisma.$transaction(
      [
        this.prisma.creditLedgerEntry.findMany({
          where,
          select: creditEntrySelect,
          orderBy: { sequence: 'desc' },
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
        }),
        this.prisma.creditLedgerEntry.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    return pageResult(
      items.map(audience === 'ADMIN' ? adminEntryView : ownerEntryView),
      total,
      query,
    );
  }

  // ------------------------------------------------------------------ movements

  recharge(
    accountId: string,
    input: {
      credits: number;
      method: 'TRANSFER' | 'CASH' | 'OTHER';
      externalReference?: string;
      reason?: string;
    },
    idempotencyKey: string,
    actor: Actor,
  ) {
    return this.move(
      accountId,
      {
        type: 'RECHARGE',
        amount: input.credits,
        rechargeMethod: input.method,
        externalReference: input.externalReference ?? null,
        reason: input.reason ?? null,
      },
      idempotencyKey,
      actor,
    );
  }

  adjust(
    accountId: string,
    input: { amount: number; reason: string },
    idempotencyKey: string,
    actor: Actor,
  ) {
    return this.move(
      accountId,
      { type: 'ADMIN_ADJUSTMENT', amount: input.amount, reason: input.reason },
      idempotencyKey,
      actor,
    );
  }

  /**
   * The only way a balance changes (§11-§13), in one transaction:
   *   lock the account row FOR UPDATE -> read balanceBefore -> validate -> compute balanceAfter ->
   *   insert the ledger entry, whose trigger moves the balance in the same statement -> commit.
   * The row lock serializes every movement of the account, so two debits built from the same
   * balance cannot both pass: the second one reads the first one's result. In PostgreSQL the ledger
   * trigger re-checks that balanceBefore is still the account's balance, and the CHECKs keep the
   * balance within 0..MAX, so no writer — this one or any other — can produce a negative balance or
   * a lost update.
   *
   * Idempotency (§29-§30): the Idempotency-Key is unique per account in the ledger itself. A repeat
   * with the same key and the same request replays the original entry; the same key with a
   * different request is a 409. The key is checked again under the lock, and the unique index
   * settles the case where two copies race past both checks.
   */
  private async move(
    accountId: string,
    movement: HumanMovement,
    idempotencyKey: string,
    actor: Actor,
  ) {
    const requestHash = fingerprint(
      `credits.${movement.type.toLowerCase()}`,
      movement,
    );
    const prior = await this.byKey(this.prisma, accountId, idempotencyKey);
    if (prior) return this.replay(accountId, prior, requestHash);
    let outcome: {
      entry: CreditEntryRecord;
      replayed: boolean;
    };
    try {
      outcome = await this.prisma.$transaction(async (tx) => {
        const [locked] = await tx.$queryRaw<
          { balance: number }[]
        >`SELECT balance FROM "CreditAccount" WHERE id = ${accountId}::uuid FOR UPDATE`;
        if (!locked)
          throw creditError(
            'CREDIT_ACCOUNT_NOT_FOUND',
            'Credit account not found',
          );
        const raced = await this.byKey(tx, accountId, idempotencyKey);
        if (raced) return { entry: raced, replayed: true };
        const next = nextBalance(locked.balance, movement.amount);
        if ('rejection' in next) {
          this.logger.warn({
            event: 'CREDIT_MOVEMENT_REJECTED',
            code: next.rejection,
            creditAccountId: accountId,
            type: movement.type,
            amount: movement.amount,
            balance: locked.balance,
            actorUserId: actor.userId,
          });
          throw creditError(
            next.rejection,
            next.rejection === 'INSUFFICIENT_CREDITS'
              ? `Insufficient credits: balance ${locked.balance}, movement ${movement.amount}`
              : 'The movement would exceed the maximum credit balance',
          );
        }
        const entry = await tx.creditLedgerEntry.create({
          data: {
            creditAccountId: accountId,
            type: movement.type,
            amount: movement.amount,
            balanceBefore: locked.balance,
            balanceAfter: next.balanceAfter,
            rechargeMethod:
              movement.type === 'RECHARGE' ? movement.rechargeMethod : null,
            externalReference:
              movement.type === 'RECHARGE' ? movement.externalReference : null,
            reason: movement.reason,
            createdByUserId: actor.userId,
            idempotencyKey,
            requestHash,
          },
          select: creditEntrySelect,
        });
        return { entry, replayed: false };
      });
    } catch (error) {
      // Domain rejections decided under the lock (insufficient credits, limit) are final answers.
      if (error instanceof DomainException) throw error;
      if (isUniqueViolation(error)) {
        const winner = await this.byKey(this.prisma, accountId, idempotencyKey);
        if (winner) return this.replay(accountId, winner, requestHash);
      }
      // A PostgreSQL guard or CHECK should never fire under the lock; if one does, the movement
      // lost a race against some other writer, which is a conflict, never a 500.
      if (isLedgerRejection(error))
        throw creditError(
          'CREDIT_MOVEMENT_CONFLICT',
          'The credit account changed while applying the movement; retry with the same Idempotency-Key',
        );
      throw error;
    }
    if (outcome.replayed)
      return this.replay(accountId, outcome.entry, requestHash);
    const account = await this.account(accountId);
    this.logger.log({
      event:
        movement.type === 'RECHARGE' ? 'CREDIT_RECHARGED' : 'CREDIT_ADJUSTED',
      creditAccountId: accountId,
      ownerType: account.ownerType,
      ownerId: account.providerId ?? account.independentDriverProfileId,
      entryId: outcome.entry.id,
      sequence: outcome.entry.sequence,
      amount: outcome.entry.amount,
      balanceBefore: outcome.entry.balanceBefore,
      balanceAfter: outcome.entry.balanceAfter,
      rechargeMethod: outcome.entry.rechargeMethod,
      externalReference: outcome.entry.externalReference,
      actorUserId: actor.userId,
    });
    return { account, entry: adminEntryView(outcome.entry), replayed: false };
  }

  private byKey(
    db: Prisma.TransactionClient | PrismaService,
    accountId: string,
    idempotencyKey: string,
  ) {
    return db.creditLedgerEntry.findUnique({
      where: {
        creditAccountId_idempotencyKey: {
          creditAccountId: accountId,
          idempotencyKey,
        },
      },
      select: creditEntrySelect,
    });
  }

  private async replay(
    accountId: string,
    entry: CreditEntryRecord,
    requestHash: string,
  ) {
    if (entry.requestHash !== requestHash) {
      this.logger.warn({
        event: 'CREDIT_IDEMPOTENCY_CONFLICT',
        creditAccountId: accountId,
        entryId: entry.id,
      });
      throw creditError(
        'CREDIT_IDEMPOTENCY_CONFLICT',
        'Idempotency-Key was already used on this account with a different request',
      );
    }
    this.logger.log({
      event: 'CREDIT_MOVEMENT_REPLAYED',
      creditAccountId: accountId,
      entryId: entry.id,
    });
    return {
      account: await this.account(accountId),
      entry: adminEntryView(entry),
      replayed: true,
    };
  }
}

/** Whole credits, never money: there is no currency and no decimal anywhere in this view. */
export function accountView(account: CreditAccountRecord) {
  return {
    id: account.id,
    ownerType: account.ownerType as CreditAccountOwnerType,
    providerId: account.providerId,
    independentDriverProfileId: account.independentDriverProfileId,
    balance: account.balance,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}
