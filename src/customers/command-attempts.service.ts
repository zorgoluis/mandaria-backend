import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  customerAttempt,
  lockHumanAttempt,
  validateAttemptKey,
  attemptError,
  CREATE_MPQ,
  CONVERT_MPQ,
  ACCEPT_MQ,
  SHIPPING_POLICY,
  type HumanAttemptScope,
} from '../idempotency/human-attempt.js';
import type { CustomerAttemptQuery } from './command-attempts.dto.js';
const termsSelect = {
  payer: true,
  method: true,
  dueAt: true,
  component: true,
  termsVersion: true,
  termsHash: true,
} as const;
const quoteSelect = {
  publicId: true,
  amount: true,
  currency: true,
  expiresAt: true,
} as const;
const operations = {
  PREQUOTE_CREATE: CREATE_MPQ,
  PREQUOTE_CONVERT: CONVERT_MPQ,
  QUOTE_ACCEPT: ACCEPT_MQ,
};
@Injectable()
export class CommandAttemptsService {
  constructor(private readonly db: PrismaService) {}
  async customer(
    ownerId: string,
    actorUserId: string,
    key: string,
    q: CustomerAttemptQuery,
    close = false,
  ) {
    validateAttemptKey(key);
    if (
      (q.operation === 'PREQUOTE_CREATE' && q.resourcePublicId !== undefined) ||
      (q.operation === 'PREQUOTE_CONVERT' &&
        !q.resourcePublicId?.startsWith('MPQ-')) ||
      (q.operation === 'QUOTE_ACCEPT' && !q.resourcePublicId?.startsWith('MQ-'))
    )
      throw new BadRequestException('Operation and resource do not match');
    const s: HumanAttemptScope = {
      namespace: 'CUSTOMER',
      ownerId,
      actorUserId,
      key,
      operation: operations[q.operation],
      resource: q.resourcePublicId ?? '',
    };
    return this.db.$transaction(
      async (tx) => {
        if (
          s.operation === CONVERT_MPQ &&
          !(await tx.deliveryPrequote.findFirst({
            where: {
              publicId: s.resource,
              customerAccountId: ownerId,
              integrationClientId: null,
            },
            select: { id: true },
          }))
        )
          throw new NotFoundException();
        if (
          s.operation === ACCEPT_MQ &&
          !(await tx.deliveryQuote.findFirst({
            where: {
              publicId: s.resource,
              deliveryRequest: {
                customerAccountId: ownerId,
                integrationClientId: null,
              },
            },
            select: { id: true },
          }))
        )
          throw new NotFoundException();
        if (close)
          await customerAttempt(
            tx,
            { kind: 'CUSTOMER', id: ownerId },
            key,
            s.operation,
            s.resource,
            true,
          );
        return this.observe(tx, s, q.operation, close);
      },
      close ? undefined : { isolationLevel: 'RepeatableRead' },
    );
  }
  async policy(id: string, actorUserId: string, key: string, close = false) {
    validateAttemptKey(key);
    return this.db.$transaction(
      async (tx) => {
        if (close)
          await tx.$queryRaw`SELECT id FROM "IntegrationClient" WHERE id=${id}::uuid FOR UPDATE`;
        if (
          !(await tx.integrationClient.findUnique({
            where: { id },
            select: { id: true },
          }))
        )
          throw new NotFoundException();
        const s: HumanAttemptScope = {
          namespace: 'POLICY',
          ownerId: actorUserId,
          actorUserId,
          key,
          operation: SHIPPING_POLICY,
          resource: id,
        };
        if (close) await lockHumanAttempt(tx, s, true);
        return this.observe(tx, s, 'SHIPPING_POLICY', close);
      },
      close ? undefined : { isolationLevel: 'RepeatableRead' },
    );
  }
  private async observe(
    tx: Prisma.TransactionClient,
    s: HumanAttemptScope,
    operation: string,
    close: boolean,
  ) {
    let fence = await tx.humanCommandAttempt.findUnique({
      where: {
        namespace_ownerId_key: {
          namespace: s.namespace,
          ownerId: s.ownerId,
          key: s.key,
        },
      },
    });
    if (
      fence &&
      (fence.actorUserId !== s.actorUserId ||
        fence.operation !== s.operation ||
        fence.resource !== s.resource)
    )
      throw attemptError('COMMAND_ATTEMPT_SCOPE_CONFLICT');
    let result: Record<string, unknown> | null = null;
    let historicalRouting = false;
    if (s.namespace === 'POLICY') {
      const audit = await tx.shippingPolicyAudit.findUnique({
        where: { actorUserId_key: { actorUserId: s.actorUserId, key: s.key } },
      });
      if (audit) {
        if (audit.integrationClientId !== s.resource)
          throw attemptError('COMMAND_ATTEMPT_SCOPE_CONFLICT');
        result = { payer: audit.payer, revision: audit.revision };
      }
    } else {
      const r = await tx.apiIdempotencyRecord.findUnique({
        where: {
          customerAccountId_key: { customerAccountId: s.ownerId, key: s.key },
        },
        include: { execution: true },
      });
      if (r) {
        if (r.operation !== s.operation)
          throw attemptError('COMMAND_ATTEMPT_SCOPE_CONFLICT');
        if (s.operation === CREATE_MPQ) {
          historicalRouting =
            !!r.execution &&
            (!fence || fence.createdAt > r.createdAt) &&
            !(await tx.prequoteConsumptionPermit.findFirst({
              where: {
                humanAttemptId:
                  fence?.id ?? '00000000-0000-0000-0000-000000000000',
              },
              select: { id: true },
            }));
          const p = await tx.deliveryPrequote.findUnique({
            where: { id: r.resourceId },
          });
          if (p)
            result = {
              prequotePublicId: p.publicId,
              amount: p.amount.toFixed(2),
              currency: p.currency,
              expiresAt: p.expiresAt,
              shippingTerms: p.shippingTerms,
            };
        } else if (s.operation === CONVERT_MPQ) {
          const c = await tx.prequoteConversion.findUnique({
            where: { id: r.resourceId },
            include: {
              prequote: { select: { publicId: true } },
              deliveryRequest: {
                select: {
                  publicId: true,
                  shippingTerms: { select: termsSelect },
                },
              },
              deliveryQuote: { select: quoteSelect },
            },
          });
          if (c) {
            if (c.prequote.publicId !== s.resource)
              throw attemptError('COMMAND_ATTEMPT_SCOPE_CONFLICT');
            result = {
              prequotePublicId: c.prequote.publicId,
              deliveryRequestPublicId: c.deliveryRequest.publicId,
              deliveryQuotePublicId: c.deliveryQuote.publicId,
              amount: c.deliveryQuote.amount.toFixed(2),
              currency: c.deliveryQuote.currency,
              expiresAt: c.deliveryQuote.expiresAt,
              shippingTerms: c.deliveryRequest.shippingTerms,
            };
          }
        } else {
          const a = await tx.authorizedQuoteAcceptance.findUnique({
            where: { id: r.resourceId },
            include: {
              quote: { select: quoteSelect },
              request: {
                select: {
                  publicId: true,
                  shippingTerms: { select: termsSelect },
                },
              },
            },
          });
          if (a) {
            if (a.quote.publicId !== s.resource || a.userId !== s.actorUserId)
              throw attemptError('COMMAND_ATTEMPT_SCOPE_CONFLICT');
            result = {
              deliveryRequestPublicId: a.request.publicId,
              deliveryQuotePublicId: a.quote.publicId,
              amount: a.authorizedAmount.toFixed(2),
              currency: a.authorizedCurrency,
              expiresAt: a.authorizedExpiresAt,
              acceptedAt: a.acceptedAt,
              shippingTerms: a.request.shippingTerms,
            };
          }
        }
      }
    }
    if (result && fence?.closedAt)
      throw new Error('Applied command has a closed fence');
    if (close && !result && fence && !fence.closedAt)
      fence = await tx.humanCommandAttempt.update({
        where: { id: fence.id },
        data: {
          closedAt: new Date(),
          routingEffectsPossible:
            fence.routingEffectsPossible || historicalRouting,
        },
      });
    const state = result
      ? 'APPLIED'
      : fence?.closedAt
        ? 'CLOSED_NO_EFFECTS'
        : 'PENDING_OR_UNKNOWN';
    return {
      operation,
      resourcePublicId: s.resource || null,
      state,
      canPrepareNewAttempt: state === 'CLOSED_NO_EFFECTS',
      closureScope: 'RESOURCE_OR_POLICY_ONLY',
      routingEffects:
        fence?.routingEffectsPossible || historicalRouting
          ? 'POSSIBLE_RETAINED'
          : 'NONE_STARTED',
      closedAt: fence?.closedAt ?? null,
      result,
    };
  }
  async consentContext(ownerId: string, publicId: string) {
    return this.db.$transaction(
      async (tx) => {
        const r = await tx.deliveryRequest.findFirst({
          where: {
            publicId,
            customerAccountId: ownerId,
            integrationClientId: null,
          },
          select: {
            publicId: true,
            status: true,
            shippingTerms: { select: termsSelect },
            directLifecycle: { select: { closedAt: true } },
            prequoteConversion: {
              select: {
                prequote: { select: { publicId: true, expiresAt: true } },
                deliveryQuote: {
                  select: { ...quoteSelect, status: true, acceptedAt: true },
                },
              },
            },
          },
        });
        if (!r) throw new NotFoundException();
        const c = r.prequoteConversion;
        return {
          deliveryRequestPublicId: r.publicId,
          prequote: c?.prequote ?? null,
          quote: c
            ? { ...c.deliveryQuote, amount: c.deliveryQuote.amount.toFixed(2) }
            : null,
          shippingTerms: r.shippingTerms,
          canPrepareConsent:
            !!c &&
            r.status === 'CREATED' &&
            !r.directLifecycle?.closedAt &&
            c.deliveryQuote.status === 'OFFERED' &&
            c.deliveryQuote.expiresAt > new Date(),
          automaticAcceptance: false,
        };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }
}
