CREATE TABLE "HumanCommandAttempt" (
 "id" UUID PRIMARY KEY,
 "namespace" TEXT NOT NULL,
 "ownerId" UUID NOT NULL,
 "actorUserId" UUID NOT NULL REFERENCES "User"(id) ON DELETE RESTRICT,
 "key" TEXT NOT NULL,
 "operation" TEXT NOT NULL,
 "resource" TEXT NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "closedAt" TIMESTAMP(3),
 "routingEffectsPossible" BOOLEAN NOT NULL DEFAULT false,
 CONSTRAINT human_attempt_shape CHECK (
   length(key) BETWEEN 8 AND 255 AND namespace IN ('CUSTOMER','POLICY')
   AND (namespace='CUSTOMER' AND operation IN ('delivery_prequotes.create','delivery_prequotes.convert','delivery_quotes.accept_authorized')
     OR namespace='POLICY' AND operation='shipping.policy' AND "ownerId"="actorUserId")
   AND (NOT "routingEffectsPossible" OR operation='delivery_prequotes.create')
 )
);
CREATE UNIQUE INDEX "HumanCommandAttempt_namespace_ownerId_key_key" ON "HumanCommandAttempt"("namespace","ownerId","key");
ALTER TABLE "PrequoteConsumptionPermit" ADD COLUMN "humanAttemptId" UUID;
ALTER TABLE "PrequoteConsumptionPermit" ADD CONSTRAINT "PrequoteConsumptionPermit_humanAttemptId_fkey" FOREIGN KEY ("humanAttemptId") REFERENCES "HumanCommandAttempt"(id) ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE FUNCTION human_attempt_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'HUMAN_ATTEMPT_IMMUTABLE'; END IF;
 IF ROW(NEW.id,NEW.namespace,NEW."ownerId",NEW."actorUserId",NEW.key,NEW.operation,NEW.resource,NEW."createdAt") IS DISTINCT FROM ROW(OLD.id,OLD.namespace,OLD."ownerId",OLD."actorUserId",OLD.key,OLD.operation,OLD.resource,OLD."createdAt") OR (OLD."closedAt" IS NOT NULL AND NEW."closedAt" IS DISTINCT FROM OLD."closedAt") OR (OLD."routingEffectsPossible" AND NOT NEW."routingEffectsPossible") THEN RAISE EXCEPTION 'HUMAN_ATTEMPT_IMMUTABLE'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER human_attempt_immutable BEFORE UPDATE OR DELETE ON "HumanCommandAttempt" FOR EACH ROW EXECUTE FUNCTION human_attempt_immutable();
CREATE FUNCTION human_permit_binding() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='UPDATE' AND NEW."humanAttemptId" IS DISTINCT FROM OLD."humanAttemptId" THEN RAISE EXCEPTION 'PERMIT_ATTEMPT_IMMUTABLE'; END IF;
 IF NEW."humanAttemptId" IS NOT NULL AND NOT EXISTS(SELECT 1 FROM "HumanCommandAttempt" a WHERE a.id=NEW."humanAttemptId" AND a.namespace='CUSTOMER' AND a.operation='delivery_prequotes.create' AND a."ownerId"=NEW."customerAccountId" AND NEW."integrationClientId" IS NULL) THEN RAISE EXCEPTION 'PERMIT_ATTEMPT_OWNER'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER human_permit_binding BEFORE INSERT OR UPDATE ON "PrequoteConsumptionPermit" FOR EACH ROW EXECUTE FUNCTION human_permit_binding();
