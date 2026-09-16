-- Preserve V1.0 clients and their state without recreating tables.
ALTER TYPE "IntegrationStatus" RENAME VALUE 'INACTIVE' TO 'SUSPENDED';
ALTER TYPE "IntegrationStatus" ADD VALUE 'REVOKED';

CREATE TYPE "CredentialStatus" AS ENUM ('ACTIVE', 'REVOKED');
ALTER TABLE "IntegrationCredential"
  ADD COLUMN "status" "CredentialStatus" NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "expiresAt" TIMESTAMP(3),
  ADD COLUMN "lastUsedAt" TIMESTAMP(3);

-- A previously revoked credential must never become active during upgrade.
UPDATE "IntegrationCredential" SET "status" = 'REVOKED' WHERE "revokedAt" IS NOT NULL;
