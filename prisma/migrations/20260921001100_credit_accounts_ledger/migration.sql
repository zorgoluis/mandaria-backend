-- V1.10-A Credit Accounts & Immutable Ledger. Incremental from V1.9; no existing row is rewritten.
-- Credits are the commercial right to be awarded services: whole numbers, never money. This
-- version creates accounts and their ledger; claim/take still do not consume credits.

-- CreateEnum
CREATE TYPE "CreditAccountOwnerType" AS ENUM ('PROVIDER', 'INDEPENDENT_DRIVER');

-- CreateEnum
CREATE TYPE "CreditLedgerEntryType" AS ENUM ('RECHARGE', 'SERVICE_AWARD', 'SERVICE_REFUND', 'ADMIN_ADJUSTMENT');

-- CreateEnum
CREATE TYPE "CreditRechargeMethod" AS ENUM ('TRANSFER', 'CASH', 'OTHER');

-- CreateTable
CREATE TABLE "CreditAccount" (
    "id" UUID NOT NULL,
    "ownerType" "CreditAccountOwnerType" NOT NULL,
    "providerId" UUID,
    "independentDriverProfileId" UUID,
    "balance" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreditAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditLedgerEntry" (
    "id" UUID NOT NULL,
    "sequence" SERIAL NOT NULL,
    "creditAccountId" UUID NOT NULL,
    "type" "CreditLedgerEntryType" NOT NULL,
    "amount" INTEGER NOT NULL,
    "balanceBefore" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "rechargeMethod" "CreditRechargeMethod",
    "externalReference" TEXT,
    "reason" TEXT,
    "referenceType" TEXT,
    "referenceId" UUID,
    "createdByUserId" UUID,
    "idempotencyKey" TEXT,
    "requestHash" CHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CreditAccount_providerId_key" ON "CreditAccount"("providerId");

-- CreateIndex
CREATE UNIQUE INDEX "CreditAccount_independentDriverProfileId_key" ON "CreditAccount"("independentDriverProfileId");

-- CreateIndex
CREATE INDEX "CreditAccount_ownerType_createdAt_idx" ON "CreditAccount"("ownerType", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CreditLedgerEntry_sequence_key" ON "CreditLedgerEntry"("sequence");

-- CreateIndex
CREATE INDEX "CreditLedgerEntry_creditAccountId_sequence_idx" ON "CreditLedgerEntry"("creditAccountId", "sequence");

-- CreateIndex
CREATE INDEX "CreditLedgerEntry_type_createdAt_idx" ON "CreditLedgerEntry"("type", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CreditLedgerEntry_creditAccountId_idempotencyKey_key" ON "CreditLedgerEntry"("creditAccountId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "CreditAccount" ADD CONSTRAINT "CreditAccount_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "DeliveryProvider"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditAccount" ADD CONSTRAINT "CreditAccount_independentDriverProfileId_fkey" FOREIGN KEY ("independentDriverProfileId") REFERENCES "IndependentDriverProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditLedgerEntry" ADD CONSTRAINT "CreditLedgerEntry_creditAccountId_fkey" FOREIGN KEY ("creditAccountId") REFERENCES "CreditAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditLedgerEntry" ADD CONSTRAINT "CreditLedgerEntry_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- V1.10-A invariants not expressible in schema.prisma (keep in sync with credit-policy.ts).
--
-- Limits: one movement moves at most 1,000,000 credits and a balance never exceeds 1,000,000,000.
-- With both bounds, balanceBefore + amount stays below 2^31, so no arithmetic here can overflow
-- the INTEGER columns.
--
-- Deletion: an account with history cannot be deleted (the ledger FK is RESTRICT) and the ledger
-- itself refuses DELETE. An account with no movements follows its owner (ON DELETE CASCADE), so
-- removing an owner that never had credits does not require touching financial history.

-- An account belongs to exactly one owner, of the declared kind, and holds a bounded, non-negative
-- whole number of credits.
ALTER TABLE "CreditAccount" ADD CONSTRAINT "CreditAccount_owner_check"
  CHECK (
    ("ownerType" = 'PROVIDER' AND "providerId" IS NOT NULL AND "independentDriverProfileId" IS NULL)
    OR ("ownerType" = 'INDEPENDENT_DRIVER' AND "independentDriverProfileId" IS NOT NULL AND "providerId" IS NULL)
  );
ALTER TABLE "CreditAccount" ADD CONSTRAINT "CreditAccount_balance_check"
  CHECK ("balance" BETWEEN 0 AND 1000000000);

-- Every entry is arithmetically closed: it cannot move zero credits, exceed the per-movement limit,
-- or leave a balance outside the account's bounds.
ALTER TABLE "CreditLedgerEntry" ADD CONSTRAINT "CreditLedgerEntry_amount_check"
  CHECK (
    "amount" <> 0
    AND "amount" BETWEEN -1000000 AND 1000000
    AND "balanceBefore" BETWEEN 0 AND 1000000000
    AND "balanceAfter" BETWEEN 0 AND 1000000000
    AND "balanceAfter" = "balanceBefore" + "amount"
  );

-- Sign convention and required context per type. RECHARGE and SERVICE_REFUND add, SERVICE_AWARD
-- removes, ADMIN_ADJUSTMENT goes either way. Human movements (RECHARGE, ADMIN_ADJUSTMENT) are
-- always attributable and always idempotent; only a recharge carries a payment method and an
-- external reference, and a recharge declared OTHER or any adjustment must say why.
ALTER TABLE "CreditLedgerEntry" ADD CONSTRAINT "CreditLedgerEntry_type_check"
  CHECK (
    ("type" = 'RECHARGE' AND "amount" > 0 AND "rechargeMethod" IS NOT NULL
      AND "createdByUserId" IS NOT NULL AND "idempotencyKey" IS NOT NULL AND "requestHash" IS NOT NULL
      AND ("rechargeMethod" <> 'OTHER' OR "reason" IS NOT NULL))
    OR ("type" = 'ADMIN_ADJUSTMENT' AND "reason" IS NOT NULL AND "rechargeMethod" IS NULL
      AND "externalReference" IS NULL
      AND "createdByUserId" IS NOT NULL AND "idempotencyKey" IS NOT NULL AND "requestHash" IS NOT NULL)
    OR ("type" = 'SERVICE_AWARD' AND "amount" < 0 AND "rechargeMethod" IS NULL AND "externalReference" IS NULL)
    OR ("type" = 'SERVICE_REFUND' AND "amount" > 0 AND "rechargeMethod" IS NULL AND "externalReference" IS NULL)
  );
ALTER TABLE "CreditLedgerEntry" ADD CONSTRAINT "CreditLedgerEntry_text_check"
  CHECK (
    ("reason" IS NULL OR char_length(btrim("reason")) BETWEEN 3 AND 500)
    AND ("externalReference" IS NULL OR char_length(btrim("externalReference")) BETWEEN 1 AND 100)
    AND ("idempotencyKey" IS NULL OR char_length("idempotencyKey") BETWEEN 8 AND 255)
    AND ("referenceType" IS NULL OR char_length("referenceType") BETWEEN 1 AND 50)
    AND (("referenceType" IS NULL) = ("referenceId" IS NULL))
    AND (("idempotencyKey" IS NULL) = ("requestHash" IS NULL))
  );

-- Accounts are born empty and their owner never changes. Their balance can only move from inside
-- credit_ledger_apply, i.e. as the effect of inserting a ledger entry: a direct
-- UPDATE "CreditAccount" SET balance = ... from any client runs at trigger depth 1 and is refused.
CREATE FUNCTION "credit_account_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."balance" <> 0 THEN
      RAISE EXCEPTION 'CREDIT_ACCOUNT_INVALID: accounts are created with a zero balance';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."ownerType" <> OLD."ownerType"
    OR NEW."providerId" IS DISTINCT FROM OLD."providerId"
    OR NEW."independentDriverProfileId" IS DISTINCT FROM OLD."independentDriverProfileId"
    OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'CREDIT_ACCOUNT_IMMUTABLE: the owner of a credit account cannot change';
  END IF;
  IF NEW."balance" <> OLD."balance" AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'CREDIT_BALANCE_WITHOUT_LEDGER: the balance only changes by inserting a CreditLedgerEntry';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "CreditAccount_guard" BEFORE INSERT OR UPDATE ON "CreditAccount"
  FOR EACH ROW EXECUTE FUNCTION "credit_account_guard"();

-- Inserting an entry IS the movement: in the same statement it moves the account to balanceAfter,
-- but only if the account still holds balanceBefore. The UPDATE takes the account row lock, so two
-- concurrent entries built from the same balance serialize and the second fails here instead of
-- producing a lost update. The service locks the account first and never reaches this failure;
-- this is the guarantee for any other writer.
CREATE FUNCTION "credit_ledger_apply"() RETURNS trigger AS $$
BEGIN
  UPDATE "CreditAccount"
     SET "balance" = NEW."balanceAfter", "updatedAt" = (now() AT TIME ZONE 'UTC')
   WHERE "id" = NEW."creditAccountId" AND "balance" = NEW."balanceBefore";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CREDIT_LEDGER_STALE: balanceBefore does not match the current account balance';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "CreditLedgerEntry_apply" AFTER INSERT ON "CreditLedgerEntry"
  FOR EACH ROW EXECUTE FUNCTION "credit_ledger_apply"();

-- The ledger is append-only. UPDATE is always refused. DELETE is refused too, with a single,
-- explicit exception for disposable test databases: a transaction that sets
--   SET LOCAL mandaria.ledger_purge = 'test-fixtures'
-- may delete entries, so automated suites can remove the fixtures they created. The application
-- never sets it and cannot (Prisma runs one statement per call, and no endpoint executes SQL).
-- TRUNCATE skips row triggers, so it is blocked by a statement-level trigger with no exception.
CREATE FUNCTION "credit_ledger_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('mandaria.ledger_purge', true) = 'test-fixtures' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'CREDIT_LEDGER_IMMUTABLE: ledger entries cannot be % once written', lower(TG_OP);
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "CreditLedgerEntry_guard" BEFORE UPDATE OR DELETE ON "CreditLedgerEntry"
  FOR EACH ROW EXECUTE FUNCTION "credit_ledger_guard"();

CREATE FUNCTION "credit_ledger_no_truncate"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'CREDIT_LEDGER_IMMUTABLE: the credit ledger cannot be truncated';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "CreditLedgerEntry_no_truncate" BEFORE TRUNCATE ON "CreditLedgerEntry"
  FOR EACH STATEMENT EXECUTE FUNCTION "credit_ledger_no_truncate"();

-- Account creation lives next to its owner, whatever path creates the owner (API, seed, fixture):
--   every provider gets its single account when it is inserted;
--   an independent profile gets its account the first time it reaches APPROVED, and keeps it
--   through SUSPENDED or REJECTED. A fleet driver never gets one.
-- ON CONFLICT on the unique owner index makes both idempotent.
CREATE FUNCTION "credit_account_for_owner"() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'DeliveryProvider' THEN
    INSERT INTO "CreditAccount" ("id", "ownerType", "providerId", "balance", "createdAt", "updatedAt")
    VALUES (gen_random_uuid(), 'PROVIDER', NEW."id", 0,
            (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC'))
    ON CONFLICT ("providerId") DO NOTHING;
  ELSE
    INSERT INTO "CreditAccount" ("id", "ownerType", "independentDriverProfileId", "balance", "createdAt", "updatedAt")
    VALUES (gen_random_uuid(), 'INDEPENDENT_DRIVER', NEW."id", 0,
            (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC'))
    ON CONFLICT ("independentDriverProfileId") DO NOTHING;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "DeliveryProvider_credit_account" AFTER INSERT ON "DeliveryProvider"
  FOR EACH ROW EXECUTE FUNCTION "credit_account_for_owner"();
CREATE TRIGGER "IndependentDriverProfile_credit_account"
  AFTER INSERT OR UPDATE OF "status" ON "IndependentDriverProfile"
  FOR EACH ROW WHEN (NEW."status" = 'APPROVED')
  EXECUTE FUNCTION "credit_account_for_owner"();

-- Backfill for data that predates V1.10: every provider, and every independent profile that has
-- ever been approved (the same rule the trigger applies from now on). Balances start at zero and
-- no ledger entry is written: an empty account has no economic history, and inventing a RECHARGE
-- would record money that nobody paid.
INSERT INTO "CreditAccount" ("id", "ownerType", "providerId", "balance", "createdAt", "updatedAt")
SELECT gen_random_uuid(), 'PROVIDER', p."id", 0, (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC')
  FROM "DeliveryProvider" p
ON CONFLICT ("providerId") DO NOTHING;
INSERT INTO "CreditAccount" ("id", "ownerType", "independentDriverProfileId", "balance", "createdAt", "updatedAt")
SELECT gen_random_uuid(), 'INDEPENDENT_DRIVER', ip."id", 0, (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC')
  FROM "IndependentDriverProfile" ip
 WHERE ip."approvedAt" IS NOT NULL
ON CONFLICT ("independentDriverProfileId") DO NOTHING;
