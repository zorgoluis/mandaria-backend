-- V1.12-E Webhook Operations & Observability.
--
-- This version adds no delivery machinery: it makes what already exists answerable. Two things are
-- needed in the database for that, and nothing else.

-- The administrative listing walks every client's events, newest first, with a stable tiebreak.
-- The per-client index already existed and is not duplicated.
CREATE INDEX "B2bOutboxEvent_occurredAt_id_idx" ON "B2bOutboxEvent"("occurredAt", "id");

-- V1.12-D refused to move an exhausted handover back to PENDING, to stop it being silently
-- resurrected. V1.12-E gives an administrator a deliberate, audited way to do exactly that, so the
-- prohibition becomes a narrower one: the transition is allowed, but only into a well-formed
-- PENDING row — which the values check already demands means a scheduled next attempt and no
-- ending stamp. Everything else the guard protects is untouched: identity, ownership, the attempt
-- count that only grows, and a delivered handover that never reopens.
CREATE OR REPLACE FUNCTION "b2b_webhook_delivery_guard"() RETURNS trigger AS $$
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
  -- Attempts only ever happened; the count cannot go backwards, so a rescue never erases history.
  IF NEW."attemptCount" < OLD."attemptCount" THEN
    RAISE EXCEPTION 'B2B_WEBHOOK_DELIVERY_INVALID: the attempt count cannot go backwards';
  END IF;
  -- A delivered handover is final for the worker: it never reopens and never restamps.
  IF OLD."state" = 'DELIVERED' AND (NEW."state" <> 'DELIVERED'
    OR NEW."deliveredAt" IS DISTINCT FROM OLD."deliveredAt") THEN
    RAISE EXCEPTION 'B2B_WEBHOOK_DELIVERY_IMMUTABLE: a delivered handover cannot be reopened';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
