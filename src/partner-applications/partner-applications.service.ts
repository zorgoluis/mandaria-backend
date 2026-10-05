import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { PartnerApplication } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { nextPublicId } from '../common/public-id.js';
import { pageResult } from '../common/pagination.dto.js';
import { MAIL_PROVIDER, MailDeliveryError } from '../mail/mail.types.js';
import type { MailProvider } from '../mail/mail.types.js';
import {
  DUPLICATE_WINDOW_DAYS,
  OPEN_STATUSES,
  PARTNER_APPLICATION_TRANSITIONS,
  assertLinks,
  assertTransition,
  notFound,
  normalizeReference,
} from './partner-application-policy.js';
import type {
  ChangePartnerApplicationStatusDto,
  CreatePartnerApplicationDto,
  LinkPartnerApplicationDto,
  PartnerApplicationListQueryDto,
} from './partner-applications.dto.js';

/** Advisory lock namespace serializing submissions that share a phone or an email. */
const SUBMISSION_LOCK_NAMESPACE = 71_600_010;
const DAY_MS = 86_400_000;

export function partnerApplicationView(row: PartnerApplication) {
  return {
    reference: row.publicId,
    type: row.type,
    status: row.status,
    contactName: row.contactName,
    phone: row.phone,
    email: row.email,
    city: row.city,
    vehicleType: row.vehicleType,
    fleetName: row.fleetName,
    fleetUnits: row.fleetUnits,
    privacyNoticeVersion: row.privacyNoticeVersion,
    privacyAcceptedAt: row.privacyAcceptedAt,
    source: row.source,
    submissionCount: row.submissionCount,
    lastSubmittedAt: row.lastSubmittedAt,
    reviewNote: row.reviewNote,
    statusChangedAt: row.statusChangedAt,
    statusChangedByUserId: row.statusChangedByUserId,
    providerId: row.providerId,
    invitationId: row.invitationId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    allowedTransitions: [...PARTNER_APPLICATION_TRANSITIONS[row.status]],
  };
}

/**
 * Partner applications are leads: nothing here creates or changes users, drivers, providers,
 * invitations or independent profiles. Logs carry only the reference, requestId and status.
 */
@Injectable()
export class PartnerApplicationsService {
  private readonly logger = new Logger(PartnerApplicationsService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject(MAIL_PROVIDER) private readonly mail: MailProvider,
  ) {}

