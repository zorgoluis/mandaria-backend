-- V1.9-A Independent Drivers. Incremental from V1.8; no existing row is rewritten and every
-- V1.8 fleet assignment keeps working unchanged (they all default to mode = 'FLEET').

-- CreateEnum
CREATE TYPE "IndependentDriverStatus" AS ENUM ('PENDING', 'APPROVED', 'SUSPENDED', 'REJECTED');

-- CreateEnum
CREATE TYPE "DeliveryAssignmentMode" AS ENUM ('FLEET', 'INDEPENDENT');

-- CreateTable
CREATE TABLE "IndependentDriverProfile" (
    "id" UUID NOT NULL,
    "driverId" UUID NOT NULL,
    "status" "IndependentDriverStatus" NOT NULL DEFAULT 'PENDING',
    "approvedAt" TIMESTAMP(3),
    "approvedByUserId" UUID,
    "suspendedAt" TIMESTAMP(3),
    "suspendedByUserId" UUID,
    "rejectedAt" TIMESTAMP(3),
    "rejectedByUserId" UUID,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IndependentDriverProfile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IndependentDriverProfile_driverId_key" ON "IndependentDriverProfile"("driverId");

-- CreateIndex
CREATE INDEX "IndependentDriverProfile_status_createdAt_idx" ON "IndependentDriverProfile"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "IndependentDriverProfile_id_driverId_key" ON "IndependentDriverProfile"("id", "driverId");

-- AddForeignKey
ALTER TABLE "IndependentDriverProfile" ADD CONSTRAINT "IndependentDriverProfile_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IndependentDriverProfile" ADD CONSTRAINT "IndependentDriverProfile_approvedByUserId_fkey" FOREIGN KEY ("approvedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IndependentDriverProfile" ADD CONSTRAINT "IndependentDriverProfile_suspendedByUserId_fkey" FOREIGN KEY ("suspendedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IndependentDriverProfile" ADD CONSTRAINT "IndependentDriverProfile_rejectedByUserId_fkey" FOREIGN KEY ("rejectedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable: a vehicle now belongs to a provider XOR to an independent driver.
ALTER TABLE "Vehicle" ADD COLUMN     "independentDriverProfileId" UUID,
ALTER COLUMN "providerId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "Vehicle_independentDriverProfileId_status_idx" ON "Vehicle"("independentDriverProfileId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Vehicle_id_independentDriverProfileId_key" ON "Vehicle"("id", "independentDriverProfileId");

-- AddForeignKey
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_independentDriverProfileId_fkey" FOREIGN KEY ("independentDriverProfileId") REFERENCES "IndependentDriverProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable: the dispatch claim owner gets its own column per execution model.
ALTER TABLE "Dispatch" ADD COLUMN     "claimedByIndependentDriverId" UUID;

-- CreateIndex
CREATE INDEX "Dispatch_claimedByIndependentDriverId_status_idx" ON "Dispatch"("claimedByIndependentDriverId", "status");

-- AddForeignKey
ALTER TABLE "Dispatch" ADD CONSTRAINT "Dispatch_claimedByIndependentDriverId_fkey" FOREIGN KEY ("claimedByIndependentDriverId") REFERENCES "Driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable: assignments gain an execution mode; existing rows are FLEET by default.
ALTER TABLE "DeliveryAssignment" ADD COLUMN     "independentDriverProfileId" UUID,
ADD COLUMN     "mode" "DeliveryAssignmentMode" NOT NULL DEFAULT 'FLEET',
ALTER COLUMN "providerId" DROP NOT NULL;

-- The V1.8 composite FKs cannot express "provider XOR independent owner": with a NULL providerId
-- MATCH SIMPLE would skip them silently. They are replaced below by per-mode ownership checks
-- inside delivery_assignment_guard plus immutable owner columns on Driver and Vehicle. Together
-- those are stricter than the FKs they replace: ownership is proven on every write, and the owner
-- of a driver or a vehicle can no longer change at all.
ALTER TABLE "DeliveryAssignment" DROP CONSTRAINT "DeliveryAssignment_driverId_providerId_fkey";
ALTER TABLE "DeliveryAssignment" DROP CONSTRAINT "DeliveryAssignment_vehicleId_providerId_fkey";

-- CreateIndex
CREATE INDEX "DeliveryAssignment_independentDriverProfileId_status_assign_idx" ON "DeliveryAssignment"("independentDriverProfileId", "status", "assignedAt");

-- AddForeignKey
ALTER TABLE "DeliveryAssignment" ADD CONSTRAINT "DeliveryAssignment_independentDriverProfileId_fkey" FOREIGN KEY ("independentDriverProfileId") REFERENCES "IndependentDriverProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryAssignment" ADD CONSTRAINT "DeliveryAssignment_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryAssignment" ADD CONSTRAINT "DeliveryAssignment_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- V1.9 invariants not expressible in schema.prisma (keep in sync with services/DTOs).

-- A vehicle has exactly one owner. Fleet vehicles keep the V1.4 unique identifier per provider;
-- independent vehicles get the equivalent partial unique index (a NULL providerId never collides).
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_owner_check"
  CHECK (num_nonnulls("providerId", "independentDriverProfileId") = 1);
CREATE UNIQUE INDEX "Vehicle_independent_identifier_key"
  ON "Vehicle"("independentDriverProfileId", "identifier")
  WHERE "independentDriverProfileId" IS NOT NULL;

-- Profile timestamps match the status; PENDING has none. reason is short free text, never personal data.
ALTER TABLE "IndependentDriverProfile" ADD CONSTRAINT "IndependentDriverProfile_values_check"
  CHECK (
    ("status" <> 'PENDING' OR ("approvedAt" IS NULL AND "suspendedAt" IS NULL AND "rejectedAt" IS NULL))
    AND ("status" <> 'APPROVED' OR ("approvedAt" IS NOT NULL AND "approvedByUserId" IS NOT NULL))
    AND ("status" <> 'SUSPENDED' OR ("suspendedAt" IS NOT NULL AND "suspendedByUserId" IS NOT NULL))
    AND ("status" <> 'REJECTED' OR ("rejectedAt" IS NOT NULL AND "rejectedByUserId" IS NOT NULL))
    AND ("reason" IS NULL OR char_length(btrim("reason")) BETWEEN 3 AND 500)
  );

-- Exactly one operational claim owner while CLAIMED, never both. A cancelled dispatch keeps
-- whichever owner it had as history; OPEN and EXPIRED have none.
ALTER TABLE "Dispatch" DROP CONSTRAINT "Dispatch_values_check";
ALTER TABLE "Dispatch" ADD CONSTRAINT "Dispatch_values_check"
  CHECK (
    "expiresAt" > "openedAt"
    AND num_nonnulls("claimedByProviderId", "claimedByIndependentDriverId") <= 1
    AND ("status" <> 'OPEN' OR (num_nonnulls("claimedByProviderId", "claimedByIndependentDriverId") = 0
      AND "claimedAt" IS NULL AND "expiredAt" IS NULL AND "cancelledAt" IS NULL))
    AND ("status" <> 'CLAIMED' OR (num_nonnulls("claimedByProviderId", "claimedByIndependentDriverId") = 1
      AND "claimedAt" IS NOT NULL AND "expiredAt" IS NULL AND "cancelledAt" IS NULL))
    AND ("status" <> 'EXPIRED' OR ("expiredAt" IS NOT NULL
      AND num_nonnulls("claimedByProviderId", "claimedByIndependentDriverId") = 0 AND "cancelledAt" IS NULL))
    AND ("status" <> 'CANCELLED' OR ("cancelledAt" IS NOT NULL AND "expiredAt" IS NULL))
    AND ("cancellationReason" IS NULL OR char_length("cancellationReason") BETWEEN 1 AND 500)
  );

-- The assignment owner column matches its mode, so a placeholder provider is impossible.
ALTER TABLE "DeliveryAssignment" ADD CONSTRAINT "DeliveryAssignment_mode_check"
  CHECK (
    ("mode" = 'FLEET' AND "providerId" IS NOT NULL AND "independentDriverProfileId" IS NULL)
    OR ("mode" = 'INDEPENDENT' AND "providerId" IS NULL AND "independentDriverProfileId" IS NOT NULL)
  );

-- Ownership of a driver or a vehicle is decided at creation and never changes. This keeps the
-- ownership proven at INSERT time true afterwards, replacing the dropped composite FKs.
CREATE FUNCTION "resource_owner_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'Driver' THEN
    IF NEW."providerId" IS DISTINCT FROM OLD."providerId" THEN
      RAISE EXCEPTION 'RESOURCE_OWNER_IMMUTABLE: a driver cannot change provider';
    END IF;
  ELSIF NEW."providerId" IS DISTINCT FROM OLD."providerId"
    OR NEW."independentDriverProfileId" IS DISTINCT FROM OLD."independentDriverProfileId" THEN
    RAISE EXCEPTION 'RESOURCE_OWNER_IMMUTABLE: a vehicle cannot change owner';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "Driver_owner_guard" BEFORE UPDATE ON "Driver"
  FOR EACH ROW EXECUTE FUNCTION "resource_owner_guard"();
CREATE TRIGGER "Vehicle_owner_guard" BEFORE UPDATE ON "Vehicle"
  FOR EACH ROW EXECUTE FUNCTION "resource_owner_guard"();

-- The independent profile belongs to one driver forever, and an APPROVED profile cannot be
-- withdrawn while it is executing a service: V1.9 refuses the suspension instead of silently
-- cancelling a delivery in progress. The service returns 409 before reaching this guard.
CREATE FUNCTION "independent_driver_profile_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."driverId" <> OLD."driverId" OR NEW."createdAt" <> OLD."createdAt" THEN
      RAISE EXCEPTION 'INDEPENDENT_PROFILE_IMMUTABLE: profile identity cannot change';
    END IF;
    IF NEW."status" <> OLD."status" AND NEW."status" <> 'APPROVED' AND EXISTS (
      SELECT 1 FROM "DeliveryAssignment" a
        WHERE a."independentDriverProfileId" = NEW."id" AND a."status" = 'ACTIVE'
    ) THEN
      RAISE EXCEPTION 'INDEPENDENT_DRIVER_HAS_ACTIVE_ASSIGNMENT: end the active delivery assignment first';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "IndependentDriverProfile_guard" BEFORE INSERT OR UPDATE ON "IndependentDriverProfile"
  FOR EACH ROW EXECUTE FUNCTION "independent_driver_profile_guard"();

-- V1.8 guard extended to both execution modes. Assignments are still born ACTIVE for a CLAIMED
-- dispatch and the owner must hold that claim; what "owner" means now depends on mode:
--   FLEET       the provider holds the claim, and driver and vehicle belong to that provider;
--   INDEPENDENT the driver itself holds the claim, and an APPROVED profile owns both the driver
--               and the vehicle, so a client-supplied vehicleId can never be someone else's.
-- Identity, including mode and owner, stays immutable afterwards.
CREATE OR REPLACE FUNCTION "delivery_assignment_guard"() RETURNS trigger AS $$
DECLARE
  d_status "DispatchStatus"; d_provider UUID; d_independent UUID;
  v_provider UUID; v_independent UUID; dr_provider UUID;
  p_driver UUID; p_status "IndependentDriverStatus";
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT "status", "claimedByProviderId", "claimedByIndependentDriverId"
      INTO d_status, d_provider, d_independent
      FROM "Dispatch" WHERE "id" = NEW."dispatchId";
    IF NEW."status" <> 'ACTIVE' OR d_status IS DISTINCT FROM 'CLAIMED' THEN
      RAISE EXCEPTION 'DELIVERY_ASSIGNMENT_INVALID: assignments are ACTIVE for a CLAIMED dispatch';
    END IF;
    SELECT "providerId", "independentDriverProfileId" INTO v_provider, v_independent
      FROM "Vehicle" WHERE "id" = NEW."vehicleId";
    IF NEW."mode" = 'FLEET' THEN
      SELECT "providerId" INTO dr_provider FROM "Driver" WHERE "id" = NEW."driverId";
      IF d_provider IS DISTINCT FROM NEW."providerId" THEN
        RAISE EXCEPTION 'DELIVERY_ASSIGNMENT_INVALID: assignments are ACTIVE for a dispatch CLAIMED by the same provider';
      END IF;
      IF dr_provider IS DISTINCT FROM NEW."providerId" OR v_provider IS DISTINCT FROM NEW."providerId" THEN
        RAISE EXCEPTION 'DELIVERY_ASSIGNMENT_INVALID: driver and vehicle must belong to the provider';
      END IF;
    ELSE
      SELECT "driverId", "status" INTO p_driver, p_status
        FROM "IndependentDriverProfile" WHERE "id" = NEW."independentDriverProfileId";
      IF p_status IS DISTINCT FROM 'APPROVED' OR p_driver IS DISTINCT FROM NEW."driverId" THEN
        RAISE EXCEPTION 'DELIVERY_ASSIGNMENT_INVALID: independent profile must be APPROVED and own the driver';
      END IF;
      IF d_independent IS DISTINCT FROM NEW."driverId" THEN
        RAISE EXCEPTION 'DELIVERY_ASSIGNMENT_INVALID: assignments are ACTIVE for a dispatch CLAIMED by the same independent driver';
      END IF;
      IF v_independent IS DISTINCT FROM NEW."independentDriverProfileId" THEN
        RAISE EXCEPTION 'DELIVERY_ASSIGNMENT_INVALID: vehicle must belong to the independent driver';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."dispatchId" <> OLD."dispatchId" OR NEW."mode" <> OLD."mode"
    OR NEW."providerId" IS DISTINCT FROM OLD."providerId"
    OR NEW."independentDriverProfileId" IS DISTINCT FROM OLD."independentDriverProfileId"
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

-- V1.7/V1.8 dispatch guard + V1.9: the candidate snapshot only governs provider claims. An
-- independent claim has no DispatchCandidate row (candidates are a provider concept) and is valid
-- only while that driver's profile is APPROVED.
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
  IF NEW."status" = 'CLAIMED' AND NEW."claimedByProviderId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "DispatchCandidate" c WHERE c."dispatchId" = NEW."id"
      AND c."providerId" = NEW."claimedByProviderId" AND c."status" = 'CLAIMED'
  ) THEN
    RAISE EXCEPTION 'DISPATCH_INVALID: claim owner must be a CLAIMED candidate';
  END IF;
  IF NEW."status" = 'CLAIMED' AND NEW."claimedByIndependentDriverId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "IndependentDriverProfile" p
      WHERE p."driverId" = NEW."claimedByIndependentDriverId" AND p."status" = 'APPROVED'
  ) THEN
    RAISE EXCEPTION 'DISPATCH_INVALID: independent claim owner must be an APPROVED independent driver';
  END IF;
  IF OLD."status" = 'CLAIMED' AND NEW."status" <> 'CLAIMED' AND EXISTS (
    SELECT 1 FROM "DeliveryAssignment" a WHERE a."dispatchId" = NEW."id" AND a."status" = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'DISPATCH_HAS_ACTIVE_ASSIGNMENT: end the active delivery assignment first';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
