import { lockCustomer, ownerKey } from '../customers/demand-owner.js';
import type { DirectAcceptanceDto } from '../customers/direct-demand.dto.js';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { DomainException } from '../common/domain-error.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { IdempotencyService } from '../idempotency/idempotency.service.js';
import type { IntegrationRequest } from '../integrations/integration.guard.js';
import { openDispatch } from '../dispatch/dispatch-policy.js';
import {
  DeliveryQuotesService,
  quoteSelect,
} from './delivery-quotes.service.js';
import type { AcceptDeliveryQuoteDto } from './authorized-acceptance.dto.js';
const fail = (code: string, status = 409) =>
  new DomainException(code, status, code);

/** Uses the existing quote opener and idempotency transaction; consent is attested, not verified. */
@Injectable()
export class AuthorizedAcceptanceService {
  private readonly logger = new Logger(AuthorizedAcceptanceService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly idempotency: IdempotencyService,
    private readonly quotes: DeliveryQuotesService,
    private readonly config: ConfigService,
  ) {}

  async accept(
    publicId: string,
    principal: IntegrationRequest['integration'],
    key: string | undefined,
    dto: AcceptDeliveryQuoteDto,
  ) {
    const owned = await this.quotes.getOwned(publicId, principal.id);
    const shipping = await this.prisma.deliveryShippingTerms.findUnique({
      where: { deliveryRequestId: owned.deliveryRequestId },
    });
    if (!owned.prequoteConversion && shipping?.payer !== 'REQUESTER') {
      if (dto.customerAuthorization !== undefined)
        throw fail('AUTHORIZED_ACCEPT_ORIGIN_REQUIRED', 400);
      return {
        quote: await this.quotes.accept(publicId, principal.id),
        replayed: undefined,
      };
    }
    const authorization = dto.customerAuthorization;
    if (!authorization || !key || !/^[!-~]{8,255}$/.test(key))
      throw new BadRequestException([
        'Converted quote requires customerAuthorization and Idempotency-Key',
      ]);
    const payload = {
      publicId,
      customerAuthorization: {
        ...authorization,
        authorizedAt: new Date(authorization.authorizedAt).toISOString(),
        expiresAt: new Date(authorization.expiresAt).toISOString(),
      },
    };
    try {
      const outcome = await this.idempotency.execute(
        {
          integrationClientId: principal.id,
          key,
          operation: 'delivery_quotes.accept_authorized',
          resourceType: 'AuthorizedQuoteAcceptance',
        },
        payload,
        async (tx, id) => {
          // Same parent-before-credential order as integration administration. Cancellation locks MDR only.
          const [client] = await tx.$queryRaw<
            { status: string }[]
          >`SELECT status FROM "IntegrationClient" WHERE id=${principal.id}::uuid FOR SHARE`;
          const [credential] = await tx.$queryRaw<
            {
              clientId: string;
              status: string;
              revokedAt: Date | null;
              expiresAt: Date | null;
              scopes: string[];
            }[]
          >`SELECT "clientId",status,"revokedAt","expiresAt",scopes FROM "IntegrationCredential" WHERE id=${principal.authentication.credentialId}::uuid FOR SHARE`;
          const [request] = await tx.$queryRaw<
            { status: string }[]
          >`SELECT status FROM "DeliveryRequest" WHERE id=${owned.deliveryRequestId}::uuid FOR UPDATE`;
          await tx.$queryRaw`SELECT id FROM "DeliveryQuote" WHERE id=${owned.id}::uuid FOR SHARE`;
          const quote = await tx.deliveryQuote.findUniqueOrThrow({
            where: { id: owned.id },
            select: quoteSelect,
          });
          const [zone] = await tx.$queryRaw<
            { status: string }[]
          >`SELECT status FROM "ServiceZone" WHERE id=${quote.serviceZoneId}::uuid FOR SHARE`;
          const [clock] = await tx.$queryRaw<
            { now: Date }[]
          >`SELECT date_trunc('milliseconds',clock_timestamp() AT TIME ZONE 'UTC') AS now`;
          if (
            client?.status !== 'ACTIVE' ||
            !credential ||
            credential.clientId !== principal.id ||
            credential.status !== 'ACTIVE' ||
            credential.revokedAt ||
            (credential.expiresAt && credential.expiresAt <= clock.now) ||
            principal.authentication.tokenExpiresAt <= clock.now
          )
            throw new UnauthorizedException('Invalid integration credentials');
          if (
            !credential.scopes.includes('quotes:accept') ||
            !principal.authentication.tokenScopes.includes('quotes:accept')
          )
            throw new ForbiddenException();
          if (
            await tx.authorizedQuoteAcceptance.findUnique({
              where: { deliveryQuoteId: quote.id },
              select: { id: true },
            })
          )
            throw fail('QUOTE_ALREADY_AUTHORIZED');
          if (request.status !== 'CREATED' || quote.status === 'CANCELLED')
            throw fail('QUOTE_NOT_ACCEPTABLE');
          if (quote.status === 'EXPIRED' || quote.expiresAt <= clock.now)
            throw fail('QUOTE_EXPIRED');
          if (quote.status !== 'OFFERED') throw fail('QUOTE_NOT_ACCEPTABLE');
          if (
            authorization.quotePublicId !== publicId ||
            authorization.amount !== quote.amount.toFixed(2) ||
            authorization.currency !== quote.currency ||
            payload.customerAuthorization.expiresAt !==
              quote.expiresAt.toISOString()
          )
            throw fail('CUSTOMER_AUTHORIZATION_MISMATCH');
          const authorizedAt = new Date(
            payload.customerAuthorization.authorizedAt,
          );
          if (authorizedAt < quote.createdAt || authorizedAt > clock.now)
            throw new BadRequestException([
              'Consent must follow quote creation and not be future',
            ]);
          if (zone?.status !== 'ACTIVE')
            throw fail('AUTHORIZED_ACCEPT_SERVICE_UNAVAILABLE');
          this.assertEnabled();
          const conversion = await tx.prequoteConversion.findUnique({
            where: { deliveryRequestId: quote.deliveryRequestId },
          });
          const record = await tx.apiIdempotencyRecord.findUniqueOrThrow({
            where: {
              integrationClientId_key: {
                integrationClientId: principal.id,
                key,
              },
            },
            select: { id: true },
          });
          const terms = await tx.deliveryShippingTerms.findUnique({
            where: { deliveryRequestId: quote.deliveryRequestId },
          });
          if (
            (terms?.payer === 'REQUESTER' || authorization.version === 2) &&
            (!terms ||
              authorization.shippingTermsHash !== terms.termsHash ||
              authorization.shippingTermsVersion !== terms.termsVersion ||
              authorization.version !== 2)
          )
            throw fail('CUSTOMER_AUTHORIZATION_MISMATCH');
          const evidence = await tx.authorizedQuoteAcceptance.create({
            data: {
              id,
              conversionId: conversion?.id,
              deliveryRequestId: quote.deliveryRequestId,
              deliveryQuoteId: quote.id,
              integrationClientId: principal.id,
              dispatchId: randomUUID(),
              idempotencyRecordId: record.id,
              credentialId: principal.authentication.credentialId,
              authenticatedTokenExpiresAt:
                principal.authentication.tokenExpiresAt,
              shippingTermsHash: authorization.shippingTermsHash,
              authorizationVersion: authorization.version,
              authorizationStatus: authorization.status,
              authorizationReference: authorization.reference,
              authorizedAt,
              authorizedAmount: authorization.amount,
              authorizedCurrency: authorization.currency,
              authorizedExpiresAt: quote.expiresAt,
            },
          });
          const accepted = await tx.deliveryQuote.update({
            where: { id: quote.id },
            data: { status: 'ACCEPTED', acceptedAt: evidence.acceptedAt },
            select: quoteSelect,
          });
          await openDispatch(
            tx,
            accepted,
            this.config.getOrThrow<number>('DISPATCH_TTL_MINUTES'),
            evidence.acceptedAt,
          );
          this.assertEnabled();
        },
        (id) =>
          this.prisma.$transaction(
            async (tx) => {
              const row = await tx.authorizedQuoteAcceptance.findFirst({
                where: { id, integrationClientId: principal.id },
                select: { quote: { select: quoteSelect } },
              });
              if (!row) throw new NotFoundException('Delivery quote not found');
              return row.quote;
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
          ),
      );
      if (!outcome.replayed)
        this.logger.log({
          event: 'DELIVERY_QUOTE_AUTHORIZED',
          quotePublicId: publicId,
          deliveryRequestPublicId: outcome.result.deliveryRequest.publicId,
        });
      return { quote: outcome.result, replayed: outcome.replayed };
    } catch (error) {
      throw mapAuthorizedAcceptanceError(error);
    }
  }

  async acceptDirect(
    publicId: string,
    customerAccountId: string,
    userId: string,
    authentication: { sessionVersion: number; tokenExpiresAt: Date },
    key: string,
    dto: DirectAcceptanceDto,
  ) {
    if (!/^[!-~]{8,255}$/.test(key)) throw fail('IDEMPOTENCY_KEY_INVALID', 400);
    const authorization = dto.customerAuthorization;
    const owner = { kind: 'CUSTOMER' as const, id: customerAccountId };
    const owned = await this.prisma.deliveryQuote.findFirst({
      where: {
        publicId,
        deliveryRequest: { customerAccountId, integrationClientId: null },
      },
      select: quoteSelect,
    });
    if (!owned) throw new NotFoundException('Delivery quote not found');
    try {
      return await this.idempotency.execute(
        {
          customerAccountId,
          key,
          operation: 'delivery_quotes.accept_authorized',
          resourceType: 'AuthorizedQuoteAcceptance',
          attemptResource: publicId,
        },
        { publicId, customerAuthorization: authorization },
        async (tx, id) => {
          const account = await lockCustomer(tx, owner);
          await tx.$queryRaw`SELECT id FROM "User" WHERE id=${userId}::uuid FOR SHARE`;
          const user = await tx.user.findUnique({ where: { id: userId } });
          if (
            account?.userId !== userId ||
            !user?.active ||
            !user.emailVerifiedAt ||
            user.sessionVersion !== authentication.sessionVersion ||
            authentication.tokenExpiresAt <= new Date()
          )
            throw new UnauthorizedException();
          await tx.$queryRaw`SELECT id FROM "DeliveryRequest" WHERE id=${owned.deliveryRequestId}::uuid FOR UPDATE`;
          await tx.$queryRaw`SELECT id FROM "DeliveryQuote" WHERE id=${owned.id}::uuid FOR SHARE`;
          const request = await tx.deliveryRequest.findUniqueOrThrow({
            where: { id: owned.deliveryRequestId },
            include: { shippingTerms: true, directLifecycle: true },
          });
          const quote = await tx.deliveryQuote.findUniqueOrThrow({
            where: { id: owned.id },
            select: quoteSelect,
          });
          const [zone] = await tx.$queryRaw<
            { status: string }[]
          >`SELECT status FROM "ServiceZone" WHERE id=${quote.serviceZoneId}::uuid FOR SHARE`;
          const [clock] = await tx.$queryRaw<
            { now: Date }[]
          >`SELECT date_trunc('milliseconds',clock_timestamp() AT TIME ZONE 'UTC') AS now`;
          if (
            !request.directLifecycle ||
            request.directLifecycle.closedAt ||
            request.status !== 'CREATED'
          )
            throw fail('QUOTE_NOT_ACCEPTABLE');
          if (quote.expiresAt <= clock.now || quote.status === 'EXPIRED')
            throw fail('QUOTE_EXPIRED');
          if (quote.status !== 'OFFERED') throw fail('QUOTE_NOT_ACCEPTABLE');
          if (
            !request.shippingTerms ||
            authorization.shippingTermsHash !==
              request.shippingTerms.termsHash ||
            authorization.shippingTermsVersion !==
              request.shippingTerms.termsVersion ||
            authorization.quotePublicId !== publicId ||
            authorization.amount !== quote.amount.toFixed(2) ||
            authorization.currency !== quote.currency ||
            new Date(authorization.expiresAt).getTime() !==
              quote.expiresAt.getTime()
          )
            throw fail('CUSTOMER_AUTHORIZATION_MISMATCH');
          const authorizedAt = new Date(authorization.authorizedAt);
          if (authorizedAt < quote.createdAt || authorizedAt > clock.now)
            throw fail('CUSTOMER_AUTHORIZATION_MISMATCH');
          if (zone?.status !== 'ACTIVE')
            throw fail('AUTHORIZED_ACCEPT_SERVICE_UNAVAILABLE');
          this.assertEnabled();
          if (!this.config.get<boolean>('CUSTOMER_ADMISSION_ENABLED'))
            throw fail('CUSTOMER_ADMISSION_DISABLED', 503);
          const conversion = await tx.prequoteConversion.findUniqueOrThrow({
            where: { deliveryRequestId: quote.deliveryRequestId },
          });
          const record = await tx.apiIdempotencyRecord.findUniqueOrThrow({
            where: ownerKey(owner, key),
          });
          const evidence = await tx.authorizedQuoteAcceptance.create({
            data: {
              id,
              conversionId: conversion.id,
              deliveryRequestId: quote.deliveryRequestId,
              deliveryQuoteId: quote.id,
              customerAccountId,
              dispatchId: randomUUID(),
              idempotencyRecordId: record.id,
              userId,
              evidenceKind: 'DIRECT_CUSTOMER',
              shippingTermsHash: request.shippingTerms.termsHash,
              authenticatedTokenExpiresAt: authentication.tokenExpiresAt,
              authorizationVersion: authorization.version,
              authorizationStatus: authorization.status,
              authorizationReference: authorization.reference,
              authorizedAt,
              authorizedAmount: authorization.amount,
              authorizedCurrency: authorization.currency,
              authorizedExpiresAt: quote.expiresAt,
            },
          });
          const accepted = await tx.deliveryQuote.update({
            where: { id: quote.id },
            data: { status: 'ACCEPTED', acceptedAt: evidence.acceptedAt },
            select: quoteSelect,
          });
          await openDispatch(
            tx,
            accepted,
            this.config.getOrThrow<number>('DISPATCH_TTL_MINUTES'),
            evidence.acceptedAt,
          );
        },
        async (id) => {
          const evidence =
            await this.prisma.authorizedQuoteAcceptance.findFirst({
              where: { id, customerAccountId, userId },
              select: { quote: { select: quoteSelect } },
            });
          if (!evidence)
            throw new NotFoundException('Delivery quote not found');
          return evidence.quote;
        },
      );
    } catch (error) {
      throw mapAuthorizedAcceptanceError(error);
    }
  }
  private assertEnabled() {
    if (!this.config.get<boolean>('PREQUOTE_AUTHORIZED_ACCEPT_ENABLED'))
      throw fail('AUTHORIZED_ACCEPT_DISABLED', 503);
  }
}

// Only our exact SQL business exceptions and recognized transaction failures are mapped.
export function mapAuthorizedAcceptanceError(error: unknown): unknown {
  const codes: Record<string, number> = {
    QUOTE_EXPIRED: 409,
    QUOTE_NOT_ACCEPTABLE: 409,
    QUOTE_ALREADY_AUTHORIZED: 409,
    CUSTOMER_AUTHORIZATION_MISMATCH: 409,
    AUTHORIZED_ACCEPT_SERVICE_UNAVAILABLE: 409,
    AUTHORIZED_ACCEPT_AUTH_INVALID: 401,
  };
  let message: string | undefined;
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (
      ['P2028', 'P2034'].includes(error.code) ||
      (error.code === 'P2010' &&
        ['40P01', '55P03', '57014'].includes(String(error.meta?.code)))
    )
      return fail('AUTHORIZED_ACCEPT_UNAVAILABLE', 503);
    if (error.code === 'P2010' && error.meta?.code === 'P0001')
      message = String(error.meta.message);
    if (error.code === 'P2004') message = String(error.meta?.database_error);
  }
  if (error instanceof Prisma.PrismaClientUnknownRequestError)
    message = error.message;
  if (message)
    for (const [code, status] of Object.entries(codes)) {
      if (
        message === code ||
        new RegExp(
          '(?:^|\\n|db error: |Error in connector: Error querying the database: )ERROR: ' +
            code +
            '(?:\\n|$)',
        ).test(message)
      )
        return status === 401
          ? new UnauthorizedException('Invalid integration credentials')
          : fail(code, status);
    }
  return error;
}