  /**
   * Contract §5: an open application (RECEIVED/CONTACTED) created in the last 30 days with the
   * same phone or email absorbs the submission and keeps its reference. Advisory locks on both
   * values, taken in a fixed order, make two simultaneous submissions resolve to one row.
   */
  async submit(dto: CreatePartnerApplicationDto, requestId: string) {
    const now = new Date();
    const result = await this.prisma.$transaction(async (tx) => {
      for (const key of [`phone:${dto.phone}`, `email:${dto.email}`].sort())
        await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(${SUBMISSION_LOCK_NAMESPACE}::int, hashtext(${key}))`;
      const existing = await tx.partnerApplication.findFirst({
        where: {
          status: { in: OPEN_STATUSES },
          createdAt: {
            gte: new Date(now.getTime() - DUPLICATE_WINDOW_DAYS * DAY_MS),
          },
          OR: [{ phone: dto.phone }, { email: dto.email }],
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true },
      });
      if (existing) {
        const row = await tx.partnerApplication.update({
          where: { id: existing.id },
          data: { submissionCount: { increment: 1 }, lastSubmittedAt: now },
          select: { publicId: true, submissionCount: true },
        });
        return { ...row, duplicate: true, type: dto.type, city: dto.city };
      }
      const fleet = dto.type === 'FLEET';
      const row = await tx.partnerApplication.create({
        data: {
          publicId: await nextPublicId(tx, 'SOC'),
          type: dto.type,
          contactName: dto.contactName,
          phone: dto.phone,
          email: dto.email,
          city: dto.city,
          vehicleType: dto.vehicleType,
          fleetName: fleet ? dto.fleetName : null,
          fleetUnits: fleet ? dto.fleetUnits : null,
          privacyNoticeVersion: dto.privacyNoticeVersion,
          privacyAcceptedAt: now,
          lastSubmittedAt: now,
          createdAt: now,
        },
        select: { publicId: true, submissionCount: true },
      });
      return { ...row, duplicate: false, type: dto.type, city: dto.city };
    });
    this.logger.log({
      event: result.duplicate
        ? 'PARTNER_APPLICATION_DUPLICATE'
        : 'PARTNER_APPLICATION_RECEIVED',
      reference: result.publicId,
      requestId,
      status: 'RECEIVED',
      submissionCount: result.submissionCount,
    });
    if (!result.duplicate)
      this.notify(result.publicId, result.type, result.city, requestId);
    return { reference: result.publicId, status: 'RECEIVED' as const };
  }

  /** Honeypot: no row, no body in logs; only the decoy reference and the correlation id. */
  logHoneypot(reference: string, requestId: string) {
    this.logger.warn({
      event: 'PARTNER_APPLICATION_HONEYPOT',
      reference,
      requestId,
    });
  }

  async list(query: PartnerApplicationListQueryDto) {
    const q = query.q;
    const where: Prisma.PartnerApplicationWhereInput = {
      status: query.status,
      type: query.type,
      ...(q
        ? {
            OR: [
              { publicId: { contains: q, mode: 'insensitive' } },
              { contactName: { contains: q, mode: 'insensitive' } },
              { phone: { contains: q } },
              { email: { contains: q, mode: 'insensitive' } },
              { fleetName: { contains: q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.partnerApplication.count({ where }),
      this.prisma.partnerApplication.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);
    return pageResult(rows.map(partnerApplicationView), total, query);
  }

  async get(reference: string) {
    const publicId = normalizeReference(reference);
    const row = publicId
      ? await this.prisma.partnerApplication.findUnique({ where: { publicId } })
      : null;
    if (!row) throw notFound();
    return partnerApplicationView(row);
  }

  async changeStatus(
    reference: string,
    dto: ChangePartnerApplicationStatusDto,
    actorId: string,
    requestId: string,
  ) {
    const { before, row } = await this.prisma.$transaction(async (tx) => {
      const current = await this.lock(tx, reference);
      const reviewNote = assertTransition(current, dto.status, dto.reviewNote);
      const row = await tx.partnerApplication.update({
        where: { id: current.id },
        data: {
          status: dto.status,
          reviewNote,
          statusChangedAt: new Date(),
          statusChangedByUserId: actorId,
        },
      });
      return { before: current.status, row };
    });
    this.logger.log({
      event: 'PARTNER_APPLICATION_STATUS_CHANGED',
      reference: row.publicId,
      requestId,
      fromStatus: before,
      status: row.status,
      actorUserId: actorId,
    });
    return partnerApplicationView(row);
  }

  async link(
    reference: string,
    dto: LinkPartnerApplicationDto,
    actorId: string,
    requestId: string,
  ) {
    if (dto.providerId === undefined && dto.invitationId === undefined)
      throw new BadRequestException(['providerId or invitationId is required']);
    const row = await this.prisma.$transaction(async (tx) => {
      const current = await this.lock(tx, reference);
      const provider =
        dto.providerId === undefined
          ? null
          : await tx.deliveryProvider.findUnique({
              where: { id: dto.providerId },
              select: { id: true, type: true },
            });
      const invitationId = dto.invitationId ?? current.invitationId;
      const invitation = invitationId
        ? await tx.userInvitation.findUnique({
            where: { id: invitationId },
            select: { id: true, email: true, providerId: true },
          })
        : null;
      const links = assertLinks(current, dto, provider, invitation);
      return tx.partnerApplication.update({
        where: { id: current.id },
        data: links,
      });
    });
    this.logger.log({
      event: 'PARTNER_APPLICATION_LINKED',
      reference: row.publicId,
      requestId,
      status: row.status,
      providerId: row.providerId,
      invitationId: row.invitationId,
      actorUserId: actorId,
    });
    return partnerApplicationView(row);
  }

  /** Row lock shared by status changes and links, so neither acts on a stale status. */
  private async lock(tx: Prisma.TransactionClient, reference: string) {
    const publicId = normalizeReference(reference);
    if (!publicId) throw notFound();
    const [locked] = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM "PartnerApplication" WHERE "publicId" = ${publicId} FOR UPDATE`;
    if (!locked) throw notFound();
    return tx.partnerApplication.findUniqueOrThrow({
      where: { id: locked.id },
    });
  }

  /** Fire-and-forget after commit: a mail failure never fails the submission. */
  private notify(
    reference: string,
    type: 'INDIVIDUAL' | 'FLEET',
    city: string,
    requestId: string,
  ) {
    const to = this.config.get<string>('PARTNER_APPLICATIONS_NOTIFY_EMAIL');
    if (!to) return;
    void this.mail
      .sendPartnerApplicationNotice({ to, reference, type, city })
      .then(() =>
        this.logger.log({
          event: 'PARTNER_APPLICATION_NOTICE_SENT',
          reference,
          requestId,
          mailProvider: this.mail.name,
        }),
      )
      .catch((error: unknown) =>
        this.logger.warn({
          event: 'PARTNER_APPLICATION_NOTICE_FAILED',
          reference,
          requestId,
          mailProvider: this.mail.name,
          reason:
            error instanceof MailDeliveryError ? error.reason : 'UNEXPECTED',
        }),
      );
  }
}
