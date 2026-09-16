-- CreateEnum
CREATE TYPE "DriverStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "DriverAvailability" AS ENUM ('OFFLINE', 'AVAILABLE', 'BUSY');

-- CreateEnum
CREATE TYPE "VehicleType" AS ENUM ('BICYCLE', 'MOTORCYCLE', 'CAR', 'PICKUP', 'VAN', 'TRUCK', 'OTHER');

-- CreateEnum
CREATE TYPE "VehicleStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'MAINTENANCE', 'SUSPENDED');

-- CreateTable
CREATE TABLE "Driver" (
    "id" UUID NOT NULL,
    "providerId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" "DriverStatus" NOT NULL DEFAULT 'PENDING',
    "availability" "DriverAvailability" NOT NULL DEFAULT 'OFFLINE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Driver_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vehicle" (
    "id" UUID NOT NULL,
    "providerId" UUID NOT NULL,
    "identifier" TEXT NOT NULL,
    "type" "VehicleType" NOT NULL,
    "status" "VehicleStatus" NOT NULL DEFAULT 'ACTIVE',
    "brand" TEXT,
    "model" TEXT,
    "year" INTEGER,
    "color" TEXT,
    "plate" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Vehicle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DriverVehicleAssignment" (
    "id" UUID NOT NULL,
    "providerId" UUID NOT NULL,
    "driverId" UUID NOT NULL,
    "vehicleId" UUID NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unassignedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DriverVehicleAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Driver_userId_key" ON "Driver"("userId");

-- CreateIndex
CREATE INDEX "Driver_providerId_status_availability_idx" ON "Driver"("providerId", "status", "availability");

-- CreateIndex
CREATE INDEX "Driver_providerId_createdAt_id_idx" ON "Driver"("providerId", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Driver_id_providerId_key" ON "Driver"("id", "providerId");

-- CreateIndex
CREATE INDEX "Vehicle_providerId_type_status_idx" ON "Vehicle"("providerId", "type", "status");

-- CreateIndex
CREATE INDEX "Vehicle_providerId_createdAt_id_idx" ON "Vehicle"("providerId", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Vehicle_providerId_identifier_key" ON "Vehicle"("providerId", "identifier");

-- CreateIndex
CREATE UNIQUE INDEX "Vehicle_id_providerId_key" ON "Vehicle"("id", "providerId");

-- CreateIndex
CREATE INDEX "DriverVehicleAssignment_driverId_assignedAt_idx" ON "DriverVehicleAssignment"("driverId", "assignedAt");

-- CreateIndex
CREATE INDEX "DriverVehicleAssignment_vehicleId_assignedAt_idx" ON "DriverVehicleAssignment"("vehicleId", "assignedAt");

-- AddForeignKey
ALTER TABLE "Driver" ADD CONSTRAINT "Driver_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "DeliveryProvider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Driver" ADD CONSTRAINT "Driver_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "DeliveryProvider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverVehicleAssignment" ADD CONSTRAINT "DriverVehicleAssignment_driverId_providerId_fkey" FOREIGN KEY ("driverId", "providerId") REFERENCES "Driver"("id", "providerId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverVehicleAssignment" ADD CONSTRAINT "DriverVehicleAssignment_vehicleId_providerId_fkey" FOREIGN KEY ("vehicleId", "providerId") REFERENCES "Vehicle"("id", "providerId") ON DELETE RESTRICT ON UPDATE CASCADE;


-- V1.4 invariants not expressible in schema.prisma (keep in sync with DTO validation).
ALTER TABLE "Driver" ADD CONSTRAINT "Driver_name_check"
  CHECK (char_length(btrim("name")) BETWEEN 1 AND 100);
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_identifier_check"
  CHECK ("identifier" ~ '^[A-Z0-9][A-Z0-9_-]{0,29}$');
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_year_check"
  CHECK ("year" IS NULL OR "year" BETWEEN 1900 AND 2100);
ALTER TABLE "DriverVehicleAssignment" ADD CONSTRAINT "DriverVehicleAssignment_period_check"
  CHECK ("unassignedAt" IS NULL OR "unassignedAt" >= "assignedAt");

-- At most one active assignment per driver and per vehicle; closed rows are history.
CREATE UNIQUE INDEX "DriverVehicleAssignment_active_driver_key"
  ON "DriverVehicleAssignment"("driverId") WHERE "unassignedAt" IS NULL;
CREATE UNIQUE INDEX "DriverVehicleAssignment_active_vehicle_key"
  ON "DriverVehicleAssignment"("vehicleId") WHERE "unassignedAt" IS NULL;
