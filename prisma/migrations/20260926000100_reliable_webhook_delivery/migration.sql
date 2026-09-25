-- V1.12-D Reliable & Secure B2B Webhook Delivery.
--
-- V1.12-C made one best-effort attempt from the request that completed the delivery. V1.12-D turns
-- that into durable transport: the work is discovered from the outbox after any restart, leased so
-- several backends never do it twice, retried on a fixed schedule, and signed so the receiver can
-- tell the request really came from Mandaria.
--
-- Three things stay apart, and this migration keeps them that way. The event is an immutable fact
-- (V1.12-B). An attempt is immutable history (V1.12-C). Only the new B2bWebhookDelivery row is
-- mutable, and it holds nothing but "what is still owed and when to try again": the outbox is never
-- turned into a queue.
--
-- Nothing is delivered retroactively. `deliverFrom` on each endpoint is the boundary of automatic
-- delivery and is set to the moment this migration runs, so every event recorded under V1.12-B or
-- V1.12-C stays outside the worker, exactly as it was. No HTTP request is made while migrating, no
-- historical attempt is rewritten, and no delivery state is invented for past events.

-- CreateEnum
CREATE TYPE "B2bWebhookDeliveryState" AS ENUM ('PENDING', 'DELIVERED', 'EXHAUSTED');

-- AlterTable
ALTER TABLE "B2bWebhookDeliveryAttempt" ADD COLUMN     "attemptNumber" INTEGER;

-- AlterTable
ALTER TABLE "B2bWebhookEndpoint" ADD COLUMN     "deliverFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "secretCiphertext" TEXT,
ADD COLUMN     "secretSetAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "B2bWebhookDelivery" (
    "id" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "integrationClientId" UUID NOT NULL,
    "endpointId" UUID NOT NULL,
    "state" "B2bWebhookDeliveryState" NOT NULL DEFAULT 'PENDING',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "leaseOwner" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "lastAttemptAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "exhaustedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "B2bWebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "B2bWebhookDelivery_eventId_key" ON "B2bWebhookDelivery"("eventId");

