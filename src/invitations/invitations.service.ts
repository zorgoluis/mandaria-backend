import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { ProviderMemberRole, UserInvitationStatus } from '@prisma/client';
import * as argon2 from 'argon2';
import { PrismaService } from '../prisma/prisma.service.js';
import { pageResult } from '../common/pagination.dto.js';
import { hashSecret } from '../common/security.js';
import {
  isUniqueViolation,
  lockProvider,
} from '../providers/provider-capacity.js';
import { buildActivationUrl } from '../mail/mail-templates.js';
import { MAIL_PROVIDER, MailDeliveryError } from '../mail/mail.types.js';
import type { MailProvider } from '../mail/mail.types.js';
import {
  assertActivatable,
  canInvite,
  effectiveInvitationStatus,
  invitationError,
  invitationExpiry,
  newInvitationToken,
} from './invitation-policy.js';
import type {
  InvitableRole,
  InvitationEffectiveStatus,
} from './invitation-policy.js';

export const invitationSelect = {
  id: true,
  userId: true,
  email: true,
  role: true,
  providerId: true,
  membershipRole: true,
  driverName: true,
  status: true,
  expiresAt: true,
  tokenIssuedAt: true,
  resendCount: true,
  acceptedAt: true,
  revokedAt: true,
  revokedByUserId: true,
  createdByUserId: true,
  createdAt: true,
  updatedAt: true,
  provider: { select: { id: true, name: true, code: true } },
} satisfies Prisma.UserInvitationSelect;
type InvitationRecord = Prisma.UserInvitationGetPayload<{
  select: typeof invitationSelect;
}>;

/** Public view: effective status (EXPIRED derived) and never the token hash. */
export const invitationView = (
  invitation: InvitationRecord,
  now = new Date(),
) => ({
  ...invitation,
  status: effectiveInvitationStatus(invitation, now),
});

export type InviteInput = {
  email: string;
  role: InvitableRole;
  membershipRole?: ProviderMemberRole;
  driverName?: string;
};
export type InvitationActor = { id: string; role: string };
/** PROVIDER_ADMIN routes pass the provider authorized by membership and only see DRIVER invitations. */
export type InvitationScope = { providerId: string; role: 'DRIVER' } | null;
export type InvitationListFilter = {
  page: number;
  pageSize: number;
  status?: InvitationEffectiveStatus;
  role?: InvitableRole;
  providerId?: string;
  search?: string;
};
type EmailDelivery = 'SENT' | 'FAILED';

@Injectable()
export class InvitationsService {
  private readonly logger = new Logger(InvitationsService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject(MAIL_PROVIDER) private readonly mail: MailProvider,
  ) {}

  /** providerId must already be authorized (SUPER_ADMIN route or membership guard). */
  async invite(providerId: string, input: InviteInput, actor: InvitationActor) {
    if (!canInvite(actor.role, input.role))
      throw new ForbiddenException('Role cannot invite this role');
    if (
      input.role === 'PROVIDER_ADMIN'
        ? !input.membershipRole || input.driverName !== undefined
        : !input.driverName || input.membershipRole !== undefined
    )
      throw new BadRequestException(
        input.role === 'PROVIDER_ADMIN'
          ? 'PROVIDER_ADMIN invitations require membershipRole and do not accept driverName'
          : 'DRIVER invitations require driverName and do not accept membershipRole',
      );
    const baseUrl = this.activationBaseUrl();
    const { token, tokenHash } = newInvitationToken();
    let invitation: InvitationRecord;
    try {
      invitation = await this.prisma.$transaction(async (tx) => {
        // Lock order shared with resend/activation: provider → user → invitation.
        const provider =
          input.role === 'DRIVER' ? await lockProvider(tx, providerId) : null;
        if (
          !provider &&
          !(await tx.deliveryProvider.findUnique({
            where: { id: providerId },
            select: { id: true },
          }))
        )
          throw new NotFoundException('Provider not found');
        const [existing] = await tx.$queryRaw<
          { id: string; active: boolean; hasPassword: boolean }[]
        >`SELECT id, active, "passwordHash" IS NOT NULL AS "hasPassword" FROM "User" WHERE email = ${input.email} FOR UPDATE`;
        let userId: string;
        if (existing) {
          if (existing.active)
            throw invitationError(
              'USER_ALREADY_ACTIVE',
              'An active account already uses this email',
            );
          if (existing.hasPassword)
            throw invitationError(
              'USER_DISABLED',
              'This account is disabled; it is not reactivated by invitation',
            );
          if (
            await tx.userInvitation.findFirst({
              where: { userId: existing.id, status: 'PENDING' },
              select: { id: true },
            })
          )
            throw pendingInvitation();
          // Never activated and no pending invitation (revoked): reuse the account for the new role.
          await tx.user.update({
            where: { id: existing.id },
            data: { role: input.role },
          });
          userId = existing.id;
        } else {
          userId = (
            await tx.user.create({
              data: {
                email: input.email,
                role: input.role,
                active: false,
                passwordHash: null,
              },
              select: { id: true },
            })
          ).id;
        }
        const now = new Date();
        if (provider) await this.assertDriverSeat(tx, provider, now);
        return tx.userInvitation.create({
          data: {
            userId,
            email: input.email,
            role: input.role,
            providerId,
            membershipRole: input.membershipRole ?? null,
            driverName: input.driverName ?? null,
            tokenHash,
            tokenIssuedAt: now,
            expiresAt: invitationExpiry(now, this.ttlHours()),
            createdByUserId: actor.id,
          },
          select: invitationSelect,
        });
      });
    } catch (error) {
      // Concurrent invitations for the same email: the loser hits User.email or the
      // one-PENDING-per-user unique index.
      if (isUniqueViolation(error)) throw pendingInvitation();
      throw error;
    }
    this.audit('USER_INVITED', invitation, actor.id);
    return {
      ...invitationView(invitation),
      emailDelivery: await this.deliver(invitation, token, baseUrl),
    };
  }

