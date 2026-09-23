-- V1.10-E: Refunds & Reversals.
--
-- When Mandaria already charged an award and a supported operational event reverses that award,
-- the credits come back as a NEW, opposite ledger entry that points at the original one. The
-- SERVICE_AWARD is never updated, deleted or zeroed: history keeps both movements, and their sum
-- is the real economic impact. Only full refunds exist in this version.
--
-- The migration creates no refund: a historical award stays exactly as it happened, and only
-- events that occur from now on can produce a refund.

CREATE TYPE "CreditRefundReason" AS ENUM ('PROVIDER_RELEASE', 'INDEPENDENT_RELEASE', 'DELIVERY_CANCELLED');
ALTER TABLE "CreditLedgerEntry" ADD COLUMN "reversesEntryId" UUID;
ALTER TABLE "CreditLedgerEntry" ADD COLUMN "refundReason" "CreditRefundReason";
ALTER TABLE "CreditLedgerEntry" ADD CONSTRAINT "CreditLedgerEntry_reversesEntryId_fkey"
  FOREIGN KEY ("reversesEntryId") REFERENCES "CreditLedgerEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- At most one refund per award: a retry, a duplicated release or two concurrent cancellations can
-- never return the credits twice. Together with the full-amount rule below, an award is either not
-- refunded or refunded exactly once, so "remaining refundable" is derivable without summing text.
CREATE UNIQUE INDEX "CreditLedgerEntry_refund_award_key"
  ON "CreditLedgerEntry"("reversesEntryId") WHERE "type" = 'SERVICE_REFUND';
CREATE INDEX "CreditLedgerEntry_reversesEntryId_idx" ON "CreditLedgerEntry"("reversesEntryId");

-- Only a refund carries a reversal and a reason, and it always says which service it returns.
-- Its author is optional because a cancellation can legitimately come from a B2B client, which is
-- not a User; the award it compensates already records who paid.
ALTER TABLE "CreditLedgerEntry" ADD CONSTRAINT "CreditLedgerEntry_refund_check"
  CHECK (
    CASE WHEN "type" = 'SERVICE_REFUND'
      THEN "reversesEntryId" IS NOT NULL AND "refundReason" IS NOT NULL
        AND "referenceType" = 'DISPATCH' AND "referenceId" IS NOT NULL
        AND "idempotencyKey" IS NULL AND "requestHash" IS NULL
      ELSE "reversesEntryId" IS NULL AND "refundReason" IS NULL
    END
  );

-- The refund is re-derived in SQL from the award it points at: same account, same dispatch, exact
-- opposite amount, and an operational reversal that really happened in this transaction. So a
-- direct SQL writer cannot turn SERVICE_REFUND into a disguised recharge, refund a service that is
-- still awarded, refund somebody else's award or refund a different amount.
CREATE FUNCTION "service_refund_guard"() RETURNS trigger AS $$
DECLARE
  award RECORD;
  dispatch RECORD;
  account RECORD;
  holder BOOLEAN;
