import {
  Injectable,
  Logger,
  type OnModuleInit,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';

/** Polling only wakes the durable work; locks and committed windows are the authority. */
@Injectable()
export class DispatchSearchWorker
  implements OnModuleInit, OnApplicationShutdown
{
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private readonly logger = new Logger(DispatchSearchWorker.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}
  onModuleInit() {
    const seconds =
      this.config.get<number>('DISPATCH_SEARCH_POLL_SECONDS') ?? 5;
    if (seconds > 0) {
      this.timer = setInterval(() => {
        if (!this.running)
          this.running = this.runOnce()
            .catch(() => {
              this.logger.error({ event: 'DISPATCH_SEARCH_WORKER_FAILED' });
            })
            .finally(() => {
              this.running = undefined;
            });
      }, seconds * 1000);
      this.timer.unref();
    }
  }
  async onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }
  async runOnce() {
    const due = await this.prisma.$queryRaw<
      { id: string; deliveryRequestId: string }[]
    >`
      SELECT id,"deliveryRequestId" FROM "Dispatch" WHERE status='OPEN' AND "searchMaxAttempts"=5
      AND "searchStoppedReason" IS NULL AND "expiresAt" <= (dispatch_search_now())
      ORDER BY "expiresAt",id LIMIT 50`;
    for (const row of due) {
      try {
        await this.advance(row.id, row.deliveryRequestId);
      } catch {
        this.logger.error({
          event: 'DISPATCH_SEARCH_ROUND_FAILED',
          dispatchId: row.id,
        });
      }
    }
  }
  async advance(dispatchId: string, requestId: string) {
    return this.prisma.$transaction(
      async (tx) => {
        // Same order as cancellation: request then dispatch. Claims lock only dispatch.
        const requests = await tx.$queryRaw<
          { status: string }[]
        >`SELECT status FROM "DeliveryRequest" WHERE id=${requestId}::uuid FOR UPDATE`;
        const locked = await tx.$queryRaw<
          { id: string }[]
        >`SELECT id FROM "Dispatch" WHERE id=${dispatchId}::uuid AND "deliveryRequestId"=${requestId}::uuid FOR UPDATE SKIP LOCKED`;
        if (!locked.length || requests[0]?.status !== 'CREATED') return;
        const d = await tx.dispatch.findUniqueOrThrow({
          where: { id: dispatchId },
          include: {
            deliveryQuote: {
              select: { serviceZone: { select: { status: true } } },
            },
            deliveryRequest: {
              select: { integrationClient: { select: { status: true } } },
            },
          },
        });
        const [clock] = await tx.$queryRaw<
          { now: Date }[]
        >`SELECT dispatch_search_now() AS now`;
        if (
          d.status !== 'OPEN' ||
          d.searchMaxAttempts !== 5 ||
          d.searchStoppedReason ||
          d.expiresAt > clock.now
        )
          return;
        const stop =
          d.deliveryRequest.integrationClient?.status !== 'ACTIVE'
            ? 'INTEGRATION_UNAVAILABLE'
            : d.deliveryQuote.serviceZone.status !== 'ACTIVE'
              ? 'SERVICE_UNAVAILABLE'
              : null;
        if (stop || d.searchAttempt === 5) {
          await tx.dispatch.update({
            where: { id: dispatchId },
            data: {
              status: 'EXPIRED',
              expiredAt: clock.now,
              searchStoppedReason: stop,
            },
          });
          return;
        }
        // SQL fixes the next start to DB time and writes the immutable round in this transaction.
        const next = await tx.dispatch.update({
          where: { id: dispatchId },
          data: { searchAttempt: { increment: 1 } },
        });
        const round = await tx.dispatchSearchRound.findUniqueOrThrow({
          where: {
            dispatchId_attempt: { dispatchId, attempt: next.searchAttempt },
          },
        });
        if (round.providerIds.length)
          await tx.dispatchCandidate.createMany({
            data: round.providerIds.map((providerId) => ({
              dispatchId,
              providerId,
              offeredAt: round.openedAt,
            })),
            skipDuplicates: true,
          });
      },
      { timeout: 10000 },
    );
  }
}
