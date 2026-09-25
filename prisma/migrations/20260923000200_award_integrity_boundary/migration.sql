-- Corrective migration: preserve prior migrations and financial history.
BEGIN;
-- Historical exemptions name an award (actor + time), never a whole future Dispatch.
CREATE TABLE "DispatchPreEnforcementAward" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "dispatchId" UUID NOT NULL,
  "actorType" "CreditAccountOwnerType" NOT NULL,
  "actorId" UUID NOT NULL,
  "awardedAt" TIMESTAMP(3) NOT NULL,
  "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DispatchPreEnforcementAward_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DispatchPreEnforcementAward_dispatchId_fkey" FOREIGN KEY ("dispatchId") REFERENCES "Dispatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "DispatchPreEnforcementAward_identity_key"
 ON "DispatchPreEnforcementAward" ("dispatchId", "actorType", "actorId", "awardedAt");

-- One-time classification includes released/cancelled historical awards. No financial writes.
INSERT INTO "DispatchPreEnforcementAward" ("dispatchId", "actorType", "actorId", "awardedAt")
SELECT c."dispatchId", 'PROVIDER', c."providerId", c."claimedAt"
FROM "DispatchCandidate" c JOIN "Dispatch" d ON d.id = c."dispatchId"
WHERE d."creditMode" = 'MONETIZED' AND c."claimedAt" IS NOT NULL
 AND EXISTS (SELECT 1 FROM "DispatchCreditSnapshot" s WHERE s."dispatchId" = d.id AND s."actorType" = 'PROVIDER')
 AND NOT EXISTS (SELECT 1 FROM "CreditLedgerEntry" l JOIN "CreditAccount" a ON a.id = l."creditAccountId"
   WHERE l.type = 'SERVICE_AWARD' AND l."referenceId" = d.id AND a."providerId" = c."providerId");
INSERT INTO "DispatchPreEnforcementAward" ("dispatchId", "actorType", "actorId", "awardedAt")
SELECT DISTINCT x."dispatchId", 'INDEPENDENT_DRIVER'::"CreditAccountOwnerType", x."driverId", x."assignedAt"
FROM "DeliveryAssignment" x JOIN "Dispatch" d ON d.id = x."dispatchId"
WHERE d."creditMode" = 'MONETIZED' AND x.mode = 'INDEPENDENT'
 AND EXISTS (SELECT 1 FROM "DispatchCreditSnapshot" s WHERE s."dispatchId" = d.id AND s."actorType" = 'INDEPENDENT_DRIVER')
 AND NOT EXISTS (SELECT 1 FROM "CreditLedgerEntry" l JOIN "CreditAccount" a ON a.id = l."creditAccountId"
   WHERE l.type = 'SERVICE_AWARD' AND l."referenceId" = d.id AND a."independentDriverProfileId" = x."independentDriverProfileId");

CREATE FUNCTION "pre_enforcement_award_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND "credit_history_purge_allowed"() THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'CREDIT_HISTORY_IMMUTABLE: historical exemptions are migration-only';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "DispatchPreEnforcementAward_guard" BEFORE INSERT OR UPDATE OR DELETE ON "DispatchPreEnforcementAward"
 FOR EACH ROW EXECUTE FUNCTION "pre_enforcement_award_guard"();

-- Resolve all durable operational awards, including released/cancelled ones.
CREATE VIEW "dispatch_operational_awards" AS
 SELECT c."dispatchId", 'PROVIDER'::"CreditAccountOwnerType" AS "actorType", c."providerId" AS "actorId", c."claimedAt" AS "awardedAt"
 FROM "DispatchCandidate" c WHERE c."claimedAt" IS NOT NULL
 UNION ALL
 SELECT x."dispatchId", 'INDEPENDENT_DRIVER'::"CreditAccountOwnerType", x."driverId", x."assignedAt"
 FROM "DeliveryAssignment" x WHERE x.mode = 'INDEPENDENT';

-- The API already forbids an independent driver taking the same Dispatch again after release.
-- Persist that rule so a second operational award cannot reuse the first award's debit in SQL.
CREATE UNIQUE INDEX "DeliveryAssignment_independent_award_key"
 ON "DeliveryAssignment" ("dispatchId", "driverId") WHERE mode = 'INDEPENDENT';

