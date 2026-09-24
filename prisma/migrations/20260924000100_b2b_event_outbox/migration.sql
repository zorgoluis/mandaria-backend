-- V1.12-B Durable B2B Event Outbox.
--
-- V1.12-A let a B2B client ask "is my delivery done?". V1.12-B records the answer as a durable
-- fact: when a delivery reaches DELIVERED, a `delivery.completed` event is written in the very
-- transaction that completes it. Either both land or neither does. Nothing here sends anything:
-- transport (webhooks, retries, signatures) belongs to a later version, so this table has no
-- transport state at all — the row existing *is* the fact.
--
-- No existing row changes: no historical Dispatch is touched and no event is created for a
-- delivery that already happened. Those stay observable through V1.12-A, which is why they need no
-- fabricated event with an invented timestamp.

-- CreateEnum
CREATE TYPE "B2bEventType" AS ENUM ('DELIVERY_COMPLETED');

-- CreateTable
CREATE TABLE "B2bOutboxEvent" (
    "id" UUID NOT NULL,
    "type" "B2bEventType" NOT NULL,
    "integrationClientId" UUID NOT NULL,
    "deliveryRequestId" UUID NOT NULL,
    "dispatchId" UUID,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "payload" JSONB NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "B2bOutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "B2bOutboxEvent_integrationClientId_occurredAt_id_idx" ON "B2bOutboxEvent"("integrationClientId", "occurredAt", "id");

-- CreateIndex
CREATE INDEX "B2bOutboxEvent_type_occurredAt_idx" ON "B2bOutboxEvent"("type", "occurredAt");

-- CreateIndex
CREATE INDEX "B2bOutboxEvent_deliveryRequestId_idx" ON "B2bOutboxEvent"("deliveryRequestId");

-- CreateIndex: the composite keys the event's foreign keys point at, so ownership and subject are
-- verified by PostgreSQL instead of trusted from the service layer.
CREATE UNIQUE INDEX "DeliveryRequest_id_integrationClientId_key" ON "DeliveryRequest"("id", "integrationClientId");

-- CreateIndex
CREATE UNIQUE INDEX "Dispatch_id_deliveryRequestId_key" ON "Dispatch"("id", "deliveryRequestId");

-- AddForeignKey
ALTER TABLE "B2bOutboxEvent" ADD CONSTRAINT "B2bOutboxEvent_integrationClientId_fkey" FOREIGN KEY ("integrationClientId") REFERENCES "IntegrationClient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: (request, owner) as one unit. An event cannot be attributed to an
-- IntegrationClient that does not own the DeliveryRequest, whatever the service layer passes.
ALTER TABLE "B2bOutboxEvent" ADD CONSTRAINT "B2bOutboxEvent_deliveryRequestId_integrationClientId_fkey" FOREIGN KEY ("deliveryRequestId", "integrationClientId") REFERENCES "DeliveryRequest"("id", "integrationClientId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: (dispatch, request) as one unit, so an event can never point at a Dispatch that
-- belongs to a different DeliveryRequest.
ALTER TABLE "B2bOutboxEvent" ADD CONSTRAINT "B2bOutboxEvent_dispatchId_deliveryRequestId_fkey" FOREIGN KEY ("dispatchId", "deliveryRequestId") REFERENCES "Dispatch"("id", "deliveryRequestId") ON DELETE RESTRICT ON UPDATE CASCADE;


-- V1.12-B invariants.

-- The payload is the V1.12-A public contract and nothing else. Declared as a function because a
-- CHECK cannot contain a subquery, and keeping it here means the shape is enforced by the database
-- rather than hoped for: exactly the seven public keys, none of the internal identifiers, and a
-- snapshot that actually says the delivery was completed. Widening the public contract therefore
-- requires a migration, which is the point: it is a versioned promise to external systems.
CREATE FUNCTION "b2b_delivery_completed_payload_ok"(p JSONB) RETURNS boolean AS $$
  SELECT jsonb_typeof(p) = 'object'
     AND (SELECT count(*) FROM jsonb_object_keys(p)) = 7
     AND p ?& ARRAY['publicId', 'externalReference', 'status', 'execution', 'requestedAt', 'deliveredAt', 'cancelledAt']
     AND p->>'status' = 'DELIVERED'
     AND p->>'publicId' IS NOT NULL
     AND p->>'deliveredAt' IS NOT NULL;
$$ LANGUAGE sql IMMUTABLE;

-- A DELIVERY_COMPLETED is always about a Dispatch, carries the public snapshot, and its
-- `occurredAt` IS the `deliveredAt` inside that snapshot: one clock, read once, never two readings
-- that drift by milliseconds. Timestamps are stored in UTC, so the ISO string converts back exactly.
--
-- `recordedAt` is deliberately not compared against `occurredAt`. It carries the project-wide
-- `@default(now())`, which PostgreSQL renders as CURRENT_TIMESTAMP in the server's own time zone,
-- while every timestamp Prisma writes is UTC: the two only agree because Prisma supplies the value
-- itself. Turning that into a constraint would make raw inserts fail for a reason that has nothing
-- to do with the event.
ALTER TABLE "B2bOutboxEvent" ADD CONSTRAINT "B2bOutboxEvent_values_check"
  CHECK (
    ("type" <> 'DELIVERY_COMPLETED' OR (
      "dispatchId" IS NOT NULL
      AND "b2b_delivery_completed_payload_ok"("payload")
      AND (("payload"->>'deliveredAt')::timestamptz AT TIME ZONE 'UTC') = "occurredAt"
    ))
  );

-- At most one DELIVERY_COMPLETED per Dispatch, and since a DeliveryRequest has at most one Dispatch
-- (one ACCEPTED quote, one Dispatch per quote) that is "at most one per delivery". A partial index
-- per one-shot event type, rather than a blanket unique on (request, type), because most future
-- events repeat: a service can be claimed and released many times. Adding `delivery.released` later
-- needs no redesign — and no index.
CREATE UNIQUE INDEX "B2bOutboxEvent_delivery_completed_key"
  ON "B2bOutboxEvent" ("dispatchId") WHERE "type" = 'DELIVERY_COMPLETED';

-- A recorded event is a historical fact: it never changes and it is never deleted. Same philosophy
-- as CreditLedgerEntry and DispatchCreditSnapshot, and the same *_test-only escape hatch, reused
-- deliberately instead of inventing a second bypass: fixtures need to clean up, production must not
-- be able to. Both foreign keys are RESTRICT, so nothing cascades events away either.
CREATE FUNCTION "b2b_outbox_event_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'B2B_EVENT_IMMUTABLE: a recorded B2B event never changes';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF "credit_history_purge_allowed"() THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'B2B_EVENT_IMMUTABLE: a recorded B2B event is history and cannot be deleted';
  END IF;
  -- INSERT: a completion event is only written by the transaction that completes the delivery.
  -- `xmin` of the Dispatch row is compared with the current transaction id, exactly as the V1.10-C
  -- snapshot guard does, so an event cannot be fabricated afterwards for a delivery that already
  -- closed, nor announced before it happens.
  IF NEW."type" = 'DELIVERY_COMPLETED' THEN
    IF NOT EXISTS (
      SELECT 1 FROM "Dispatch" d
       WHERE d."id" = NEW."dispatchId"
         AND d."status" = 'DELIVERED'
         AND d."deliveredAt" = NEW."occurredAt"
         AND d.xmin::text = (pg_current_xact_id()::text::bigint % 4294967296)::text
    ) THEN
      RAISE EXCEPTION 'B2B_EVENT_INVALID: delivery.completed is only recorded by the transaction that delivers its dispatch';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER "B2bOutboxEvent_guard" BEFORE INSERT OR UPDATE OR DELETE ON "B2bOutboxEvent"
  FOR EACH ROW EXECUTE FUNCTION "b2b_outbox_event_guard"();

CREATE FUNCTION "b2b_outbox_event_no_truncate"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'B2B_EVENT_IMMUTABLE: recorded B2B events cannot be truncated';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "B2bOutboxEvent_no_truncate" BEFORE TRUNCATE ON "B2bOutboxEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION "b2b_outbox_event_no_truncate"();

-- The enforcement boundary, and the reason no column was added to Dispatch for it: this constraint
-- trigger fires on the *transition* into DELIVERED, so it can only ever see deliveries completed
-- from now on. Dispatches that were already DELIVERED never transition again — `dispatch_guard`
-- forbids changing a resolved dispatch — so they are outside the rule by construction, with no
-- flag, no backfill and none of the ambiguity the V1.10-C/D boundary needed a column to resolve.
-- Deferred to COMMIT so the completion can write the assignment, the dispatch and the event in the
-- order its own guards demand; if the event is missing or fails, the whole delivery rolls back.
CREATE FUNCTION "b2b_delivery_completed_required"() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Dispatch" WHERE "id" = NEW."id" AND "status" = 'DELIVERED') THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "B2bOutboxEvent"
     WHERE "dispatchId" = NEW."id" AND "type" = 'DELIVERY_COMPLETED'
  ) THEN
    RAISE EXCEPTION 'B2B_EVENT_REQUIRED: dispatch % was delivered without recording delivery.completed', NEW."id";
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "Dispatch_b2b_delivery_completed_required"
  AFTER UPDATE ON "Dispatch"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (NEW."status" = 'DELIVERED' AND OLD."status" IS DISTINCT FROM 'DELIVERED')
  EXECUTE FUNCTION "b2b_delivery_completed_required"();
