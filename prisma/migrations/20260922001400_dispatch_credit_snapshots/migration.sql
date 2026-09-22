-- V1.10-C Dispatch Credit Snapshot. Incremental from V1.10-B. No existing row is touched and no
-- snapshot is backfilled: Dispatches opened before V1.10-C keep having none, because inventing
-- their cost with today's policy would be false history. Snapshots only record the cost; claim and
-- take still consume no credits.

-- CreateTable
CREATE TABLE "DispatchCreditSnapshot" (
    "id" UUID NOT NULL,
    "dispatchId" UUID NOT NULL,
    "actorType" "CreditAccountOwnerType" NOT NULL,
    "serviceType" "ServiceType" NOT NULL,
    "creditPolicyId" UUID NOT NULL,
    "policyVersion" INTEGER NOT NULL,
    "calculationType" "CreditCalculationType" NOT NULL,
    "distanceMeters" INTEGER NOT NULL,
    "billableKm" INTEGER,
    "creditsPerKm" INTEGER,
    "minimumCredits" INTEGER,
    "calculatedCredits" INTEGER,
    "flatCredits" INTEGER,
    "appliedRangeId" UUID,
    "appliedRangePosition" INTEGER,
    "appliedRangeMinDistanceMeters" INTEGER,
    "appliedRangeMaxDistanceMeters" INTEGER,
    "credits" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DispatchCreditSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DispatchCreditSnapshot_creditPolicyId_idx" ON "DispatchCreditSnapshot"("creditPolicyId");

-- CreateIndex
CREATE UNIQUE INDEX "DispatchCreditSnapshot_dispatchId_actorType_key" ON "DispatchCreditSnapshot"("dispatchId", "actorType");

-- AddForeignKey
ALTER TABLE "DispatchCreditSnapshot" ADD CONSTRAINT "DispatchCreditSnapshot_dispatchId_fkey" FOREIGN KEY ("dispatchId") REFERENCES "Dispatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DispatchCreditSnapshot" ADD CONSTRAINT "DispatchCreditSnapshot_creditPolicyId_fkey" FOREIGN KEY ("creditPolicyId") REFERENCES "CreditPolicy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DispatchCreditSnapshot" ADD CONSTRAINT "DispatchCreditSnapshot_appliedRangeId_fkey" FOREIGN KEY ("appliedRangeId") REFERENCES "CreditPolicyRange"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- V1.10-C invariants not expressible in schema.prisma (keep in sync with
-- src/credit-policies/dispatch-credit-snapshots.ts and SERVICE_EXECUTION_MODES).

-- Which actor types may be awarded each ServiceType: the SQL mirror of SERVICE_EXECUTION_MODES
-- (LOCAL_DELIVERY is BOTH). A new ServiceType needs an enum migration anyway; add it here in the
-- same migration. An undeclared type returns NULL, and a Dispatch of it cannot be opened.
CREATE FUNCTION "credit_required_actors"(service "ServiceType") RETURNS "CreditAccountOwnerType"[] AS $$
  SELECT CASE service
    WHEN 'LOCAL_DELIVERY' THEN ARRAY['PROVIDER', 'INDEPENDENT_DRIVER']::"CreditAccountOwnerType"[]
  END;
$$ LANGUAGE sql IMMUTABLE;

-- Bounded whole credits (a service award will be one V1.10-A ledger movement, 1..1,000,000; a
-- service never costs 0), and exactly the evidence columns of the calculation type. The IS NOT NULL
-- tests are required: a CHECK that evaluates to NULL passes.
ALTER TABLE "DispatchCreditSnapshot" ADD CONSTRAINT "DispatchCreditSnapshot_values_check"
  CHECK (
    "credits" BETWEEN 1 AND 1000000
    AND "distanceMeters" >= 0
    AND "policyVersion" > 0
    AND (
      ("calculationType" = 'PER_KM'
        AND "billableKm" IS NOT NULL AND "billableKm" >= 0
        AND "creditsPerKm" IS NOT NULL AND "minimumCredits" IS NOT NULL AND "calculatedCredits" IS NOT NULL
        AND "flatCredits" IS NULL
        AND "appliedRangeId" IS NULL AND "appliedRangePosition" IS NULL
        AND "appliedRangeMinDistanceMeters" IS NULL AND "appliedRangeMaxDistanceMeters" IS NULL)
      OR ("calculationType" = 'FLAT'
        AND "flatCredits" IS NOT NULL
        AND "billableKm" IS NULL AND "creditsPerKm" IS NULL AND "minimumCredits" IS NULL AND "calculatedCredits" IS NULL
        AND "appliedRangeId" IS NULL AND "appliedRangePosition" IS NULL
        AND "appliedRangeMinDistanceMeters" IS NULL AND "appliedRangeMaxDistanceMeters" IS NULL)
      OR ("calculationType" = 'DISTANCE_RANGE'
        AND "appliedRangeId" IS NOT NULL AND "appliedRangePosition" IS NOT NULL AND "appliedRangeMinDistanceMeters" IS NOT NULL
        AND "billableKm" IS NULL AND "creditsPerKm" IS NULL AND "minimumCredits" IS NULL AND "calculatedCredits" IS NULL
        AND "flatCredits" IS NULL)
    )
  );

-- A snapshot is born with its Dispatch and can only say what the ACTIVE policy really charges for
-- the canonical distance of that Dispatch. On INSERT PostgreSQL checks that:
--   * the Dispatch is being opened in this very transaction (row created by this transaction,
--     OPEN, never claimed, no assignment) — no later backfill, no retroactive costs;
--   * serviceType and distanceMeters are those of the Dispatch's DeliveryQuote (the canonical
--     distance, fixed by routing when the quote was made);
--   * the actor may execute that ServiceType (credit_required_actors);
--   * the policy is the ACTIVE one of that actor and ServiceType, with that version and type;
--   * the evidence and the credits are exactly what that policy produces (recomputed here).
-- UPDATE is always refused. DELETE is refused unless the Dispatch itself is being deleted (the
-- evidence lives and dies with its Dispatch) or the test-only purge switch is on in a *_test DB.
CREATE FUNCTION "dispatch_credit_snapshot_guard"() RETURNS trigger AS $$
DECLARE
  d RECORD;
  q RECORD;
  p RECORD;
  r RECORD;
  km BIGINT;
  current_xid TEXT := (pg_current_xact_id()::text::bigint % 4294967296)::text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'CREDIT_SNAPSHOT_IMMUTABLE: a dispatch credit snapshot never changes';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF "credit_history_purge_allowed"()
      OR NOT EXISTS (SELECT 1 FROM "Dispatch" WHERE "id" = OLD."dispatchId") THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'CREDIT_SNAPSHOT_IMMUTABLE: a dispatch credit snapshot is only removed with its dispatch';
  END IF;

  SELECT "status", "claimedAt", "deliveryQuoteId", xmin::text AS row_xid INTO d
    FROM "Dispatch" WHERE "id" = NEW."dispatchId";
  IF NOT FOUND OR d."status" <> 'OPEN' OR d."claimedAt" IS NOT NULL OR d.row_xid <> current_xid
    OR EXISTS (SELECT 1 FROM "DispatchCandidate" c WHERE c."dispatchId" = NEW."dispatchId" AND c."claimedAt" IS NOT NULL)
    OR EXISTS (SELECT 1 FROM "DeliveryAssignment" a WHERE a."dispatchId" = NEW."dispatchId") THEN
    RAISE EXCEPTION 'CREDIT_SNAPSHOT_INVALID: a credit snapshot is created only while its dispatch is being opened';
  END IF;
  SELECT "serviceType", "distanceMeters" INTO q FROM "DeliveryQuote" WHERE "id" = d."deliveryQuoteId";
  IF q."serviceType" <> NEW."serviceType" OR q."distanceMeters" <> NEW."distanceMeters" THEN
    RAISE EXCEPTION 'CREDIT_SNAPSHOT_INVALID: serviceType and distanceMeters must be those of the dispatch quote';
  END IF;
  IF NOT (NEW."actorType" = ANY (coalesce("credit_required_actors"(NEW."serviceType"), '{}'))) THEN
    RAISE EXCEPTION 'CREDIT_SNAPSHOT_INVALID: % cannot be awarded a % service', NEW."actorType", NEW."serviceType";
  END IF;
  SELECT * INTO p FROM "CreditPolicy" WHERE "id" = NEW."creditPolicyId";
  -- NOT FOUND first: with no row every p field is NULL and the comparisons below would be NULL.
  IF NOT FOUND OR p."actorType" <> NEW."actorType" OR p."serviceType" <> NEW."serviceType"
    OR p."version" <> NEW."policyVersion" OR p."calculationType" <> NEW."calculationType"
    OR p."status" <> 'ACTIVE' THEN
    RAISE EXCEPTION 'CREDIT_SNAPSHOT_INVALID: the policy must be the ACTIVE version of this actor and service type';
  END IF;

  IF p."calculationType" = 'PER_KM' THEN
    km := (NEW."distanceMeters"::bigint + 999) / 1000;
    IF NEW."billableKm" <> km OR NEW."creditsPerKm" <> p."creditsPerKm" OR NEW."minimumCredits" <> p."minimumCredits"
      OR NEW."calculatedCredits" <> km * p."creditsPerKm"
      OR NEW."credits" <> greatest(km * p."creditsPerKm", p."minimumCredits") THEN
      RAISE EXCEPTION 'CREDIT_SNAPSHOT_MISMATCH: PER_KM evidence does not match policy v%', p."version";
    END IF;
  ELSIF p."calculationType" = 'FLAT' THEN
    IF NEW."flatCredits" <> p."flatCredits" OR NEW."credits" <> p."flatCredits" THEN
      RAISE EXCEPTION 'CREDIT_SNAPSHOT_MISMATCH: FLAT evidence does not match policy v%', p."version";
    END IF;
  ELSE
    SELECT * INTO r FROM "CreditPolicyRange" WHERE "id" = NEW."appliedRangeId" AND "creditPolicyId" = p."id";
    IF NOT FOUND OR NEW."appliedRangePosition" <> r."position"
      OR NEW."appliedRangeMinDistanceMeters" <> r."minDistanceMeters"
      OR NEW."appliedRangeMaxDistanceMeters" IS DISTINCT FROM r."maxDistanceMeters"
      OR NEW."credits" <> r."credits"
      OR NEW."distanceMeters" < r."minDistanceMeters"
      OR (r."maxDistanceMeters" IS NOT NULL AND NEW."distanceMeters" >= r."maxDistanceMeters") THEN
      RAISE EXCEPTION 'CREDIT_SNAPSHOT_MISMATCH: DISTANCE_RANGE evidence does not match policy v%', p."version";
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "DispatchCreditSnapshot_guard" BEFORE INSERT OR UPDATE OR DELETE ON "DispatchCreditSnapshot"
  FOR EACH ROW EXECUTE FUNCTION "dispatch_credit_snapshot_guard"();

