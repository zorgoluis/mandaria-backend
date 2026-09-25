-- V1.12-C B2B Webhook Delivery.
--
-- V1.12-B made `delivery.completed` a durable fact. V1.12-C hands that fact to the client, by
-- POSTing the event Mandaria already recorded to the HTTPS endpoint an administrator configured
-- for that IntegrationClient. The HTTP call never happens inside the completion transaction: the
-- delivery is confirmed and the event committed first, and only then is transport attempted, so a
-- service is delivered even with the client, or the whole internet, unreachable.
--
-- Nothing of V1.12-B changes. The event stays immutable, no event is delivered retroactively by
-- this migration, and no HTTP request is made while migrating: existing events simply have no
-- attempt yet, which is the honest state for them.

-- CreateEnum
CREATE TYPE "B2bWebhookAttemptResult" AS ENUM ('SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "B2bWebhookFailureKind" AS ENUM ('HTTP_STATUS', 'TIMEOUT', 'NETWORK', 'INVALID_ENDPOINT');

-- CreateTable
CREATE TABLE "B2bWebhookEndpoint" (
    "id" UUID NOT NULL,
    "integrationClientId" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdByUserId" UUID NOT NULL,
    "updatedByUserId" UUID NOT NULL,

    CONSTRAINT "B2bWebhookEndpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "B2bWebhookDeliveryAttempt" (
    "id" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "integrationClientId" UUID NOT NULL,
    "endpointId" UUID NOT NULL,
    "endpointUrl" TEXT NOT NULL,
    "attemptedAt" TIMESTAMP(3) NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "result" "B2bWebhookAttemptResult" NOT NULL,
    "httpStatus" INTEGER,
    "failureKind" "B2bWebhookFailureKind",
    "failureDetail" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "B2bWebhookDeliveryAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "B2bWebhookEndpoint_integrationClientId_key" ON "B2bWebhookEndpoint"("integrationClientId");

-- CreateIndex
CREATE UNIQUE INDEX "B2bWebhookEndpoint_id_integrationClientId_key" ON "B2bWebhookEndpoint"("id", "integrationClientId");

-- CreateIndex
CREATE INDEX "B2bWebhookDeliveryAttempt_eventId_attemptedAt_idx" ON "B2bWebhookDeliveryAttempt"("eventId", "attemptedAt");

-- CreateIndex
CREATE INDEX "B2bWebhookDeliveryAttempt_integrationClientId_attemptedAt_i_idx" ON "B2bWebhookDeliveryAttempt"("integrationClientId", "attemptedAt", "id");

-- CreateIndex
CREATE INDEX "B2bWebhookDeliveryAttempt_result_attemptedAt_idx" ON "B2bWebhookDeliveryAttempt"("result", "attemptedAt");

-- CreateIndex
CREATE UNIQUE INDEX "B2bOutboxEvent_id_integrationClientId_key" ON "B2bOutboxEvent"("id", "integrationClientId");

-- AddForeignKey
ALTER TABLE "B2bWebhookEndpoint" ADD CONSTRAINT "B2bWebhookEndpoint_integrationClientId_fkey" FOREIGN KEY ("integrationClientId") REFERENCES "IntegrationClient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "B2bWebhookEndpoint" ADD CONSTRAINT "B2bWebhookEndpoint_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "B2bWebhookEndpoint" ADD CONSTRAINT "B2bWebhookEndpoint_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "B2bWebhookDeliveryAttempt" ADD CONSTRAINT "B2bWebhookDeliveryAttempt_eventId_integrationClientId_fkey" FOREIGN KEY ("eventId", "integrationClientId") REFERENCES "B2bOutboxEvent"("id", "integrationClientId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "B2bWebhookDeliveryAttempt" ADD CONSTRAINT "B2bWebhookDeliveryAttempt_endpointId_integrationClientId_fkey" FOREIGN KEY ("endpointId", "integrationClientId") REFERENCES "B2bWebhookEndpoint"("id", "integrationClientId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "B2bWebhookDeliveryAttempt" ADD CONSTRAINT "B2bWebhookDeliveryAttempt_integrationClientId_fkey" FOREIGN KEY ("integrationClientId") REFERENCES "IntegrationClient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- V1.12-C invariants.

-- Configuration is mutable (that is what configuration is), but never its identity or its owner:
-- an endpoint cannot be moved to another IntegrationClient, which is what would let one client's
-- events reach another's receiver.
ALTER TABLE "B2bWebhookEndpoint" ADD CONSTRAINT "B2bWebhookEndpoint_values_check"
  CHECK (char_length("url") BETWEEN 8 AND 2048 AND "url" ~ '^https?://');

CREATE FUNCTION "b2b_webhook_endpoint_guard"() RETURNS trigger AS $$
BEGIN
  IF NEW."integrationClientId" <> OLD."integrationClientId" OR NEW."id" <> OLD."id"
    OR NEW."createdAt" <> OLD."createdAt" OR NEW."createdByUserId" <> OLD."createdByUserId" THEN
    RAISE EXCEPTION 'B2B_WEBHOOK_ENDPOINT_IMMUTABLE: an endpoint cannot change identity or owner';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER "B2bWebhookEndpoint_guard" BEFORE UPDATE ON "B2bWebhookEndpoint"
  FOR EACH ROW EXECUTE FUNCTION "b2b_webhook_endpoint_guard"();

-- An attempt describes something that already happened, so it is append-only: a FAILED one can
-- never become SUCCEEDED, a 500 can never become a 200, and it can never be re-pointed at another
-- event or endpoint. Same philosophy as the credit ledger and the outbox itself, and the same
-- *_test-only escape hatch reused rather than inventing a second bypass.
ALTER TABLE "B2bWebhookDeliveryAttempt" ADD CONSTRAINT "B2bWebhookDeliveryAttempt_values_check"
  CHECK (
    "durationMs" >= 0
    AND char_length("endpointUrl") BETWEEN 8 AND 2048
    AND ("failureDetail" IS NULL OR char_length("failureDetail") BETWEEN 1 AND 200)
    AND ("httpStatus" IS NULL OR "httpStatus" BETWEEN 100 AND 599)
    -- A success is exactly "the endpoint answered 2xx"; a failure always says why, and only a
    -- failure that reached the endpoint carries a status.
    --
    -- Every branch tests IS NOT NULL before comparing. A CHECK that evaluates to NULL is accepted
    -- by PostgreSQL, so `"httpStatus" BETWEEN 200 AND 299` alone would let a SUCCEEDED attempt
    -- with no status through: three-valued logic makes the whole expression NULL, not false.
    AND (
      ("result" = 'SUCCEEDED' AND "failureKind" IS NULL AND "failureDetail" IS NULL
        AND "httpStatus" IS NOT NULL AND "httpStatus" BETWEEN 200 AND 299)
      OR ("result" = 'FAILED' AND "failureKind" IS NOT NULL
        AND (("failureKind" = 'HTTP_STATUS') = ("httpStatus" IS NOT NULL)))
    )
  );

CREATE FUNCTION "b2b_webhook_attempt_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'B2B_WEBHOOK_ATTEMPT_IMMUTABLE: a delivery attempt is history and never changes';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF "credit_history_purge_allowed"() THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'B2B_WEBHOOK_ATTEMPT_IMMUTABLE: a delivery attempt is history and cannot be deleted';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER "B2bWebhookDeliveryAttempt_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "B2bWebhookDeliveryAttempt"
  FOR EACH ROW EXECUTE FUNCTION "b2b_webhook_attempt_guard"();

CREATE FUNCTION "b2b_webhook_attempt_no_truncate"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'B2B_WEBHOOK_ATTEMPT_IMMUTABLE: delivery attempts cannot be truncated';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "B2bWebhookDeliveryAttempt_no_truncate" BEFORE TRUNCATE ON "B2bWebhookDeliveryAttempt"
  FOR EACH STATEMENT EXECUTE FUNCTION "b2b_webhook_attempt_no_truncate"();
