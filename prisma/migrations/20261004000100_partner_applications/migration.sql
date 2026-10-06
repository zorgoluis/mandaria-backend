-- Partner applications (Fase 1): public landing leads reviewed by SUPER_ADMIN.
-- Incremental: no existing table, row or flow is modified.
-- CreateEnum
CREATE TYPE "PartnerApplicationType" AS ENUM ('INDIVIDUAL', 'FLEET');

-- CreateEnum
CREATE TYPE "PartnerApplicationStatus" AS ENUM ('RECEIVED', 'CONTACTED', 'APPROVED', 'REJECTED', 'DISCARDED');

-- CreateTable
CREATE TABLE "PartnerApplication" (
    "id" UUID NOT NULL,
    "publicId" TEXT NOT NULL,
    "type" "PartnerApplicationType" NOT NULL,
    "status" "PartnerApplicationStatus" NOT NULL DEFAULT 'RECEIVED',
    "contactName" VARCHAR(100) NOT NULL,
    "phone" CHAR(10) NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "city" VARCHAR(80) NOT NULL,
    "vehicleType" "VehicleType" NOT NULL,
    "fleetName" VARCHAR(100),
    "fleetUnits" INTEGER,
    "privacyNoticeVersion" VARCHAR(20) NOT NULL,
    "privacyAcceptedAt" TIMESTAMP(3) NOT NULL,
    "source" VARCHAR(20) NOT NULL DEFAULT 'LANDING',
    "submissionCount" INTEGER NOT NULL DEFAULT 1,
    "lastSubmittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewNote" VARCHAR(500),
    "statusChangedAt" TIMESTAMP(3),
    "statusChangedByUserId" UUID,
    "providerId" UUID,
    "invitationId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PartnerApplication_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PartnerApplication_publicId_key" ON "PartnerApplication"("publicId");

-- CreateIndex
CREATE INDEX "PartnerApplication_status_createdAt_idx" ON "PartnerApplication"("status", "createdAt");

-- CreateIndex
CREATE INDEX "PartnerApplication_phone_idx" ON "PartnerApplication"("phone");

-- CreateIndex
CREATE INDEX "PartnerApplication_email_idx" ON "PartnerApplication"("email");

-- CreateIndex
CREATE INDEX "PartnerApplication_createdAt_id_idx" ON "PartnerApplication"("createdAt", "id");

-- AddForeignKey
ALTER TABLE "PartnerApplication" ADD CONSTRAINT "PartnerApplication_statusChangedByUserId_fkey" FOREIGN KEY ("statusChangedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnerApplication" ADD CONSTRAINT "PartnerApplication_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "DeliveryProvider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnerApplication" ADD CONSTRAINT "PartnerApplication_invitationId_fkey" FOREIGN KEY ("invitationId") REFERENCES "UserInvitation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- SOC-000001 references come from a dedicated sequence read inside the creating transaction.
CREATE SEQUENCE "PartnerApplication_publicId_seq" AS BIGINT START WITH 1 INCREMENT BY 1 NO CYCLE;

-- Fleet fields are present only, and always, with FLEET.
ALTER TABLE "PartnerApplication" ADD CONSTRAINT "PartnerApplication_fleet_check" CHECK (
  ("type" = 'FLEET' AND "fleetName" IS NOT NULL AND "fleetUnits" IS NOT NULL
    AND "fleetUnits" BETWEEN 2 AND 10000 AND char_length(btrim("fleetName")) BETWEEN 2 AND 100)
  OR ("type" = 'INDIVIDUAL' AND "fleetName" IS NULL AND "fleetUnits" IS NULL)
);

ALTER TABLE "PartnerApplication" ADD CONSTRAINT "PartnerApplication_values_check" CHECK (
  "publicId" ~ '^SOC-[0-9]{6,}$'
  AND "phone" ~ '^[0-9]{10}$'
  AND "email" = lower("email") AND position('@' in "email") > 1
  AND char_length(btrim("contactName")) BETWEEN 2 AND 100
  AND char_length(btrim("city")) BETWEEN 2 AND 80
  AND char_length(btrim("privacyNoticeVersion")) BETWEEN 1 AND 20
  AND "source" = 'LANDING'
  AND "submissionCount" >= 1
  AND "lastSubmittedAt" >= "createdAt"
  AND ("reviewNote" IS NULL OR char_length(btrim("reviewNote")) BETWEEN 1 AND 500)
);

-- Links are recorded only once approved (they survive a later APPROVED -> REJECTED), and an
-- approval always carries a note or a link.
ALTER TABLE "PartnerApplication" ADD CONSTRAINT "PartnerApplication_review_check" CHECK (
  (("providerId" IS NULL AND "invitationId" IS NULL) OR "status" IN ('APPROVED', 'REJECTED'))
  AND ("status" <> 'APPROVED' OR "reviewNote" IS NOT NULL OR "providerId" IS NOT NULL OR "invitationId" IS NOT NULL)
  AND (("statusChangedAt" IS NULL) = ("statusChangedByUserId" IS NULL))
  AND ("status" = 'RECEIVED' OR "statusChangedAt" IS NOT NULL)
);
