-- V1.10-D: Atomic CLAIM / TAKE credit consumption.
--
-- Awarding a monetized Dispatch and debiting its frozen cost are one economic operation: the
-- application does both inside the transaction that claims or takes the service, and the
-- guarantees below make the database refuse any other combination. No charge is backfilled: the
-- Dispatches that already exist keep their history untouched.

-- ---------------------------------------------------------------- monetization boundary
-- Which Dispatches are chargeable is persisted per row, decided when the Dispatch is created, and
-- never inferred from "it has no snapshot". Every Dispatch that exists today without snapshots is
-- marked LEGACY once, here; from now on every Dispatch is born MONETIZED and must carry the
-- snapshot of each allowed actor (V1.10-C's deferred trigger). So a monetized Dispatch whose
-- snapshot is missing later is corruption and fails closed, instead of becoming a free service.
-- The column is added defaulting to LEGACY, so every Dispatch that already exists is labelled
-- without rewriting a single row, and the default becomes MONETIZED for the ones opened from now
-- on. Only the Dispatches opened under V1.10-C (the ones that already froze their cost) are
-- relabelled MONETIZED; dispatch_guard freezes resolved rows, so that one backfill statement runs
-- with the guard disabled inside this migration's transaction. It is a labelling step: no status,
-- claim, assignment or money changes.
CREATE TYPE "DispatchCreditMode" AS ENUM ('LEGACY', 'MONETIZED');
ALTER TABLE "Dispatch" ADD COLUMN "creditMode" "DispatchCreditMode" NOT NULL DEFAULT 'LEGACY';
ALTER TABLE "Dispatch" DISABLE TRIGGER "Dispatch_guard";
UPDATE "Dispatch" d SET "creditMode" = 'MONETIZED'
 WHERE EXISTS (SELECT 1 FROM "DispatchCreditSnapshot" s WHERE s."dispatchId" = d."id");
ALTER TABLE "Dispatch" ENABLE TRIGGER "Dispatch_guard";
ALTER TABLE "Dispatch" ALTER COLUMN "creditMode" SET DEFAULT 'MONETIZED';

-- The boundary is immutable: a Dispatch cannot be re-labelled to dodge (or invent) a charge. The
-- single exception is the fixture switch automated suites already use for credit history
-- (mandaria.ledger_purge = 'test-fixtures'), which PostgreSQL only honours in a database whose
-- name ends in _test, so a suite can build a genuine legacy Dispatch to test that path.
CREATE FUNCTION "dispatch_credit_mode_guard"() RETURNS trigger AS $$
BEGIN
  IF "credit_history_purge_allowed"() THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."creditMode" <> 'MONETIZED' THEN
      RAISE EXCEPTION 'DISPATCH_CREDIT_MODE_INVALID: dispatches opened from V1.10-D on are always MONETIZED';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."creditMode" <> OLD."creditMode" THEN
    RAISE EXCEPTION 'DISPATCH_CREDIT_MODE_IMMUTABLE: the monetization boundary of a dispatch cannot change';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "Dispatch_credit_mode_guard" BEFORE INSERT OR UPDATE ON "Dispatch"
  FOR EACH ROW EXECUTE FUNCTION "dispatch_credit_mode_guard"();

-- V1.10-C's deferred requirement, now stated in terms of the boundary it was implicitly creating.
CREATE OR REPLACE FUNCTION "dispatch_credit_snapshots_required"() RETURNS trigger AS $$
DECLARE
  service "ServiceType";
  required "CreditAccountOwnerType"[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Dispatch" WHERE "id" = NEW."id") THEN
    RETURN NULL;
  END IF;
  IF NEW."creditMode" <> 'MONETIZED' THEN
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

-- ---------------------------------------------------------------- the award charge
-- Exactly one SERVICE_AWARD per account and Dispatch. A retry, a double click or a duplicated
-- request can never produce a second debit for the same award; a different provider claiming the
-- same Dispatch after a release pays from its own account, which is a different award.
CREATE UNIQUE INDEX "CreditLedgerEntry_service_award_key"
  ON "CreditLedgerEntry"("creditAccountId", "referenceId") WHERE "type" = 'SERVICE_AWARD';

-- A SERVICE_AWARD always says which Dispatch it paid for and who triggered it, and never borrows
-- the human idempotency contract (recharges and adjustments keep that; the index above is this
-- movement's exactly-once guarantee).
ALTER TABLE "CreditLedgerEntry" ADD CONSTRAINT "CreditLedgerEntry_award_check"
  CHECK (
    "type" <> 'SERVICE_AWARD'
    OR ("referenceType" = 'DISPATCH' AND "referenceId" IS NOT NULL
        AND "createdByUserId" IS NOT NULL
        AND "idempotencyKey" IS NULL AND "requestHash" IS NULL)
  );

-- The charge itself is verified in SQL, not only in TypeScript: it must point at a monetized
-- Dispatch that the paying account has actually just won, and its amount must be exactly the
-- credits frozen in that actor's snapshot. So a forged amount, a charge to a bystander's account,
-- a charge for a legacy or unclaimed Dispatch and a charge without a snapshot are all impossible,
-- whoever writes them.
CREATE FUNCTION "service_award_guard"() RETURNS trigger AS $$
DECLARE
  account RECORD;
  dispatch RECORD;
  frozen INTEGER;
  winner BOOLEAN;
BEGIN
  SELECT "ownerType", "providerId", "independentDriverProfileId" INTO account
    FROM "CreditAccount" WHERE "id" = NEW."creditAccountId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CREDIT_AWARD_INVALID: the credit account of the award does not exist';
  END IF;
  SELECT "id", "status", "creditMode", "claimedByProviderId", "claimedByIndependentDriverId"
    INTO dispatch FROM "Dispatch" WHERE "id" = NEW."referenceId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CREDIT_AWARD_INVALID: award % does not reference an existing dispatch', NEW."referenceId";
  END IF;
  IF dispatch."creditMode" <> 'MONETIZED' THEN
    RAISE EXCEPTION 'CREDIT_AWARD_INVALID: dispatch % is not monetized and cannot be charged', dispatch."id";
  END IF;
  SELECT "credits" INTO frozen FROM "DispatchCreditSnapshot"
   WHERE "dispatchId" = dispatch."id" AND "actorType" = account."ownerType";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CREDIT_AWARD_INVALID: dispatch % has no credit snapshot for %', dispatch."id", account."ownerType";
  END IF;
  IF NEW."amount" <> -frozen THEN
    RAISE EXCEPTION 'CREDIT_AWARD_MISMATCH: award of % credits does not match the frozen cost of %', -NEW."amount", frozen;
  END IF;
  IF account."ownerType" = 'PROVIDER' THEN
    winner := dispatch."claimedByProviderId" IS NOT DISTINCT FROM account."providerId";
  ELSE
    winner := dispatch."claimedByIndependentDriverId" IS NOT DISTINCT FROM
      (SELECT "driverId" FROM "IndependentDriverProfile" WHERE "id" = account."independentDriverProfileId");
  END IF;
  IF dispatch."status" <> 'CLAIMED' OR NOT winner THEN
    RAISE EXCEPTION 'CREDIT_AWARD_INVALID: only the actor holding dispatch % pays for it', dispatch."id";
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "CreditLedgerEntry_service_award_guard" BEFORE INSERT ON "CreditLedgerEntry"
  FOR EACH ROW WHEN (NEW."type" = 'SERVICE_AWARD') EXECUTE FUNCTION "service_award_guard"();
