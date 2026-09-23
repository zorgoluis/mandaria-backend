-- V1.10-B Credit Policy Engine. Incremental from V1.10-A; no existing row is touched and no
-- policy is created here (initial policies are configuration: SUPER_ADMIN through the admin API,
-- or the LOCAL/TEST ONLY seed). Policies only calculate: claim/take still consume no credits.

-- CreateEnum
CREATE TYPE "CreditCalculationType" AS ENUM ('PER_KM', 'FLAT', 'DISTANCE_RANGE');

-- CreateEnum
CREATE TYPE "CreditPolicyStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateTable
CREATE TABLE "CreditPolicy" (
    "id" UUID NOT NULL,
    "serviceType" "ServiceType" NOT NULL,
    "actorType" "CreditAccountOwnerType" NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "CreditPolicyStatus" NOT NULL DEFAULT 'ACTIVE',
    "calculationType" "CreditCalculationType" NOT NULL,
    "creditsPerKm" INTEGER,
    "minimumCredits" INTEGER,
    "flatCredits" INTEGER,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveUntil" TIMESTAMP(3),
    "reason" TEXT,
    "createdByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditPolicyRange" (
    "id" UUID NOT NULL,
    "creditPolicyId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "minDistanceMeters" INTEGER NOT NULL,
    "maxDistanceMeters" INTEGER,
    "credits" INTEGER NOT NULL,

    CONSTRAINT "CreditPolicyRange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CreditPolicy_serviceType_actorType_status_idx" ON "CreditPolicy"("serviceType", "actorType", "status");

-- CreateIndex
CREATE INDEX "CreditPolicy_createdAt_id_idx" ON "CreditPolicy"("createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "CreditPolicy_serviceType_actorType_version_key" ON "CreditPolicy"("serviceType", "actorType", "version");

-- CreateIndex
CREATE UNIQUE INDEX "CreditPolicyRange_creditPolicyId_position_key" ON "CreditPolicyRange"("creditPolicyId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "CreditPolicyRange_creditPolicyId_minDistanceMeters_key" ON "CreditPolicyRange"("creditPolicyId", "minDistanceMeters");

-- AddForeignKey
ALTER TABLE "CreditPolicy" ADD CONSTRAINT "CreditPolicy_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditPolicyRange" ADD CONSTRAINT "CreditPolicyRange_creditPolicyId_fkey" FOREIGN KEY ("creditPolicyId") REFERENCES "CreditPolicy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- V1.10-B invariants not expressible in schema.prisma (keep in sync with credit-policy-engine.ts).
-- Credit values are whole credits bounded by the V1.10-A movement limit (1,000,000): a service
-- award is one ledger movement, so no single policy value or result may exceed it.

-- At most one ACTIVE policy per serviceType + actorType. A new version deactivates the previous
-- one before inserting itself, in the same transaction, so two ACTIVE rows never coexist.
CREATE UNIQUE INDEX "CreditPolicy_active_key"
  ON "CreditPolicy"("serviceType", "actorType") WHERE "status" = 'ACTIVE';

ALTER TABLE "CreditPolicy" ADD CONSTRAINT "CreditPolicy_values_check"
  CHECK (
    "version" > 0
    AND ("reason" IS NULL OR char_length(btrim("reason")) BETWEEN 3 AND 500)
    AND (
      ("status" = 'ACTIVE' AND "effectiveUntil" IS NULL)
      OR ("status" = 'INACTIVE' AND "effectiveUntil" IS NOT NULL AND "effectiveUntil" >= "effectiveFrom")
    )
  );
-- Exactly the columns of the calculation type are set; everything else is NULL. A PER_KM policy
-- with a flat price, or a FLAT one with a per-km rate, cannot exist. The IS NOT NULL tests are
-- required: a CHECK whose expression is NULL passes, so "NULL BETWEEN 1 AND ..." alone would let a
-- PER_KM policy without a rate through.
ALTER TABLE "CreditPolicy" ADD CONSTRAINT "CreditPolicy_calculation_check"
  CHECK (
    ("calculationType" = 'PER_KM'
      AND "creditsPerKm" IS NOT NULL AND "creditsPerKm" BETWEEN 1 AND 1000000
      AND "minimumCredits" IS NOT NULL AND "minimumCredits" BETWEEN 0 AND 1000000
      AND "flatCredits" IS NULL)
    OR ("calculationType" = 'FLAT'
      AND "flatCredits" IS NOT NULL AND "flatCredits" BETWEEN 1 AND 1000000
      AND "creditsPerKm" IS NULL AND "minimumCredits" IS NULL)
    OR ("calculationType" = 'DISTANCE_RANGE'
      AND "creditsPerKm" IS NULL AND "minimumCredits" IS NULL AND "flatCredits" IS NULL)
  );
ALTER TABLE "CreditPolicyRange" ADD CONSTRAINT "CreditPolicyRange_values_check"
  CHECK (
    "position" >= 1
    AND "minDistanceMeters" >= 0
    AND ("maxDistanceMeters" IS NULL OR "maxDistanceMeters" > "minDistanceMeters")
    AND "credits" BETWEEN 1 AND 1000000
  );

-- Same test-only switch as the credit ledger (20260921001200): DELETE of economic history is
-- only possible in a database whose name ends in _test, inside a transaction that sets
-- mandaria.ledger_purge = 'test-fixtures'. Everywhere else it is refused.
CREATE FUNCTION "credit_history_purge_allowed"() RETURNS boolean AS $$
  SELECT current_setting('mandaria.ledger_purge', true) = 'test-fixtures'
     AND right(current_database(), 5) = '_test';
$$ LANGUAGE sql STABLE;

-- A policy is born ACTIVE with the next version of its serviceType + actorType (max + 1: never
-- chosen by the client, never reused, never skipped). Afterwards its only possible change is being
-- superseded: ACTIVE -> INACTIVE with effectiveUntil. Economics, identity, author and dates of a
-- written version never change, and an INACTIVE version is never reactivated.
CREATE FUNCTION "credit_policy_guard"() RETURNS trigger AS $$
DECLARE expected INTEGER;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'ACTIVE' OR NEW."effectiveUntil" IS NOT NULL THEN
      RAISE EXCEPTION 'CREDIT_POLICY_INVALID: a policy version is created ACTIVE';
    END IF;
    SELECT coalesce(max("version"), 0) + 1 INTO expected FROM "CreditPolicy"
     WHERE "serviceType" = NEW."serviceType" AND "actorType" = NEW."actorType";
    IF NEW."version" <> expected THEN
      RAISE EXCEPTION 'CREDIT_POLICY_VERSION_INVALID: next version for this service and actor is %', expected;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF "credit_history_purge_allowed"() THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'CREDIT_POLICY_IMMUTABLE: credit policies are never deleted';
  END IF;
  IF OLD."status" = 'ACTIVE' AND NEW."status" = 'INACTIVE' AND NEW."effectiveUntil" IS NOT NULL
    AND NEW."id" = OLD."id" AND NEW."serviceType" = OLD."serviceType" AND NEW."actorType" = OLD."actorType"
    AND NEW."version" = OLD."version" AND NEW."calculationType" = OLD."calculationType"
    AND NEW."creditsPerKm" IS NOT DISTINCT FROM OLD."creditsPerKm"
    AND NEW."minimumCredits" IS NOT DISTINCT FROM OLD."minimumCredits"
    AND NEW."flatCredits" IS NOT DISTINCT FROM OLD."flatCredits"
    AND NEW."effectiveFrom" = OLD."effectiveFrom"
    AND NEW."reason" IS NOT DISTINCT FROM OLD."reason"
    AND NEW."createdByUserId" = OLD."createdByUserId" AND NEW."createdAt" = OLD."createdAt" THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'CREDIT_POLICY_IMMUTABLE: a policy version never changes; create a new version';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "CreditPolicy_guard" BEFORE INSERT OR UPDATE OR DELETE ON "CreditPolicy"
  FOR EACH ROW EXECUTE FUNCTION "credit_policy_guard"();

-- Ranges are written together with their policy and never changed or removed afterwards.
CREATE FUNCTION "credit_policy_range_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND "credit_history_purge_allowed"() THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'CREDIT_POLICY_IMMUTABLE: credit policy ranges cannot be % once written', lower(TG_OP);
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "CreditPolicyRange_guard" BEFORE UPDATE OR DELETE ON "CreditPolicyRange"
  FOR EACH ROW EXECUTE FUNCTION "credit_policy_range_guard"();

CREATE FUNCTION "credit_policy_no_truncate"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'CREDIT_POLICY_IMMUTABLE: credit policies cannot be truncated';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "CreditPolicy_no_truncate" BEFORE TRUNCATE ON "CreditPolicy"
  FOR EACH STATEMENT EXECUTE FUNCTION "credit_policy_no_truncate"();
CREATE TRIGGER "CreditPolicyRange_no_truncate" BEFORE TRUNCATE ON "CreditPolicyRange"
  FOR EACH STATEMENT EXECUTE FUNCTION "credit_policy_no_truncate"();

-- Checked at COMMIT (deferred), once the policy and all its ranges exist: a DISTANCE_RANGE policy
-- has positions 1..n, starts at 0, each range begins where the previous one ends ([min, max)),
-- and only the last one is open (max NULL), so every distance >= 0 matches exactly one range; any
-- other policy has no ranges. A range added later to a complete policy necessarily breaks this
-- chain, so the check also makes the set of ranges append-proof.
CREATE FUNCTION "credit_policy_ranges_check"() RETURNS trigger AS $$
DECLARE
  pid UUID;
  calc "CreditCalculationType";
  r RECORD;
  n INTEGER := 0;
  previous_max INTEGER;
  previous_open BOOLEAN := false;
BEGIN
  -- IF, not CASE: plpgsql only evaluates the branch it runs, and NEW of a CreditPolicy row has no
  -- "creditPolicyId" field (a CASE referencing it fails for every policy insert).
  IF TG_TABLE_NAME = 'CreditPolicy' THEN
    pid := NEW."id";
  ELSE
    pid := NEW."creditPolicyId";
  END IF;
  SELECT "calculationType" INTO calc FROM "CreditPolicy" WHERE "id" = pid;
  IF NOT FOUND THEN RETURN NULL; END IF;
  FOR r IN SELECT "position", "minDistanceMeters", "maxDistanceMeters"
             FROM "CreditPolicyRange" WHERE "creditPolicyId" = pid ORDER BY "position" LOOP
    n := n + 1;
    IF calc <> 'DISTANCE_RANGE' THEN
      RAISE EXCEPTION 'CREDIT_POLICY_RANGES_INVALID: only DISTANCE_RANGE policies have ranges';
    END IF;
    IF r."position" <> n THEN
      RAISE EXCEPTION 'CREDIT_POLICY_RANGES_INVALID: range positions must be 1..n without gaps';
    END IF;
    IF previous_open THEN
      RAISE EXCEPTION 'CREDIT_POLICY_RANGES_INVALID: only the last range may be open-ended';
    END IF;
    IF n = 1 AND r."minDistanceMeters" <> 0 THEN
      RAISE EXCEPTION 'CREDIT_POLICY_RANGES_INVALID: the first range must start at 0 meters';
    END IF;
    IF n > 1 AND r."minDistanceMeters" <> previous_max THEN
      RAISE EXCEPTION 'CREDIT_POLICY_RANGES_INVALID: ranges must be contiguous (gap or overlap at % meters)', r."minDistanceMeters";
    END IF;
    previous_max := r."maxDistanceMeters";
    previous_open := r."maxDistanceMeters" IS NULL;
  END LOOP;
  IF calc = 'DISTANCE_RANGE' AND (n = 0 OR NOT previous_open) THEN
    RAISE EXCEPTION 'CREDIT_POLICY_RANGES_INVALID: a DISTANCE_RANGE policy needs contiguous ranges from 0 ending in an open range';
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "CreditPolicy_ranges_check" AFTER INSERT ON "CreditPolicy"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "credit_policy_ranges_check"();
CREATE CONSTRAINT TRIGGER "CreditPolicyRange_ranges_check" AFTER INSERT ON "CreditPolicyRange"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "credit_policy_ranges_check"();
