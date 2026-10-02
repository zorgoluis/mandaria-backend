import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import type { Prisma, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { EXECUTION_PHASES } from './execution.types.js';
import {
  executionError,
  executionEvent,
  executionHead,
  executionView,
  lockExecutionDispatch,
} from './execution.persistence.js';
import type {
  AdvanceExecutionDto,
  ReportCustodyIncidentDto,
  ResolveCustodyIncidentDto,
  TransferCandidatesQueryDto,
} from './execution.dto.js';
import { pageResult, PaginationQueryDto } from '../common/pagination.dto.js';
import { allowsIndependent } from '../independent-drivers/independent-driver-policy.js';
import { pairingConflict } from '../delivery-assignments/assignment-policy.js';

type Actor = { id: string; role: Role; providerId?: string };
type Incident = {
  id: string;
  dispatchId: string;
  assignmentId: string;
  chainId: string;
  resolvedAt: Date | null;
};
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
async function retryExecution<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await work();
    } catch (error) {
      const e = error as { code?: string; meta?: { code?: string } };
      const transient =
        e.code === 'P2034' ||
        (e.code === 'P2010' && ['40P01', '40001'].includes(e.meta?.code ?? ''));
      if (!transient) throw error;
      if (attempt === 2) throw executionError('EXECUTION_CONFLICT');
    }
  }
}
@Injectable()
export class ExecutionService {
  constructor(private readonly db: PrismaService) {}
  private async view(tx: Prisma.TransactionClient, id: string, actor: Actor) {
    const result = await executionView(tx, id);
    if (result && actor.role === 'SUPER_ADMIN')
      result.allowedActions = result.openIncidentId
        ? ['RESOLVE_INCIDENT']
        : result.custodyStatus === 'HELD'
          ? ['REPORT_INCIDENT']
          : [];
    return result;
  }
  async incidentDetail(dispatchId: string, incidentId: string) {
    const incident = await this.db.deliveryCustodyIncident.findFirst({
      where: { id: incidentId, dispatchId },
    });
    if (!incident) throw new NotFoundException('Incident not found');
    const resolution = await this.db.deliveryCustodyResolution.findUnique({
      where: { incidentId },
    });
    return { incident, resolution };
  }
  async transferCandidates(dispatchId: string, q: TransferCandidatesQueryDto) {
    return this.db.$transaction(
      async (tx) => {
        const head = await executionHead(tx, dispatchId);
        if (!head) throw new NotFoundException('Execution not found');
        const current = await tx.deliveryAssignment.findUniqueOrThrow({
          where: { id: head.assignmentId },
        });
        const dispatch = await tx.dispatch.findUniqueOrThrow({
          where: { id: dispatchId },
          include: { deliveryQuote: true },
        });
        if (head.phase < 3 || dispatch.status !== 'CLAIMED')
          throw executionError('CUSTODY_INCIDENT_REQUIRED');
        type Pair = {
          driverId: string;
          driverName: string;
          vehicleId: string;
          vehicleIdentifier: string;
          providerId: string | null;
        };
        const [result] = await tx.$queryRaw<
          { total: number; items: Pair[] }[]
        >`WITH eligible AS (SELECT d.id AS "driverId",d.name AS "driverName",v.id AS "vehicleId",v.identifier AS "vehicleIdentifier",CASE WHEN ${q.mode}='FLEET' THEN d."providerId" ELSE NULL END AS "providerId"
      FROM "Driver" d JOIN "User" u ON u.id=d."userId"
      LEFT JOIN "IndependentDriverProfile" p ON p."driverId"=d.id
      JOIN "Vehicle" v ON (${q.mode}='FLEET' AND v."providerId"=d."providerId") OR (${q.mode}='INDEPENDENT' AND v."independentDriverProfileId"=p.id)
      WHERE d.id<>${current.driverId}::uuid AND d.status='ACTIVE' AND u.active AND v.status='ACTIVE'
      AND ((${q.mode}='INDEPENDENT' AND p.status='APPROVED' AND ${allowsIndependent(dispatch.deliveryQuote.serviceType)}) OR
       (${q.mode}='FLEET' AND EXISTS(SELECT 1 FROM "DeliveryProvider" dp WHERE dp.id=d."providerId" AND dp.status='ACTIVE')
        AND EXISTS(SELECT 1 FROM "ProviderServiceCoverage" c WHERE c."providerId"=d."providerId" AND c.status='ACTIVE' AND c."serviceZoneId"=${dispatch.deliveryQuote.serviceZoneId}::uuid AND c."serviceType"=${dispatch.deliveryQuote.serviceType}::"ServiceType")
        AND EXISTS(SELECT 1 FROM "ProviderMembership" m JOIN "User" admin ON admin.id=m."userId" WHERE m."providerId"=d."providerId" AND admin.active AND admin.role='PROVIDER_ADMIN')
        AND NOT EXISTS(SELECT 1 FROM "DriverVehicleAssignment" pair WHERE pair."unassignedAt" IS NULL AND ((pair."driverId"=d.id AND pair."vehicleId"<>v.id) OR (pair."vehicleId"=v.id AND pair."driverId"<>d.id)))))
      AND NOT EXISTS(SELECT 1 FROM "DeliveryAssignment" a WHERE a.status='ACTIVE' AND a.id<>${current.id}::uuid AND (a."driverId"=d.id OR a."vehicleId"=v.id))
      ) SELECT (SELECT count(*)::int FROM eligible) AS total, COALESCE((SELECT jsonb_agg(p) FROM (SELECT * FROM eligible ORDER BY "driverId","vehicleId" LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}) p),'[]'::jsonb) AS items`;
        return pageResult(
          result.items.map((pair) => ({
            driverId: pair.driverId,
            driverName: pair.driverName,
            vehicleId: pair.vehicleId,
            vehicleIdentifier: pair.vehicleIdentifier,
            providerId: pair.providerId,
            mode: q.mode,
          })),
          result.total,
          q,
        );
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }
  async authorize(
    tx: Prisma.TransactionClient,
    dispatchId: string,
    actor: Actor,
  ) {
    const user = await tx.user.findUnique({ where: { id: actor.id } });
    if (!user?.active || user.role !== actor.role)
      throw new ForbiddenException();
    const e = await executionHead(tx, dispatchId);
    if (!e) throw new NotFoundException('Detailed execution not found');
    const a = await tx.deliveryAssignment.findUniqueOrThrow({
      where: { id: e.assignmentId },
    });
    if (actor.role === 'SUPER_ADMIN') return { e, a };
    if (
      actor.role === 'PROVIDER_ADMIN' &&
      a.mode === 'FLEET' &&
      a.providerId === actor.providerId &&
      (await tx.providerMembership.findFirst({
        where: { userId: actor.id, providerId: a.providerId },
      }))
    )
      return { e, a };
    if (
      actor.role === 'DRIVER' &&
      a.mode === 'INDEPENDENT' &&
      (await tx.driver.findFirst({
        where: { id: a.driverId, userId: actor.id },
      }))
    )
      return { e, a };
    throw new NotFoundException('Execution not found');
  }
  async detail(
    dispatchId: string,
    actor: Actor,
    query = new PaginationQueryDto(),
  ) {
    return this.db.$transaction(
      async (tx) => {
        await this.authorize(tx, dispatchId, actor);
        const events = await tx.deliveryExecutionEvent.findMany({
          where: { dispatchId },
          select: {
            kind: true,
            phase: true,
            revision: true,
            assignmentId: true,
            actorUserId: true,
            actorRole: true,
            source: true,
            recordedAt: true,
          },
          orderBy: { revision: 'desc' },
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
        });
        const execution = await executionView(tx, dispatchId);
        if (execution && actor.role === 'SUPER_ADMIN')
          execution.allowedActions = execution.openIncidentId
            ? ['RESOLVE_INCIDENT']
            : execution.custodyStatus === 'HELD'
              ? ['REPORT_INCIDENT']
              : [];
        return {
          execution,
          events: pageResult(
            events,
            await tx.deliveryExecutionEvent.count({ where: { dispatchId } }),
            query,
          ),
        };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }
  private async command(
    dispatchId: string,
    actor: Actor,
    key: string,
    operation: string,
    body:
      | AdvanceExecutionDto
      | ReportCustodyIncidentDto
      | ResolveCustodyIncidentDto,
    work: (
      tx: Prisma.TransactionClient,
      state: Awaited<ReturnType<ExecutionService['authorize']>>,
    ) => Promise<unknown>,
  ) {
    if (!isUUID(key))
      throw new BadRequestException('UUID Idempotency-Key required');
    const hash = createHash('sha256').update(canonical(body)).digest('hex');
    return retryExecution(() =>
      this.db.$transaction(
        async (tx) => {
          await lockExecutionDispatch(tx, dispatchId);
          await tx.$queryRaw`SELECT id FROM "User" WHERE id=${actor.id}::uuid FOR SHARE`;
          const user = await tx.user.findUnique({ where: { id: actor.id } });
          if (!user?.active || user.role !== actor.role)
            throw new ForbiddenException();
          const receipts = await tx.$queryRaw<
            { hash: string; response: Prisma.JsonValue }[]
          >`SELECT hash,response FROM "DeliveryExecutionCommand" WHERE "dispatchId"=${dispatchId}::uuid AND "actorUserId"=${actor.id}::uuid AND operation=${operation} AND key=${key}::uuid`;
          if (receipts[0]) {
            if (receipts[0].hash !== hash)
              throw executionError('IDEMPOTENCY_KEY_REUSED');
            return receipts[0].response;
          }
          if (
            operation.startsWith('RESOLVE:') &&
            (await tx.deliveryCustodyResolution.findUnique({
              where: { incidentId: operation.slice(8) },
              select: { id: true },
            }))
          )
            throw executionError('INCIDENT_ALREADY_RESOLVED');
          const state = await this.authorize(tx, dispatchId, actor);
          const d = await tx.dispatch.findUniqueOrThrow({
            where: { id: dispatchId },
          });
          if (
            d.status !== 'CLAIMED' ||
            state.a.status !== 'ACTIVE' ||
            state.a.id !== body.assignmentId ||
            state.e.revision !== body.expectedRevision
          )
            throw executionError('EXECUTION_CONFLICT');
          const result = await work(tx, state);
          const response = JSON.stringify(result);
          await tx.$executeRaw`INSERT INTO "DeliveryExecutionCommand" ("dispatchId","actorUserId",operation,key,hash,response) VALUES (${dispatchId}::uuid,${actor.id}::uuid,${operation},${key}::uuid,${hash},${response}::jsonb)`;
          return JSON.parse(response) as Prisma.JsonValue;
        },
        { timeout: 15000 },
      ),
    );
  }
  advance(id: string, actor: Actor, key: string, body: AdvanceExecutionDto) {
    if (actor.role === 'SUPER_ADMIN') throw new ForbiddenException();
    return this.command(
      id,
      actor,
      key,
      'ADVANCE',
      body,
      async (tx, { e, a }) => {
        if (EXECUTION_PHASES.indexOf(body.phase) !== e.phase)
          throw executionError('EXECUTION_TRANSITION_INVALID');
        if ((await executionView(tx, id))?.openIncidentId)
          throw executionError('CUSTODY_INCIDENT_OPEN');
        await executionEvent(tx, e, a.id, actor.id, 'ADVANCED', e.phase + 1);
        return executionView(tx, id);
      },
    );
  }
  report(
    id: string,
    actor: Actor,
    key: string,
    body: ReportCustodyIncidentDto,
  ) {
    return this.command(
      id,
      actor,
      key,
      'REPORT',
      body,
      async (tx, { e, a }) => {
        if (e.phase < 3) throw executionError('CUSTODY_INCIDENT_REQUIRED');
        if ((await executionView(tx, id))?.openIncidentId)
          throw executionError('INCIDENT_ALREADY_OPEN');
        const incidentId = randomUUID();
        await tx.$executeRaw`INSERT INTO "DeliveryCustodyIncident" (id,"dispatchId","assignmentId","chainId","reasonCode","reasonDetail","reportedByUserId") VALUES (${incidentId}::uuid,${id}::uuid,${a.id}::uuid,${e.chainId}::uuid,${body.reasonCode},${body.reasonDetail.trim()},${actor.id}::uuid)`;
        await executionEvent(tx, e, a.id, actor.id, 'INCIDENT');
        return { id: incidentId, execution: await this.view(tx, id, actor) };
      },
    );
  }
  resolve(
    id: string,
    incidentId: string,
    actor: Actor,
    key: string,
    body: ResolveCustodyIncidentDto,
  ) {
    if (actor.role !== 'SUPER_ADMIN') throw new ForbiddenException();
    return this.command(
      id,
      actor,
      key,
      'RESOLVE:' + incidentId,
      body,
      async (tx, { e, a }) => {
        const rows = await tx.$queryRaw<
          Incident[]
        >`SELECT * FROM "DeliveryCustodyIncident" WHERE id=${incidentId}::uuid AND "dispatchId"=${id}::uuid FOR UPDATE`;
        const incident = rows[0];
        if (!incident) throw new NotFoundException('Incident not found');
        if (incident.resolvedAt)
          throw executionError('INCIDENT_ALREADY_RESOLVED');
        if (incident.assignmentId !== a.id || incident.chainId !== e.chainId)
          throw executionError('EXECUTION_CONFLICT');
        const occurredAt = new Date(body.occurredAt),
          now = new Date();
        const pickup = await tx.$queryRaw<
          { recordedAt: Date }[]
        >`SELECT max(moment) AS "recordedAt" FROM (
          SELECT "recordedAt" AS moment FROM "DeliveryExecutionEvent" WHERE "dispatchId"=${id}::uuid AND "chainId"=${e.chainId}::uuid AND kind='ADVANCED' AND phase>=3
          UNION ALL SELECT r."occurredAt" FROM "DeliveryCustodyResolution" r JOIN "DeliveryCustodyIncident" i ON i.id=r."incidentId" WHERE r."dispatchId"=${id}::uuid AND i."chainId"=${e.chainId}::uuid
        ) facts`;
        if (!pickup[0] || occurredAt > now || occurredAt < pickup[0].recordedAt)
          throw new BadRequestException('Invalid physical confirmation time');
        const resolutionId = randomUUID();
        let targetId: string | null = null;
        let recipientData: {
          mode: 'FLEET' | 'INDEPENDENT';
          providerId: string | null;
          independentDriverProfileId: string | null;
          driverId: string;
          vehicleId: string;
        } | null = null;
        if (body.type === 'RETURN_TO_ORIGIN') {
          if (
            !body.custodianConfirmed ||
            !body.originConfirmed ||
            !body.originContactLabel?.trim() ||
            !body.originContactRole?.trim() ||
            body.recipient ||
            body.releasingCustodianConfirmed ||
            body.receivingCustodianConfirmed ||
            body.atCurrentStageLocation ||
            body.recipientProviderAdminUserId ||
            body.recipientProviderAdminConfirmed
          )
            throw new BadRequestException(
              'Complete origin confirmation required; transfer fields forbidden',
            );
        } else {
          const r = body.recipient;
          if (
            body.custodianConfirmed ||
            body.originConfirmed ||
            body.originContactLabel ||
            body.originContactRole
          )
            throw new BadRequestException(
              'Origin return fields forbidden for transfer',
            );
          if (
            !r ||
            !body.releasingCustodianConfirmed ||
            !body.receivingCustodianConfirmed ||
            !body.atCurrentStageLocation ||
            r.driverId === a.driverId
          )
            throw new BadRequestException(
              'Distinct recipient and physical confirmations required',
            );
          const quote = await tx.dispatch.findUniqueOrThrow({
            where: { id },
            select: { deliveryQuote: true },
          });
          if (r.providerId)
            await tx.$queryRaw`SELECT id FROM "DeliveryProvider" WHERE id=${r.providerId}::uuid FOR SHARE`;
          // Consistent resource lock order, including the resources being released.
          await tx.$queryRaw`SELECT id FROM "Driver" WHERE id IN (${a.driverId}::uuid,${r.driverId}::uuid) ORDER BY id FOR UPDATE`;
          await tx.$queryRaw`SELECT id FROM "Vehicle" WHERE id IN (${a.vehicleId}::uuid,${r.vehicleId}::uuid) ORDER BY id FOR UPDATE`;
          await tx.$queryRaw`SELECT u.id FROM "User" u JOIN "Driver" d ON d."userId"=u.id WHERE d.id=${r.driverId}::uuid FOR SHARE OF u`;
          await tx.$queryRaw`SELECT id FROM "IndependentDriverProfile" WHERE "driverId"=${r.driverId}::uuid FOR SHARE`;
          const driver = await tx.driver.findUnique({
            where: { id: r.driverId },
            include: { user: true, independentProfile: true },
          });
          const vehicle = await tx.vehicle.findUnique({
            where: { id: r.vehicleId },
          });
          if (
            !driver ||
            driver.status !== 'ACTIVE' ||
            !driver.user.active ||
            !vehicle ||
            vehicle.status !== 'ACTIVE'
          )
            throw executionError('CUSTODY_RECIPIENT_NOT_ELIGIBLE');
          if (
            await tx.deliveryAssignment.findFirst({
              where: {
                status: 'ACTIVE',
                id: { not: a.id },
                OR: [{ driverId: r.driverId }, { vehicleId: r.vehicleId }],
              },
            })
          )
            throw executionError('CUSTODY_RECIPIENT_NOT_ELIGIBLE');
          if (r.mode === 'FLEET') {
            if (
              !r.providerId ||
              !body.recipientProviderAdminUserId ||
              !body.recipientProviderAdminConfirmed
            )
              throw new BadRequestException(
                'Recipient provider confirmation required',
              );
            await tx.$queryRaw`SELECT m.id FROM "ProviderMembership" m JOIN "User" u ON u.id=m."userId" WHERE m."providerId"=${r.providerId}::uuid AND m."userId"=${body.recipientProviderAdminUserId}::uuid FOR SHARE OF m,u`;
            await tx.$queryRaw`SELECT id FROM "ProviderServiceCoverage" WHERE "providerId"=${r.providerId}::uuid FOR SHARE`;
            await tx.$queryRaw`SELECT id FROM "DriverVehicleAssignment" WHERE "providerId"=${r.providerId}::uuid AND "unassignedAt" IS NULL FOR SHARE`;
            const provider = await tx.deliveryProvider.findUnique({
              where: { id: r.providerId },
            });
            const member = await tx.providerMembership.findFirst({
              where: {
                providerId: r.providerId,
                userId: body.recipientProviderAdminUserId,
                user: { active: true, role: 'PROVIDER_ADMIN' },
              },
            });
            const coverage = await tx.providerServiceCoverage.findFirst({
              where: {
                providerId: r.providerId,
                status: 'ACTIVE',
                serviceZoneId: quote.deliveryQuote.serviceZoneId,
                serviceType: quote.deliveryQuote.serviceType,
              },
            });
            const pairings = await tx.driverVehicleAssignment.findMany({
              where: { providerId: r.providerId, unassignedAt: null },
            });
            if (
              provider?.status !== 'ACTIVE' ||
              driver.providerId !== r.providerId ||
              vehicle.providerId !== r.providerId ||
              !member ||
              !coverage ||
              pairingConflict(pairings, r.driverId, r.vehicleId)
            )
              throw executionError('CUSTODY_RECIPIENT_NOT_ELIGIBLE');
            recipientData = {
              mode: r.mode,
              providerId: r.providerId,
              independentDriverProfileId: null,
              driverId: r.driverId,
              vehicleId: r.vehicleId,
            };
          } else {
            if (
              r.providerId ||
              body.recipientProviderAdminUserId ||
              body.recipientProviderAdminConfirmed ||
              driver.independentProfile?.status !== 'APPROVED' ||
              vehicle.independentDriverProfileId !==
                driver.independentProfile.id ||
              !allowsIndependent(quote.deliveryQuote.serviceType)
            )
              throw executionError('CUSTODY_RECIPIENT_NOT_ELIGIBLE');
            recipientData = {
              mode: r.mode,
              providerId: null,
              independentDriverProfileId: driver.independentProfile.id,
              driverId: r.driverId,
              vehicleId: r.vehicleId,
            };
          }
          targetId = randomUUID();
        }
        const confirmations = JSON.stringify(body);
        await tx.$executeRaw`INSERT INTO "DeliveryCustodyResolution" (id,"incidentId","dispatchId","fromAssignmentId","toAssignmentId",type,reason,"actorUserId","occurredAt",confirmations) VALUES (${resolutionId}::uuid,${incidentId}::uuid,${id}::uuid,${a.id}::uuid,${targetId}::uuid,${body.type},${body.reason.trim()},${actor.id}::uuid,(${occurredAt}::timestamptz AT TIME ZONE 'UTC'),${confirmations}::jsonb)`;
        await tx.deliveryAssignment.update({
          where: { id: a.id },
          data: {
            status: body.type === 'TRANSFER' ? 'TRANSFERRED' : 'RETURNED',
            endedAt: now,
            endedByUserId: actor.id,
          },
        });
        await tx.$executeRaw`UPDATE "DeliveryCustodyIncident" SET "resolvedAt"=(${now}::timestamptz AT TIME ZONE 'UTC') WHERE id=${incidentId}::uuid`;
        if (recipientData && targetId) {
          await tx.deliveryAssignment.create({
            data: {
              id: targetId,
              dispatchId: id,
              ...recipientData,
              custodyResolutionId: resolutionId,
              assignedAt: now,
              assignedByUserId: actor.id,
            },
          });
          await executionEvent(tx, e, targetId, actor.id, 'TRANSFER');
        } else {
          await tx.dispatch.update({
            where: { id },
            data: { status: 'RETURNED' },
          });
          const dispatch = await tx.dispatch.findUniqueOrThrow({
            where: { id },
          });
          await tx.deliveryRequest.update({
            where: { id: dispatch.deliveryRequestId },
            data: {
              status: 'CANCELLED',
              cancelledAt: now,
              cancellationReason: 'RETURNED_TO_ORIGIN',
            },
          });
          await executionEvent(tx, e, a.id, actor.id, 'RETURN');
        }
        return {
          id: resolutionId,
          type: body.type,
          occurredAt,
          recordedAt: now,
          fromAssignmentId: a.id,
          toAssignmentId: targetId,
          execution: await this.view(tx, id, actor),
        };
      },
    );
  }
}
