import { Injectable } from '@nestjs/common';
import {
  Prisma,
  type BusinessCommandReceipt,
  type BusinessApplication,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { DomainException } from '../common/domain-error.js';
import { fingerprint } from '../idempotency/idempotency.service.js';
import { businessProjection } from './business-policy.js';
import type { AuthenticatedRequest } from '../auth/auth.guards.js';
export type BusinessOperation =
  | 'SUBMIT'
  | 'WITHDRAW'
  | 'DECIDE'
  | 'REVOKE'
  | 'DOWNGRADE'
  | 'ALLOW_REAPPLICATION';
type Payload = {
  expectedAccountRevision?: number;
  expectedApplicationRevision?: number;
  expectedRevision?: number;
  type?: string;
  businessName?: string;
  activity?: string;
  city?: string;
  estimatedDeliveryVolume?: string;
  note?: string;
  decision?: string;
  publicReason?: string;
  internalNote?: string;
  grantId?: string;
  revokedGrantId?: string;
};
const fail = (code: string, status = 409) =>
  new DomainException(code, status, code);
export const businessReceipt = (r: BusinessCommandReceipt) => ({
  key: r.key,
  operation: r.operation,
  outcome: r.outcome,
  code: r.code,
  resourceId: r.resourceId,
  committedAt: r.committedAt,
  result: r.result,
});
export const publicApplication = (a: BusinessApplication) => ({
  id: a.id,
  status: a.status,
  revision: a.revision,
  submittedAt: a.submittedAt,
  resolvedAt: a.resolvedAt,
  snapshot: a.snapshot,
  publicReason: a.publicReason,
});
@Injectable()
export class BusinessService {
  constructor(private readonly db: PrismaService) {}
  async ownAccount(userId: string) {
    const c = await this.db.customerAccount.findUnique({
      where: { userId },
      include: { user: true },
    });
    if (!c?.active || !c.user.active || !c.user.emailVerifiedAt)
      throw fail('CUSTOMER_ACCESS_DENIED', 403);
    return c.id;
  }
  async applicationAccount(id: string) {
    const a = await this.db.businessApplication.findUnique({ where: { id } });
    if (!a) throw fail('NOT_FOUND', 404);
    return a.customerAccountId;
  }
  private async authorize(
    tx: Prisma.TransactionClient,
    req: AuthenticatedRequest,
    id: string,
    admin: boolean,
  ) {
    await tx.$queryRaw`SELECT id FROM "CustomerAccount" WHERE id=${id}::uuid FOR UPDATE`;
    let c = await tx.customerAccount.findUnique({
      where: { id },
      include: { user: true },
    });
    if (!c) throw fail('NOT_FOUND', 404);
    await tx.$queryRaw`SELECT id FROM "User" WHERE id IN (${req.user.id}::uuid,${c.userId}::uuid) ORDER BY id FOR SHARE`;
    c = await tx.customerAccount.findUniqueOrThrow({
      where: { id },
      include: { user: true },
    });
    const u = await tx.user.findUnique({ where: { id: req.user.id } });
    if (
      !u?.active ||
      u.sessionVersion !== req.authentication.sessionVersion ||
      req.authentication.tokenExpiresAt <= new Date()
    )
      throw fail('UNAUTHORIZED', 401);
    if (admin) {
      if (u.role !== 'SUPER_ADMIN') throw fail('FORBIDDEN', 403);
    } else if (c.userId !== u.id) throw fail('NOT_FOUND', 404);
    else if (!c.active || !u.emailVerifiedAt)
      throw fail('CUSTOMER_ACCESS_DENIED', 403);
    return c;
  }
  private async scope(
    tx: Prisma.TransactionClient,
    id: string,
    op: BusinessOperation,
    target: string | undefined,
    admin: boolean,
  ) {
    if (admin !== ['DECIDE', 'REVOKE', 'ALLOW_REAPPLICATION'].includes(op))
      throw fail('VALIDATION_ERROR', 400);
    if (op === 'SUBMIT') {
      if (target !== undefined) throw fail('VALIDATION_ERROR', 400);
    } else if (!target) throw fail('VALIDATION_ERROR', 400);
    else if (['WITHDRAW', 'DECIDE'].includes(op)) {
      if (
        !(await tx.businessApplication.findFirst({
          where: { id: target, customerAccountId: id },
        }))
      )
        throw fail('NOT_FOUND', 404);
    } else if (target !== id) throw fail('NOT_FOUND', 404);
  }
  async command(
    req: AuthenticatedRequest,
    id: string,
    op: BusinessOperation,
    target: string | undefined,
    key: string,
    p: Payload,
    admin = false,
    close = false,
  ) {
    if (typeof key !== 'string' || !/^[!-~]{8,255}$/.test(key))
      throw fail('IDEMPOTENCY_KEY_INVALID', 400);
    const namespace = admin ? 'BUSINESS_ADMIN' : 'BUSINESS_CUSTOMER',
      ownerId = admin ? req.user.id : id;
    const hash = fingerprint('business.v1', {
      operation: op,
      target: target ?? null,
      payload: p,
    });
    return this.db.$transaction(
      async (tx) => {
        await this.authorize(tx, req, id, admin);
        await this.scope(tx, id, op, target, admin);
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${namespace + ':' + ownerId + ':' + key},0))::text`;
        let c = await this.authorize(tx, req, id, admin);
        const old = await tx.businessCommandReceipt.findUnique({
          where: { namespace_ownerId_key: { namespace, ownerId, key } },
        });
        if (old) {
          if (
            old.operation !== op ||
            old.customerAccountId !== id ||
            old.target !== (target ?? null) ||
            (!close && old.outcome !== 'CLOSED' && old.requestHash !== hash)
          )
            throw fail('IDEMPOTENCY_KEY_REUSED');
          return { receipt: old, replayed: true };
        }
        const [{ now }] = await tx.$queryRaw<
          { now: Date }[]
        >`SELECT date_trunc('milliseconds',clock_timestamp() AT TIME ZONE 'UTC') as now`;
        const blank = {
          applicationStatus: null,
          applicationRevision: null,
          accountRevision: null,
          accessState: null,
          accountType: null,
          grantId: null,
          reapplicationBlocked: null,
        };
        const receiptId = randomUUID();
        if (close) {
          const receipt = await tx.businessCommandReceipt.create({
            data: {
              id: receiptId,
              namespace,
              ownerId,
              customerAccountId: id,
              actorUserId: req.user.id,
              key,
              operation: op,
              target: target ?? null,
              requestHash: null,
              outcome: 'CLOSED',
              code: 'BUSINESS_ATTEMPT_CLOSED',
              httpStatus: 409,
              resourceId: op === 'SUBMIT' ? null : target,
              result: blank,
              committedAt: now,
            },
          });
          return { receipt, replayed: false };
        }
        if (op === 'SUBMIT' || op === 'WITHDRAW') {
          const recent = await tx.businessCommandReceipt.findMany({
            where: {
              customerAccountId: id,
              operation: { in: ['SUBMIT', 'WITHDRAW'] },
              outcome: { not: 'CLOSED' },
              committedAt: { gt: new Date(now.getTime() - 60000) },
            },
            orderBy: { committedAt: 'asc' },
          });
          if (recent.length >= 5)
            throw new DomainException(
              'BUSINESS_RATE_LIMITED',
              429,
              'Business command rate limit',
              Math.max(
                1,
                Math.ceil(
                  (recent[0].committedAt.getTime() + 60000 - now.getTime()) /
                    1000,
                ),
              ),
            );
        }
        let a =
          target && ['WITHDRAW', 'DECIDE'].includes(op)
            ? await tx.businessApplication.findUnique({ where: { id: target } })
            : null;
        let g = await tx.businessAccessGrant.findFirst({
          where: { customerAccountId: id, status: 'ACTIVE' },
        });
        const pending = await tx.businessApplication.findFirst({
          where: { customerAccountId: id, status: 'PENDING' },
        });
        const open = await tx.directRequestLifecycle.count({
          where: { customerAccountId: id, closedAt: null },
        });
        let code: string | null = null;
        const expected =
          op === 'DOWNGRADE' ? p.expectedRevision : p.expectedAccountRevision;
        if (op === 'DOWNGRADE' && p.type !== 'PERSONAL')
          code = 'BUSINESS_APPROVAL_REQUIRED';
        else if (expected !== undefined && expected !== c.revision)
          code = 'PROFILE_REVISION_CONFLICT';
        else if (a && p.expectedApplicationRevision !== a.revision)
          code = 'BUSINESS_APPLICATION_REVISION_CONFLICT';
        else if (
          (op === 'WITHDRAW' || op === 'DECIDE') &&
          a?.status !== 'PENDING'
        )
          code = 'BUSINESS_APPLICATION_NOT_PENDING';
        else if (
          op === 'SUBMIT' ||
          (op === 'DECIDE' && p.decision === 'APPROVE')
        ) {
          if (!c.active || !c.user.active || !c.user.emailVerifiedAt)
            code = 'CUSTOMER_ACCESS_DENIED';
          else if (c.businessReapplicationBlockedByGrantId)
            code = 'BUSINESS_REAPPLICATION_REQUIRES_ADMIN';
          else if (g) code = 'BUSINESS_ACCESS_ALREADY_ACTIVE';
          else if (op === 'SUBMIT' && pending)
            code = 'BUSINESS_APPLICATION_PENDING';
          else if (op === 'DECIDE' && open) code = 'CUSTOMER_ACTIVE_REQUESTS';
        } else if (op === 'DOWNGRADE' && open)
          code = 'CUSTOMER_ACTIVE_REQUESTS';
        else if (op === 'REVOKE' && (!g || g.id !== p.grantId))
          code = 'BUSINESS_GRANT_NOT_ACTIVE';
        else if (op === 'ALLOW_REAPPLICATION') {
          if (!c.businessReapplicationBlockedByGrantId)
            code = 'BUSINESS_REAPPLICATION_NOT_BLOCKED';
          else if (c.businessReapplicationBlockedByGrantId !== p.revokedGrantId)
            code = 'BUSINESS_REVOCATION_MISMATCH';
          else if (g) code = 'BUSINESS_ACCESS_ALREADY_ACTIVE';
          else if (pending) code = 'BUSINESS_APPLICATION_PENDING';
        }
        const before = c.revision;
        let eventGrant: string | null = g?.id ?? null;
        let eventApp: string | null = a?.id ?? null;
        if (!code) {
          if (op === 'SUBMIT')
            a = await tx.businessApplication.create({
              data: {
                customerAccountId: id,
                snapshot: {
                  businessName: p.businessName!,
                  activity: p.activity!,
                  city: p.city!,
                  estimatedDeliveryVolume: p.estimatedDeliveryVolume!,
                  note: p.note ?? null,
                },
                submittedAt: now,
              },
            });
          if (op === 'WITHDRAW' || op === 'DECIDE') {
            a = await tx.businessApplication.update({
              where: { id: a!.id },
              data: {
                status:
                  op === 'WITHDRAW'
                    ? 'WITHDRAWN'
                    : p.decision === 'APPROVE'
                      ? 'APPROVED'
                      : 'REJECTED',
                revision: { increment: 1 },
                resolvedAt: now,
                publicReason: p.publicReason ?? null,
                internalNote: p.internalNote ?? null,
                decisionActorId: op === 'DECIDE' ? req.user.id : null,
              },
            });
            if (op === 'DECIDE' && p.decision === 'APPROVE') {
              g = await tx.businessAccessGrant.create({
                data: {
                  customerAccountId: id,
                  applicationId: a.id,
                  grantedByUserId: req.user.id,
                  grantedAt: now,
                },
              });
              eventGrant = g.id;
              c = await tx.customerAccount.update({
                where: { id },
                data: {
                  type: 'BUSINESS',
                  businessAccessState: 'ACTIVE',
                  revision: { increment: 1 },
                },
                include: { user: true },
              });
            } else if (op === 'DECIDE' && c.type === 'BUSINESS')
              c = await tx.customerAccount.update({
                where: { id },
                data: {
                  businessAccessState: 'RESTRICTED',
                  revision: { increment: 1 },
                },
                include: { user: true },
              });
          }
          if (
            op === 'REVOKE' ||
            (op === 'DOWNGRADE' && c.type === 'BUSINESS')
          ) {
            if (g)
              g = await tx.businessAccessGrant.update({
                where: { id: g.id },
                data: {
                  status: 'REVOKED',
                  revokedAt: now,
                  revocationCause:
                    op === 'REVOKE'
                      ? 'ADMIN_REVOCATION'
                      : 'VOLUNTARY_DOWNGRADE',
                  publicReason: p.publicReason ?? null,
                },
              });
            if (op === 'DOWNGRADE' && pending)
              a = await tx.businessApplication.update({
                where: { id: pending.id },
                data: {
                  status: 'WITHDRAWN',
                  revision: { increment: 1 },
                  resolvedAt: now,
                },
              });
            c = await tx.customerAccount.update({
              where: { id },
              data: {
                type: open ? 'BUSINESS' : 'PERSONAL',
                businessAccessState: open ? 'RESTRICTED' : 'NONE',
                businessReapplicationBlockedByGrantId:
                  op === 'REVOKE'
                    ? g!.id
                    : c.businessReapplicationBlockedByGrantId,
                revision: { increment: 1 },
              },
              include: { user: true },
            });
          }
          if (op === 'ALLOW_REAPPLICATION') {
            eventGrant = p.revokedGrantId!;
            c = await tx.customerAccount.update({
              where: { id },
              data: {
                businessReapplicationBlockedByGrantId: null,
                revision: { increment: 1 },
              },
              include: { user: true },
            });
          }
          eventApp = a?.id ?? eventApp;
        }
        const receipt = await tx.businessCommandReceipt.create({
          data: {
            id: receiptId,
            namespace,
            ownerId,
            customerAccountId: id,
            actorUserId: req.user.id,
            key,
            operation: op,
            target: target ?? null,
            requestHash: hash,
            outcome: code ? 'REJECTED' : 'APPLIED',
            code,
            httpStatus: code ? 409 : op === 'SUBMIT' ? 201 : 200,
            resourceId: ['SUBMIT', 'WITHDRAW', 'DECIDE'].includes(op)
              ? (a?.id ?? null)
              : id,
            result: {
              applicationStatus: a?.status ?? null,
              applicationRevision: a?.revision ?? null,
              accountRevision: c.revision,
              accessState: c.businessAccessState,
              accountType: c.type,
              grantId: eventGrant,
              reapplicationBlocked: !!c.businessReapplicationBlockedByGrantId,
            },
            committedAt: now,
          },
        });
        if (!code)
          await tx.businessAccessEvent.create({
            data: {
              customerAccountId: id,
              actorUserId: req.user.id,
              operation: op,
              applicationId: eventApp,
              grantId: eventGrant,
              previousRevision: before,
              accountRevision: c.revision,
              publicReason: p.publicReason ?? null,
              internalNote: p.internalNote ?? null,
              receiptId,
              createdAt: now,
            },
          });
        return { receipt, replayed: false };
      },
      { timeout: 15000 },
    );
  }
  async attempt(
    req: AuthenticatedRequest,
    id: string,
    op: BusinessOperation,
    target: string | undefined,
    key: string,
    admin = false,
  ) {
    if (typeof key !== 'string' || !/^[!-~]{8,255}$/.test(key))
      throw fail('IDEMPOTENCY_KEY_INVALID', 400);
    return this.db.$transaction(async (tx) => {
      await this.authorize(tx, req, id, admin);
      await this.scope(tx, id, op, target, admin);
      const r = await tx.businessCommandReceipt.findUnique({
        where: {
          namespace_ownerId_key: {
            namespace: admin ? 'BUSINESS_ADMIN' : 'BUSINESS_CUSTOMER',
            ownerId: admin ? req.user.id : id,
            key,
          },
        },
      });
      if (
        r &&
        (r.operation !== op ||
          r.customerAccountId !== id ||
          r.target !== (target ?? null))
      )
        throw fail('IDEMPOTENCY_KEY_REUSED');
      return {
        state: r?.outcome ?? 'NOT_OBSERVED',
        receipt: r ? businessReceipt(r) : null,
      };
    });
  }
  async access(tx: Prisma.TransactionClient, id: string) {
    const c = await tx.customerAccount.findUnique({
      where: { id },
      include: { user: true },
    });
    if (!c) throw fail('NOT_FOUND', 404);
    const projection = await businessProjection(tx, id);
    const activeGrant = await tx.businessAccessGrant.findFirst({
      where: { customerAccountId: id, status: 'ACTIVE' },
    });
    const revoked = await tx.businessAccessGrant.findFirst({
      where: { customerAccountId: id, revocationCause: 'ADMIN_REVOCATION' },
      orderBy: [{ revokedAt: 'desc' }, { id: 'desc' }],
    });
    const allowed = revoked
      ? await tx.businessAccessEvent.findFirst({
          where: {
            customerAccountId: id,
            grantId: revoked.id,
            operation: 'ALLOW_REAPPLICATION',
          },
          orderBy: { createdAt: 'desc' },
        })
      : null;
    const pending = await tx.businessApplication.count({
      where: { customerAccountId: id, status: 'PENDING' },
    });
    return {
      customerAccount: {
        id,
        type: c.type,
        revision: c.revision,
        active: c.active,
        verifiedEmail: c.user.emailVerifiedAt ? c.user.email : null,
        businessAccess: projection.businessAccess,
        activeRequestCount: await tx.directRequestLifecycle.count({
          where: { customerAccountId: id, closedAt: null },
        }),
      },
      businessAccessAdministration: {
        activeGrant: activeGrant
          ? {
              id: activeGrant.id,
              applicationId: activeGrant.applicationId,
              grantedAt: activeGrant.grantedAt,
            }
          : null,
        lastAdministrativeRevocation: revoked
          ? {
              grantId: revoked.id,
              revokedAt: revoked.revokedAt,
              publicReason: revoked.publicReason,
              reapplicationAllowedAt: allowed?.createdAt ?? null,
            }
          : null,
        canRevoke: !!activeGrant,
        canAllowReapplication:
          !!c.businessReapplicationBlockedByGrantId && !activeGrant && !pending,
      },
    };
  }
  async readAccess(req: AuthenticatedRequest, id: string) {
    return this.db.$transaction(
      async (tx) => {
        await this.authorize(tx, req, id, true);
        return this.access(tx, id);
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }
  async detail(id: string, accountId?: string) {
    return this.db.$transaction(
      async (tx) => {
        const a = await tx.businessApplication.findFirst({
          where: { id, ...(accountId ? { customerAccountId: accountId } : {}) },
        });
        if (!a) throw fail('NOT_FOUND', 404);
        return accountId
          ? publicApplication(a)
          : {
              ...publicApplication(a),
              ...(await this.access(tx, a.customerAccountId)),
              decisionActorId: a.decisionActorId,
              internalNote: a.internalNote,
            };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }
  async list(
    page: number,
    pageSize: number,
    status?: string,
    accountId?: string,
    admin = false,
  ) {
    return this.db.$transaction(
      async (tx) => {
        const where = {
          ...(accountId ? { customerAccountId: accountId } : {}),
          ...(status ? { status } : {}),
        };
        const rows = await tx.businessApplication.findMany({
          where,
          orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }],
          skip: (page - 1) * pageSize,
          take: pageSize,
        });
        const items = await Promise.all(
          rows.map(async (a) =>
            admin
              ? {
                  ...publicApplication(a),
                  ...(await this.access(tx, a.customerAccountId)),
                  decisionActorId: a.decisionActorId,
                  internalNote: a.internalNote,
                }
              : publicApplication(a),
          ),
        );
        return {
          items,
          total: await tx.businessApplication.count({ where }),
          page,
          pageSize,
        };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }
}
