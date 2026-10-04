BEGIN;
-- Public observation versions, independent of execution phases and client clocks.
CREATE TABLE "PublicDeliveryTracking" (
 "deliveryRequestId" UUID PRIMARY KEY REFERENCES "DeliveryRequest"(id) ON DELETE CASCADE,
 version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0),
 snapshot JSONB,
 "expiryObserved" BOOLEAN NOT NULL DEFAULT false,
 CHECK (snapshot IS NULL OR jsonb_typeof(snapshot)='object')
);
INSERT INTO "PublicDeliveryTracking" ("deliveryRequestId") SELECT id FROM "DeliveryRequest";
CREATE FUNCTION public_tracking_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  INSERT INTO "PublicDeliveryTracking" ("deliveryRequestId") VALUES (NEW.id);
 ELSE
  UPDATE "PublicDeliveryTracking" SET version=version+1,snapshot=NULL WHERE "deliveryRequestId"=NEW.id;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER public_tracking_request AFTER INSERT OR UPDATE ON "DeliveryRequest" FOR EACH ROW EXECUTE FUNCTION public_tracking_request();

-- Conservative invalidation: extra revisions are valid, but a visible change cannot reuse one.
CREATE FUNCTION public_tracking_dispatch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_row jsonb; new_row jsonb; target uuid;
BEGIN
 IF TG_OP<>'INSERT' THEN old_row=to_jsonb(OLD); END IF;
 IF TG_OP<>'DELETE' THEN new_row=to_jsonb(NEW); END IF;
 FOR target IN
  SELECT DISTINCT d."deliveryRequestId" FROM "Dispatch" d WHERE
   (TG_TABLE_NAME='Dispatch' AND d.id IN ((old_row->>'id')::uuid,(new_row->>'id')::uuid)) OR
   (TG_TABLE_NAME<>'Dispatch' AND d.id IN ((old_row->>'dispatchId')::uuid,(new_row->>'dispatchId')::uuid))
  ORDER BY d."deliveryRequestId"
 LOOP
  UPDATE "PublicDeliveryTracking" SET version=version+1,snapshot=NULL WHERE "deliveryRequestId"=target;
 END LOOP;
 -- A deleted Dispatch is no longer available to the lookup above.
 IF TG_TABLE_NAME='Dispatch' AND TG_OP='DELETE' THEN
  UPDATE "PublicDeliveryTracking" SET version=version+1,snapshot=NULL WHERE "deliveryRequestId"=(old_row->>'deliveryRequestId')::uuid;
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER public_tracking_dispatch AFTER INSERT OR UPDATE OR DELETE ON "Dispatch" FOR EACH ROW EXECUTE FUNCTION public_tracking_dispatch();
CREATE TRIGGER public_tracking_candidate AFTER INSERT OR UPDATE OR DELETE ON "DispatchCandidate" FOR EACH ROW EXECUTE FUNCTION public_tracking_dispatch();
CREATE TRIGGER public_tracking_assignment AFTER INSERT OR UPDATE OR DELETE ON "DeliveryAssignment" FOR EACH ROW EXECUTE FUNCTION public_tracking_dispatch();
CREATE TRIGGER public_tracking_execution AFTER INSERT OR UPDATE OR DELETE ON "DeliveryExecution" FOR EACH ROW EXECUTE FUNCTION public_tracking_dispatch();
CREATE TRIGGER public_tracking_incident AFTER INSERT OR UPDATE OR DELETE ON "DeliveryCustodyIncident" FOR EACH ROW EXECUTE FUNCTION public_tracking_dispatch();
CREATE TRIGGER public_tracking_resolution AFTER INSERT OR UPDATE OR DELETE ON "DeliveryCustodyResolution" FOR EACH ROW EXECUTE FUNCTION public_tracking_dispatch();

CREATE FUNCTION public_tracking_identity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid;
BEGIN
 IF TG_TABLE_NAME='Driver' AND to_jsonb(OLD)->'displayName' IS NOT DISTINCT FROM to_jsonb(NEW)->'displayName' THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='DeliveryProvider' AND to_jsonb(OLD)->'name' IS NOT DISTINCT FROM to_jsonb(NEW)->'name' THEN RETURN NEW; END IF;
 FOR target IN
  SELECT DISTINCT d."deliveryRequestId" FROM "Dispatch" d WHERE d.status='CLAIMED' AND (
   (TG_TABLE_NAME='Driver' AND EXISTS(SELECT 1 FROM "DeliveryAssignment" a WHERE a."dispatchId"=d.id AND a.status='ACTIVE' AND a."driverId"=NEW.id)) OR
   (TG_TABLE_NAME='DeliveryProvider' AND (d."claimedByProviderId"=NEW.id OR EXISTS(SELECT 1 FROM "DeliveryAssignment" a WHERE a."dispatchId"=d.id AND a.status='ACTIVE' AND a."providerId"=NEW.id)))
  ) ORDER BY d."deliveryRequestId"
 LOOP
  UPDATE "PublicDeliveryTracking" SET version=version+1,snapshot=NULL WHERE "deliveryRequestId"=target;
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER public_tracking_driver AFTER UPDATE ON "Driver" FOR EACH ROW EXECUTE FUNCTION public_tracking_identity();
CREATE TRIGGER public_tracking_provider AFTER UPDATE ON "DeliveryProvider" FOR EACH ROW EXECUTE FUNCTION public_tracking_identity();
COMMIT;
