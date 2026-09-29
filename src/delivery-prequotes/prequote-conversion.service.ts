import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  IdempotencyService,
  canonicalJson,
} from '../idempotency/idempotency.service.js';
import { normalizeDeliveryRequest } from '../delivery-requests/delivery-requests.service.js';
import { nextPublicId } from '../common/public-id.js';
import { DomainException } from '../common/domain-error.js';
import { normalizePrequoteConditions } from './prequote-conditions.js';
import { ConvertPrequoteDto } from './prequote-conversion.dto.js';
import {
  integrationQuoteView,
  quoteSelect,
} from '../delivery-quotes/delivery-quotes.service.js';
const fail = (code: string, status = 409) =>
  new DomainException(code, status, code);
export function conversionPayload(publicId: string, dto: ConvertPrequoteDto) {
  const deliveryRequest = normalizeDeliveryRequest(dto.deliveryRequest);
  if (
    dto.conditionsVersion !== 1 ||
    dto.deliveryRequest.serviceType !== 'LOCAL_DELIVERY' ||
    deliveryRequest.financialContext.goodsPaymentMode !== 'PREPAID' ||
    deliveryRequest.financialContext.currency !== 'MXN'
  )
    throw new BadRequestException([
      'Conversion requires LOCAL_DELIVERY, PREPAID and MXN',
    ]);
  const conditions = normalizePrequoteConditions({
    conditionsVersion: dto.conditionsVersion,
    serviceType: 'LOCAL_DELIVERY',
    stops: deliveryRequest.stops.map(
      ({ type, sequence, latitude, longitude }) => ({
        type,
        sequence,
        latitude,
        longitude,
      }),
    ),
    packages: deliveryRequest.packages.map(
      ({
        category,
        quantity,
        weightKg,
        lengthCm,
        widthCm,
        heightCm,
        isFragile,
      }) => ({
        category,
        quantity,
        weightKg,
        lengthCm,
        widthCm,
        heightCm,
        isFragile,
      }),
    ),
  });
  const merchantConfirmation = {
    ...dto.merchantConfirmation,
    goodsPaymentConfirmedAt: new Date(
      dto.merchantConfirmation.goodsPaymentConfirmedAt,
    ).toISOString(),
    orderAcceptedAt: new Date(
      dto.merchantConfirmation.orderAcceptedAt,
    ).toISOString(),
  };
  return {
    conditions,
    payload: {
      publicId,
      conditionsVersion: 1,
      deliveryRequest,
      merchantConfirmation,
      deliveryCollectionInstruction: { ...dto.deliveryCollectionInstruction },
    },
  };
}
@Injectable()
export class PrequoteConversionService {
  private readonly logger = new Logger(PrequoteConversionService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly idempotency: IdempotencyService,
    private readonly config: ConfigService,
  ) {}
  async convert(
    integrationClientId: string,
    publicId: string,
    key: string,
    dto: ConvertPrequoteDto,
  ) {
    const { conditions, payload } = conversionPayload(publicId, dto);
    try {
      const outcome = await this.idempotency.execute(
        {
          integrationClientId,
          key,
          operation: 'delivery_prequotes.convert',
          resourceType: 'PrequoteConversion',
        },
        payload,
        async (tx, id) => {
          if (!this.config.get<boolean>('PREQUOTE_CONVERSION_ENABLED'))
            throw fail('PREQUOTE_CONVERSION_DISABLED', 503);
          const rows = await tx.$queryRaw<
            { id: string }[]
          >`SELECT id FROM "DeliveryPrequote" WHERE "publicId"=${publicId} AND "integrationClientId"=${integrationClientId}::uuid FOR UPDATE`;
          if (!rows.length) throw new NotFoundException('Prequote not found');
          const q = await tx.deliveryPrequote.findUniqueOrThrow({
            where: { id: rows[0].id },
          });
          if (
            await tx.prequoteConversion.findUnique({
              where: { prequoteId: q.id },
              select: { id: true },
            })
          )
            throw fail('PREQUOTE_ALREADY_CONVERTED');
          const [zone] = await tx.$queryRaw<
            { status: string }[]
          >`SELECT status FROM "ServiceZone" WHERE id=${q.serviceZoneId}::uuid FOR SHARE`;
          if (zone?.status !== 'ACTIVE')
            throw fail('PREQUOTE_SERVICE_UNAVAILABLE');
          const [clock] = await tx.$queryRaw<
            { now: Date }[]
          >`SELECT date_trunc('milliseconds',clock_timestamp() AT TIME ZONE 'UTC') AS now`;
          if (clock.now >= q.expiresAt) throw fail('PREQUOTE_EXPIRED');
          if (canonicalJson(conditions) !== canonicalJson(q.conditions))
            throw fail('PREQUOTE_CONDITIONS_MISMATCH');
          if (
            new Date(payload.merchantConfirmation.goodsPaymentConfirmedAt) >
              clock.now ||
            new Date(payload.merchantConfirmation.orderAcceptedAt) > clock.now
          )
            throw new BadRequestException([
              'Merchant confirmation dates must not be future',
            ]);
          const record = await tx.apiIdempotencyRecord.findUniqueOrThrow({
            where: { integrationClientId_key: { integrationClientId, key } },
            select: { id: true },
          });
          const deliveryRequestId = randomUUID(),
            deliveryQuoteId = randomUUID();
          const stopIds = payload.deliveryRequest.stops.map(() => randomUUID()),
            packageIds = payload.deliveryRequest.packages.map(() =>
              randomUUID(),
            ),
            financialContextId = randomUUID();
          const c = await tx.prequoteConversion.create({
            data: {
              id,
              prequoteId: q.id,
              deliveryRequestId,
              deliveryQuoteId,
              idempotencyRecordId: record.id,
              integrationClientId,
              ...payload.merchantConfirmation,
              collectionPayer: 'RECIPIENT',
              collectionMethod: 'CASH',
              collectionDueAt: 'DELIVERY',
              collectionComponent: 'DELIVERY_FEE',
              stopIds,
              packageIds,
              financialContextId,
            },
          });
          await tx.deliveryRequest.create({
            data: {
              id: deliveryRequestId,
              publicId: await nextPublicId(tx, 'MDR'),
              integrationClientId,
              serviceType: q.serviceType,
              externalReference: payload.deliveryRequest.externalReference,
              createdAt: c.convertedAt,
              requestedAt: c.convertedAt,
              stops: {
                create: payload.deliveryRequest.stops.map((s, i) => ({
                  ...s,
                  id: stopIds[i],
                })),
              },
              packages: {
                create: payload.deliveryRequest.packages.map((p, i) => ({
                  ...p,
                  id: packageIds[i],
                })),
              },
              financialContext: {
                create: {
                  ...payload.deliveryRequest.financialContext,
                  id: financialContextId,
                },
              },
            },
          });
          await tx.deliveryQuote.create({
            data: {
              id: deliveryQuoteId,
              publicId: await nextPublicId(tx, 'MQ'),
              deliveryRequestId,
              serviceType: q.serviceType,
              serviceZoneId: q.serviceZoneId,
              ratePlanId: q.ratePlanId,
              rateBandId: q.rateBandId,
              distanceMeters: q.distanceMeters,
              durationSeconds: q.durationSeconds,
              amount: q.amount,
              currency: q.currency,
              routingProvider: q.routingProvider,
              routeCalculatedAt: q.routeCalculatedAt,
              expiresAt: q.expiresAt,
              createdAt: c.convertedAt,
            },
          });
        },
        (id) => this.load(id, integrationClientId),
      );
      if (!outcome.replayed)
        this.logger.log({
          event: 'PREQUOTE_CONVERTED',
          prequotePublicId: publicId,
          deliveryRequestPublicId: outcome.result.deliveryRequestPublicId,
          deliveryQuotePublicId: outcome.result.quote.publicId,
        });
      return outcome;
    } catch (error) {
      // PostgreSQL commit-time trigger failures can be Prisma unknown request errors.
      if (error instanceof Prisma.PrismaClientUnknownRequestError) {
        const match =
          /(?:^|\n)Error in connector: Error querying the database: ERROR: (PREQUOTE_EXPIRED|PREQUOTE_ALREADY_CONVERTED|PREQUOTE_SERVICE_UNAVAILABLE|PREQUOTE_CONDITIONS_MISMATCH)(?:\n|$)/.exec(
            error.message,
          );
        if (match) throw fail(match[1]);
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        // Allowlisted DB business errors only; never log Prisma messages/parameters.
        const databaseError = error.meta?.database_error;
        if (error.code === 'P2004' && typeof databaseError === 'string') {
          const match =
            /(?:^|\n|db error: )ERROR: (PREQUOTE_EXPIRED|PREQUOTE_ALREADY_CONVERTED|PREQUOTE_SERVICE_UNAVAILABLE|PREQUOTE_CONDITIONS_MISMATCH)(?:\n|$)/.exec(
              databaseError,
            );
          if (match) throw fail(match[1]);
        }
        if (
          error.code === 'P2010' &&
          error.meta?.code === 'P0001' &&
          [
            'PREQUOTE_EXPIRED',
            'PREQUOTE_ALREADY_CONVERTED',
            'PREQUOTE_SERVICE_UNAVAILABLE',
            'PREQUOTE_CONDITIONS_MISMATCH',
          ].includes(String(error.meta.message))
        ) {
          throw fail(String(error.meta.message));
        }
        if (['P2028', 'P2034'].includes(error.code))
          throw fail('PREQUOTE_CONVERSION_UNAVAILABLE', 503);
      }
      throw error;
    }
  }
  private async load(id: string, integrationClientId: string) {
    return this.prisma.$transaction(
      async (tx) => {
        const c = await tx.prequoteConversion.findFirstOrThrow({
          where: { id, integrationClientId },
          include: {
            prequote: { select: { publicId: true } },
            deliveryRequest: {
              select: { publicId: true, externalReference: true, status: true },
            },
            deliveryQuote: { select: quoteSelect },
          },
        });
        return {
          prequotePublicId: c.prequote.publicId,
          convertedAt: c.convertedAt,
          deliveryRequestPublicId: c.deliveryRequest.publicId,
          externalReference: c.deliveryRequest.externalReference,
          deliveryRequestStatus: c.deliveryRequest.status,
          deliveryCollectionInstruction: {
            payer: c.collectionPayer,
            method: c.collectionMethod,
            dueAt: c.collectionDueAt,
            components: [c.collectionComponent],
          },
          quote: integrationQuoteView(c.deliveryQuote),
          availabilityGuaranteed: false as const,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}
