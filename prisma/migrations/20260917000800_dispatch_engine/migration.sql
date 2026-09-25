-- V1.7 Dispatch Engine & Provider Claiming. Incremental from V1.6.1; no existing row is rewritten.

-- CreateEnum
CREATE TYPE "ProviderServiceCoverageStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "DispatchStatus" AS ENUM ('OPEN', 'CLAIMED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DispatchCandidateStatus" AS ENUM ('OFFERED', 'CLAIMED', 'RELEASED');

-- CreateTable
CREATE TABLE "ProviderServiceCoverage" (
    "id" UUID NOT NULL,
    "providerId" UUID NOT NULL,
    "serviceZoneId" UUID NOT NULL,
    "serviceType" "ServiceType" NOT NULL,
    "status" "ProviderServiceCoverageStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderServiceCoverage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Dispatch" (
    "id" UUID NOT NULL,
    "deliveryRequestId" UUID NOT NULL,
    "deliveryQuoteId" UUID NOT NULL,
    "status" "DispatchStatus" NOT NULL DEFAULT 'OPEN',
    "openedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "claimedByProviderId" UUID,
    "claimedAt" TIMESTAMP(3),
    "expiredAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancellationReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Dispatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DispatchCandidate" (
    "id" UUID NOT NULL,
    "dispatchId" UUID NOT NULL,
    "providerId" UUID NOT NULL,
    "status" "DispatchCandidateStatus" NOT NULL DEFAULT 'OFFERED',
    "offeredAt" TIMESTAMP(3) NOT NULL,
    "claimedAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "releaseReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DispatchCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProviderServiceCoverage_serviceZoneId_serviceType_status_idx" ON "ProviderServiceCoverage"("serviceZoneId", "serviceType", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderServiceCoverage_providerId_serviceZoneId_serviceTyp_key" ON "ProviderServiceCoverage"("providerId", "serviceZoneId", "serviceType");

-- CreateIndex
CREATE UNIQUE INDEX "Dispatch_deliveryQuoteId_key" ON "Dispatch"("deliveryQuoteId");

-- CreateIndex
CREATE INDEX "Dispatch_deliveryRequestId_idx" ON "Dispatch"("deliveryRequestId");

-- CreateIndex
CREATE INDEX "Dispatch_status_expiresAt_idx" ON "Dispatch"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "Dispatch_claimedByProviderId_status_idx" ON "Dispatch"("claimedByProviderId", "status");

-- CreateIndex
CREATE INDEX "Dispatch_createdAt_id_idx" ON "Dispatch"("createdAt", "id");

-- CreateIndex
CREATE INDEX "DispatchCandidate_providerId_status_dispatchId_idx" ON "DispatchCandidate"("providerId", "status", "dispatchId");

-- CreateIndex
CREATE UNIQUE INDEX "DispatchCandidate_dispatchId_providerId_key" ON "DispatchCandidate"("dispatchId", "providerId");

-- AddForeignKey
ALTER TABLE "ProviderServiceCoverage" ADD CONSTRAINT "ProviderServiceCoverage_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "DeliveryProvider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderServiceCoverage" ADD CONSTRAINT "ProviderServiceCoverage_serviceZoneId_fkey" FOREIGN KEY ("serviceZoneId") REFERENCES "ServiceZone"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dispatch" ADD CONSTRAINT "Dispatch_deliveryRequestId_fkey" FOREIGN KEY ("deliveryRequestId") REFERENCES "DeliveryRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dispatch" ADD CONSTRAINT "Dispatch_deliveryQuoteId_fkey" FOREIGN KEY ("deliveryQuoteId") REFERENCES "DeliveryQuote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DispatchCandidate" ADD CONSTRAINT "DispatchCandidate_dispatchId_fkey" FOREIGN KEY ("dispatchId") REFERENCES "Dispatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DispatchCandidate" ADD CONSTRAINT "DispatchCandidate_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "DeliveryProvider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- V1.7 invariants not expressible in schema.prisma (keep in sync with services/DTOs).

ALTER TABLE "Dispatch" ADD CONSTRAINT "Dispatch_values_check"
  CHECK (
    "expiresAt" > "openedAt"
    AND ("status" <> 'OPEN' OR ("claimedByProviderId" IS NULL AND "claimedAt" IS NULL AND "expiredAt" IS NULL AND "cancelledAt" IS NULL))
    AND ("status" <> 'CLAIMED' OR ("claimedByProviderId" IS NOT NULL AND "claimedAt" IS NOT NULL AND "expiredAt" IS NULL AND "cancelledAt" IS NULL))
    AND ("status" <> 'EXPIRED' OR ("expiredAt" IS NOT NULL AND "claimedByProviderId" IS NULL AND "cancelledAt" IS NULL))
    AND ("status" <> 'CANCELLED' OR ("cancelledAt" IS NOT NULL AND "expiredAt" IS NULL))
    AND ("cancellationReason" IS NULL OR char_length("cancellationReason") BETWEEN 1 AND 500)
  );
ALTER TABLE "DispatchCandidate" ADD CONSTRAINT "DispatchCandidate_values_check"
  CHECK (
    ("status" <> 'OFFERED' OR ("claimedAt" IS NULL AND "releasedAt" IS NULL AND "releaseReason" IS NULL))
    AND ("status" <> 'CLAIMED' OR ("claimedAt" IS NOT NULL AND "releasedAt" IS NULL AND "releaseReason" IS NULL))
    AND ("status" <> 'RELEASED' OR ("claimedAt" IS NOT NULL AND "releasedAt" IS NOT NULL
      AND "releaseReason" IS NOT NULL AND char_length(btrim("releaseReason")) BETWEEN 3 AND 500))
  );

-- At most one CLAIMED candidate per dispatch: a second concurrent claim cannot commit.
CREATE UNIQUE INDEX "DispatchCandidate_claimed_dispatch_key"
  ON "DispatchCandidate"("dispatchId") WHERE "status" = 'CLAIMED';

-- Legacy backfill: quotes ACCEPTED before V1.7 get their dispatch so "ACCEPTED ⇒ Dispatch" holds for
-- all data. They were never offered (no coverage existed): EXPIRED without candidates, or CANCELLED
-- when the request was already cancelled.
INSERT INTO "Dispatch" ("id", "deliveryRequestId", "deliveryQuoteId", "status", "openedAt", "expiresAt",
  "expiredAt", "cancelledAt", "cancellationReason", "updatedAt")
SELECT gen_random_uuid(), q."deliveryRequestId", q."id",
  CASE WHEN r."status" = 'CANCELLED' THEN 'CANCELLED'::"DispatchStatus" ELSE 'EXPIRED'::"DispatchStatus" END,
  q."acceptedAt", q."acceptedAt" + interval '10 minutes',
  CASE WHEN r."status" = 'CANCELLED' THEN NULL ELSE GREATEST(now(), q."acceptedAt" + interval '10 minutes') END,
  CASE WHEN r."status" = 'CANCELLED' THEN COALESCE(r."cancelledAt", now()) ELSE NULL END,
  CASE WHEN r."status" = 'CANCELLED' THEN 'DELIVERY_REQUEST_CANCELLED' ELSE NULL END,
  now()
FROM "DeliveryQuote" q
JOIN "DeliveryRequest" r ON r."id" = q."deliveryRequestId"
WHERE q."status" = 'ACCEPTED'
  AND NOT EXISTS (SELECT 1 FROM "Dispatch" d WHERE d."deliveryQuoteId" = q."id");

-- A dispatch is only born OPEN for an ACCEPTED quote of the same request. Afterwards its identity
-- and window never change; status moves OPEN→CLAIMED|EXPIRED|CANCELLED, CLAIMED→OPEN (release)
-- |EXPIRED (release after the window)|CANCELLED; EXPIRED and CANCELLED are terminal. CLAIMED requires
-- the owner to be a CLAIMED candidate of that dispatch.
CREATE FUNCTION "dispatch_guard"() RETURNS trigger AS $$
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
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "Dispatch_guard" BEFORE INSERT OR UPDATE ON "Dispatch"
  FOR EACH ROW EXECUTE FUNCTION "dispatch_guard"();

-- Candidates are a snapshot taken while the dispatch opens: inserted OFFERED only, then
-- OFFERED→CLAIMED→RELEASED. Provider, dispatch and offer time never change.
CREATE FUNCTION "dispatch_candidate_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'OFFERED' OR NOT EXISTS (
      SELECT 1 FROM "Dispatch" d WHERE d."id" = NEW."dispatchId" AND d."status" = 'OPEN'
    ) THEN
      RAISE EXCEPTION 'DISPATCH_CANDIDATE_INVALID: candidates are OFFERED on an OPEN dispatch';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."dispatchId" <> OLD."dispatchId" OR NEW."providerId" <> OLD."providerId"
    OR NEW."offeredAt" <> OLD."offeredAt" OR NEW."createdAt" <> OLD."createdAt"
  THEN
    RAISE EXCEPTION 'DISPATCH_CANDIDATE_IMMUTABLE: candidate identity cannot change';
  END IF;
  IF NEW."status" <> OLD."status" AND NOT (
    (OLD."status" = 'OFFERED' AND NEW."status" = 'CLAIMED')
    OR (OLD."status" = 'CLAIMED' AND NEW."status" = 'RELEASED')
  ) THEN
    RAISE EXCEPTION 'DISPATCH_CANDIDATE_IMMUTABLE: invalid status transition';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "DispatchCandidate_guard" BEFORE INSERT OR UPDATE ON "DispatchCandidate"
  FOR EACH ROW EXECUTE FUNCTION "dispatch_candidate_guard"();
