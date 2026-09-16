-- V1.6.1 user provisioning: invitations and account activation.
-- Incremental from V1.6.0. No existing row is rewritten: every current User keeps its passwordHash,
-- so active users stay ACTIVE and inactive users are reported as DISABLED.

-- CreateEnum
CREATE TYPE "UserInvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REVOKED');

-- AlterTable: an INVITED account has no password until its owner activates it.
ALTER TABLE "User" ALTER COLUMN "passwordHash" DROP NOT NULL;

-- CreateTable
CREATE TABLE "UserInvitation" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "providerId" UUID NOT NULL,
    "membershipRole" "ProviderMemberRole",
    "driverName" TEXT,
    "tokenHash" CHAR(64) NOT NULL,
    "status" "UserInvitationStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "tokenIssuedAt" TIMESTAMP(3) NOT NULL,
    "resendCount" INTEGER NOT NULL DEFAULT 0,
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedByUserId" UUID,
    "createdByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserInvitation_tokenHash_key" ON "UserInvitation"("tokenHash");

-- CreateIndex
CREATE INDEX "UserInvitation_userId_createdAt_idx" ON "UserInvitation"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "UserInvitation_providerId_role_status_createdAt_idx" ON "UserInvitation"("providerId", "role", "status", "createdAt");

-- CreateIndex
CREATE INDEX "UserInvitation_status_expiresAt_idx" ON "UserInvitation"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "UserInvitation_createdAt_id_idx" ON "UserInvitation"("createdAt", "id");

-- AddForeignKey
ALTER TABLE "UserInvitation" ADD CONSTRAINT "UserInvitation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserInvitation" ADD CONSTRAINT "UserInvitation_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "DeliveryProvider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserInvitation" ADD CONSTRAINT "UserInvitation_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserInvitation" ADD CONSTRAINT "UserInvitation_revokedByUserId_fkey" FOREIGN KEY ("revokedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- V1.6.1 invariants not expressible in schema.prisma (keep in sync with services/DTOs).

-- An account that can log in always has a password; only INVITED accounts lack one.
ALTER TABLE "User" ADD CONSTRAINT "User_active_password_check"
  CHECK (NOT "active" OR "passwordHash" IS NOT NULL);

-- Only one valid (PENDING) invitation per account, whatever its expiry.
CREATE UNIQUE INDEX "UserInvitation_pending_user_key"
  ON "UserInvitation"("userId") WHERE "status" = 'PENDING';

ALTER TABLE "UserInvitation" ADD CONSTRAINT "UserInvitation_values_check"
  CHECK (
    "email" = lower("email") AND char_length("email") BETWEEN 3 AND 254
    AND "tokenHash" ~ '^[0-9a-f]{64}$'
    AND "resendCount" >= 0
    AND "expiresAt" > "tokenIssuedAt"
    AND (
      ("role" = 'PROVIDER_ADMIN' AND "membershipRole" IS NOT NULL AND "driverName" IS NULL)
      OR ("role" = 'DRIVER' AND "membershipRole" IS NULL
        AND "driverName" IS NOT NULL AND char_length(btrim("driverName")) BETWEEN 1 AND 100)
    )
    AND (
      ("status" = 'PENDING' AND "acceptedAt" IS NULL AND "revokedAt" IS NULL AND "revokedByUserId" IS NULL)
      OR ("status" = 'ACCEPTED' AND "acceptedAt" IS NOT NULL AND "revokedAt" IS NULL AND "revokedByUserId" IS NULL)
      OR ("status" = 'REVOKED' AND "revokedAt" IS NOT NULL AND "acceptedAt" IS NULL)
    )
  );

-- Who/what/where of an invitation never changes; only PENDING rows rotate their token, and
-- status only leaves PENDING (to ACCEPTED or REVOKED). Terminal invitations are frozen.
CREATE FUNCTION "user_invitation_immutable"() RETURNS trigger AS $$
BEGIN
  IF NEW."userId" <> OLD."userId" OR NEW."email" <> OLD."email" OR NEW."role" <> OLD."role"
    OR NEW."providerId" <> OLD."providerId"
    OR NEW."membershipRole" IS DISTINCT FROM OLD."membershipRole"
    OR NEW."driverName" IS DISTINCT FROM OLD."driverName"
    OR NEW."createdByUserId" <> OLD."createdByUserId" OR NEW."createdAt" <> OLD."createdAt"
  THEN
    RAISE EXCEPTION 'USER_INVITATION_IMMUTABLE: invitation target cannot change';
  END IF;
  IF OLD."status" <> 'PENDING' THEN
    RAISE EXCEPTION 'USER_INVITATION_IMMUTABLE: resolved invitations cannot change';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "UserInvitation_immutable" BEFORE UPDATE ON "UserInvitation"
  FOR EACH ROW EXECUTE FUNCTION "user_invitation_immutable"();