CREATE FUNCTION "dispatch_credit_snapshot_no_truncate"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'CREDIT_SNAPSHOT_IMMUTABLE: dispatch credit snapshots cannot be truncated';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "DispatchCreditSnapshot_no_truncate" BEFORE TRUNCATE ON "DispatchCreditSnapshot"
  FOR EACH STATEMENT EXECUTE FUNCTION "dispatch_credit_snapshot_no_truncate"();

-- Checked at COMMIT (deferred) for every Dispatch opened from now on: it must carry the snapshot of
-- every actor that may execute its ServiceType, so no Dispatch is ever published awardable without
-- its frozen cost, and a failed snapshot rolls the whole opening back. Dispatches that already
-- exist are not re-checked (they predate V1.10-C and stay legacy, without snapshots).
CREATE FUNCTION "dispatch_credit_snapshots_required"() RETURNS trigger AS $$
DECLARE
  service "ServiceType";
  required "CreditAccountOwnerType"[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Dispatch" WHERE "id" = NEW."id") THEN
    RETURN NULL;
  END IF;
  SELECT "serviceType" INTO service FROM "DeliveryQuote" WHERE "id" = NEW."deliveryQuoteId";
  required := "credit_required_actors"(service);
  IF required IS NULL THEN
    RAISE EXCEPTION 'CREDIT_SNAPSHOT_MISSING: service type % has no declared execution mode', service;
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(required) AS actor
     WHERE NOT EXISTS (SELECT 1 FROM "DispatchCreditSnapshot" s
                        WHERE s."dispatchId" = NEW."id" AND s."actorType" = actor)
  ) THEN
    RAISE EXCEPTION 'CREDIT_SNAPSHOT_MISSING: dispatch % opened without the credit snapshot of every allowed actor', NEW."id";
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "Dispatch_credit_snapshots_required" AFTER INSERT ON "Dispatch"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "dispatch_credit_snapshots_required"();