CREATE FUNCTION "assert_dispatch_award_integrity"(target UUID) RETURNS VOID AS $$
BEGIN
  -- Exemptions are explicit, immutable history. Missing snapshots never grant an exemption.
  IF EXISTS (
    SELECT 1 FROM "dispatch_operational_awards" o JOIN "Dispatch" d ON d.id = o."dispatchId"
    WHERE d.id = target AND d."creditMode" = 'MONETIZED'
    AND NOT EXISTS (SELECT 1 FROM "DispatchPreEnforcementAward" h WHERE h."dispatchId" = o."dispatchId"
      AND h."actorType" = o."actorType" AND h."actorId" = o."actorId" AND h."awardedAt" = o."awardedAt")
    AND (SELECT count(*) FROM "CreditLedgerEntry" l
      JOIN "CreditAccount" a ON a.id = l."creditAccountId"
      JOIN "DispatchCreditSnapshot" s ON s."dispatchId" = target AND s."actorType" = o."actorType"
      LEFT JOIN "IndependentDriverProfile" p ON p.id = a."independentDriverProfileId"
      WHERE l.type = 'SERVICE_AWARD' AND l."referenceId" = target AND l.amount = -s.credits
        AND a."ownerType" = o."actorType"
        AND CASE WHEN o."actorType" = 'PROVIDER' THEN a."providerId" ELSE p."driverId" END = o."actorId") <> 1
  ) THEN RAISE EXCEPTION 'CREDIT_AWARD_REQUIRED: operational award requires exactly one matching debit'; END IF;

  IF EXISTS (
    SELECT 1 FROM "CreditLedgerEntry" l JOIN "CreditAccount" a ON a.id = l."creditAccountId"
    LEFT JOIN "IndependentDriverProfile" p ON p.id = a."independentDriverProfileId"
    WHERE l.type = 'SERVICE_AWARD' AND l."referenceId" = target
    AND NOT EXISTS (
      SELECT 1 FROM "dispatch_operational_awards" o JOIN "Dispatch" d ON d.id = o."dispatchId"
      JOIN "DispatchCreditSnapshot" s ON s."dispatchId" = d.id AND s."actorType" = o."actorType"
      WHERE d.id = target AND d."creditMode" = 'MONETIZED' AND o."actorType" = a."ownerType"
        AND o."actorId" = CASE WHEN a."ownerType" = 'PROVIDER' THEN a."providerId" ELSE p."driverId" END
        AND l.amount = -s.credits
        AND NOT EXISTS (SELECT 1 FROM "DispatchPreEnforcementAward" h WHERE h."dispatchId" = target
          AND h."actorType" = o."actorType" AND h."actorId" = o."actorId" AND h."awardedAt" = o."awardedAt")
    )
  ) THEN RAISE EXCEPTION 'CREDIT_AWARD_ORPHAN: debit must match an enforced operational award and snapshot'; END IF;
END $$ LANGUAGE plpgsql;

CREATE FUNCTION "dispatch_award_integrity"() RETURNS trigger AS $$
DECLARE target UUID; actor "CreditAccountOwnerType"; actor_id UUID;
BEGIN
  IF "credit_history_purge_allowed"() THEN RETURN NULL; END IF;
  IF TG_TABLE_NAME = 'Dispatch' THEN
    target := COALESCE(NEW.id, OLD.id);
    -- Check the event, not only the final row: claim+release in one transaction still costs.
    IF TG_OP <> 'DELETE' AND NEW."creditMode" = 'MONETIZED' AND NEW."claimedAt" IS NOT NULL THEN
      actor := CASE WHEN NEW."claimedByProviderId" IS NOT NULL THEN 'PROVIDER'::"CreditAccountOwnerType" ELSE 'INDEPENDENT_DRIVER'::"CreditAccountOwnerType" END;
      actor_id := COALESCE(NEW."claimedByProviderId", NEW."claimedByIndependentDriverId");
      IF NOT EXISTS (SELECT 1 FROM "dispatch_operational_awards" o WHERE o."dispatchId" = target
        AND o."actorType" = actor AND o."actorId" = actor_id AND o."awardedAt" = NEW."claimedAt") THEN
        RAISE EXCEPTION 'CREDIT_AWARD_REQUIRED: winner must have durable candidate/assignment history';
      END IF;
      -- A new claim cannot reuse an old exemption, even by forging its timestamp.
      IF (TG_OP = 'INSERT' OR OLD."claimedAt" IS NULL OR OLD."claimedAt" IS DISTINCT FROM NEW."claimedAt"
          OR OLD."claimedByProviderId" IS DISTINCT FROM NEW."claimedByProviderId"
          OR OLD."claimedByIndependentDriverId" IS DISTINCT FROM NEW."claimedByIndependentDriverId")
        AND EXISTS (SELECT 1 FROM "DispatchPreEnforcementAward" h WHERE h."dispatchId" = target
          AND h."actorType" = actor AND h."actorId" = actor_id AND h."awardedAt" = NEW."claimedAt") THEN
        RAISE EXCEPTION 'CREDIT_HISTORY_IMMUTABLE: historical exemption cannot authorize a new award';
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'CreditLedgerEntry' THEN target := COALESCE(NEW."referenceId", OLD."referenceId");
  ELSE target := COALESCE(NEW."dispatchId", OLD."dispatchId"); END IF;
  PERFORM "assert_dispatch_award_integrity"(target);
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "Dispatch_award_integrity" AFTER INSERT OR UPDATE OR DELETE ON "Dispatch"
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "dispatch_award_integrity"();
CREATE CONSTRAINT TRIGGER "DispatchCandidate_award_integrity" AFTER INSERT OR UPDATE OR DELETE ON "DispatchCandidate"
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "dispatch_award_integrity"();
CREATE CONSTRAINT TRIGGER "DeliveryAssignment_award_integrity" AFTER INSERT OR UPDATE OR DELETE ON "DeliveryAssignment"
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "dispatch_award_integrity"();
CREATE CONSTRAINT TRIGGER "CreditLedgerEntry_award_integrity" AFTER INSERT OR UPDATE OR DELETE ON "CreditLedgerEntry"
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "dispatch_award_integrity"();
CREATE CONSTRAINT TRIGGER "DispatchCreditSnapshot_award_integrity" AFTER UPDATE OR DELETE ON "DispatchCreditSnapshot"
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "dispatch_award_integrity"();

-- Validate what was classified before completing deployment. No automatic repairs or debits.
DO $$ DECLARE d RECORD; BEGIN
 FOR d IN SELECT id FROM "Dispatch" LOOP PERFORM "assert_dispatch_award_integrity"(d.id); END LOOP;
END $$;
COMMIT;
