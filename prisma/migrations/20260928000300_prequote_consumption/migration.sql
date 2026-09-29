CREATE TYPE "PrequotePermitState" AS ENUM ('RESERVED','STARTED','FINISHED','CANCELLED','EXPIRED','ABANDONED');
CREATE TABLE "PrequoteConsumptionPolicy" (
  id integer PRIMARY KEY CHECK (id=1), fingerprint varchar(64) NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$')
);
CREATE TABLE "PrequoteConsumptionPermit" (
  id uuid PRIMARY KEY,
  "integrationClientId" uuid NOT NULL REFERENCES "IntegrationClient"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  "ownerHash" varchar(64) NOT NULL,
  "policyFingerprint" varchar(64) NOT NULL,
  state "PrequotePermitState" NOT NULL,
  units integer NOT NULL,
  "routingBudgetMs" integer NOT NULL,
  "reservedAt" timestamp(3) NOT NULL,
  "reserveExpiresAt" timestamp(3) NOT NULL,
  "startedAt" timestamp(3), "startBy" timestamp(3), "protectedUntil" timestamp(3),
  "finishedAt" timestamp(3), "routingReported" boolean, "publishedReported" boolean,
  CONSTRAINT "PrequotePermit_values" CHECK (
    "ownerHash" ~ '^[0-9a-f]{64}$' AND "policyFingerprint" ~ '^[0-9a-f]{64}$'
    AND units BETWEEN 1 AND 3 AND "routingBudgetMs" BETWEEN 16000 AND 60600
    AND "reserveExpiresAt" > "reservedAt" AND "reserveExpiresAt" <= "reservedAt" + interval '5 minutes'
    AND ((state IN ('RESERVED','CANCELLED','EXPIRED') AND "startedAt" IS NULL AND "startBy" IS NULL AND "protectedUntil" IS NULL)
      OR (state IN ('STARTED','FINISHED','ABANDONED') AND "startedAt" IS NOT NULL AND "startBy" IS NOT NULL AND "protectedUntil" IS NOT NULL
        AND "startedAt" >= "reservedAt" AND "startedAt" < "reserveExpiresAt"
        AND "startBy" = "startedAt" + interval '5 seconds'
        AND "protectedUntil" = "startedAt" + "routingBudgetMs" * interval '1 millisecond'))
    AND ((state IN ('RESERVED','STARTED') AND "finishedAt" IS NULL AND "routingReported" IS NULL AND "publishedReported" IS NULL)
      OR (state IN ('CANCELLED','EXPIRED','FINISHED','ABANDONED') AND "finishedAt" IS NOT NULL AND "finishedAt" >= "reservedAt"))
    AND (state <> 'CANCELLED' OR ("routingReported" IS NOT DISTINCT FROM false AND "publishedReported" IS NOT DISTINCT FROM false))
  )
);
CREATE INDEX "PrequoteConsumptionPermit_integrationClientId_startedAt_idx" ON "PrequoteConsumptionPermit"("integrationClientId","startedAt");
CREATE INDEX "PrequoteConsumptionPermit_startedAt_idx" ON "PrequoteConsumptionPermit"("startedAt");
CREATE INDEX "PrequoteConsumptionPermit_state_reserveExpiresAt_idx" ON "PrequoteConsumptionPermit"(state,"reserveExpiresAt");
CREATE INDEX "PrequoteConsumptionPermit_protectedUntil_idx" ON "PrequoteConsumptionPermit"("protectedUntil");
CREATE FUNCTION prequote_permit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'PREQUOTE_PERMIT_HISTORY_IMMUTABLE'; END IF;
 IF TG_OP='INSERT' THEN
   IF NEW.state <> 'RESERVED' THEN RAISE EXCEPTION 'PREQUOTE_PERMIT_INITIAL_STATE'; END IF;
   RETURN NEW;
 END IF;
 IF (NEW.id,NEW."integrationClientId",NEW."ownerHash",NEW."policyFingerprint",NEW.units,NEW."routingBudgetMs",NEW."reservedAt",NEW."reserveExpiresAt") IS DISTINCT FROM
    (OLD.id,OLD."integrationClientId",OLD."ownerHash",OLD."policyFingerprint",OLD.units,OLD."routingBudgetMs",OLD."reservedAt",OLD."reserveExpiresAt")
 THEN RAISE EXCEPTION 'PREQUOTE_PERMIT_IDENTITY_IMMUTABLE'; END IF;
 IF OLD.state='RESERVED' THEN
   IF NEW.state NOT IN ('STARTED','CANCELLED','EXPIRED') THEN RAISE EXCEPTION 'PREQUOTE_PERMIT_TRANSITION'; END IF;
   IF NEW.state='STARTED' AND OLD."reserveExpiresAt" <= (clock_timestamp() AT TIME ZONE 'UTC') THEN RAISE EXCEPTION 'PREQUOTE_PERMIT_EXPIRED'; END IF;
   IF NEW.state='EXPIRED' AND OLD."reserveExpiresAt" > (clock_timestamp() AT TIME ZONE 'UTC') THEN RAISE EXCEPTION 'PREQUOTE_PERMIT_NOT_EXPIRED'; END IF;
 ELSIF OLD.state='STARTED' THEN
   IF NEW.state NOT IN ('FINISHED','ABANDONED') OR (NEW."startedAt",NEW."startBy",NEW."protectedUntil") IS DISTINCT FROM (OLD."startedAt",OLD."startBy",OLD."protectedUntil") THEN RAISE EXCEPTION 'PREQUOTE_PERMIT_CONSUMPTION_IMMUTABLE'; END IF;
   IF NEW.state='ABANDONED' AND OLD."protectedUntil" > (clock_timestamp() AT TIME ZONE 'UTC') THEN RAISE EXCEPTION 'PREQUOTE_PERMIT_STILL_PROTECTED'; END IF;
 ELSE RAISE EXCEPTION 'PREQUOTE_PERMIT_TERMINAL';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "PrequotePermit_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PrequoteConsumptionPermit" FOR EACH ROW EXECUTE FUNCTION prequote_permit_guard();
