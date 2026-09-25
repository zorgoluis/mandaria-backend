-- V1.11-A MVP Delivery Completion, part 2 of 2: who delivered, when, and the rules around it.
-- No existing row changes: every Dispatch keeps its status and no historical service becomes
-- DELIVERED. Completion is an operational close, never an economic event: the credits charged at
-- CLAIM/TAKE stay consumed and nothing here touches the ledger, the policies or the snapshots.

-- AlterTable
ALTER TABLE "Dispatch" ADD COLUMN     "deliveredAt" TIMESTAMP(3),
ADD COLUMN     "deliveredByUserId" UUID;

-- AddForeignKey
ALTER TABLE "Dispatch" ADD CONSTRAINT "Dispatch_deliveredByUserId_fkey" FOREIGN KEY ("deliveredByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateIndex: auditing "what was delivered, when and by whom".
CREATE INDEX "Dispatch_status_deliveredAt_idx" ON "Dispatch"("status", "deliveredAt");


-- V1.11-A invariants (keep in sync with delivery-completion.policy.ts).

-- A DELIVERED dispatch keeps the claim owner that paid for it and records who confirmed and when.
-- Keeping the owner is what makes the delivery final for credits: service_refund_guard only returns
-- credits when the payer no longer holds the service (release) or the service was CANCELLED/EXPIRED,
-- so no refund can reference a delivered dispatch. Any other status carries no delivery stamp.
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
    AND ("status" <> 'DELIVERED' OR (num_nonnulls("claimedByProviderId", "claimedByIndependentDriverId") = 1
      AND "claimedAt" IS NOT NULL AND "deliveredAt" IS NOT NULL AND "deliveredByUserId" IS NOT NULL
      AND "expiredAt" IS NULL AND "cancelledAt" IS NULL))
    AND ("status" = 'DELIVERED' OR ("deliveredAt" IS NULL AND "deliveredByUserId" IS NULL))
    AND ("cancellationReason" IS NULL OR char_length("cancellationReason") BETWEEN 1 AND 500)
  );

-- COMPLETED reuses the V1.8 ending columns and carries no endReason: nothing failed. Like every
-- non-ACTIVE row it stops holding the driver and the vehicle (the partial unique indexes only
-- constrain ACTIVE), so both can take another service while this row stays as history.
ALTER TABLE "DeliveryAssignment" DROP CONSTRAINT "DeliveryAssignment_values_check";
ALTER TABLE "DeliveryAssignment" ADD CONSTRAINT "DeliveryAssignment_values_check"
  CHECK (
    ("status" = 'ACTIVE' AND "endedAt" IS NULL AND "endedByUserId" IS NULL
      AND "endReason" IS NULL AND "endReasonDetail" IS NULL)
    OR ("status" IN ('REASSIGNED', 'CANCELLED') AND "endedAt" IS NOT NULL AND "endReason" IS NOT NULL
      AND "endedAt" >= "assignedAt")
    OR ("status" = 'COMPLETED' AND "endedAt" IS NOT NULL AND "endedByUserId" IS NOT NULL
      AND "endReason" IS NULL AND "endReasonDetail" IS NULL AND "endedAt" >= "assignedAt")
  );

