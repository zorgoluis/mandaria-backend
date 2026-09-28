-- Additive public presentation identity. Existing names are NOT copied or inferred.
ALTER TABLE "Driver" ADD COLUMN "displayName" VARCHAR(100);
ALTER TABLE "Driver" ADD CONSTRAINT "Driver_displayName_check"
  CHECK ("displayName" IS NULL OR (char_length(btrim("displayName")) BETWEEN 1 AND 100 AND "displayName" = btrim("displayName")));
ALTER TABLE "Dispatch" ADD COLUMN "publicExecutionSnapshot" JSONB;

-- Captured by the very UPDATE that closes the dispatch, after the ACTIVE assignment was
-- completed under the dispatch lock. One SELECT observes both presentation profiles coherently.
-- No backfill: historical deliveries without public evidence retain NULL forever.
CREATE FUNCTION "dispatch_public_execution_guard"() RETURNS trigger AS $$
DECLARE identity JSONB;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."publicExecutionSnapshot" IS NOT NULL THEN
      RAISE EXCEPTION 'PUBLIC_EXECUTION_INVALID: snapshot only exists at completion';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."publicExecutionSnapshot" IS DISTINCT FROM OLD."publicExecutionSnapshot" THEN
    RAISE EXCEPTION 'PUBLIC_EXECUTION_IMMUTABLE: snapshot is server generated';
  END IF;
  IF OLD.status = 'CLAIMED' AND NEW.status = 'DELIVERED' THEN
    SELECT jsonb_build_object(
      'mode', CASE WHEN a.mode = 'FLEET' THEN 'PROVIDER' ELSE 'INDEPENDENT' END,
      'provider', CASE WHEN a.mode = 'FLEET' AND nullif(btrim(p.name), '') IS NOT NULL
        THEN jsonb_build_object('displayName', p.name) ELSE 'null'::jsonb END,
      'driver', CASE WHEN d."displayName" IS NOT NULL
        THEN jsonb_build_object('displayName', d."displayName") ELSE 'null'::jsonb END)
      INTO STRICT identity
      FROM "DeliveryAssignment" a JOIN "Driver" d ON d.id = a."driverId"
      LEFT JOIN "DeliveryProvider" p ON p.id = a."providerId"
     WHERE a."dispatchId" = NEW.id AND a.status = 'COMPLETED'
       AND a."endedAt" = NEW."deliveredAt" AND a."endedByUserId" = NEW."deliveredByUserId"
       AND ((a.mode = 'FLEET' AND a."providerId" = NEW."claimedByProviderId")
         OR (a.mode = 'INDEPENDENT' AND a."driverId" = NEW."claimedByIndependentDriverId"));
    NEW."publicExecutionSnapshot" := identity;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "Dispatch_public_execution_guard" BEFORE INSERT OR UPDATE ON "Dispatch"
  FOR EACH ROW EXECUTE FUNCTION "dispatch_public_execution_guard"();

-- The existing outbox guards, immutable payload, uniqueness and deferred requirement remain.
-- New completion events must carry exactly the identity frozen by the dispatch transition.
CREATE FUNCTION "b2b_public_execution_guard"() RETURNS trigger AS $$
DECLARE identity JSONB;
BEGIN
  IF NEW.type = 'DELIVERY_COMPLETED' THEN
    SELECT "publicExecutionSnapshot" INTO identity FROM "Dispatch" WHERE id = NEW."dispatchId";
    IF identity IS NULL OR NEW.payload->'execution' IS DISTINCT FROM identity THEN
      RAISE EXCEPTION 'PUBLIC_EXECUTION_MISMATCH: event must match completed dispatch identity';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "B2bOutboxEvent_public_execution_guard" BEFORE INSERT ON "B2bOutboxEvent"
  FOR EACH ROW EXECUTE FUNCTION "b2b_public_execution_guard"();
