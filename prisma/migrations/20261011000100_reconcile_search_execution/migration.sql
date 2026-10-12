-- Preserve QA RETURNED lifecycle and independent authority rules after the main search migration.
-- Window immutability/retries remain enforced by Dispatch_search_guard for both modes.
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
    OR NEW."openedAt" <> OLD."openedAt" OR NEW."createdAt" <> OLD."createdAt"
  THEN
    RAISE EXCEPTION 'DISPATCH_IMMUTABLE: dispatch identity and window cannot change';
  END IF;
  IF NEW."status" <> OLD."status" AND NOT (
    (OLD."status" = 'OPEN' AND NEW."status" IN ('CLAIMED', 'EXPIRED', 'CANCELLED'))
    OR (OLD."status" = 'CLAIMED' AND NEW."status" IN ('OPEN', 'EXPIRED', 'CANCELLED', 'DELIVERED', 'RETURNED'))
  ) THEN
    RAISE EXCEPTION 'DISPATCH_IMMUTABLE: invalid status transition';
  END IF;
  IF OLD."status" IN ('EXPIRED', 'CANCELLED', 'DELIVERED', 'RETURNED') THEN
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
  IF NEW."status" = 'CLAIMED' AND OLD."status" <> 'CLAIMED' AND NEW."claimedByIndependentDriverId" IS NOT NULL AND NOT EXISTS (
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
