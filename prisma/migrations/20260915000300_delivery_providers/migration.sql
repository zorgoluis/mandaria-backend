CREATE TYPE "ProviderType" AS ENUM ('FLEET', 'INDEPENDENT');
CREATE TYPE "ProviderStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED');
CREATE TYPE "ProviderMemberRole" AS ENUM ('OWNER', 'ADMIN');

CREATE TABLE "DeliveryProvider" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "type" "ProviderType" NOT NULL,
    "status" "ProviderStatus" NOT NULL DEFAULT 'PENDING',
    "maxDrivers" INTEGER NOT NULL,
    "maxVehicles" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DeliveryProvider_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "DeliveryProvider_maxDrivers_check" CHECK ("maxDrivers" BETWEEN 1 AND 10000),
    CONSTRAINT "DeliveryProvider_maxVehicles_check" CHECK ("maxVehicles" BETWEEN 1 AND 10000)
);
CREATE TABLE "ProviderMembership" (
    "id" UUID NOT NULL,
    "providerId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "ProviderMemberRole" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ProviderMembership_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DeliveryProvider_code_key" ON "DeliveryProvider"("code");
CREATE INDEX "DeliveryProvider_type_status_idx" ON "DeliveryProvider"("type", "status");
CREATE INDEX "DeliveryProvider_createdAt_id_idx" ON "DeliveryProvider"("createdAt", "id");
CREATE UNIQUE INDEX "ProviderMembership_providerId_userId_key" ON "ProviderMembership"("providerId", "userId");
CREATE INDEX "ProviderMembership_userId_providerId_idx" ON "ProviderMembership"("userId", "providerId");
ALTER TABLE "ProviderMembership" ADD CONSTRAINT "ProviderMembership_providerId_fkey"
  FOREIGN KEY ("providerId") REFERENCES "DeliveryProvider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProviderMembership" ADD CONSTRAINT "ProviderMembership_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
