import type { Prisma } from '@prisma/client';
import { DomainException } from '../common/domain-error.js';
import { EXECUTION_PHASES } from './execution.types.js';
import type { ExecutionView } from './execution.types.js';
export type ExecutionHead = {
  dispatchId: string;
  chainId: string;
  assignmentId: string;
  revision: number;
  phase: number;
  recordedAt: Date;
};
export const executionError = (code: string) =>
  new DomainException(code, 409, code);

export async function lockExecutionDispatch(
  tx: Prisma.TransactionClient,
  dispatchId: string,
) {
  await tx.$queryRaw`SELECT r.id FROM "DeliveryRequest" r JOIN "Dispatch" d ON d."deliveryRequestId"=r.id WHERE d.id=${dispatchId}::uuid FOR UPDATE OF r`;
  await tx.$queryRaw`SELECT id FROM "Dispatch" WHERE id=${dispatchId}::uuid FOR UPDATE`;
}
export async function executionHead(tx: Prisma.TransactionClient, id: string) {
  const rows = await tx.$queryRaw<
    ExecutionHead[]
  >`SELECT * FROM "DeliveryExecution" WHERE "dispatchId"=${id}::uuid`;
  return rows[0] ?? null;
}
export async function executionEvent(
  tx: Prisma.TransactionClient,
  head: ExecutionHead,
  assignmentId: string,
  actorId: string,
  kind: string,
  phase = head.phase,
  chainId = head.chainId,
) {
  await tx.$executeRaw`INSERT INTO "DeliveryExecutionEvent" ("dispatchId","chainId","assignmentId",revision,phase,kind,"actorUserId","actorRole",source)
   SELECT ${head.dispatchId}::uuid,${chainId}::uuid,${assignmentId}::uuid,${head.revision + 1},${phase},${kind},id,role,
   CASE role WHEN 'SUPER_ADMIN' THEN 'ADMIN_RESOLUTION' WHEN 'DRIVER' THEN 'SELF_REPORT' ELSE 'PHONE_REPORT' END FROM "User" WHERE id=${actorId}::uuid`;
}
export async function initializeExecution(
  tx: Prisma.TransactionClient,
  assignmentId: string,
  enabled: boolean,
) {
  const assignment = await tx.deliveryAssignment.findUniqueOrThrow({
    where: { id: assignmentId },
  });
  const existing = await executionHead(tx, assignment.dispatchId);
  if (!existing && !enabled) return;
  if (!existing)
    await tx.$executeRaw`INSERT INTO "DeliveryExecution" ("dispatchId","chainId","assignmentId",revision,phase) VALUES (${assignment.dispatchId}::uuid,${assignment.id}::uuid,${assignment.id}::uuid,0,0)`;
  const head = await executionHead(tx, assignment.dispatchId);
  await executionEvent(
    tx,
    head!,
    assignment.id,
    assignment.assignedByUserId,
    'ASSIGNED',
    0,
    assignment.id,
  );
}
export async function executionView(
  tx: Prisma.TransactionClient,
  dispatchId: string,
): Promise<ExecutionView | null> {
  const e = await executionHead(tx, dispatchId);
  if (!e) return null;
  const a = await tx.deliveryAssignment.findUniqueOrThrow({
    where: { id: e.assignmentId },
  });
  const d = await tx.dispatch.findUniqueOrThrow({ where: { id: dispatchId } });
  const incidents = await tx.$queryRaw<
    { id: string }[]
  >`SELECT id FROM "DeliveryCustodyIncident" WHERE "dispatchId"=${dispatchId}::uuid AND "resolvedAt" IS NULL`;
  const active = d.status === 'CLAIMED' && a.status === 'ACTIVE';
  return {
    trackingMode: 'DETAILED',
    revision: e.revision,
    phase: EXECUTION_PHASES[e.phase - 1] ?? null,
    activeAssignmentId: active ? a.id : null,
    custodyStatus:
      d.status === 'RETURNED'
        ? 'RETURNED'
        : d.status === 'DELIVERED'
          ? 'DELIVERED'
          : e.phase >= 3
            ? 'HELD'
            : 'NOT_COLLECTED',
    openIncidentId: incidents[0]?.id ?? null,
    allowedActions: !active
      ? []
      : incidents.length
        ? []
        : [
            ...(e.phase < 5 ? ['ADVANCE'] : ['DELIVER']),
            ...(e.phase >= 3
              ? ['REPORT_INCIDENT']
              : ['ORDINARY_ASSIGNMENT_OPERATIONS']),
          ],
    lastRecordedAt: e.recordedAt.toISOString(),
  };
}
export async function assertExecutionCompletion(
  tx: Prisma.TransactionClient,
  dispatchId: string,
) {
  const view = await executionView(tx, dispatchId);
  if (view && (view.phase !== 'AT_DROPOFF' || view.openIncidentId))
    throw executionError(
      view.openIncidentId
        ? 'CUSTODY_INCIDENT_OPEN'
        : 'EXECUTION_TRANSITION_INVALID',
    );
}

/** Only enrich authorized operational views; offers and former owners keep their redacted view. */
export async function withExecutionInstructions<
  T extends { access?: string; assignment?: { id: string } | null },
>(
  tx: Prisma.TransactionClient,
  dispatchId: string,
  view: T,
  expectedAssignmentId?: string,
): Promise<
  T & {
    execution?: ExecutionView;
    collectionActionAllowed?: boolean;
    advanceToOriginAllowed?: boolean;
  }
> {
  if (view.access !== 'OWNER') return view;
  const execution = await executionView(tx, dispatchId);
  if (!execution) return view;
  execution.allowedActions = execution.allowedActions.filter((action) =>
    'claimedByMe' in view
      ? !['ADVANCE', 'DELIVER'].includes(action)
      : action !== 'ORDINARY_ASSIGNMENT_OPERATIONS',
  );
  // An intervening transfer must never attach the new custodian's IDs/actions to an old view.
  const expected = expectedAssignmentId ?? view.assignment?.id;
  if (
    execution.activeAssignmentId &&
    (expectedAssignmentId !== undefined || 'assignment' in view) &&
    expected !== execution.activeAssignmentId
  )
    return view;
  return {
    ...view,
    execution,
    collectionActionAllowed:
      execution.activeAssignmentId !== null &&
      execution.openIncidentId === null &&
      execution.phase === 'AT_DROPOFF',
    advanceToOriginAllowed:
      execution.custodyStatus === 'NOT_COLLECTED' &&
      execution.activeAssignmentId !== null,
  };
}
