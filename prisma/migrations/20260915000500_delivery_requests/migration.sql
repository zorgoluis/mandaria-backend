-- CreateEnum
CREATE TYPE "DeliveryRequestStatus" AS ENUM ('CREATED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DeliveryStopType" AS ENUM ('PICKUP', 'DROPOFF');

-- CreateEnum
CREATE TYPE "PackageCategory" AS ENUM ('FOOD', 'GROCERIES', 'MEDICINE', 'DOCUMENT', 'PARCEL', 'MERCHANDISE', 'OTHER');

-- CreateEnum
CREATE TYPE "GoodsPaymentMode" AS ENUM ('PREPAID', 'COURIER_ADVANCE');

-- CreateTable
CREATE TABLE "DeliveryRequest" (
    "id" UUID NOT NULL,
    "publicId" TEXT NOT NULL,
    "integrationClientId" UUID NOT NULL,
    "externalReference" TEXT,
    "status" "DeliveryRequestStatus" NOT NULL DEFAULT 'CREATED',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelledAt" TIMESTAMP(3),
    "cancellationReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeliveryRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryStop" (
    "id" UUID NOT NULL,
    "deliveryRequestId" UUID NOT NULL,
    "type" "DeliveryStopType" NOT NULL,
    "sequence" INTEGER NOT NULL,
    "address" TEXT NOT NULL,
    "latitude" DECIMAL(9,6) NOT NULL,
    "longitude" DECIMAL(9,6) NOT NULL,
    "contactName" TEXT NOT NULL,
    "contactPhone" TEXT NOT NULL,
    "instructions" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeliveryStop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryPackage" (
    "id" UUID NOT NULL,
    "deliveryRequestId" UUID NOT NULL,
    "category" "PackageCategory" NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "weightKg" DECIMAL(10,3),
    "lengthCm" DECIMAL(8,2),
    "widthCm" DECIMAL(8,2),
    "heightCm" DECIMAL(8,2),
    "isFragile" BOOLEAN NOT NULL DEFAULT false,
    "handlingInstructions" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeliveryPackage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryFinancialContext" (
    "id" UUID NOT NULL,
    "deliveryRequestId" UUID NOT NULL,
    "goodsValue" DECIMAL(14,2),
    "goodsPaymentMode" "GoodsPaymentMode" NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeliveryFinancialContext_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiIdempotencyRecord" (
    "id" UUID NOT NULL,
    "integrationClientId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "requestHash" CHAR(64) NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiIdempotencyRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryRequest_publicId_key" ON "DeliveryRequest"("publicId");

-- CreateIndex
CREATE INDEX "DeliveryRequest_integrationClientId_requestedAt_id_idx" ON "DeliveryRequest"("integrationClientId", "requestedAt", "id");

-- CreateIndex
CREATE INDEX "DeliveryRequest_externalReference_idx" ON "DeliveryRequest"("externalReference");

-- CreateIndex
CREATE INDEX "DeliveryRequest_status_requestedAt_idx" ON "DeliveryRequest"("status", "requestedAt");

-- CreateIndex
CREATE INDEX "DeliveryRequest_requestedAt_id_idx" ON "DeliveryRequest"("requestedAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryStop_deliveryRequestId_sequence_key" ON "DeliveryStop"("deliveryRequestId", "sequence");

-- CreateIndex
CREATE INDEX "DeliveryPackage_deliveryRequestId_idx" ON "DeliveryPackage"("deliveryRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryFinancialContext_deliveryRequestId_key" ON "DeliveryFinancialContext"("deliveryRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "ApiIdempotencyRecord_integrationClientId_key_key" ON "ApiIdempotencyRecord"("integrationClientId", "key");

-- AddForeignKey
ALTER TABLE "DeliveryRequest" ADD CONSTRAINT "DeliveryRequest_integrationClientId_fkey" FOREIGN KEY ("integrationClientId") REFERENCES "IntegrationClient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryStop" ADD CONSTRAINT "DeliveryStop_deliveryRequestId_fkey" FOREIGN KEY ("deliveryRequestId") REFERENCES "DeliveryRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryPackage" ADD CONSTRAINT "DeliveryPackage_deliveryRequestId_fkey" FOREIGN KEY ("deliveryRequestId") REFERENCES "DeliveryRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryFinancialContext" ADD CONSTRAINT "DeliveryFinancialContext_deliveryRequestId_fkey" FOREIGN KEY ("deliveryRequestId") REFERENCES "DeliveryRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiIdempotencyRecord" ADD CONSTRAINT "ApiIdempotencyRecord_integrationClientId_fkey" FOREIGN KEY ("integrationClientId") REFERENCES "IntegrationClient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- V1.5 invariants not expressible in schema.prisma (keep in sync with DTO/service validation).
-- Global operational identifier source: nextval is concurrency-safe (gaps allowed, never reused).
CREATE SEQUENCE "DeliveryRequest_publicId_seq" AS BIGINT START WITH 1 INCREMENT BY 1 NO CYCLE;

ALTER TABLE "DeliveryRequest" ADD CONSTRAINT "DeliveryRequest_publicId_check"
  CHECK ("publicId" ~ '^MDR-[0-9]{6,}$');
ALTER TABLE "DeliveryRequest" ADD CONSTRAINT "DeliveryRequest_cancellation_check"
  CHECK (
    ("status" = 'CREATED' AND "cancelledAt" IS NULL AND "cancellationReason" IS NULL)
    OR ("status" = 'CANCELLED' AND "cancelledAt" IS NOT NULL AND "cancellationReason" IS NOT NULL)
  );
ALTER TABLE "DeliveryStop" ADD CONSTRAINT "DeliveryStop_values_check"
  CHECK (
    "sequence" >= 1
    AND "latitude" BETWEEN -90 AND 90
    AND "longitude" BETWEEN -180 AND 180
    AND char_length(btrim("address")) > 0
    AND char_length(btrim("contactName")) > 0
    AND char_length(btrim("contactPhone")) > 0
  );
ALTER TABLE "DeliveryPackage" ADD CONSTRAINT "DeliveryPackage_values_check"
  CHECK (
    "quantity" >= 1
    AND char_length(btrim("description")) > 0
    AND ("weightKg" IS NULL OR "weightKg" > 0)
    AND ("lengthCm" IS NULL OR "lengthCm" > 0)
    AND ("widthCm" IS NULL OR "widthCm" > 0)
    AND ("heightCm" IS NULL OR "heightCm" > 0)
  );
ALTER TABLE "DeliveryFinancialContext" ADD CONSTRAINT "DeliveryFinancialContext_goods_check"
  CHECK (
    "currency" ~ '^[A-Z]{3}$'
    AND ("goodsValue" IS NULL OR "goodsValue" > 0)
    AND ("goodsPaymentMode" <> 'COURIER_ADVANCE' OR "goodsValue" IS NOT NULL)
  );
ALTER TABLE "ApiIdempotencyRecord" ADD CONSTRAINT "ApiIdempotencyRecord_hash_check"
  CHECK ("requestHash" ~ '^[0-9a-f]{64}$' AND char_length("key") BETWEEN 8 AND 255);