  async list(filter: InvitationListFilter, scope: InvitationScope) {
    const now = new Date();
    const where: Prisma.UserInvitationWhereInput = {
      ...(scope ?? {
        role: filter.role,
        providerId: filter.providerId,
      }),
      ...statusWhere(filter.status, now),
      ...(filter.search
        ? { email: { contains: filter.search, mode: 'insensitive' } }
        : {}),
    };
    const [items, total] = await this.prisma.$transaction(
      [
        this.prisma.userInvitation.findMany({
          where,
          select: invitationSelect,
          skip: (filter.page - 1) * filter.pageSize,
          take: filter.pageSize,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        }),
        this.prisma.userInvitation.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    return pageResult(
      items.map((item) => invitationView(item, now)),
      total,
      filter,
    );
  }

  async get(id: string, scope: InvitationScope) {
    const invitation = await this.prisma.userInvitation.findFirst({
      where: { id, ...scope },
      select: invitationSelect,
    });
    if (!invitation) throw new NotFoundException('Invitation not found');
    return invitationView(invitation);
  }

  /** Rotates the token: the previous link stops working, expiry restarts and a new email is sent. */
  async resend(id: string, scope: InvitationScope, actorId: string) {
    const baseUrl = this.activationBaseUrl();
    const target = await this.findInScope(id, scope);
    const { token, tokenHash } = newInvitationToken();
    const invitation = await this.prisma.$transaction(async (tx) => {
      const provider =
        target.role === 'DRIVER'
          ? await lockProvider(tx, target.providerId)
          : null;
      const current = await this.lockInvitation(tx, id);
      if (current.status !== 'PENDING')
        throw invitationError(
          'INVITATION_NOT_PENDING',
          'Only pending invitations can be resent',
        );
      const now = new Date();
      const cooldownMs =
        this.config.getOrThrow<number>(
          'USER_INVITATION_RESEND_COOLDOWN_SECONDS',
        ) * 1000;
      // Checked under the row lock: simultaneous resends rotate the token exactly once.
      if (now.getTime() - current.tokenIssuedAt.getTime() < cooldownMs)
        throw invitationError(
          'INVITATION_RESEND_COOLDOWN',
          'Invitation was sent recently; try again later',
        );
      if (provider) await this.assertDriverSeat(tx, provider, now, id);
      return tx.userInvitation.update({
        where: { id },
        data: {
          tokenHash,
          tokenIssuedAt: now,
          expiresAt: invitationExpiry(now, this.ttlHours()),
          resendCount: { increment: 1 },
        },
        select: invitationSelect,
      });
    });
    this.audit('USER_INVITATION_RESENT', invitation, actorId);
    return {
      ...invitationView(invitation),
      emailDelivery: await this.deliver(invitation, token, baseUrl),
    };
  }

  /**
   * Invalidates the token. The invited User stays INVITED (inactive, without password): no
   * membership or Driver exists yet, so nothing else changes and the email can be invited again.
   * Revoking an already revoked invitation is idempotent.
   */
  async revoke(id: string, scope: InvitationScope, actorId: string) {
    await this.findInScope(id, scope);
    const { invitation, changed } = await this.prisma.$transaction(
      async (tx) => {
        const current = await this.lockInvitation(tx, id);
        if (current.status === 'ACCEPTED')
          throw invitationError(
            'INVITATION_NOT_PENDING',
            'Accepted invitations cannot be revoked',
          );
        if (current.status === 'REVOKED')
          return {
            invitation: await tx.userInvitation.findUniqueOrThrow({
              where: { id },
              select: invitationSelect,
            }),
            changed: false,
          };
        return {
          invitation: await tx.userInvitation.update({
            where: { id },
            data: {
              status: 'REVOKED',
              revokedAt: new Date(),
              revokedByUserId: actorId,
            },
            select: invitationSelect,
          }),
          changed: true,
        };
      },
    );
    if (changed) this.audit('USER_INVITATION_REVOKED', invitation, actorId);
    return invitationView(invitation);
  }

  /**
   * Public activation. In one transaction: password (Argon2id) → User ACTIVE with the invited
   * role → ProviderMembership or Driver → invitation ACCEPTED. Any failure leaves no change.
   */
  async activate(token: string, password: string) {
    const tokenHash = hashSecret(token);
    const found = await this.prisma.userInvitation.findUnique({
      where: { tokenHash },
      select: { id: true, status: true, expiresAt: true },
    });
    this.rejectUnlessActivatable(found, found?.id);
    const invitationId = found.id;
    // Hash before taking locks: Argon2id is deliberately slow.
    const passwordHash = await argon2.hash(password, {
      type: argon2.argon2id,
    });
    const result = await this.prisma.$transaction(async (tx) => {
      const invitation = await tx.userInvitation.findUniqueOrThrow({
        where: { id: invitationId },
        select: {
          userId: true,
          email: true,
          role: true,
          providerId: true,
          membershipRole: true,
          driverName: true,
        },
      });
      const provider =
        invitation.role === 'DRIVER'
          ? await lockProvider(tx, invitation.providerId)
          : null;
      const [user] = await tx.$queryRaw<
        { active: boolean; hasPassword: boolean }[]
      >`SELECT active, "passwordHash" IS NOT NULL AS "hasPassword" FROM "User" WHERE id = ${invitation.userId}::uuid FOR UPDATE`;
      const current = await this.lockInvitation(tx, invitationId);
      // Re-check under lock: a concurrent activation, resend (new token) or revoke may have won.
      this.rejectUnlessActivatable(
        current.tokenHash === tokenHash ? current : null,
        invitationId,
      );
      if (!user || user.active || user.hasPassword)
        throw invitationError(
          'ACCOUNT_NOT_ACTIVATABLE',
          'This account cannot be activated with an invitation',
        );
      if (
        provider &&
        (await tx.driver.count({ where: { providerId: provider.id } })) >=
          provider.maxDrivers
      )
        throw invitationError(
          'PROVIDER_DRIVER_LIMIT_REACHED',
          'Provider driver limit reached',
        );
      const now = new Date();
      await tx.user.update({
        where: { id: invitation.userId },
        data: {
          active: true,
          passwordHash,
          role: invitation.role,
          // Opening the emailed link proves control of the address.
          emailVerifiedAt: now,
        },
      });
      const membership =
        invitation.role === 'PROVIDER_ADMIN'
          ? await tx.providerMembership.create({
              data: {
                providerId: invitation.providerId,
                userId: invitation.userId,
                role: invitation.membershipRole!,
              },
              select: { id: true },
            })
          : null;
      const driver =
        invitation.role === 'DRIVER'
          ? await tx.driver.create({
              data: {
                providerId: invitation.providerId,
                userId: invitation.userId,
                name: invitation.driverName!,
              },
              select: { id: true },
            })
          : null;
      await tx.userInvitation.update({
        where: { id: invitationId },
        data: { status: 'ACCEPTED', acceptedAt: now },
      });
      return { invitation, membership, driver };
    });
    const { invitation, membership, driver } = result;
    const base = {
      invitationId: invitationId,
      targetUserId: invitation.userId,
      role: invitation.role,
      providerId: invitation.providerId,
      actorId: invitation.userId,
    };
    this.logger.log({ event: 'USER_INVITATION_ACCEPTED', ...base });
    this.logger.log({ event: 'USER_ACTIVATED', ...base });
    if (membership)
      this.logger.log({
        event: 'PROVIDER_MEMBER_ADDED',
        source: 'invitation',
        providerId: invitation.providerId,
        membershipId: membership.id,
        userId: invitation.userId,
        actorId: invitation.userId,
      });
    if (driver)
      this.logger.log({
        event: 'DRIVER_CREATED',
        source: 'invitation',
        providerId: invitation.providerId,
        driverId: driver.id,
        userId: invitation.userId,
        actorId: invitation.userId,
      });
    return {
      status: 'ACTIVE' as const,
      email: invitation.email,
      role: invitation.role,
    };
  }

  private rejectUnlessActivatable<
    T extends { status: UserInvitationStatus; expiresAt: Date },
  >(invitation: T | null, invitationId?: string): asserts invitation is T {
    try {
      assertActivatable(invitation);
    } catch (error) {
      this.logger.warn({
        event: 'USER_ACTIVATION_REJECTED',
        reason: (error as { code?: string }).code,
        ...(invitationId ? { invitationId } : {}),
      });
      throw error;
    }
  }

  private async findInScope(id: string, scope: InvitationScope) {
    const invitation = await this.prisma.userInvitation.findFirst({
      where: { id, ...scope },
      select: { providerId: true, role: true },
    });
    if (!invitation) throw new NotFoundException('Invitation not found');
    return invitation;
  }

  private async lockInvitation(tx: Prisma.TransactionClient, id: string) {
    const [row] = await tx.$queryRaw<
      {
        status: UserInvitationStatus;
        expiresAt: Date;
        tokenIssuedAt: Date;
        tokenHash: string;
      }[]
    >`SELECT status, "expiresAt", "tokenIssuedAt", "tokenHash" FROM "UserInvitation" WHERE id = ${id}::uuid FOR UPDATE`;
    if (!row) throw new NotFoundException('Invitation not found');
    return row;
  }

  /**
   * Pending, unexpired DRIVER invitations reserve a seat: Drivers plus reservations may not
   * exceed maxDrivers. Requires the provider row lock.
   */
  private async assertDriverSeat(
    tx: Prisma.TransactionClient,
    provider: { id: string; maxDrivers: number },
    now: Date,
    excludeInvitationId?: string,
  ) {
    const drivers = await tx.driver.count({
      where: { providerId: provider.id },
    });
    const reserved = await tx.userInvitation.count({
      where: {
        providerId: provider.id,
        role: 'DRIVER',
        status: 'PENDING',
        expiresAt: { gt: now },
        ...(excludeInvitationId ? { id: { not: excludeInvitationId } } : {}),
      },
    });
    if (drivers + reserved >= provider.maxDrivers)
      throw invitationError(
        'PROVIDER_DRIVER_LIMIT_REACHED',
        'Provider driver limit reached, counting pending driver invitations',
      );
  }

  private activationBaseUrl() {
    const url = this.config.get<string>('MANDARIA_WEB_URL');
    if (!url)
      throw invitationError(
        'MAIL_NOT_CONFIGURED',
        'MANDARIA_WEB_URL is not configured',
      );
    return url;
  }

  private ttlHours() {
    return this.config.getOrThrow<number>('USER_INVITATION_TTL_HOURS');
  }

  /** Sent after commit: a delivery failure keeps the invitation, which can be resent. */
  private async deliver(
    invitation: InvitationRecord,
    token: string,
    baseUrl: string,
  ): Promise<EmailDelivery> {
    try {
      await this.mail.sendUserInvitation({
        to: invitation.email,
        role: invitation.role as InvitableRole,
        providerName: invitation.provider.name,
        activationUrl: buildActivationUrl(baseUrl, token),
        expiresAt: invitation.expiresAt,
      });
      this.logger.log({
        event: 'USER_INVITATION_EMAIL_SENT',
        invitationId: invitation.id,
        mailProvider: this.mail.name,
      });
      return 'SENT';
    } catch (error) {
      this.logger.warn({
        event: 'USER_INVITATION_EMAIL_FAILED',
        invitationId: invitation.id,
        mailProvider: this.mail.name,
        reason:
          error instanceof MailDeliveryError ? error.reason : 'UNEXPECTED',
      });
      return 'FAILED';
    }
  }

  /** Audit without token, token hash, password or email. */
  private audit(event: string, invitation: InvitationRecord, actorId: string) {
    this.logger.log({
      event,
      invitationId: invitation.id,
      targetUserId: invitation.userId,
      role: invitation.role,
      providerId: invitation.providerId,
      actorId,
    });
  }
}

const pendingInvitation = () =>
  invitationError(
    'USER_INVITATION_PENDING',
    'A pending invitation already exists for this email; resend it instead',
  );

function statusWhere(
  status: InvitationEffectiveStatus | undefined,
  now: Date,
): Prisma.UserInvitationWhereInput {
  switch (status) {
    case 'PENDING':
      return { status: 'PENDING', expiresAt: { gt: now } };
    case 'EXPIRED':
      return { status: 'PENDING', expiresAt: { lte: now } };
    case undefined:
      return {};
    default:
      return { status };
  }
}
