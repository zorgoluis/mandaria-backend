-- GPS is independent of economic/operational history. Only the latest sample is retained.
CREATE TABLE "DeliveryLocationHead" (
 "deliveryRequestId" uuid PRIMARY KEY REFERENCES "DeliveryRequest"(id) ON DELETE CASCADE,
 version bigint NOT NULL DEFAULT 1 CHECK(version>0),
 generation bigint NOT NULL DEFAULT 1 CHECK(generation>0),
 "streamRevision" bigint NOT NULL DEFAULT 1 CHECK("streamRevision">0),
 "streamId" uuid, "streamStartedAt" timestamp(3),
 "lastSequence" integer NOT NULL DEFAULT 0 CHECK("lastSequence">=0),
 "sampleHash" text, sample jsonb, "eraseAfter" timestamp(3),
 "openReceipt" jsonb,
 CHECK ((sample IS NULL AND "sampleHash" IS NULL AND "eraseAfter" IS NULL) OR
        (sample IS NOT NULL AND "sampleHash" IS NOT NULL AND "eraseAfter" IS NOT NULL)),
 CHECK(sample IS NULL OR (jsonb_typeof(sample)='object'
   AND (sample->>'latitude')::double precision BETWEEN -90 AND 90
   AND (sample->>'longitude')::double precision BETWEEN -180 AND 180
   AND (sample->>'accuracyMeters')::double precision > 0
   AND (sample->>'accuracyMeters')::double precision <= 100))
);
CREATE INDEX "Location_expiry" ON "DeliveryLocationHead"("eraseAfter") WHERE sample IS NOT NULL;
CREATE TABLE "DeliveryTrackingLinkHead" (
 "deliveryRequestId" uuid PRIMARY KEY REFERENCES "DeliveryRequest"(id) ON DELETE CASCADE,
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 selector text UNIQUE, "secretHash" text, "createdAt" timestamp(3), "expiresAt" timestamp(3), "revokedAt" timestamp(3),
 receipt jsonb,
 CHECK ("secretHash" IS NULL OR selector IS NOT NULL),
 CHECK("expiresAt" IS NULL OR ("createdAt" IS NOT NULL AND "expiresAt">"createdAt" AND "expiresAt"<="createdAt"+interval '24 hours'))
);
CREATE TABLE "LocationRateBucket" (
 key text PRIMARY KEY, count integer NOT NULL CHECK(count>0), "expiresAt" timestamp(3) NOT NULL
);
CREATE INDEX "LocationRateBucket_expiry" ON "LocationRateBucket"("expiresAt");
INSERT INTO "DeliveryLocationHead"("deliveryRequestId") SELECT id FROM "DeliveryRequest";
INSERT INTO "DeliveryTrackingLinkHead"("deliveryRequestId") SELECT id FROM "DeliveryRequest";
CREATE FUNCTION location_initialize() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO "DeliveryLocationHead"("deliveryRequestId") VALUES(NEW.id);
 INSERT INTO "DeliveryTrackingLinkHead"("deliveryRequestId") VALUES(NEW.id);
 RETURN NEW;
END $$;
CREATE TRIGGER location_initialize AFTER INSERT ON "DeliveryRequest" FOR EACH ROW EXECUTE FUNCTION location_initialize();
-- Invalidation executes inside the writer transaction, including writers predating GPS.
CREATE FUNCTION location_invalidate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE rid uuid; clear_sample boolean := true;
BEGIN
 IF TG_TABLE_NAME='DeliveryRequest' THEN rid:=NEW.id;
 ELSIF TG_TABLE_NAME='Dispatch' THEN rid:=NEW."deliveryRequestId";
 ELSE SELECT "deliveryRequestId" INTO rid FROM "Dispatch" WHERE id=NEW."dispatchId";
 END IF;
 IF TG_TABLE_NAME='DeliveryExecution' AND TG_OP='UPDATE' THEN
   clear_sample:=NEW."assignmentId" IS DISTINCT FROM OLD."assignmentId";
 END IF;
 IF clear_sample THEN
  UPDATE "DeliveryLocationHead" SET version=version+1,generation=generation+1,
   "streamRevision"="streamRevision"+1,"streamId"=NULL,"streamStartedAt"=NULL,
   sample=NULL,"sampleHash"=NULL,"eraseAfter"=NULL,"lastSequence"=0,"openReceipt"=NULL
   WHERE "deliveryRequestId"=rid;
 ELSE UPDATE "DeliveryLocationHead" SET version=version+1 WHERE "deliveryRequestId"=rid;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER location_request AFTER UPDATE OF status ON "DeliveryRequest" FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION location_invalidate();
CREATE TRIGGER location_dispatch AFTER UPDATE OF status ON "Dispatch" FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION location_invalidate();
CREATE TRIGGER location_assignment AFTER INSERT OR UPDATE OF status ON "DeliveryAssignment" FOR EACH ROW EXECUTE FUNCTION location_invalidate();
CREATE TRIGGER location_execution AFTER INSERT OR UPDATE ON "DeliveryExecution" FOR EACH ROW EXECUTE FUNCTION location_invalidate();
CREATE TRIGGER location_incident AFTER INSERT OR UPDATE ON "DeliveryCustodyIncident" FOR EACH ROW EXECUTE FUNCTION location_invalidate();
