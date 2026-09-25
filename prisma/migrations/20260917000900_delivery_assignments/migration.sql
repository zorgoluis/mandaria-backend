-- V1.8 Provider Driver & Vehicle Assignment. Incremental from V1.7; no existing row is rewritten.

-- CreateEnum
CREATE TYPE "DeliveryAssignmentStatus" AS ENUM ('ACTIVE', 'REASSIGNED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DeliveryAssignmentEndReason" AS ENUM ('DRIVER_UNAVAILABLE', 'VEHICLE_ISSUE', 'OPERATIONAL_CHANGE', 'DELIVERY_CANCELLED', 'OTHER');

-- CreateTable
CREATE TABLE "DeliveryAssignment" (
    "id" UUID NOT NULL,
    "dispatchId" UUID NOT NULL,
    "providerId" UUID NOT NULL,
    "driverId" UUID NOT NULL,
    "vehicleId" UUID NOT NULL,
    "status" "DeliveryAssignmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "assignedAt" TIMESTAMP(3) NOT NULL,
    "assignedByUserId" UUID NOT NULL,
    "endedAt" TIMESTAMP(3),
    "endedByUserId" UUID,
    "endReason" "DeliveryAssignmentEndReason",
    "endReasonDetail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeliveryAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeliveryAssignment_dispatchId_assignedAt_idx" ON "DeliveryAssignment"("dispatchId", "assignedAt");

-- CreateIndex
CREATE INDEX "DeliveryAssignment_providerId_status_assignedAt_idx" ON "DeliveryAssignment"("providerId", "status", "assignedAt");

-- CreateIndex
CREATE INDEX "DeliveryAssignment_driverId_assignedAt_idx" ON "DeliveryAssignment"("driverId", "assignedAt");

-- CreateIndex
CREATE INDEX "DeliveryAssignment_vehicleId_assignedAt_idx" ON "DeliveryAssignment"("vehicleId", "assignedAt");

-- AddForeignKey
ALTER TABLE "DeliveryAssignment" ADD CONSTRAINT "DeliveryAssignment_dispatchId_fkey" FOREIGN KEY ("dispatchId") REFERENCES "Dispatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryAssignment" ADD CONSTRAINT "DeliveryAssignment_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "DeliveryProvider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryAssignment" ADD CONSTRAINT "DeliveryAssignment_driverId_providerId_fkey" FOREIGN KEY ("driverId", "providerId") REFERENCES "Driver"("id", "providerId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryAssignment" ADD CONSTRAINT "DeliveryAssignment_vehicleId_providerId_fkey" FOREIGN KEY ("vehicleId", "providerId") REFERENCES "Vehicle"("id", "providerId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryAssignment" ADD CONSTRAINT "DeliveryAssignment_assignedByUserId_fkey" FOREIGN KEY ("assignedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryAssignment" ADD CONSTRAINT "DeliveryAssignment_endedByUserId_fkey" FOREIGN KEY ("endedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- V1.8 invariants not expressible in schema.prisma (keep in sync with services/DTOs).

-- One ACTIVE assignment per dispatch, per driver and per vehicle. With the row locks taken by the
-- service these are the last line of defence against concurrent double assignment.
CREATE UNIQUE INDEX "DeliveryAssignment_active_dispatch_key"
  ON "DeliveryAssignment"("dispatchId") WHERE "status" = 'ACTIVE';
CREATE UNIQUE INDEX "DeliveryAssignment_active_driver_key"
  ON "DeliveryAssignment"("driverId") WHERE "status" = 'ACTIVE';
CREATE UNIQUE INDEX "DeliveryAssignment_active_vehicle_key"
  ON "DeliveryAssignment"("vehicleId") WHERE "status" = 'ACTIVE';

ALTER TABLE "DeliveryAssignment" ADD CONSTRAINT "DeliveryAssignment_values_check"
  CHECK (
    ("status" = 'ACTIVE' AND "endedAt" IS NULL AND "endedByUserId" IS NULL
      AND "endReason" IS NULL AND "endReasonDetail" IS NULL)
    OR ("status" IN ('REASSIGNED', 'CANCELLED') AND "endedAt" IS NOT NULL AND "endReason" IS NOT NULL
      AND "endedAt" >= "assignedAt")
  );
ALTER TABLE "DeliveryAssignment" ADD CONSTRAINT "DeliveryAssignment_reason_check"
  CHECK (
    ("endReasonDetail" IS NULL OR char_length(btrim("endReasonDetail")) BETWEEN 3 AND 500)
    AND ("endReason" IS DISTINCT FROM 'OTHER' OR "endReasonDetail" IS NOT NULL)
    AND ("status" <> 'REASSIGNED' OR "endReason" <> 'DELIVERY_CANCELLED')
  );

-- Assignments are born ACTIVE for a CLAIMED dispatch of the same provider; who/what/when never
-- changes and status only leaves ACTIVE.
CREATE FUNCTION "delivery_assignment_guard"() RETURNS trigger AS $$
DECLARE d_status "DispatchStatus"; d_owner UUID;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT "status", "claimedByProviderId" INTO d_status, d_owner
      FROM "Dispatch" WHERE "id" = NEW."dispatchId";
    IF NEW."status" <> 'ACTIVE' OR d_status IS DISTINCT FROM 'CLAIMED'
      OR d_owner IS DISTINCT FROM NEW."providerId" THEN
      RAISE EXCEPTION 'DELIVERY_ASSIGNMENT_INVALID: assignments are ACTIVE for a dispatch CLAIMED by the same provider';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."dispatchId" <> OLD."dispatchId" OR NEW."providerId" <> OLD."providerId"
    OR NEW."driverId" <> OLD."driverId" OR NEW."vehicleId" <> OLD."vehicleId"
    OR NEW."assignedAt" <> OLD."assignedAt" OR NEW."assignedByUserId" <> OLD."assignedByUserId"
    OR NEW."createdAt" <> OLD."createdAt"
  THEN
    RAISE EXCEPTION 'DELIVERY_ASSIGNMENT_IMMUTABLE: assignment history cannot be overwritten';
  END IF;
  IF OLD."status" <> 'ACTIVE' THEN
    RAISE EXCEPTION 'DELIVERY_ASSIGNMENT_IMMUTABLE: ended assignments cannot change';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "DeliveryAssignment_guard" BEFORE INSERT OR UPDATE ON "DeliveryAssignment"
  FOR EACH ROW EXECUTE FUNCTION "delivery_assignment_guard"();

-- V1.7 dispatch guard + V1.8: a dispatch with an ACTIVE assignment cannot leave CLAIMED (release,
-- expiry or cancellation must end the assignment first, in the same transaction).
CREATE OR REPLACE FUNCTION "dispatch_guard"() RETURNS trigger AS $$
DECLARE quote_status "DeliveryQuoteStatus"; quote_request UUID;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT "status", "deliveryRequestId" INTO quote_status, quote_request
      FROM "DeliveryQuote" WHERE "id" = NEW."deliveryQuoteId";
    IF NEW."status" <> 'OPEN' OR quote_status IS DISTINCT FROM 'ACCEPTED'
      OR quote_request IS DISTINCT FROM NEW."deliveryRequestId" THEN
      RAISE EXCEPTION 'DISPATCH_INVALID: dispatch must open for an ACCEPTED quote of its request';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."deliveryRequestId" <> OLD."deliveryRequestId" OR NEW."deliveryQuoteId" <> OLD."deliveryQuoteId"
    OR NEW."openedAt" <> OLD."openedAt" OR NEW."expiresAt" <> OLD."expiresAt" OR NEW."createdAt" <> OLD."createdAt"
  THEN
    RAISE EXCEPTION 'DISPATCH_IMMUTABLE: dispatch identity and window cannot change';
  END IF;
  IF NEW."status" <> OLD."status" AND NOT (
    (OLD."status" = 'OPEN' AND NEW."status" IN ('CLAIMED', 'EXPIRED', 'CANCELLED'))
    OR (OLD."status" = 'CLAIMED' AND NEW."status" IN ('OPEN', 'EXPIRED', 'CANCELLED'))
  ) THEN
    RAISE EXCEPTION 'DISPATCH_IMMUTABLE: invalid status transition';
  END IF;
  IF OLD."status" IN ('EXPIRED', 'CANCELLED') THEN
    RAISE EXCEPTION 'DISPATCH_IMMUTABLE: resolved dispatches cannot change';
  END IF;
  IF NEW."status" = 'CLAIMED' AND NOT EXISTS (
    SELECT 1 FROM "DispatchCandidate" c WHERE c."dispatchId" = NEW."id"
      AND c."providerId" = NEW."claimedByProviderId" AND c."status" = 'CLAIMED'
  ) THEN
    RAISE EXCEPTION 'DISPATCH_INVALID: claim owner must be a CLAIMED candidate';
  END IF;
  IF OLD."status" = 'CLAIMED' AND NEW."status" <> 'CLAIMED' AND EXISTS (
    SELECT 1 FROM "DeliveryAssignment" a WHERE a."dispatchId" = NEW."id" AND a."status" = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'DISPATCH_HAS_ACTIVE_ASSIGNMENT: end the active delivery assignment first';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