-- CreateIndex
CREATE INDEX "B2bWebhookDelivery_state_nextAttemptAt_idx" ON "B2bWebhookDelivery"("state", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "B2bWebhookDelivery_integrationClientId_state_idx" ON "B2bWebhookDelivery"("integrationClientId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "B2bWebhookDelivery_eventId_integrationClientId_key" ON "B2bWebhookDelivery"("eventId", "integrationClientId");

-- AddForeignKey
ALTER TABLE "B2bWebhookDelivery" ADD CONSTRAINT "B2bWebhookDelivery_eventId_integrationClientId_fkey" FOREIGN KEY ("eventId", "integrationClientId") REFERENCES "B2bOutboxEvent"("id", "integrationClientId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "B2bWebhookDelivery" ADD CONSTRAINT "B2bWebhookDelivery_endpointId_integrationClientId_fkey" FOREIGN KEY ("endpointId", "integrationClientId") REFERENCES "B2bWebhookEndpoint"("id", "integrationClientId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "B2bWebhookDelivery" ADD CONSTRAINT "B2bWebhookDelivery_integrationClientId_fkey" FOREIGN KEY ("integrationClientId") REFERENCES "IntegrationClient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- The endpoints that already existed get the boundary at this instant, so the worker starts with
-- the events that happen from now on and never with the history. New endpoints get the same rule
-- through the column default, which is what stops wiring a webhook months later from unleashing an
-- avalanche of old events.
UPDATE "B2bWebhookEndpoint" SET "deliverFrom" = (now() AT TIME ZONE 'UTC');


-- V1.12-D invariants.

-- The attempt ordinal, when present, is unique per event: two workers cannot mint the same one.
-- Partial, because the V1.12-C attempts predate the counter and are deliberately left as they are.
CREATE UNIQUE INDEX "B2bWebhookDeliveryAttempt_ordinal_key"
  ON "B2bWebhookDeliveryAttempt" ("eventId", "attemptNumber") WHERE "attemptNumber" IS NOT NULL;

ALTER TABLE "B2bWebhookDeliveryAttempt" ADD CONSTRAINT "B2bWebhookDeliveryAttempt_ordinal_check"
  CHECK ("attemptNumber" IS NULL OR "attemptNumber" >= 1);

-- The secret is stored encrypted or not at all. The shape is the one the application writes,
-- `v1:<iv>:<tag>:<ciphertext>` in base64url, so a plaintext secret cannot be slipped into the
-- column by hand: it would have to be forged into this shape, and it still would not decrypt.
ALTER TABLE "B2bWebhookEndpoint" ADD CONSTRAINT "B2bWebhookEndpoint_secret_check"
  CHECK (
    ("secretCiphertext" IS NULL) = ("secretSetAt" IS NULL)
    AND ("secretCiphertext" IS NULL
      OR "secretCiphertext" ~ '^v1:[A-Za-z0-9_-]{16,}:[A-Za-z0-9_-]{16,}:[A-Za-z0-9_-]{8,}$')
  );

-- What a transport state is allowed to look like. Each branch tests IS NOT NULL before comparing:
-- a CHECK that evaluates to NULL is accepted by PostgreSQL, so an incomplete condition would let
-- the impossible row through instead of rejecting it.
ALTER TABLE "B2bWebhookDelivery" ADD CONSTRAINT "B2bWebhookDelivery_values_check"
  CHECK (
    "attemptCount" >= 0
    -- Still owed: it has a next attempt and no ending.
    AND ("state" <> 'PENDING' OR ("nextAttemptAt" IS NOT NULL
      AND "deliveredAt" IS NULL AND "exhaustedAt" IS NULL))
    -- Handed over: it is stamped, it took at least one attempt, and nothing more is scheduled.
    AND ("state" <> 'DELIVERED' OR ("deliveredAt" IS NOT NULL AND "attemptCount" >= 1
      AND "nextAttemptAt" IS NULL AND "exhaustedAt" IS NULL))
    -- Given up: stamped, attempted, and nothing more is scheduled either.
    AND ("state" <> 'EXHAUSTED' OR ("exhaustedAt" IS NOT NULL AND "attemptCount" >= 1
      AND "nextAttemptAt" IS NULL AND "deliveredAt" IS NULL))
    -- A lease is whole or absent; half a lease is what leaves work stuck forever.
    AND (("leaseOwner" IS NULL) = ("leaseExpiresAt" IS NULL))
    AND ("leaseOwner" IS NULL OR char_length("leaseOwner") BETWEEN 1 AND 100)
    -- Nobody holds a lease on something already finished.
    AND ("state" = 'PENDING' OR "leaseOwner" IS NULL)
    AND ("lastAttemptAt" IS NOT NULL) = ("attemptCount" > 0)
  );

-- The transport state may change — that is its whole purpose — but never what it is about. An
-- event's delivery cannot be re-pointed at another event, another client or another endpoint, and
-- a terminal outcome cannot be quietly reopened or rewritten.
CREATE FUNCTION "b2b_webhook_delivery_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF "credit_history_purge_allowed"() THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'B2B_WEBHOOK_DELIVERY_IMMUTABLE: a delivery state is not deleted';
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."eventId" <> OLD."eventId"
    OR NEW."integrationClientId" <> OLD."integrationClientId"
    OR NEW."endpointId" <> OLD."endpointId" OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'B2B_WEBHOOK_DELIVERY_IMMUTABLE: a delivery state cannot change what it is about';
  END IF;
  -- Attempts only ever happened; the count cannot go backwards.
  IF NEW."attemptCount" < OLD."attemptCount" THEN
    RAISE EXCEPTION 'B2B_WEBHOOK_DELIVERY_INVALID: the attempt count cannot go backwards';
  END IF;
  -- A delivered handover is final for the worker: it never reopens and never restamps.
  IF OLD."state" = 'DELIVERED' AND (NEW."state" <> 'DELIVERED'
    OR NEW."deliveredAt" IS DISTINCT FROM OLD."deliveredAt") THEN
    RAISE EXCEPTION 'B2B_WEBHOOK_DELIVERY_IMMUTABLE: a delivered handover cannot be reopened';
  END IF;
  -- Exhaustion can be lifted only by delivering it: an administrator retries and it succeeds.
  IF OLD."state" = 'EXHAUSTED' AND NEW."state" = 'PENDING' THEN
    RAISE EXCEPTION 'B2B_WEBHOOK_DELIVERY_INVALID: an exhausted handover is not rescheduled';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER "B2bWebhookDelivery_guard" BEFORE UPDATE OR DELETE ON "B2bWebhookDelivery"
  FOR EACH ROW EXECUTE FUNCTION "b2b_webhook_delivery_guard"();

CREATE FUNCTION "b2b_webhook_delivery_no_truncate"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'B2B_WEBHOOK_DELIVERY_IMMUTABLE: delivery states cannot be truncated';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "B2bWebhookDelivery_no_truncate" BEFORE TRUNCATE ON "B2bWebhookDelivery"
  FOR EACH STATEMENT EXECUTE FUNCTION "b2b_webhook_delivery_no_truncate"();
