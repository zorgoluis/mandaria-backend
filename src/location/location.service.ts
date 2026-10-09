import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  ForbiddenException,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Prisma,
  type DeliveryLocationHead,
  type DeliveryTrackingLinkHead,
} from '@prisma/client';
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { DomainException } from '../common/domain-error.js';
import {
  ownerFields,
  rowOwner,
  lockRequestCustomer,
  type DemandOwner,
} from '../customers/demand-owner.js';
import { lockExecutionDispatch } from '../delivery-execution/execution.persistence.js';
import { publicDeliveryStatusTx } from '../delivery-requests/public-delivery-tracking.js';
import type { LocationSampleDto } from './location.dto.js';

type Tx = Prisma.TransactionClient;
type Sample = {
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  capturedAt: string;
  receivedAt: string;
  freshUntil: string;
  eraseAfter: string;
};
type Receipt = {
  actor: string;
  key: string;
  operation: string;
  expected: string;
  result?: Record<string, unknown>;
};
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
const error = (code: string, status = 409) =>
  new DomainException(code, status, code);
const phases = [
  null,
  'TO_PICKUP',
  'AT_PICKUP',
  'PICKED_UP',
  'TO_DROPOFF',
  'AT_DROPOFF',
];
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function receipt(value: Prisma.JsonValue | null): Receipt | null {
  return value as Receipt | null;
}
export function sampleTimes(capturedAt: Date, receivedAt: Date) {
  const base = Math.min(capturedAt.getTime(), receivedAt.getTime());
  return {
    freshUntil: new Date(base + 60000).toISOString(),
    eraseAfter: new Date(base + 600000).toISOString(),
  };
}
export function locationFreshness(sample: Sample | null, now: Date) {
  if (!sample || now.getTime() >= new Date(sample.eraseAfter).getTime())
    return 'UNAVAILABLE';
  return now.getTime() <= new Date(sample.freshUntil).getTime()
    ? 'RECENT'
    : 'STALE';
}
@Injectable()
export class LocationClock {
  async now(tx: Tx) {
    const [r] = await tx.$queryRaw<
      { now: Date }[]
    >`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`;
    return r.now;
  }
}
@Injectable()
export class LocationService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private readonly logger = new Logger(LocationService.name);
  constructor(
    private readonly db: PrismaService,
    private readonly config: ConfigService,
    private readonly clock: LocationClock,
  ) {}
  async onModuleInit() {
    // Coordinated deployments only. A policy change withdraws old streams, including empty heads.
    await this.policy(this.db);
    this.timer = setInterval(() => {
      void this.cleanup().catch(() => {
        this.logger.error({ event: 'LOCATION_CLEANUP_FAILED' });
      });
    }, 30000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
  private async policy(tx: Tx, id?: string) {
    const enabled = !!this.config.get<boolean>('LOCATION_TRACKING_ENABLED');
    await tx.$executeRaw`UPDATE "DeliveryLocationHead" SET "trackingEnabled"=${enabled},"lastSequence"=0,sample=NULL,"sampleHash"=NULL,"eraseAfter"=NULL,"streamId"=NULL,"streamStartedAt"=NULL,"openReceipt"=NULL,version=version+1,"streamRevision"="streamRevision"+1 WHERE "trackingEnabled" IS DISTINCT FROM ${enabled} AND (${id ?? null}::uuid IS NULL OR "deliveryRequestId"=${id ?? null}::uuid)`;
  }
  async cleanup() {
    const erased = await this.db
      .$executeRaw`UPDATE "DeliveryLocationHead" SET sample=NULL,"sampleHash"=NULL,"eraseAfter"=NULL,version=version+1 WHERE "deliveryRequestId" IN (SELECT "deliveryRequestId" FROM "DeliveryLocationHead" WHERE "eraseAfter"<=(clock_timestamp() AT TIME ZONE 'UTC') ORDER BY "eraseAfter" LIMIT 500 FOR UPDATE SKIP LOCKED)`;
    await this.db
      .$executeRaw`UPDATE "DeliveryTrackingLinkHead" SET "secretHash"=NULL WHERE "deliveryRequestId" IN (
        SELECT l."deliveryRequestId" FROM "DeliveryTrackingLinkHead" l
        JOIN "DeliveryRequest" r ON r.id=l."deliveryRequestId"
        LEFT JOIN "Dispatch" d ON d."deliveryRequestId"=r.id
        LEFT JOIN "DeliveryCustodyResolution" z ON z."dispatchId"=d.id AND z.type='RETURN_TO_ORIGIN'
        WHERE l."secretHash" IS NOT NULL AND (
          l."expiresAt"<=(clock_timestamp() AT TIME ZONE 'UTC') OR
          r."cancelledAt"+interval '1 hour'<=(clock_timestamp() AT TIME ZONE 'UTC') OR
          d."deliveredAt"+interval '1 hour'<=(clock_timestamp() AT TIME ZONE 'UTC') OR
          z."occurredAt"+interval '1 hour'<=(clock_timestamp() AT TIME ZONE 'UTC') OR
          (d.status IN ('OPEN','EXPIRED') AND d."expiresAt"+interval '1 hour'<=(clock_timestamp() AT TIME ZONE 'UTC'))
        ) LIMIT 500 FOR UPDATE OF l SKIP LOCKED)`;
    await this.db
      .$executeRaw`DELETE FROM "LocationRateBucket" WHERE key IN (SELECT key FROM "LocationRateBucket" WHERE "expiresAt"<(clock_timestamp() AT TIME ZONE 'UTC') LIMIT 500)`;
    if (erased)
      this.logger.log({ event: 'LOCATION_SAMPLES_ERASED', count: erased });
  }
  private enabled(shared = false) {
    if (
      !this.config.get<boolean>(
        shared ? 'SHARED_TRACKING_ENABLED' : 'LOCATION_TRACKING_ENABLED',
      )
    )
      throw error('TRACKING_DISABLED', 503);
  }
  private key(k: string | undefined) {
    if (!k || !uuid.test(k))
      throw new BadRequestException('Idempotency-Key UUID required');
    return hash(k);
  }
  private async now(tx: Tx) {
    return this.clock.now(tx);
  }
  private async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    for (let i = 0; i < 5; i++)
      try {
        return await this.db.$transaction(fn, {
          isolationLevel: 'RepeatableRead',
          timeout: 15000,
        });
      } catch (e) {
        if (
          !(e instanceof Prisma.PrismaClientKnownRequestError) ||
          !(
            e.code === 'P2034' ||
            (e.code === 'P2010' &&
              ['40001', '40P01'].includes(String(e.meta?.code)))
          )
        )
          throw e;
      }
    throw error('TRACKING_TEMPORARILY_UNAVAILABLE', 503);
  }
  async rate(identity: string, limit: number, seconds = 60) {
    const [r] = await this.db.$queryRaw<
      { count: number }[]
    >`INSERT INTO "LocationRateBucket"(key,count,"expiresAt") VALUES (${hash(identity)}||':'||floor(extract(epoch FROM clock_timestamp())/${seconds})::text,1,(clock_timestamp() AT TIME ZONE 'UTC')+make_interval(secs=>${seconds})) ON CONFLICT(key) DO UPDATE SET count="LocationRateBucket".count+1 RETURNING count`;
    if (r.count > limit)
      throw new DomainException(
        'TRACKING_RATE_LIMITED',
        429,
        'TRACKING_RATE_LIMITED',
        seconds,
      );
  }
  private async own(tx: Tx, id: string, owner: DemandOwner, lock = false) {
    const r = await tx.deliveryRequest.findFirst({
      where: { publicId: id, ...ownerFields(owner) },
    });
    if (!r) throw new NotFoundException('Delivery request not found');
    if (lock) {
      await lockRequestCustomer(tx, r.id);
      await tx.$queryRaw`SELECT id FROM "DeliveryRequest" WHERE id=${r.id}::uuid FOR UPDATE`;
    }
    if (owner.kind === 'INTEGRATION') {
      if (
        !(await tx.integrationClient.findFirst({
          where: { id: owner.id, status: 'ACTIVE' },
        }))
      )
        throw new NotFoundException('Delivery request not found');
    } else {
      const c = await tx.customerAccount.findUnique({
        where: { id: owner.id },
        include: { user: true },
      });
      if (!c?.active || !c.user.active || !c.user.emailVerifiedAt)
        throw new NotFoundException('Delivery request not found');
    }
    return r;
  }
  private async driver(
    tx: Tx,
    dispatchId: string,
    assignmentId: string,
    userId: string,
  ) {
    await lockExecutionDispatch(tx, dispatchId);
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user?.active || user.role !== 'DRIVER') throw new ForbiddenException();
    const a = await tx.deliveryAssignment.findFirst({
      where: {
        id: assignmentId,
        dispatchId,
        status: 'ACTIVE',
        driver: { userId },
      },
      include: { driver: true, dispatch: true },
    });
    if (
      !a ||
      a.driver.status !== 'ACTIVE' ||
      (a.mode === 'FLEET' && a.driver.providerId !== a.providerId)
    )
      throw new NotFoundException('Assignment not found');
    const e = await tx.deliveryExecution.findUnique({ where: { dispatchId } });
    if (!e || e.assignmentId !== a.id || a.dispatch.status !== 'CLAIMED')
      throw error('LOCATION_NOT_ACTIVE');
    const incident = await tx.deliveryCustodyIncident.findFirst({
      where: { dispatchId, resolvedAt: null },
    });
    const canPublish = e.phase >= 1 && e.phase <= 5 && !incident;
    await this.policy(tx, a.dispatch.deliveryRequestId);
    const h = await tx.deliveryLocationHead.findUniqueOrThrow({
      where: { deliveryRequestId: a.dispatch.deliveryRequestId },
    });
    return { a, e, h, canPublish };
  }
  async stream(
    dispatchId: string,
    assignmentId: string,
    userId: string,
    open?: { expected: string; key: string | undefined },
  ) {
    this.enabled();
    await this.rate(
      'driver:' + userId,
      this.config.getOrThrow<number>('LOCATION_DRIVER_PER_MINUTE'),
    );
    const k = open ? this.key(open.key) : null;
    return this.transaction(async (tx) => {
      const { h, canPublish } = await this.driver(
        tx,
        dispatchId,
        assignmentId,
        userId,
      );
      const view = (head: DeliveryLocationHead) => ({
        streamId: head.streamId,
        streamRevision: head.streamRevision.toString(),
        lastSequence: head.lastSequence,
        canPublish,
      });
      if (!open) return view(h);
      if (!canPublish) throw error('LOCATION_PHASE_NOT_ALLOWED');
      const old = receipt(h.openReceipt);
      if (old?.actor === userId && old.key === k) {
        if (old.expected !== open.expected)
          throw error('IDEMPOTENCY_KEY_REUSED');
        return old.result;
      }
      if (h.streamRevision.toString() !== open.expected)
        throw error('LOCATION_STREAM_REVISION_CONFLICT');
      const now = await this.now(tx);
      const result = {
        streamId: randomUUID(),
        streamRevision: (h.streamRevision + 1n).toString(),
        lastSequence: 0,
        canPublish,
      };
      await tx.deliveryLocationHead.update({
        where: { deliveryRequestId: h.deliveryRequestId },
        data: {
          streamId: result.streamId,
          streamRevision: { increment: 1 },
          streamStartedAt: now,
          lastSequence: 0,
          sample: Prisma.DbNull,
          sampleHash: null,
          eraseAfter: null,
          version: { increment: 1 },
          openReceipt: {
            actor: userId,
            key: k!,
            operation: 'OPEN',
            expected: open.expected,
            result,
          },
        },
      });
      return result;
    });
  }
  async publish(
    dispatchId: string,
    assignmentId: string,
    userId: string,
    input: LocationSampleDto,
  ) {
    this.enabled();
    await this.rate(
      'driver:' + userId,
      this.config.getOrThrow<number>('LOCATION_DRIVER_PER_MINUTE'),
    );
    return this.transaction(async (tx) => {
      const { h, a, canPublish } = await this.driver(
        tx,
        dispatchId,
        assignmentId,
        userId,
      );
      if (!canPublish) throw error('LOCATION_PHASE_NOT_ALLOWED');
      if (h.streamId !== input.streamId)
        throw error('LOCATION_STREAM_REPLACED');
      const now = await this.now(tx),
        captured = new Date(input.capturedAt);
      const fingerprint = hash(
        JSON.stringify([
          input.streamId,
          input.sequence,
          captured.toISOString(),
          input.latitude,
          input.longitude,
          input.accuracyMeters,
        ]),
      );
      const ack = (outcome: string, sequence: number, version: bigint) => ({
        outcome,
        streamRevision: h.streamRevision.toString(),
        acknowledgedSequence: outcome === 'SUPERSEDED' ? null : input.sequence,
        currentSequence: sequence,
        locationVersion: version.toString(),
      });
      if (
        input.sequence < h.lastSequence ||
        (input.sequence === h.lastSequence && !h.sampleHash)
      )
        return ack('SUPERSEDED', h.lastSequence, h.version);
      if (input.sequence === h.lastSequence) {
        if (h.sampleHash !== fingerprint)
          throw error('LOCATION_SAMPLE_CONFLICT');
        return ack('DUPLICATE', h.lastSequence, h.version);
      }
      if (input.accuracyMeters > 100)
        throw error('LOCATION_ACCURACY_INSUFFICIENT', 422);
      const previous = h.sample as Sample | null;
      if (
        captured.getTime() > now.getTime() + 15000 ||
        captured.getTime() < now.getTime() - 120000 ||
        captured < a.assignedAt ||
        captured < h.streamStartedAt! ||
        (previous && captured < new Date(previous.capturedAt))
      )
        throw error('LOCATION_CAPTURE_TIME_INVALID', 422);
      const sample = {
        latitude: input.latitude,
        longitude: input.longitude,
        accuracyMeters: input.accuracyMeters,
        capturedAt: captured.toISOString(),
        receivedAt: now.toISOString(),
        ...sampleTimes(captured, now),
      };
      await tx.deliveryLocationHead.update({
        where: { deliveryRequestId: h.deliveryRequestId },
        data: {
          lastSequence: input.sequence,
          sampleHash: fingerprint,
          sample,
          eraseAfter: new Date(sample.eraseAfter),
          version: { increment: 1 },
        },
      });
      return ack('ACCEPTED', input.sequence, h.version + 1n);
    });
  }
  private async view(
    tx: Tx,
    id: string,
    owner: DemandOwner,
    recipient = false,
  ) {
    const r = await this.own(tx, id, owner);
    const status = await publicDeliveryStatusTx(tx, id, owner);
    const now = await this.now(tx);
    await this.policy(tx, r.id);
    await tx.$executeRaw`UPDATE "DeliveryLocationHead" SET sample=NULL,"sampleHash"=NULL,"eraseAfter"=NULL,version=version+1 WHERE "deliveryRequestId"=${r.id}::uuid AND sample IS NOT NULL AND ("eraseAfter"<=(${now}::timestamptz AT TIME ZONE 'UTC') OR ${!!status.terminalOutcome})`;
    const h = await tx.deliveryLocationHead.findUniqueOrThrow({
      where: { deliveryRequestId: r.id },
    });
    const progress = status.executionProgress as
      { phase: string | null; attentionRequired: boolean } | null | undefined;
    const phase = progress?.phase ?? null,
      attention = progress?.attentionRequired ?? false;
    const reason = status.terminalOutcome
      ? 'TERMINAL'
      : !this.config.get<boolean>('LOCATION_TRACKING_ENABLED')
        ? 'TRACKING_DISABLED'
        : status.trackingMode === 'LEGACY'
          ? 'LEGACY_UNSUPPORTED'
          : status.assignmentState !== 'ACTIVE'
            ? 'NO_ASSIGNMENT'
            : attention || phases.indexOf(phase) < (recipient ? 3 : 1)
              ? 'NOT_VISIBLE'
              : !h.sample
                ? h.lastSequence > 0
                  ? 'EXPIRED_SAMPLE'
                  : 'NO_SAMPLE'
                : null;
    const sample = reason ? null : (h.sample as Sample | null);
    return {
      publicId: id,
      progress: {
        publicVersion: status.publicVersion,
        status: status.status,
        trackingMode: status.trackingMode,
        assignmentState: status.assignmentState,
        phase,
        attentionRequired: attention,
        terminalOutcome: status.terminalOutcome,
      },
      location: {
        locationVersion: h.version.toString(),
        assignmentGeneration: h.generation.toString(),
        availability: sample ? 'AVAILABLE' : 'UNAVAILABLE',
        unavailableReason: reason,
        sample,
      },
      observation: {
        evaluatedAt: now.toISOString(),
        freshness: locationFreshness(sample, now),
      },
    };
  }
  async ownerView(id: string, owner: DemandOwner) {
    await this.rate(
      'owner:' + owner.kind + owner.id,
      this.config.getOrThrow<number>('LOCATION_OWNER_PER_MINUTE'),
    );
    return this.transaction((tx) => this.view(tx, id, owner));
  }
  private metadata(
    h: DeliveryTrackingLinkHead,
    now: Date,
    terminal: { occurredAt: string } | null,
  ) {
    const until =
      h.expiresAt && terminal
        ? new Date(
            Math.min(
              h.expiresAt.getTime(),
              new Date(terminal.occurredAt).getTime() + 3600000,
            ),
          )
        : null;
    return {
      linkRevision: h.revision.toString(),
      linkId: h.selector,
      status: !h.selector
        ? 'NONE'
        : h.revokedAt
          ? 'REVOKED'
          : h.expiresAt! <= now || (until && until <= now)
            ? 'EXPIRED'
            : terminal
              ? 'TERMINAL'
              : 'ACTIVE',
      createdAt: h.createdAt?.toISOString() ?? null,
      expiresAt: h.expiresAt?.toISOString() ?? null,
      terminalAccessUntil: until?.toISOString() ?? null,
    };
  }
  async link(
    id: string,
    owner: DemandOwner,
    actor: string,
    action?: {
      operation: 'ISSUE' | 'REVOKE' | 'ATTEMPT';
      expected: string;
      key: string | undefined;
      attemptOperation?: 'ISSUE' | 'REVOKE';
    },
  ) {
    this.enabled(true);
    const k = action ? this.key(action.key) : null;
    await this.rate(
      'owner:' + owner.kind + owner.id,
      this.config.getOrThrow<number>('LOCATION_OWNER_PER_MINUTE'),
    );
    return this.transaction(async (tx) => {
      const r = await this.own(tx, id, owner, true);
      if (action && action.operation !== 'ATTEMPT')
        await this.rate(
          'links:' + owner.kind + owner.id + r.id,
          this.config.getOrThrow<number>(
            'LOCATION_LINK_MUTATIONS_PER_TEN_MINUTES',
          ),
          600,
        );
      const status = await publicDeliveryStatusTx(tx, id, owner);
      const terminal = status.terminalOutcome as { occurredAt: string } | null;
      const now = await this.now(tx);
      let h = await tx.deliveryTrackingLinkHead.findUniqueOrThrow({
        where: { deliveryRequestId: r.id },
      });
      const old = receipt(h.receipt),
        op =
          action?.operation === 'ATTEMPT'
            ? action.attemptOperation
            : action?.operation;
      const matching =
        old?.actor === actor &&
        old.key === k &&
        old.operation === op &&
        old.expected === action?.expected;
      if (action?.operation === 'ATTEMPT')
        return {
          state: matching
            ? op === 'ISSUE'
              ? 'APPLIED_SECRET_UNAVAILABLE'
              : 'APPLIED_REVOKED'
            : h.revision.toString() === action.expected
              ? 'PENDING_OR_UNKNOWN'
              : 'SUPERSEDED',
          linkRevision: h.revision.toString(),
          currentLinkId: h.selector,
          secretAvailable: false,
        };
      if (!action) return this.metadata(h, now, terminal);
      if (old?.actor === actor && old.key === k) {
        if (!matching) throw error('IDEMPOTENCY_KEY_REUSED');
        return { ...old.result, secretAvailable: false };
      }
      if (action.expected !== h.revision.toString())
        throw error('LINK_REVISION_CONFLICT');
      let secret: string | undefined;
      if (action.operation === 'ISSUE') {
        if (terminal || !['OPEN', 'ASSIGNED'].includes(String(status.status)))
          throw error('LINK_NOT_ISSUABLE');
        secret = randomBytes(32).toString('base64url');
        h = await tx.deliveryTrackingLinkHead.update({
          where: { deliveryRequestId: r.id },
          data: {
            revision: { increment: 1 },
            selector: randomBytes(16).toString('base64url'),
            secretHash: hash('mandaria-tracking:' + secret),
            createdAt: now,
            expiresAt: new Date(now.getTime() + 86400000),
            revokedAt: null,
          },
        });
      } else
        h = await tx.deliveryTrackingLinkHead.update({
          where: { deliveryRequestId: r.id },
          data: {
            revision: { increment: 1 },
            revokedAt: now,
            secretHash: null,
          },
        });
      const result = this.metadata(h, now, terminal);
      await tx.deliveryTrackingLinkHead.update({
        where: { deliveryRequestId: r.id },
        data: {
          receipt: {
            actor,
            key: k!,
            operation: action.operation,
            expected: action.expected,
            result,
          },
        },
      });
      const origin =
        this.config.get<string>('MANDARIA_WEB_URL') ||
        'https://mandaria.com.mx';
      return {
        ...result,
        secretAvailable: !!secret,
        ...(secret
          ? {
              url: new URL(
                '/track#t=' + h.selector + '.' + secret,
                origin,
              ).toString(),
            }
          : {}),
      };
    });
  }
  async shared(authorization: string | undefined, ip: string) {
    this.enabled(true);
    await this.rate(
      'recipient-ip:' + ip,
      this.config.getOrThrow<number>('LOCATION_IP_PER_MINUTE'),
    );
    const token = /^Tracking ([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/.exec(
      authorization ?? '',
    );
    if (!token) throw error('SHARED_TRACKING_UNAVAILABLE', 404);
    return this.transaction(async (tx) => {
      const h = await tx.deliveryTrackingLinkHead.findUnique({
        where: { selector: token[1] },
        include: { deliveryRequest: true },
      });
      const expected = Buffer.from(h?.secretHash ?? '0'.repeat(64), 'hex');
      if (
        !timingSafeEqual(
          expected,
          Buffer.from(hash('mandaria-tracking:' + token[2]), 'hex'),
        ) ||
        !h
      )
        throw error('SHARED_TRACKING_UNAVAILABLE', 404);
      const now = await this.now(tx);
      if (h.revokedAt || !h.expiresAt || h.expiresAt <= now)
        throw error('SHARED_TRACKING_UNAVAILABLE', 404);
      let view: Awaited<ReturnType<LocationService['view']>>;
      try {
        view = await this.view(
          tx,
          h.deliveryRequest.publicId,
          rowOwner(h.deliveryRequest),
          true,
        );
      } catch (e) {
        if (e instanceof NotFoundException)
          throw error('SHARED_TRACKING_UNAVAILABLE', 404);
        throw e;
      }
      const terminal = view.progress.terminalOutcome as {
        occurredAt: string;
      } | null;
      if (
        terminal &&
        now.getTime() >= new Date(terminal.occurredAt).getTime() + 3600000
      )
        throw error('SHARED_TRACKING_UNAVAILABLE', 404);
      await this.rate(
        'recipient-link:' + h.selector,
        this.config.getOrThrow<number>('LOCATION_RECIPIENT_PER_MINUTE'),
      );
      return view;
    });
  }
}