BEGIN
  SELECT "id", "type", "amount", "creditAccountId", "referenceId"
    INTO award FROM "CreditLedgerEntry" WHERE "id" = NEW."reversesEntryId";
  IF NOT FOUND OR award."type" <> 'SERVICE_AWARD' THEN
    RAISE EXCEPTION 'CREDIT_REFUND_INVALID: a refund must compensate an existing SERVICE_AWARD';
  END IF;
  IF award."creditAccountId" <> NEW."creditAccountId" THEN
    RAISE EXCEPTION 'CREDIT_REFUND_INVALID: the refund must return the credits to the account that paid';
  END IF;
  IF award."referenceId" IS DISTINCT FROM NEW."referenceId" THEN
    RAISE EXCEPTION 'CREDIT_REFUND_INVALID: the refund must reference the same dispatch as its award';
  END IF;
  IF NEW."amount" <> -award."amount" THEN
    RAISE EXCEPTION 'CREDIT_REFUND_MISMATCH: only full refunds exist; expected % credits', -award."amount";
  END IF;
  SELECT "ownerType", "providerId", "independentDriverProfileId" INTO account
    FROM "CreditAccount" WHERE "id" = NEW."creditAccountId";
  SELECT "id", "status", "claimedByProviderId", "claimedByIndependentDriverId"
    INTO dispatch FROM "Dispatch" WHERE "id" = NEW."referenceId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CREDIT_REFUND_INVALID: refund % does not reference an existing dispatch', NEW."referenceId";
  END IF;
  -- The actor of the refund reason must match the actor that paid, so a provider award cannot be
  -- returned as an independent reversal or the other way round.
  IF (NEW."refundReason" = 'PROVIDER_RELEASE' AND account."ownerType" <> 'PROVIDER')
    OR (NEW."refundReason" = 'INDEPENDENT_RELEASE' AND account."ownerType" <> 'INDEPENDENT_DRIVER') THEN
    RAISE EXCEPTION 'CREDIT_REFUND_INVALID: the refund reason does not match the actor that paid';
  END IF;
  -- The operational reversal must already be written in this transaction: the payer no longer
  -- holds the service, or the service itself was cancelled.
  IF account."ownerType" = 'PROVIDER' THEN
    holder := dispatch."claimedByProviderId" IS NOT DISTINCT FROM account."providerId";
  ELSE
    holder := dispatch."claimedByIndependentDriverId" IS NOT DISTINCT FROM
      (SELECT "driverId" FROM "IndependentDriverProfile" WHERE "id" = account."independentDriverProfileId");
  END IF;
  IF NEW."refundReason" = 'DELIVERY_CANCELLED' THEN
    IF dispatch."status" NOT IN ('CANCELLED', 'EXPIRED') OR NOT holder THEN
      RAISE EXCEPTION 'CREDIT_REFUND_INVALID: the dispatch of a cancellation refund must be closed by that cancellation';
    END IF;
  ELSIF dispatch."status" = 'CLAIMED' OR holder THEN
    RAISE EXCEPTION 'CREDIT_REFUND_INVALID: the service is still awarded to the actor being refunded';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "CreditLedgerEntry_service_refund_guard" BEFORE INSERT ON "CreditLedgerEntry"
  FOR EACH ROW WHEN (NEW."type" = 'SERVICE_REFUND') EXECUTE FUNCTION "service_refund_guard"();

-- The other half of the rule: an operational reversal of a paid award cannot commit without its
-- refund. Checked at COMMIT (deferred), because the application writes the reversal first and the
-- refund immediately after, inside the same transaction.
CREATE FUNCTION "dispatch_award_refund_required"() RETURNS trigger AS $$
DECLARE
  account_id UUID;
  award RECORD;
BEGIN
  IF OLD."status" <> 'CLAIMED' THEN
    RETURN NULL;
  END IF;
  -- Nothing to settle while the same actor still holds the service (an assignment change, for
  -- example, leaves the claim exactly where it was).
  IF NEW."status" = 'CLAIMED'
    AND NEW."claimedByProviderId" IS NOT DISTINCT FROM OLD."claimedByProviderId"
    AND NEW."claimedByIndependentDriverId" IS NOT DISTINCT FROM OLD."claimedByIndependentDriverId" THEN
    RETURN NULL;
  END IF;
  SELECT a."id" INTO account_id FROM "CreditAccount" a
   WHERE (OLD."claimedByProviderId" IS NOT NULL AND a."providerId" = OLD."claimedByProviderId")
      OR (OLD."claimedByIndependentDriverId" IS NOT NULL
          AND a."independentDriverProfileId" = (SELECT "id" FROM "IndependentDriverProfile" WHERE "driverId" = OLD."claimedByIndependentDriverId"));
  IF account_id IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT "id" INTO award FROM "CreditLedgerEntry"
   WHERE "type" = 'SERVICE_AWARD' AND "referenceId" = OLD."id" AND "creditAccountId" = account_id;
  -- No award means this service was never charged (LEGACY or a pre-enforcement claim): there is
  -- nothing to give back and no credit is invented.
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "CreditLedgerEntry"
     WHERE "type" = 'SERVICE_REFUND' AND "reversesEntryId" = award."id"
  ) THEN
    RAISE EXCEPTION 'CREDIT_REFUND_REQUIRED: dispatch % was reversed without returning the credits of its award', OLD."id";
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "Dispatch_award_refund_required" AFTER UPDATE ON "Dispatch"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "dispatch_award_refund_required"();
