-- CreateEnum
CREATE TYPE "ServiceType" AS ENUM ('LOCAL_DELIVERY');

-- CreateEnum
CREATE TYPE "ServiceZoneStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "RatePlanStatus" AS ENUM ('DRAFT', 'ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "RateCalculationType" AS ENUM ('DISTANCE_BANDS');

-- CreateEnum
CREATE TYPE "DeliveryQuoteStatus" AS ENUM ('OFFERED', 'ACCEPTED', 'EXPIRED', 'CANCELLED');

-- AlterTable
ALTER TABLE "DeliveryRequest" ADD COLUMN     "serviceType" "ServiceType" NOT NULL DEFAULT 'LOCAL_DELIVERY';

-- CreateTable
CREATE TABLE "ServiceZone" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "ServiceZoneStatus" NOT NULL DEFAULT 'INACTIVE',
    "currency" CHAR(3) NOT NULL,
    "boundary" JSONB NOT NULL,
    "minLatitude" DECIMAL(9,6) NOT NULL,
    "maxLatitude" DECIMAL(9,6) NOT NULL,
    "minLongitude" DECIMAL(9,6) NOT NULL,
    "maxLongitude" DECIMAL(9,6) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceZone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RatePlan" (
    "id" UUID NOT NULL,
    "serviceZoneId" UUID NOT NULL,
    "serviceType" "ServiceType" NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "RatePlanStatus" NOT NULL DEFAULT 'DRAFT',
    "calculationType" "RateCalculationType" NOT NULL DEFAULT 'DISTANCE_BANDS',
    "quoteValidityMinutes" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "activatedAt" TIMESTAMP(3),
    "deactivatedAt" TIMESTAMP(3),

    CONSTRAINT "RatePlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RateBand" (
    "id" UUID NOT NULL,
    "ratePlanId" UUID NOT NULL,
    "minDistanceMeters" INTEGER NOT NULL,
    "maxDistanceMeters" INTEGER NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateBand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryQuote" (
    "id" UUID NOT NULL,
    "publicId" TEXT NOT NULL,
    "deliveryRequestId" UUID NOT NULL,
    "serviceType" "ServiceType" NOT NULL,
    "serviceZoneId" UUID NOT NULL,
    "ratePlanId" UUID NOT NULL,
    "rateBandId" UUID NOT NULL,
    "distanceMeters" INTEGER NOT NULL,
    "durationSeconds" INTEGER NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "routingProvider" TEXT NOT NULL,
    "routeCalculatedAt" TIMESTAMP(3) NOT NULL,
    "status" "DeliveryQuoteStatus" NOT NULL DEFAULT 'OFFERED',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "expiredAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancellationReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeliveryQuote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ServiceZone_code_key" ON "ServiceZone"("code");

-- CreateIndex
CREATE INDEX "ServiceZone_status_minLatitude_maxLatitude_minLongitude_max_idx" ON "ServiceZone"("status", "minLatitude", "maxLatitude", "minLongitude", "maxLongitude");

-- CreateIndex
CREATE INDEX "RatePlan_serviceZoneId_serviceType_status_idx" ON "RatePlan"("serviceZoneId", "serviceType", "status");

-- CreateIndex
CREATE UNIQUE INDEX "RatePlan_serviceZoneId_serviceType_version_key" ON "RatePlan"("serviceZoneId", "serviceType", "version");

-- CreateIndex
CREATE UNIQUE INDEX "RatePlan_id_serviceZoneId_key" ON "RatePlan"("id", "serviceZoneId");

-- CreateIndex
CREATE UNIQUE INDEX "RateBand_ratePlanId_minDistanceMeters_key" ON "RateBand"("ratePlanId", "minDistanceMeters");

-- CreateIndex
CREATE UNIQUE INDEX "RateBand_id_ratePlanId_key" ON "RateBand"("id", "ratePlanId");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryQuote_publicId_key" ON "DeliveryQuote"("publicId");

-- CreateIndex
CREATE INDEX "DeliveryQuote_deliveryRequestId_createdAt_idx" ON "DeliveryQuote"("deliveryRequestId", "createdAt");

-- CreateIndex
CREATE INDEX "DeliveryQuote_status_expiresAt_idx" ON "DeliveryQuote"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "DeliveryQuote_createdAt_id_idx" ON "DeliveryQuote"("createdAt", "id");

-- CreateIndex
CREATE INDEX "DeliveryQuote_serviceZoneId_createdAt_idx" ON "DeliveryQuote"("serviceZoneId", "createdAt");

-- AddForeignKey
ALTER TABLE "RatePlan" ADD CONSTRAINT "RatePlan_serviceZoneId_fkey" FOREIGN KEY ("serviceZoneId") REFERENCES "ServiceZone"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RateBand" ADD CONSTRAINT "RateBand_ratePlanId_fkey" FOREIGN KEY ("ratePlanId") REFERENCES "RatePlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryQuote" ADD CONSTRAINT "DeliveryQuote_deliveryRequestId_fkey" FOREIGN KEY ("deliveryRequestId") REFERENCES "DeliveryRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryQuote" ADD CONSTRAINT "DeliveryQuote_serviceZoneId_fkey" FOREIGN KEY ("serviceZoneId") REFERENCES "ServiceZone"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryQuote" ADD CONSTRAINT "DeliveryQuote_ratePlanId_serviceZoneId_fkey" FOREIGN KEY ("ratePlanId", "serviceZoneId") REFERENCES "RatePlan"("id", "serviceZoneId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryQuote" ADD CONSTRAINT "DeliveryQuote_rateBandId_ratePlanId_fkey" FOREIGN KEY ("rateBandId", "ratePlanId") REFERENCES "RateBand"("id", "ratePlanId") ON DELETE RESTRICT ON UPDATE CASCADE;


-- V1.6 invariants not expressible in schema.prisma (keep in sync with services/DTOs).
CREATE SEQUENCE "DeliveryQuote_publicId_seq" AS BIGINT START WITH 1 INCREMENT BY 1 NO CYCLE;

-- At most one ACTIVE rate plan per zone + service type; one OFFERED and one ACCEPTED quote per request.
CREATE UNIQUE INDEX "RatePlan_active_zone_service_key"
  ON "RatePlan"("serviceZoneId", "serviceType") WHERE "status" = 'ACTIVE';
CREATE UNIQUE INDEX "DeliveryQuote_offered_request_key"
  ON "DeliveryQuote"("deliveryRequestId") WHERE "status" = 'OFFERED';
CREATE UNIQUE INDEX "DeliveryQuote_accepted_request_key"
  ON "DeliveryQuote"("deliveryRequestId") WHERE "status" = 'ACCEPTED';

ALTER TABLE "ServiceZone" ADD CONSTRAINT "ServiceZone_values_check"
  CHECK (
    "code" ~ '^[A-Z][A-Z0-9_]{1,49}$'
    AND char_length(btrim("name")) BETWEEN 1 AND 100
    AND "currency" ~ '^[A-Z]{3}$'
    AND "minLatitude" BETWEEN -90 AND 90 AND "maxLatitude" BETWEEN -90 AND 90
    AND "minLongitude" BETWEEN -180 AND 180 AND "maxLongitude" BETWEEN -180 AND 180
    AND "minLatitude" < "maxLatitude" AND "minLongitude" < "maxLongitude"
  );
ALTER TABLE "RatePlan" ADD CONSTRAINT "RatePlan_values_check"
  CHECK (
    "version" >= 1
    AND "quoteValidityMinutes" BETWEEN 1 AND 10080
    AND "currency" ~ '^[A-Z]{3}$'
    AND (
      ("status" = 'DRAFT' AND "activatedAt" IS NULL AND "deactivatedAt" IS NULL)
      OR ("status" = 'ACTIVE' AND "activatedAt" IS NOT NULL AND "deactivatedAt" IS NULL)
      OR ("status" = 'INACTIVE' AND "activatedAt" IS NOT NULL AND "deactivatedAt" IS NOT NULL)
    )
  );
ALTER TABLE "RateBand" ADD CONSTRAINT "RateBand_values_check"
  CHECK (
    "minDistanceMeters" >= 0
    AND "maxDistanceMeters" > "minDistanceMeters"
    AND "amount" > 0
    AND "currency" ~ '^[A-Z]{3}$'
  );
ALTER TABLE "DeliveryQuote" ADD CONSTRAINT "DeliveryQuote_values_check"
  CHECK (
    "publicId" ~ '^MQ-[0-9]{6,}$'
    AND "distanceMeters" >= 0
    AND "durationSeconds" >= 0
    AND "amount" > 0
    AND "currency" ~ '^[A-Z]{3}$'
    AND "expiresAt" > "createdAt"
    AND ("status" <> 'ACCEPTED' OR "acceptedAt" IS NOT NULL)
    AND ("status" <> 'EXPIRED' OR "expiredAt" IS NOT NULL)
    AND ("status" <> 'CANCELLED' OR "cancelledAt" IS NOT NULL)
  );

-- Historical immutability: bands only change while their plan is DRAFT; non-DRAFT plans keep
-- their structure and only move DRAFT -> ACTIVE -> INACTIVE.
CREATE FUNCTION "rate_band_draft_only"() RETURNS trigger AS $$
DECLARE plan_status "RatePlanStatus";
BEGIN
  SELECT "status" INTO plan_status FROM "RatePlan" WHERE "id" = NEW."ratePlanId";
  IF plan_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'RATE_PLAN_IMMUTABLE: bands can only change on DRAFT plans';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."ratePlanId" <> OLD."ratePlanId" THEN
    RAISE EXCEPTION 'RATE_PLAN_IMMUTABLE: bands cannot move between plans';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "RateBand_draft_only" BEFORE INSERT OR UPDATE ON "RateBand"
  FOR EACH ROW EXECUTE FUNCTION "rate_band_draft_only"();

CREATE FUNCTION "rate_plan_immutable"() RETURNS trigger AS $$
BEGIN
  IF OLD."status" <> 'DRAFT' AND (
    NEW."serviceZoneId" <> OLD."serviceZoneId" OR NEW."serviceType" <> OLD."serviceType"
    OR NEW."version" <> OLD."version" OR NEW."calculationType" <> OLD."calculationType"
    OR NEW."quoteValidityMinutes" <> OLD."quoteValidityMinutes" OR NEW."currency" <> OLD."currency"
    OR NEW."activatedAt" IS DISTINCT FROM OLD."activatedAt"
  ) THEN
    RAISE EXCEPTION 'RATE_PLAN_IMMUTABLE: non-DRAFT plans cannot change structurally';
  END IF;
  IF NEW."status" <> OLD."status" AND NOT (
    (OLD."status" = 'DRAFT' AND NEW."status" = 'ACTIVE')
    OR (OLD."status" = 'ACTIVE' AND NEW."status" = 'INACTIVE')
  ) THEN
    RAISE EXCEPTION 'RATE_PLAN_IMMUTABLE: invalid status transition';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "RatePlan_immutable" BEFORE UPDATE ON "RatePlan"
  FOR EACH ROW EXECUTE FUNCTION "rate_plan_immutable"();

-- Quote snapshot never changes; status only leaves OFFERED.
CREATE FUNCTION "delivery_quote_immutable"() RETURNS trigger AS $$
BEGIN
  IF NEW."publicId" <> OLD."publicId" OR NEW."deliveryRequestId" <> OLD."deliveryRequestId"
    OR NEW."serviceType" <> OLD."serviceType" OR NEW."serviceZoneId" <> OLD."serviceZoneId"
    OR NEW."ratePlanId" <> OLD."ratePlanId" OR NEW."rateBandId" <> OLD."rateBandId"
    OR NEW."distanceMeters" <> OLD."distanceMeters" OR NEW."durationSeconds" <> OLD."durationSeconds"
    OR NEW."amount" <> OLD."amount" OR NEW."currency" <> OLD."currency"
    OR NEW."routingProvider" <> OLD."routingProvider" OR NEW."routeCalculatedAt" <> OLD."routeCalculatedAt"
    OR NEW."expiresAt" <> OLD."expiresAt" OR NEW."createdAt" <> OLD."createdAt"
  THEN
    RAISE EXCEPTION 'DELIVERY_QUOTE_IMMUTABLE: quote snapshot cannot change';
  END IF;
  IF NEW."status" <> OLD."status" AND OLD."status" <> 'OFFERED' THEN
    RAISE EXCEPTION 'DELIVERY_QUOTE_IMMUTABLE: invalid status transition';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "DeliveryQuote_immutable" BEFORE UPDATE ON "DeliveryQuote"
  FOR EACH ROW EXECUTE FUNCTION "delivery_quote_immutable"();
