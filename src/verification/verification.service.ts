import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Prisma,
  type VerificationCase,
  type VerificationSubject,
} from '@prisma/client';
import { randomBytes, randomUUID } from 'node:crypto';
import * as argon2 from 'argon2';
import { isUUID } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service.js';
import { MAIL_PROVIDER, type MailProvider } from '../mail/mail.types.js';
import { verificationError as fail } from './verification-error.js';
import { VerificationRuntime } from './verification-policy.js';
import {
  canonical,
  digest,
  parseData,
  categories,
  checks,
  POLICY_VERSION,
  type IdentityData,
  type VehicleData,
} from './verification-rules.js';
import {
  VERIFICATION_STORAGE,
  type VerificationStorage,
  validateImage,
  MAX_BYTES,
} from './verification-storage.js';
import type {
  AcceptTermsDto,
  CreateCaseDto,
  DecisionDto,
  OnboardingVehicleDto,
  RegistrationConfirmDto,
  UpdateCaseDto,
  UploadDto,
  VerificationListDto,
  AttemptDto,
  PolicyDto,
  TermsQueryDto,
} from './verification.dto.js';
type Tx = Prisma.TransactionClient;
type Subject = VerificationSubject & {
  driver: { id: string; userId: string; name: string } | null;
  vehicle: {
    id: string;
    identifier: string;
    type: string;
    brand: string | null;
    model: string | null;
    year: number | null;
    plate: string | null;
  } | null;
  independentProfile: { driver: { id: string; userId: string } } | null;
};
const subjectInclude = {
  driver: { select: { id: true, userId: true, name: true } },
  vehicle: {
    select: {
      id: true,
      identifier: true,
      type: true,
      brand: true,
      model: true,
      year: true,
      plate: true,
    },
  },
  independentProfile: {
    select: { driver: { select: { id: true, userId: true } } },
  },
} as const;
const json = (value: unknown) =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
@Injectable()
export class VerificationService {
  constructor(
    private readonly db: PrismaService,
    private readonly runtime: VerificationRuntime,
    private readonly config: ConfigService,
    @Inject(VERIFICATION_STORAGE) private readonly storage: VerificationStorage,
    @Inject(MAIL_PROVIDER) private readonly mail: MailProvider,
  ) {}
  private async actor(tx: Tx, userId: string) {
    await tx.$queryRaw`SELECT id FROM "User" WHERE id=${userId}::uuid FOR SHARE`;
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user?.active) fail('VERIFICATION_FORBIDDEN', 403);
    return user;
  }
  private async member(tx: Tx, userId: string, providerId: string) {
    const members = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM "ProviderMembership" WHERE "userId"=${userId}::uuid AND "providerId"=${providerId}::uuid FOR SHARE`;
    if (!members.length) fail('VERIFICATION_NOT_FOUND', 404);
  }
  private async policy(tx: Tx) {
    await tx.$queryRaw`SELECT id FROM "VerificationPolicy" WHERE id=1 FOR SHARE`;
    return tx.verificationPolicy.findUniqueOrThrow({ where: { id: 1 } });
  }
  private async authorize(
    tx: Tx,
    userId: string,
    subject: Subject,
    write = false,
  ) {
    const user = await this.actor(tx, userId);
    if (user.role === 'SUPER_ADMIN') {
      if (write) fail('VERIFICATION_PRESENTER_REQUIRED', 403);
      return;
    }
    if (user.role === 'PROVIDER_ADMIN' && subject.providerId) {
      await this.member(tx, userId, subject.providerId);
      return;
    }
    if (
      user.role === 'DRIVER' &&
      (subject.driver?.userId === userId ||
        (!subject.providerId &&
          subject.independentProfile?.driver.userId === userId))
    ) {
      if (write && subject.providerId)
        fail('VERIFICATION_FLEET_PRESENTER_REQUIRED', 403);
      return;
    }
    fail('VERIFICATION_NOT_FOUND', 404);
  }
  private async termsAuthority(tx: Tx, userId: string, scope: TermsQueryDto) {
    const user = await this.actor(tx, userId);
    if (!user.emailVerifiedAt) fail('VERIFICATION_EMAIL_REQUIRED', 403);
    if (scope.scope === 'DRIVER') {
      if (user.role !== 'DRIVER' || scope.providerId)
        fail('VERIFICATION_FORBIDDEN', 403);
      if (!(await tx.driver.findUnique({ where: { userId } })))
        fail('VERIFICATION_NOT_FOUND', 404);
    } else {
      if (user.role !== 'PROVIDER_ADMIN' || !scope.providerId)
        fail('VERIFICATION_FORBIDDEN', 403);
      await this.member(tx, userId, scope.providerId);
    }
  }
  private async requireTerms(tx: Tx, subject: Subject) {
    const policy = await this.policy(tx);
    const userId =
      subject.driver?.userId ?? subject.independentProfile?.driver.userId;
    if (
      userId &&
      !(await tx.verificationAcceptance.findFirst({
        where: { userId, scope: 'DRIVER', version: policy.driverTermsVersion },
      }))
    )
      fail('TERMS_ACCEPTANCE_REQUIRED');
    if (subject.providerId) {
      const acceptances = await tx.verificationAcceptance.findMany({
        where: {
          providerId: subject.providerId,
          scope: 'FLEET',
          version: policy.fleetTermsVersion,
        },
        select: { userId: true },
      });
      const present = await tx.providerMembership.findFirst({
        where: {
          providerId: subject.providerId,
          userId: { in: acceptances.map((a) => a.userId) },
          user: { active: true, role: 'PROVIDER_ADMIN' },
        },
      });
      if (!present) fail('TERMS_ACCEPTANCE_REQUIRED');
    }
  }
  private async lockSubject(tx: Tx, subject: Subject) {
    if (subject.providerId)
      await tx.$queryRaw`SELECT id FROM "DeliveryProvider" WHERE id=${subject.providerId}::uuid FOR SHARE`;
    if (subject.driverId)
      await tx.$queryRaw`SELECT id FROM "Driver" WHERE id=${subject.driverId}::uuid FOR UPDATE`;
    if (subject.vehicleId)
      await tx.$queryRaw`SELECT id FROM "Vehicle" WHERE id=${subject.vehicleId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "VerificationSubject" WHERE id=${subject.id}::uuid FOR UPDATE`;
  }
  private async case(
    tx: Tx,
    userId: string,
    id: string,
    write = false,
    lock = false,
  ) {
    const record = await tx.verificationCase.findUnique({
      where: { id },
      include: { subject: { include: subjectInclude } },
    });
    if (!record) fail('VERIFICATION_NOT_FOUND', 404);
    await this.authorize(tx, userId, record.subject, write);
    if (lock) {
      await this.lockSubject(tx, record.subject);
      await tx.$queryRaw`SELECT id FROM "VerificationCase" WHERE id=${id}::uuid FOR UPDATE`;
      return tx.verificationCase.findUniqueOrThrow({
        where: { id },
        include: { subject: { include: subjectInclude } },
      });
    }
    return record;
  }
  private version(record: VerificationCase, expected: number, status?: string) {
    if (record.revision !== expected) fail('VERIFICATION_VERSION_CONFLICT');
    if (status && record.status !== status)
      fail('VERIFICATION_CASE_NOT_' + status);
  }
  private async event(tx: Tx, actorId: string, target: string, kind: string) {
    await tx.verificationEvent.create({ data: { actorId, target, kind } });
  }
  private async command<T>(
    userId: string,
    key: string,
    operation: string,
    target: string,
    body: unknown,
    authorize: (tx: Tx) => Promise<unknown>,
    apply: (tx: Tx) => Promise<T>,
  ): Promise<T> {
    this.runtime.assertLocal();
    if (!isUUID(key)) fail('IDEMPOTENCY_KEY_REQUIRED', 400);
    const hash = digest(canonical({ operation, target, body }));
    return this.db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${userId + ':' + key},0))`;
        await authorize(tx);
        const old = await tx.verificationCommand.findUnique({
          where: { actorId_key: { actorId: userId, key } },
        });
        if (old) {
          if (old.operation !== operation || old.target !== target)
            fail('IDEMPOTENCY_KEY_REUSED');
          if (old.state === 'CLOSED_NO_EFFECTS')
            fail('VERIFICATION_ATTEMPT_CLOSED');
          if (old.hash !== hash) fail('IDEMPOTENCY_KEY_REUSED');
          return old.result as T;
        }
        const result = await apply(tx);
        await tx.verificationCommand.create({
          data: {
            actorId: userId,
            key,
            operation,
            target,
            hash,
            result: json(result),
          },
        });
        await this.event(tx, userId, target, operation);
        return JSON.parse(JSON.stringify(result)) as T;
      },
      { timeout: 30000 },
    );
  }
  async register(email: string) {
    this.runtime.assertLocal();
    email = email.trim().toLowerCase();
    const token = randomBytes(32).toString('base64url');
    const challenge = await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${email},4))`;
      if (await tx.user.findUnique({ where: { email } })) return null;
      if (
        await tx.driverRegistrationChallenge.findFirst({
          where: { email, createdAt: { gt: new Date(Date.now() - 60000) } },
        })
      )
        return null;
      return tx.driverRegistrationChallenge.create({
        data: {
          email,
          tokenHash: digest(token),
          expiresAt: new Date(Date.now() + 1800000),
        },
      });
    });
    if (challenge) {
      try {
        if (!this.mail.sendDriverVerification)
          throw new Error('MAIL_UNAVAILABLE');
        await this.mail.sendDriverVerification({
          to: email,
          kind: 'REGISTRATION',
          reference: challenge.id,
          token,
        });
      } catch {
        /* Generic response; resend generates a fresh token after cooldown. */
      }
    }
    return { status: 'CHECK_EMAIL' };
  }
  async confirm(dto: RegistrationConfirmDto) {
    this.runtime.assertLocal();
    const hash = await argon2.hash(dto.password);
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "DriverRegistrationChallenge" WHERE "tokenHash"=${digest(dto.token)} FOR UPDATE`;
      const challenge = await tx.driverRegistrationChallenge.findUnique({
        where: { tokenHash: digest(dto.token) },
      });
      if (!challenge || challenge.userId) fail('REGISTRATION_INVALID', 400);
      if (challenge.consumedAt) return { status: 'CONFIRMED_LOGIN_REQUIRED' };
      if (challenge.expiresAt <= new Date()) fail('REGISTRATION_INVALID', 400);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${challenge.email},4))`;
      if (!(await tx.user.findUnique({ where: { email: challenge.email } }))) {
        const user = await tx.user.create({
          data: {
            email: challenge.email,
            passwordHash: hash,
            role: 'DRIVER',
            active: true,
            emailVerifiedAt: new Date(),
          },
        });
        const driver = await tx.driver.create({
          data: {
            userId: user.id,
            name: dto.name.trim(),
            status: 'PENDING',
            availability: 'OFFLINE',
          },
        });
        await tx.independentDriverProfile.create({
          data: { driverId: driver.id, status: 'PENDING' },
        });
      }
      await tx.driverRegistrationChallenge.update({
        where: { id: challenge.id },
        data: { consumedAt: new Date() },
      });
      return { status: 'CONFIRMED_LOGIN_REQUIRED' };
    });
  }
  async terms(userId: string, query: TermsQueryDto) {
    this.runtime.assertLocal();
    return this.db.$transaction(async (tx) => {
      await this.termsAuthority(tx, userId, query);
      const policy = await this.policy(tx);
      const version =
        query.scope === 'DRIVER'
          ? policy.driverTermsVersion
          : policy.fleetTermsVersion;
      return tx.verificationTerms.findUniqueOrThrow({ where: { version } });
    });
  }
  async acceptTerms(userId: string, key: string, dto: AcceptTermsDto) {
    return this.command(
      userId,
      key,
      'ACCEPT_TERMS',
      dto.scope === 'DRIVER' ? 'DRIVER' : 'FLEET:' + dto.providerId,
      dto,
      (tx) => this.termsAuthority(tx, userId, dto),
      async (tx) => {
        const policy = await this.policy(tx);
        const required =
          dto.scope === 'DRIVER'
            ? policy.driverTermsVersion
            : policy.fleetTermsVersion;
        const terms = await tx.verificationTerms.findUnique({
          where: { version: required },
        });
        if (
          !terms ||
          dto.version !== required ||
          dto.hash !== terms.hash ||
          terms.environment !== 'LOCAL_TEST'
        )
          fail('TERMS_VERSION_CONFLICT');
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${userId + ':' + required + ':' + (dto.providerId ?? '')},7))`;
        const previous = await tx.verificationAcceptance.findFirst({
          where: {
            userId,
            providerId: dto.providerId ?? null,
            version: required,
          },
        });
        const receipt =
          previous ??
          (await tx.verificationAcceptance.create({
            data: {
              userId,
              providerId: dto.providerId,
              scope: dto.scope,
              version: required,
            },
          }));
        return {
          id: receipt.id,
          status: 'ACCEPTED',
          scope: receipt.scope,
          version: receipt.version,
          acceptedAt: receipt.acceptedAt,
          environment: 'LOCAL_TEST',
          contractuallyEffective: false,
        };
      },
    );
  }
  async acceptance(userId: string, id: string) {
    this.runtime.assertLocal();
    return this.db.$transaction(async (tx) => {
      const a = await tx.verificationAcceptance.findUnique({
        where: { id },
        include: { terms: true },
      });
      if (!a || a.userId !== userId) fail('VERIFICATION_NOT_FOUND', 404);
      await this.termsAuthority(tx, userId, {
        scope: a.scope as 'DRIVER' | 'FLEET',
        providerId: a.providerId ?? undefined,
      });
      return { ...a, contractuallyEffective: false };
    });
  }
  async createCase(userId: string, key: string, dto: CreateCaseDto) {
    return this.command(
      userId,
      key,
      'CREATE_CASE',
      dto.subjectId,
      dto,
      async (tx) => {
        await this.resolveSubject(tx, userId, dto, false);
      },
      async (tx) => {
        const subject = await this.resolveSubject(tx, userId, dto, true);
        await this.lockSubject(tx, subject);
        await this.requireTerms(tx, subject);
        if (
          await tx.verificationCase.findFirst({
            where: {
              subjectId: subject.id,
              status: { in: ['DRAFT', 'SUBMITTED'] },
            },
          })
        )
          fail('VERIFICATION_OPEN_CASE_EXISTS');
        const row = await tx.verificationCase.create({
          data: { subjectId: subject.id, presenterId: userId },
        });
        return { id: row.id, status: row.status, revision: row.revision };
      },
    );
  }
  private async resolveSubject(
    tx: Tx,
    userId: string,
    dto: CreateCaseDto,
    create: boolean,
  ): Promise<Subject> {
    const driver =
      dto.subjectType === 'DRIVER_IDENTITY'
        ? await tx.driver.findUnique({
            where: { id: dto.subjectId },
            include: { independentProfile: true },
          })
        : null;
    const vehicle =
      dto.subjectType === 'VEHICLE'
        ? await tx.vehicle.findUnique({
            where: { id: dto.subjectId },
            include: {
              independentDriverProfile: { include: { driver: true } },
            },
          })
        : null;
    if (!driver && !vehicle) fail('VERIFICATION_NOT_FOUND', 404);
    const caller = await this.actor(tx, userId);
    const independentScope =
      !!driver?.independentProfile &&
      caller.role === 'DRIVER' &&
      driver.userId === userId;
    const providerId = independentScope
      ? null
      : (driver?.providerId ?? vehicle?.providerId ?? null);
    const profileId = providerId
      ? null
      : (driver?.independentProfile?.id ??
        vehicle?.independentDriverProfileId ??
        null);
    const stub = {
      id: '',
      driverId: driver?.id ?? null,
      vehicleId: vehicle?.id ?? null,
      providerId,
      independentProfileId: profileId,
      driver,
      vehicle,
      independentProfile:
        vehicle?.independentDriverProfile ?? (driver ? { driver } : null),
      createdAt: new Date(),
    } as Subject;
    await this.authorize(tx, userId, stub, true);
    if (!create) return stub;
    // Resource row serializes lazy subject creation, including two distinct idempotency keys.
    if (providerId)
      await tx.$queryRaw`SELECT id FROM "DeliveryProvider" WHERE id=${providerId}::uuid FOR SHARE`;
    if (driver)
      await tx.$queryRaw`SELECT id FROM "Driver" WHERE id=${driver.id}::uuid FOR UPDATE`;
    else
      await tx.$queryRaw`SELECT id FROM "Vehicle" WHERE id=${vehicle!.id}::uuid FOR UPDATE`;
    const existing = await tx.verificationSubject.findFirst({
      where: driver
        ? { driverId: driver.id, providerId, independentProfileId: profileId }
        : { vehicleId: vehicle!.id },
      include: subjectInclude,
    });
    return (
      existing ??
      tx.verificationSubject.create({
        data: {
          driverId: stub.driverId,
          vehicleId: stub.vehicleId,
          providerId,
          independentProfileId: profileId,
        },
        include: subjectInclude,
      })
    );
  }
  async updateCase(
    userId: string,
    key: string,
    id: string,
    dto: UpdateCaseDto,
  ) {
    return this.command(
      userId,
      key,
      'UPDATE_CASE',
      id,
      dto,
      (tx) => this.case(tx, userId, id, true),
      async (tx) => {
        const c = await this.case(tx, userId, id, true, true);
        this.version(c, dto.expectedVersion, 'DRAFT');
        await this.requireTerms(tx, c.subject);
        const data = parseData(!!c.subject.driverId, dto.data);
        const row = await tx.verificationCase.update({
          where: { id },
          data: { data: json(data), revision: { increment: 1 } },
        });
        return { id, status: row.status, revision: row.revision };
      },
    );
  }
  async getCase(userId: string, id: string) {
    this.runtime.assertLocal();
    return this.db.$transaction(async (tx) => {
      const c = await this.case(tx, userId, id);
      const actor = await this.actor(tx, userId);
      const { subject, internalNote, reviewerId, ...publicCase } = c;
      const attachments = await tx.verificationAttachment.findMany({
        where: { caseId: id },
        select: {
          id: true,
          category: true,
          status: true,
          bytes: true,
          mime: true,
          hash: true,
          createdAt: true,
        },
      });
      const events = await tx.verificationEvent.findMany({
        where: { target: id },
        orderBy: { createdAt: 'asc' },
        select: { id: true, kind: true, createdAt: true },
      });
      const status =
        c.status === 'APPROVED'
          ? c.validUntil && c.validUntil <= new Date()
            ? 'EXPIRED'
            : 'APPROVED'
          : c.status === 'SUBMITTED'
            ? 'UNDER_REVIEW'
            : c.status === 'REJECTED'
              ? 'REJECTED'
              : 'NOT_SUBMITTED';
      return {
        ...publicCase,
        verificationStatus: status,
        scope: {
          providerId: subject.providerId,
          independentProfileId: subject.independentProfileId,
        },
        subjectType: subject.driverId ? 'DRIVER_IDENTITY' : 'VEHICLE',
        resourceId: subject.driverId ?? subject.vehicleId,
        attachments,
        events,
        ...(actor.role === 'SUPER_ADMIN' ? { internalNote, reviewerId } : {}),
      };
    });
  }
  async list(userId: string, query: VerificationListDto, admin = false) {
    this.runtime.assertLocal();
    return this.db.$transaction(async (tx) => {
      const actor = await this.actor(tx, userId);
      let scope: Prisma.VerificationSubjectWhereInput = {};
      if (admin) {
        if (actor.role !== 'SUPER_ADMIN') fail('VERIFICATION_FORBIDDEN', 403);
        if (query.providerId) scope = { providerId: query.providerId };
      } else if (actor.role === 'PROVIDER_ADMIN') {
        if (!query.providerId) fail('VERIFICATION_PROVIDER_REQUIRED', 400);
        await this.member(tx, userId, query.providerId);
        scope = { providerId: query.providerId };
      } else if (actor.role === 'DRIVER')
        scope = {
          OR: [
            { driver: { userId } },
            { providerId: null, independentProfile: { driver: { userId } } },
          ],
        };
      else fail('VERIFICATION_FORBIDDEN', 403);
      const where = { status: query.status, subject: scope };
      const items = await tx.verificationCase.findMany({
        where,
        select: {
          id: true,
          subjectId: true,
          status: true,
          revision: true,
          createdAt: true,
          decidedAt: true,
          publicReason: true,
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: query.pageSize,
        skip: (query.page - 1) * query.pageSize,
      });
      const total = await tx.verificationCase.count({ where });
      return {
        items,
        total,
        page: query.page,
        pageSize: query.pageSize,
        totalPages: Math.ceil(total / query.pageSize),
      };
    });
  }
  async createVehicle(userId: string, key: string, dto: OnboardingVehicleDto) {
    return this.command(
      userId,
      key,
      'CREATE_VEHICLE',
      'SELF',
      dto,
      (tx) => this.termsAuthority(tx, userId, { scope: 'DRIVER' }),
      async (tx) => {
        const driver = await tx.driver.findUniqueOrThrow({
          where: { userId },
          include: { independentProfile: true },
        });
        if (!driver.independentProfile) fail('INDEPENDENT_NOT_FOUND', 404);
        await tx.$queryRaw`SELECT id FROM "Driver" WHERE id=${driver.id}::uuid FOR UPDATE`;
        const policy = await this.policy(tx);
        if (
          !(await tx.verificationAcceptance.findFirst({
            where: { userId, version: policy.driverTermsVersion },
          }))
        )
          fail('TERMS_ACCEPTANCE_REQUIRED');
        const count = await tx.vehicle.count({
          where: { independentDriverProfileId: driver.independentProfile.id },
        });
        if (
          count >=
          (this.config.get<number>('INDEPENDENT_DRIVER_MAX_VEHICLES') ?? 3)
        )
          fail('VEHICLE_LIMIT_REACHED');
        const vehicle = await tx.vehicle.create({
          data: {
            ...dto,
            independentDriverProfileId: driver.independentProfile.id,
            status: 'INACTIVE',
            verificationOnboardingPending: true,
          },
        });
        return { id: vehicle.id, status: vehicle.status };
      },
    );
  }
  async onboarding(userId: string) {
    this.runtime.assertLocal();
    return this.db.$transaction(async (tx) => {
      await this.termsAuthority(tx, userId, { scope: 'DRIVER' });
      const driver = await tx.driver.findUniqueOrThrow({
        where: { userId },
        select: {
          id: true,
          providerId: true,
          status: true,
          availability: true,
          independentProfile: {
            select: {
              id: true,
              status: true,
              vehicles: {
                select: {
                  id: true,
                  identifier: true,
                  status: true,
                  type: true,
                },
              },
            },
          },
        },
      });
      const policy = await this.policy(tx);
      const acceptance = await tx.verificationAcceptance.findFirst({
        where: { userId, version: policy.driverTermsVersion },
        select: { id: true, version: true, acceptedAt: true },
      });
      const subjects = await tx.verificationSubject.findMany({
        where: {
          OR: [
            { driverId: driver.id },
            {
              independentProfileId:
                driver.independentProfile?.id ??
                '00000000-0000-0000-0000-000000000000',
            },
          ],
        },
        select: {
          id: true,
          driverId: true,
          vehicleId: true,
          cases: {
            select: {
              id: true,
              status: true,
              revision: true,
              decidedAt: true,
              validUntil: true,
              licenseValidUntil: true,
            },
            orderBy: { createdAt: 'desc' },
            take: 2,
          },
        },
      });
      return {
        driver,
        subjects,
        terms: { requiredVersion: policy.driverTermsVersion, acceptance },
        environment: 'LOCAL_TEST',
        contractuallyEffective: false,
        enforcementEnabled: policy.enabled,
        productionReady: false,
      };
    });
  }
  requirements() {
    this.runtime.assertLocal();
    return {
      policyVersion: POLICY_VERSION,
      environment: 'LOCAL_TEST',
      formats: ['image/jpeg', 'image/png'],
      maxBytes: MAX_BYTES,
      maxPixels: 20000000,
      maxFiles: 10,
      malwareScan: false,
      pdfSupported: false,
      identity: {
        required: ['FACE_PHOTO', 'INE_FRONT', 'INE_BACK'],
        motorizedLicense: 'LICENSE',
        checks: [
          'IDENTITY_MATCH',
          'LEGIBLE',
          'LICENSE_HOLDER',
          'LICENSE_VALIDITY',
          'LICENSE_CATEGORY',
        ],
      },
      vehicle: {
        required: ['REGISTRATION_CARD'],
        OWNED: 'OWNERSHIP_PROOF',
        RENTED: 'RENTAL_CONTRACT',
        BORROWED: 'OWNER_AUTHORIZATION',
        checks: ['UNIT_MATCH', 'LEGIBLE', 'AUTHORIZED_USE'],
      },
      licenseCompatibility:
        'Reviewer confirms declared exact vehicle types; no automatic legal category mapping',
      productionReady: false,
    };
  }
  async upload(userId: string, key: string, id: string, dto: UploadDto) {
    const receipt = await this.command(
      userId,
      key,
      'CREATE_UPLOAD',
      id,
      dto,
      (tx) => this.case(tx, userId, id, true),
      async (tx) => {
        const c = await this.case(tx, userId, id, true, true);
        this.version(c, dto.expectedVersion, 'DRAFT');
        await this.requireTerms(tx, c.subject);
        if (
          (await tx.verificationAttachment.count({ where: { caseId: id } })) >=
          10
        )
          fail('VERIFICATION_FILE_LIMIT');
        const attachmentId = randomUUID(),
          s = c.subject;
        const prefix = s.providerId
          ? `providers/${s.providerId}/${s.driverId ? 'drivers/' + s.driverId + '/identity' : 'vehicles/' + s.vehicleId}`
          : `independents/${s.independentProfile!.driver.id}/${s.driverId ? 'identity' : 'vehicles/' + s.vehicleId}`;
        const a = await tx.verificationAttachment.create({
          data: {
            id: attachmentId,
            caseId: id,
            category: dto.category,
            quarantineKey: `verification/v1/quarantine/${attachmentId}/source`,
            objectKey: `verification/v1/${prefix}/${id}/${attachmentId}/original`,
            expiresAt: new Date(Date.now() + 300000),
          },
        });
        const row = await tx.verificationCase.update({
          where: { id },
          data: { revision: { increment: 1 } },
        });
        return {
          id: a.id,
          status: a.status,
          revision: row.revision,
          expiresAt: a.expiresAt,
        };
      },
    );
    // Authorization and current draft state rechecked even on replay before minting a fresh URL.
    const a = await this.db.$transaction(async (tx) => {
      const c = await this.case(tx, userId, id, true);
      await this.requireTerms(tx, c.subject);
      if (c.status !== 'DRAFT') fail('VERIFICATION_CASE_NOT_DRAFT');
      return tx.verificationAttachment.findUniqueOrThrow({
        where: { id: receipt.id },
      });
    });
    if (a.expiresAt <= new Date() || a.status !== 'CREATED') return receipt;
    try {
      return {
        ...receipt,
        uploadUrl: await this.storage.uploadUrl(a.quarantineKey),
        contentType: 'application/octet-stream',
      };
    } catch {
      fail('STORAGE_UNAVAILABLE', 503);
    }
  }
  async complete(
    userId: string,
    key: string,
    id: string,
    uploadId: string,
    expectedVersion: number,
  ) {
    return this.command(
      userId,
      key,
      'COMPLETE_UPLOAD',
      id,
      { uploadId, expectedVersion },
      (tx) => this.case(tx, userId, id, true),
      async (tx) => {
        const c = await this.case(tx, userId, id, true, true);
        this.version(c, expectedVersion, 'DRAFT');
        await this.requireTerms(tx, c.subject);
        const a = await tx.verificationAttachment.findFirst({
          where: { id: uploadId, caseId: id },
        });
        if (!a) fail('VERIFICATION_NOT_FOUND', 404);
        if (a.status !== 'CREATED' || a.expiresAt <= new Date())
          fail('VERIFICATION_UPLOAD_EXPIRED');
        let body: Buffer;
        try {
          body = await this.storage.read(a.quarantineKey);
        } catch {
          fail('STORAGE_UNAVAILABLE', 503);
        }
        const file = await validateImage(body);
        try {
          await this.storage.write(a.objectKey, file.body);
        } catch {
          fail('STORAGE_UNAVAILABLE', 503);
        }
        await tx.verificationAttachment.update({
          where: { id: uploadId },
          data: {
            status: 'VALIDATED',
            bytes: file.bytes,
            mime: file.mime,
            hash: file.hash,
            sourceHash: file.sourceHash,
          },
        });
        const row = await tx.verificationCase.update({
          where: { id },
          data: { revision: { increment: 1 } },
        });
        return {
          id: uploadId,
          status: 'VALIDATED',
          revision: row.revision,
          malwareScanned: false,
        };
      },
    );
  }
  async attachment(userId: string, id: string, attachmentId: string) {
    this.runtime.assertLocal();
    const a = await this.db.$transaction(async (tx) => {
      await this.case(tx, userId, id);
      const a = await tx.verificationAttachment.findFirst({
        where: { id: attachmentId, caseId: id, status: 'VALIDATED' },
      });
      if (!a) fail('VERIFICATION_NOT_FOUND', 404);
      await this.event(tx, userId, id, 'ATTACHMENT_ACCESS');
      return a;
    });
    try {
      const body = await this.storage.read(a.objectKey);
      if (digest(body) !== a.hash) fail('VERIFICATION_OBJECT_CHANGED');
      return body;
    } catch {
      fail('STORAGE_UNAVAILABLE', 503);
    }
  }
  async removeAttachment(
    userId: string,
    key: string,
    id: string,
    attachmentId: string,
    expectedVersion: number,
  ) {
    return this.command(
      userId,
      key,
      'REMOVE_ATTACHMENT',
      id,
      { attachmentId, expectedVersion },
      (tx) => this.case(tx, userId, id, true),
      async (tx) => {
        const c = await this.case(tx, userId, id, true, true);
        this.version(c, expectedVersion, 'DRAFT');
        const a = await tx.verificationAttachment.findFirst({
          where: { id: attachmentId, caseId: id },
        });
        if (!a) fail('VERIFICATION_NOT_FOUND', 404);
        // Keep immutable file evidence while the account exists. Exclusion from the draft is separate.
        await tx.verificationAttachment.update({
          where: { id: attachmentId },
          data: { status: 'REMOVED' },
        });
        const row = await tx.verificationCase.update({
          where: { id },
          data: { revision: { increment: 1 } },
        });
        return { id: attachmentId, status: 'REMOVED', revision: row.revision };
      },
    );
  }
  private material(s: Subject) {
    if (s.driver) return { name: s.driver.name };
    const v = s.vehicle!;
    return {
      identifier: v.identifier,
      type: v.type,
      brand: v.brand,
      model: v.model,
      year: v.year,
      plate: v.plate,
    };
  }
  async transition(
    userId: string,
    key: string,
    id: string,
    expectedVersion: number,
    action: 'SUBMIT' | 'WITHDRAW',
  ) {
    return this.command(
      userId,
      key,
      action,
      id,
      { expectedVersion },
      (tx) => this.case(tx, userId, id, true),
      async (tx) => {
        const c = await this.case(tx, userId, id, true, true);
        this.version(c, expectedVersion);
        if (!['DRAFT', 'SUBMITTED'].includes(c.status))
          fail('VERIFICATION_CASE_TERMINAL');
        if (action === 'SUBMIT') {
          if (c.status !== 'DRAFT') fail('VERIFICATION_CASE_NOT_DRAFT');
          await this.requireTerms(tx, c.subject);
          const data = parseData(!!c.subject.driverId, c.data) as Record<
            string,
            unknown
          >;
          await this.requiredFiles(tx, c, data);
          const row = await tx.verificationCase.update({
            where: { id },
            data: {
              status: 'SUBMITTED',
              submittedAt: new Date(),
              materialSnapshot: json(this.material(c.subject)),
              revision: { increment: 1 },
            },
          });
          return { id, status: row.status, revision: row.revision };
        }
        const row = await tx.verificationCase.update({
          where: { id },
          data: { status: 'WITHDRAWN', revision: { increment: 1 } },
        });
        return { id, status: row.status, revision: row.revision };
      },
    );
  }
  private async requiredFiles(
    tx: Tx,
    c: VerificationCase & { subject: Subject },
    data: Record<string, unknown>,
  ) {
    const files = await tx.verificationAttachment.findMany({
      where: { caseId: c.id, status: 'VALIDATED' },
    });
    if (
      categories(!!c.subject.driverId, data).some(
        (category) => !files.some((a) => a.category === category),
      )
    )
      fail('VERIFICATION_DOCUMENTS_PENDING');
  }
  async decide(userId: string, key: string, id: string, dto: DecisionDto) {
    return this.command(
      userId,
      key,
      'DECIDE',
      id,
      dto,
      async (tx) => {
        const a = await this.actor(tx, userId);
        if (a.role !== 'SUPER_ADMIN') fail('VERIFICATION_FORBIDDEN', 403);
        await this.case(tx, userId, id);
      },
      async (tx) => {
        const c = await this.case(tx, userId, id, false, true);
        this.version(c, dto.expectedVersion, 'SUBMITTED');
        let license: IdentityData['license'];
        let validUntil: Date | undefined;
        if (dto.decision === 'APPROVE') {
          await this.requireTerms(tx, c.subject);
          const data = parseData(!!c.subject.driverId, c.data) as Record<
            string,
            unknown
          >;
          await this.requiredFiles(tx, c, data);
          const required = checks(!!c.subject.driverId, data);
          if (
            dto.checklistVersion !== c.policyVersion ||
            canonical([...new Set(dto.passedChecks)].sort()) !==
              canonical(required.sort())
          )
            fail('VERIFICATION_CHECKLIST_REQUIRED');
          if (
            canonical(c.materialSnapshot) !==
            canonical(this.material(c.subject))
          )
            fail('VERIFICATION_MATERIAL_CHANGED');
          license = c.subject.driverId
            ? (data as IdentityData).license
            : undefined;
          if (license && new Date(license.expiresAt) <= new Date())
            fail('LICENSE_EXPIRED');
          if (!c.subject.driverId) {
            if (c.subject.vehicle?.type === 'OTHER')
              fail('VERIFICATION_VEHICLE_CLASSIFICATION_REQUIRED');
            if (
              c.subject.vehicle?.type !== 'BICYCLE' &&
              !c.subject.vehicle?.plate
            )
              fail('VERIFICATION_PLATE_REQUIRED');
            const expiry = (data as VehicleData).authorizationExpiresAt;
            validUntil = expiry ? new Date(expiry) : undefined;
            if (validUntil && validUntil <= new Date())
              fail('VERIFICATION_EXPIRED');
          }
        } else if (!dto.publicReason?.trim())
          fail('VERIFICATION_REJECTION_REASON_REQUIRED', 400);
        const row = await tx.verificationCase.update({
          where: { id },
          data: {
            status: dto.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',
            revision: { increment: 1 },
            reviewerId: userId,
            decidedAt: new Date(),
            publicReason: dto.publicReason,
            internalNote: dto.internalNote,
            checklist: json({
              version: dto.checklistVersion,
              passed: dto.passedChecks,
            }),
            validUntil,
            licenseValidUntil: license
              ? new Date(license.expiresAt)
              : undefined,
            licenseVehicleTypes: license?.vehicleTypes ?? [],
          },
        });
        if (
          dto.decision === 'APPROVE' &&
          c.subject.driverId &&
          !c.subject.providerId
        ) {
          const driver = await tx.driver.findUniqueOrThrow({
            where: { id: c.subject.driverId },
            include: { independentProfile: true },
          });
          if (
            driver.status === 'PENDING' &&
            driver.independentProfile?.status === 'PENDING'
          ) {
            await tx.driver.update({
              where: { id: driver.id },
              data: { status: 'ACTIVE', availability: 'OFFLINE' },
            });
            await tx.independentDriverProfile.update({
              where: { id: driver.independentProfile.id },
              data: {
                status: 'APPROVED',
                approvedByUserId: userId,
                approvedAt: new Date(),
              },
            });
          }
        }
        if (dto.decision === 'APPROVE' && c.subject.vehicleId) {
          const vehicle = await tx.vehicle.findUniqueOrThrow({
            where: { id: c.subject.vehicleId },
          });
          if (
            vehicle.verificationOnboardingPending &&
            vehicle.status === 'INACTIVE'
          )
            await tx.vehicle.update({
              where: { id: vehicle.id },
              data: { status: 'ACTIVE', verificationOnboardingPending: false },
            });
        }
        // Only onboarding's initial INACTIVE is cleared. Any explicit status update clears its marker.
        const recipients = new Set([
          c.presenterId,
          ...(c.subject.driver ? [c.subject.driver.userId] : []),
        ]);
        for (const recipientId of recipients)
          await tx.verificationNotice.create({
            data: { caseId: id, recipientId },
          });
        return {
          id,
          status: row.status,
          revision: row.revision,
          decidedAt: row.decidedAt,
        };
      },
    );
  }
  async notifications(userId: string) {
    this.runtime.assertLocal();
    return this.db.$transaction(async (tx) => {
      const user = await this.actor(tx, userId);
      const scope: Prisma.VerificationSubjectWhereInput =
        user.role === 'PROVIDER_ADMIN'
          ? { provider: { memberships: { some: { userId } } } }
          : {
              OR: [
                { driver: { userId } },
                {
                  providerId: null,
                  independentProfile: { driver: { userId } },
                },
              ],
            };
      return tx.verificationNotice.findMany({
        where: { recipientId: userId, case: { subject: scope } },
        select: {
          id: true,
          caseId: true,
          status: true,
          createdAt: true,
          case: {
            select: { status: true, publicReason: true, decidedAt: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
      });
    });
  }
  async requestEmailVerification(userId: string) {
    this.runtime.assertLocal();
    const token = randomBytes(32).toString('base64url');
    const challenge = await this.db.$transaction(async (tx) => {
      const user = await this.actor(tx, userId);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${user.email},4))`;
      if (
        user.emailVerifiedAt ||
        (await tx.driverRegistrationChallenge.findFirst({
          where: { userId, createdAt: { gt: new Date(Date.now() - 60000) } },
        }))
      )
        return null;
      return tx.driverRegistrationChallenge.create({
        data: {
          userId,
          email: user.email,
          tokenHash: digest(token),
          expiresAt: new Date(Date.now() + 1800000),
        },
      });
    });
    if (challenge)
      try {
        if (!this.mail.sendDriverVerification) throw new Error();
        await this.mail.sendDriverVerification({
          to: challenge.email,
          kind: 'EMAIL_VERIFICATION',
          reference: challenge.id,
          token,
        });
      } catch {
        /* Retry after cooldown; never mark email verified on mail failure. */
      }
    return { status: 'CHECK_EMAIL' };
  }
  async confirmEmail(userId: string, token: string) {
    this.runtime.assertLocal();
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id=${userId}::uuid FOR UPDATE`;
      const user = await this.actor(tx, userId);
      await tx.$queryRaw`SELECT id FROM "DriverRegistrationChallenge" WHERE "tokenHash"=${digest(token)} FOR UPDATE`;
      const c = await tx.driverRegistrationChallenge.findUnique({
        where: { tokenHash: digest(token) },
      });
      if (
        !c ||
        c.userId !== userId ||
        c.email !== user.email ||
        (!c.consumedAt && c.expiresAt <= new Date())
      )
        fail('REGISTRATION_INVALID', 400);
      if (!c.consumedAt) {
        await tx.user.update({
          where: { id: userId },
          data: { emailVerifiedAt: new Date() },
        });
        await tx.driverRegistrationChallenge.update({
          where: { id: c.id },
          data: { consumedAt: new Date() },
        });
      }
      return { status: 'EMAIL_VERIFIED' };
    });
  }
  private async attemptAuthority(tx: Tx, userId: string, dto: AttemptDto) {
    if (dto.operation === 'ACCEPT_TERMS')
      return this.termsAuthority(tx, userId, {
        scope: dto.target === 'DRIVER' ? 'DRIVER' : 'FLEET',
        providerId: dto.target.startsWith('FLEET:')
          ? dto.target.slice(6)
          : undefined,
      });
    if (dto.operation === 'CREATE_VEHICLE')
      return this.termsAuthority(tx, userId, { scope: 'DRIVER' });
    if (dto.operation === 'POLICY') {
      const u = await this.actor(tx, userId);
      if (u.role !== 'SUPER_ADMIN') fail('VERIFICATION_FORBIDDEN', 403);
      return;
    }
    if (!isUUID(dto.target)) fail('VERIFICATION_TARGET_INVALID', 400);
    if (dto.operation === 'CREATE_CASE') {
      const driver = await tx.driver.findUnique({ where: { id: dto.target } });
      return this.resolveSubject(
        tx,
        userId,
        {
          subjectId: dto.target,
          subjectType: driver ? 'DRIVER_IDENTITY' : 'VEHICLE',
        },
        false,
      );
    }
    return this.case(tx, userId, dto.target, dto.operation !== 'DECIDE');
  }
  async attempt(userId: string, key: string, dto: AttemptDto, close = false) {
    this.runtime.assertLocal();
    return this.db.$transaction(async (tx) => {
      if (close)
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${userId + ':' + key},0))`;
      await this.attemptAuthority(tx, userId, dto);
      const old = await tx.verificationCommand.findUnique({
        where: { actorId_key: { actorId: userId, key } },
      });
      if (old && (old.operation !== dto.operation || old.target !== dto.target))
        fail('IDEMPOTENCY_KEY_REUSED');
      if (old) return { state: old.state, result: old.result };
      if (close)
        await tx.verificationCommand.create({
          data: {
            actorId: userId,
            key,
            operation: dto.operation,
            target: dto.target,
            hash: '',
            result: {},
            state: 'CLOSED_NO_EFFECTS',
          },
        });
      return { state: close ? 'CLOSED_NO_EFFECTS' : 'ABSENT' };
    });
  }
  async activation(userId: string, key: string, dto: PolicyDto) {
    return this.command(
      userId,
      key,
      'POLICY',
      'POLICY',
      dto,
      async (tx) => {
        const u = await this.actor(tx, userId);
        if (u.role !== 'SUPER_ADMIN') fail('VERIFICATION_FORBIDDEN', 403);
      },
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "VerificationPolicy" WHERE id=1 FOR UPDATE`;
        const policy = await tx.verificationPolicy.findUniqueOrThrow({
          where: { id: 1 },
        });
        if (policy.revision !== dto.expectedVersion)
          fail('VERIFICATION_VERSION_CONFLICT');
        return tx.verificationPolicy.update({
          where: { id: 1 },
          data: { enabled: dto.enabled, revision: { increment: 1 } },
        });
      },
    );
  }
}