-- V1.7/V1.8/V1.9 dispatch guard + V1.11: CLAIMED -> DELIVERED is the only way in, DELIVERED is
-- terminal like EXPIRED and CANCELLED, the claim owner cannot change while delivering, and the
-- delivery stamp is written once and never edited. The pre-existing rule that a dispatch cannot
-- leave CLAIMED while an assignment is ACTIVE also applies here, which is what forces completion to
-- close the assignment in the same transaction.
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
    IF NEW."deliveredAt" IS NOT NULL OR NEW."deliveredByUserId" IS NOT NULL THEN
      RAISE EXCEPTION 'DISPATCH_INVALID: a dispatch cannot open already delivered';
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
    OR (OLD."status" = 'CLAIMED' AND NEW."status" IN ('OPEN', 'EXPIRED', 'CANCELLED', 'DELIVERED'))
  ) THEN
    RAISE EXCEPTION 'DISPATCH_IMMUTABLE: invalid status transition';
  END IF;
  IF OLD."status" IN ('EXPIRED', 'CANCELLED', 'DELIVERED') THEN
    RAISE EXCEPTION 'DISPATCH_IMMUTABLE: resolved dispatches cannot change';
  END IF;
  -- The delivery stamp belongs to the transition that writes it: it appears exactly once, with the
  -- claim owner untouched, and can never be rewritten or cleared afterwards.
  IF OLD."deliveredAt" IS NOT NULL OR OLD."deliveredByUserId" IS NOT NULL THEN
    RAISE EXCEPTION 'DISPATCH_IMMUTABLE: the delivery record cannot change';
  END IF;
  IF NEW."status" = 'DELIVERED' AND (
    NEW."claimedByProviderId" IS DISTINCT FROM OLD."claimedByProviderId"
    OR NEW."claimedByIndependentDriverId" IS DISTINCT FROM OLD."claimedByIndependentDriverId"
    OR NEW."claimedAt" IS DISTINCT FROM OLD."claimedAt"
  ) THEN
    RAISE EXCEPTION 'DISPATCH_INVALID: a delivery keeps the actor that was awarded the service';
  END IF;
  IF NEW."status" <> 'DELIVERED' AND (NEW."deliveredAt" IS NOT NULL OR NEW."deliveredByUserId" IS NOT NULL) THEN
    RAISE EXCEPTION 'DISPATCH_INVALID: only a delivered dispatch carries a delivery record';
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
  -- A delivery is the end of a service that was really dispatched to a driver and a vehicle.
  IF NEW."status" = 'DELIVERED' AND NOT EXISTS (
    SELECT 1 FROM "DeliveryAssignment" a
     WHERE a."dispatchId" = NEW."id" AND a."status" = 'COMPLETED' AND a."endedAt" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'DISPATCH_INVALID: a delivered dispatch must close its delivery assignment';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- V1.10-E + V1.11: a delivery is not a reversal. The service was performed, so the award stays
-- consumed and no SERVICE_REFUND is required or allowed. Without this, CLAIMED -> DELIVERED would
-- demand the refund that releases and cancellations owe.
CREATE OR REPLACE FUNCTION "dispatch_award_refund_required"() RETURNS trigger AS $$
DECLARE
  account_id UUID;
  award RECORD;
BEGIN
  IF OLD."status" <> 'CLAIMED' THEN
    RETURN NULL;
  END IF;
  IF NEW."status" = 'DELIVERED' THEN
    RETURN NULL;
  END IF;
  -- Nothing to settle while the same actor still holds the service (an assignment change, for
  -- example, leaves the claim exactly where it was).
  IF NEW."status" = 'CLAIMED'
    AND NEW."claimedByProviderId" IS NOT DISTINCT FROM OLD."claimedByProviderId"
    AND NEW."claimedByIndependentDriverId" IS NOT DISTINCT FROM OLD."claimedByIndependentDriverId" THEN
    RETURN NULL;
  END IF;
  SELECT a."id" INTO account_id FROM "CreditAccount" a
   WHERE (OLD."claimedByProviderId" IS NOT NULL AND a."providerId" = OLD."claimedByProviderId")
      OR (OLD."claimedByIndependentDriverId" IS NOT NULL
          AND a."independentDriverProfileId" = (SELECT "id" FROM "IndependentDriverProfile" WHERE "driverId" = OLD."claimedByIndependentDriverId"));
  IF account_id IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT "id" INTO award FROM "CreditLedgerEntry"
   WHERE "type" = 'SERVICE_AWARD' AND "referenceId" = OLD."id" AND "creditAccountId" = account_id;
  -- No award means this service was never charged (LEGACY or a pre-enforcement claim): there is
  -- nothing to give back and no credit is invented.
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "CreditLedgerEntry"
     WHERE "type" = 'SERVICE_REFUND' AND "reversesEntryId" = award."id"
  ) THEN
    RAISE EXCEPTION 'CREDIT_REFUND_REQUIRED: dispatch % was reversed without returning the credits of its award', OLD."id";
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
