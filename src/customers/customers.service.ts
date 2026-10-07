import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import * as argon2 from 'argon2';
import { PrismaService } from '../prisma/prisma.service.js';
import { DomainException } from '../common/domain-error.js';
import { hashSecret, newSecret } from '../common/security.js';
import { MAIL_PROVIDER } from '../mail/mail.types.js';
import type { MailProvider } from '../mail/mail.types.js';
import type {
  CustomerProfileDto,
  RegisterCustomerDto,
  UpdateCustomerDto,
  ChangeCustomerTypeDto,
} from './customers.dto.js';
import { lockCustomer } from './demand-owner.js';
const fail = (code: string, status = 409) =>
  new DomainException(code, status, code);
const profileSelect = {
  type: true,
  displayName: true,
  businessName: true,
  revision: true,
  active: true,
} as const;
@Injectable()
export class CustomersService {
  private readonly logger = new Logger(CustomersService.name);
  constructor(
    private readonly db: PrismaService,
    private readonly config: ConfigService,
    @Inject(MAIL_PROVIDER) private readonly mail: MailProvider,
  ) {}
  admission() {
    if (!this.config.get<boolean>('CUSTOMER_ADMISSION_ENABLED'))
      throw fail('CUSTOMER_ADMISSION_DISABLED', 503);
  }
  private async emailLock(tx: Prisma.TransactionClient, email: string) {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`customer-email:${email}`},0))::text`;
  }
  async challenge(
    email: string,
    purpose: 'REGISTER' | 'RESET' | 'VERIFY',
    profile?: CustomerProfileDto,
  ) {
    if (purpose === 'REGISTER') this.admission();
    const token = newSecret();
    const expiresAt = new Date(
      Date.now() +
        this.config.getOrThrow<number>('CUSTOMER_CHALLENGE_TTL_SECONDS') * 1000,
    );
    const send = await this.db.$transaction(async (tx) => {
      await this.emailLock(tx, email);
      const user = await tx.user.findUnique({
        where: { email },
        select: { active: true, passwordHash: true },
      });
      if (
        (purpose === 'REGISTER' && user) ||
        (purpose !== 'REGISTER' && (!user?.active || !user.passwordHash))
      )
        return false;
      await tx.customerChallenge.updateMany({
        where: { email, purpose, consumedAt: null },
        data: { consumedAt: new Date() },
      });
      await tx.customerChallenge.create({
        data: {
          email,
          purpose,
          tokenHash: hashSecret(token),
          expiresAt,
          profile: profile
            ? {
                type: profile.type,
                displayName: profile.displayName,
                businessName: profile.businessName ?? null,
              }
            : Prisma.JsonNull,
        },
      });
      return true;
    });
    if (send) {
      try {
        if (!this.mail.sendCustomerAccess)
          throw Error('Unsupported mail adapter');
        const url = new URL(
          '/customer/access',
          this.config.getOrThrow<string>('MANDARIA_WEB_URL'),
        );
        url.hash = new URLSearchParams({ token, purpose }).toString();
        await this.mail.sendCustomerAccess({
          to: email,
          purpose,
          actionUrl: url.toString(),
          expiresAt,
        });
      } catch {
        this.logger.warn({ event: 'CUSTOMER_ACCESS_MAIL_FAILED' });
      }
    }
    return { status: 'ACCEPTED' };
  }
  register(dto: RegisterCustomerDto) {
    return this.challenge(dto.email, 'REGISTER', dto);
  }
  async confirm(
    token: string,
    password: string,
    purpose: 'REGISTER' | 'RESET',
  ) {
    if (purpose === 'REGISTER') this.admission();
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    return this.db.$transaction(async (tx) => {
      const probe = await tx.customerChallenge.findUnique({
        where: { tokenHash: hashSecret(token) },
      });
      if (!probe || probe.purpose !== purpose)
        throw fail('ACCESS_TOKEN_INVALID', 400);
      await this.emailLock(tx, probe.email);
      const row = await tx.customerChallenge.findUniqueOrThrow({
        where: { id: probe.id },
      });
      if (row.consumedAt) throw fail('ACCESS_TOKEN_INVALID', 400);
      if (row.expiresAt <= new Date()) throw fail('ACCESS_TOKEN_EXPIRED', 410);
      await tx.$queryRaw`SELECT id FROM "User" WHERE email=${row.email} FOR UPDATE`;
      const user = await tx.user.findUnique({ where: { email: row.email } });
      if (purpose === 'REGISTER') {
        if (user) throw fail('ACCESS_TOKEN_INVALID', 400);
        const p = row.profile;
        if (
          !p ||
          typeof p !== 'object' ||
          Array.isArray(p) ||
          !['PERSONAL', 'BUSINESS'].includes(String(p.type)) ||
          typeof p.displayName !== 'string'
        )
          throw fail('ACCESS_TOKEN_INVALID', 400);
        const created = await tx.user.create({
          data: {
            email: row.email,
            passwordHash,
            role: 'CUSTOMER',
            active: true,
            emailVerifiedAt: new Date(),
          },
        });
        await tx.customerAccount.create({
          data: {
            userId: created.id,
            type: p.type === 'BUSINESS' ? 'BUSINESS' : 'PERSONAL',
            displayName: p.displayName,
            businessName:
              typeof p.businessName === 'string' ? p.businessName : null,
          },
        });
      } else {
        if (!user?.active || !user.passwordHash)
          throw fail('ACCESS_TOKEN_INVALID', 400);
        await tx.user.update({
          where: { id: user.id },
          data: { passwordHash, sessionVersion: { increment: 1 } },
        });
        await tx.refreshToken.updateMany({
          where: { userId: user.id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }
      await tx.customerChallenge.updateMany({
        where: { email: row.email, purpose, consumedAt: null },
        data: { consumedAt: new Date() },
      });
      return { status: 'CONFIRMED' };
    });
  }
  async verifyContact(userId: string, token?: string) {
    const user = await this.db.user.findUniqueOrThrow({
      where: { id: userId },
    });
    if (!token) return this.challenge(user.email, 'VERIFY');
    return this.db.$transaction(async (tx) => {
      await this.emailLock(tx, user.email);
      await tx.$queryRaw`SELECT id FROM "User" WHERE id=${userId}::uuid FOR UPDATE`;
      const current = await tx.user.findUniqueOrThrow({
        where: { id: userId },
      });
      if (!current.active || current.email !== user.email)
        throw fail('CUSTOMER_ACCESS_DENIED', 403);
      const row = await tx.customerChallenge.findUnique({
        where: { tokenHash: hashSecret(token) },
      });
      if (
        !row ||
        row.email !== user.email ||
        row.purpose !== 'VERIFY' ||
        row.consumedAt
      )
        throw fail('ACCESS_TOKEN_INVALID', 400);
      if (row.expiresAt <= new Date()) throw fail('ACCESS_TOKEN_EXPIRED', 410);
      await tx.user.update({
        where: { id: userId },
        data: { emailVerifiedAt: new Date() },
      });
      await tx.customerChallenge.update({
        where: { id: row.id },
        data: { consumedAt: new Date() },
      });
      return { status: 'CONFIRMED' };
    });
  }
  async attach(userId: string, dto: CustomerProfileDto) {
    this.admission();
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id=${userId}::uuid FOR UPDATE`;
      const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
      if (!user.active || !user.emailVerifiedAt)
        throw fail('CUSTOMER_CONTACT_NOT_VERIFIED', 403);
      if (await tx.customerAccount.findUnique({ where: { userId } }))
        throw fail('PROFILE_ALREADY_EXISTS');
      return tx.customerAccount.create({
        data: { userId, ...dto },
        select: profileSelect,
      });
    });
  }
  async account(userId: string) {
    const user = await this.db.user.findUnique({
      where: { id: userId },
      select: { active: true, emailVerifiedAt: true, customerAccount: true },
    });
    if (!user?.active || !user.emailVerifiedAt || !user.customerAccount?.active)
      throw fail('CUSTOMER_ACCESS_DENIED', 403);
    return user.customerAccount;
  }
  async profile(userId: string) {
    const p = await this.account(userId);
    return {
      type: p.type,
      displayName: p.displayName,
      businessName: p.businessName,
      revision: p.revision,
      active: p.active,
    };
  }
  async capabilities(userId: string) {
    const account = await this.account(userId);
    return this.db.$transaction(
      async (tx) => {
        const current = await tx.customerAccount.findUniqueOrThrow({
          where: { id: account.id },
        });
        const active = await tx.directRequestLifecycle.findMany({
          where: { customerAccountId: account.id, closedAt: null },
          select: { request: { select: { publicId: true } } },
          orderBy: { createdAt: 'asc' },
        });
        const admission = !!this.config.get<boolean>(
          'CUSTOMER_ADMISSION_ENABLED',
        );
        const limited = current.type === 'PERSONAL' && active.length > 0;
        const conversion = !!this.config.get<boolean>(
          'PREQUOTE_CONVERSION_ENABLED',
        );
        return {
          type: current.type,
          allowedShippingPayers:
            current.type === 'PERSONAL'
              ? ['REQUESTER']
              : ['REQUESTER', 'RECIPIENT'],
          defaultShippingPayer: 'REQUESTER',
          capacity: {
            maxActiveRequests: current.type === 'PERSONAL' ? 1 : null,
            occupied: active.length > 0,
            activeCount: active.length,
            activeRequestPublicId:
              current.type === 'PERSONAL'
                ? (active[0]?.request.publicId ?? null)
                : null,
          },
          canCreateRequest: admission && conversion && !limited,
          canPrequote:
            admission && !!this.config.get<boolean>('PREQUOTE_ENABLED'),
          reason: !admission
            ? 'CUSTOMER_ADMISSION_DISABLED'
            : limited
              ? 'CUSTOMER_ACTIVE_REQUEST_LIMIT'
              : !conversion
                ? 'PREQUOTE_CONVERSION_DISABLED'
                : null,
        };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }
  async update(userId: string, dto: UpdateCustomerDto) {
    const p = await this.account(userId);
    const result = await this.db.customerAccount.updateMany({
      where: { id: p.id, revision: dto.expectedRevision, active: true },
      data: {
        displayName: dto.displayName,
        businessName: dto.businessName,
        revision: { increment: 1 },
      },
    });
    if (!result.count) throw fail('PROFILE_REVISION_CONFLICT');
    return this.profile(userId);
  }
  async changeType(userId: string, dto: ChangeCustomerTypeDto) {
    const p = await this.account(userId);
    const result = await this.db.$transaction(async (tx) => {
      const current = await lockCustomer(tx, { kind: 'CUSTOMER', id: p.id });
      if (!current || current.revision !== dto.expectedRevision)
        throw fail('PROFILE_REVISION_CONFLICT');
      if (
        await tx.directRequestLifecycle.findFirst({
          where: { customerAccountId: p.id, closedAt: null },
          select: { deliveryRequestId: true },
        })
      )
        throw fail('CUSTOMER_ACTIVE_REQUESTS');
      return tx.customerAccount.update({
        where: { id: p.id },
        data: { type: dto.type, revision: { increment: 1 } },
        select: profileSelect,
      });
    });
    this.logger.log({
      event: 'CUSTOMER_TYPE_CHANGED',
      customerAccountId: p.id,
      actorUserId: userId,
      previousType: p.type,
      type: result.type,
      revision: result.revision,
    });
    return result;
  }
}
