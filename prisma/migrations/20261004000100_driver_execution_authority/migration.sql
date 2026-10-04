-- New authority; historical facts remain immutable.
CREATE OR REPLACE FUNCTION execution_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e "DeliveryExecution"; a "DeliveryAssignment"; u "User"; ds "DispatchStatus";
BEGIN
 SELECT * INTO STRICT e FROM "DeliveryExecution" WHERE "dispatchId"=NEW."dispatchId" FOR UPDATE;
 SELECT * INTO STRICT a FROM "DeliveryAssignment" WHERE id=NEW."assignmentId";
 IF NEW."actorUserId" IS NOT NULL THEN SELECT * INTO STRICT u FROM "User" WHERE id=NEW."actorUserId"; END IF;
 SELECT status INTO ds FROM "Dispatch" WHERE id=NEW."dispatchId";
 IF NOT u.active OR u.role<>NEW."actorRole" OR a."dispatchId"<>NEW."dispatchId" OR NEW.revision<>e.revision+1 THEN
  RAISE EXCEPTION 'EXECUTION_CONFLICT';
 END IF;
 IF NEW."actorUserId" IS NULL AND (NEW.kind<>'ENDED' OR a."endedByUserId" IS NOT NULL) THEN RAISE EXCEPTION 'EXECUTION_FORBIDDEN'; END IF;
 IF NEW.kind='ADVANCED' THEN
  IF ds<>'CLAIMED' OR a.status<>'ACTIVE' OR e."assignmentId"<>a.id OR NEW."chainId"<>e."chainId" OR NEW.phase<>e.phase+1
   OR EXISTS(SELECT 1 FROM "DeliveryCustodyIncident" WHERE "dispatchId"=e."dispatchId" AND "resolvedAt" IS NULL) THEN RAISE EXCEPTION 'EXECUTION_TRANSITION_INVALID'; END IF;
  IF NOT (u.role='DRIVER' AND EXISTS(SELECT 1 FROM "Driver" WHERE id=a."driverId" AND "userId"=u.id AND (a.mode='INDEPENDENT' OR "providerId"=a."providerId"))) THEN RAISE EXCEPTION 'EXECUTION_FORBIDDEN'; END IF;
 ELSIF NEW.kind='ASSIGNED' THEN
  IF e.phase>=3 OR NEW.phase<>0 OR a.status<>'ACTIVE' OR a."custodyResolutionId" IS NOT NULL OR NEW."chainId"<>a.id THEN RAISE EXCEPTION 'CUSTODY_OPERATION_FORBIDDEN'; END IF;
 ELSE
  IF NEW.phase<>e.phase OR NEW."chainId"<>e."chainId" THEN RAISE EXCEPTION 'EXECUTION_CONFLICT'; END IF;
  IF NEW.kind='TRANSFER' THEN
   IF u.role<>'SUPER_ADMIN' OR a.status<>'ACTIVE' OR NOT EXISTS(SELECT 1 FROM "DeliveryCustodyResolution" r JOIN "DeliveryCustodyIncident" i ON i.id=r."incidentId" WHERE r.id=a."custodyResolutionId" AND r."toAssignmentId"=a.id AND r."fromAssignmentId"=e."assignmentId" AND r."dispatchId"=e."dispatchId" AND i."chainId"=e."chainId" AND r.type='TRANSFER') THEN RAISE EXCEPTION 'CUSTODY_TRANSFER_INVALID'; END IF;
  ELSE
   IF a.id<>e."assignmentId" THEN RAISE EXCEPTION 'EXECUTION_CONFLICT'; END IF;
   IF NEW.kind='RETURN' AND (u.role<>'SUPER_ADMIN' OR ds<>'RETURNED' OR a.status<>'RETURNED') THEN RAISE EXCEPTION 'CUSTODY_RETURN_INVALID'; END IF;
   IF NEW.kind='DELIVERED' AND (u.role<>'DRIVER' OR NOT EXISTS(SELECT 1 FROM "Driver" WHERE id=a."driverId" AND "userId"=u.id) OR ds<>'DELIVERED' OR a.status<>'COMPLETED' OR e.phase<>5) THEN RAISE EXCEPTION 'EXECUTION_DELIVERY_INVALID'; END IF;
   IF NEW.kind='INCIDENT' AND NOT EXISTS(SELECT 1 FROM "DeliveryCustodyIncident" WHERE "dispatchId"=e."dispatchId" AND "assignmentId"=a.id AND "resolvedAt" IS NULL AND "reportedByUserId"=u.id) THEN RAISE EXCEPTION 'CUSTODY_INCIDENT_REQUIRED'; END IF;
   IF NEW.kind='ENDED' AND (e.phase>=3 OR a.status NOT IN ('CANCELLED','REASSIGNED')) THEN RAISE EXCEPTION 'EXECUTION_CONFLICT'; END IF;
  END IF;
 END IF;
 UPDATE "DeliveryExecution" SET revision=NEW.revision, phase=NEW.phase,"chainId"=NEW."chainId","assignmentId"=a.id,"recordedAt"=NEW."recordedAt" WHERE "dispatchId"=NEW."dispatchId";
 RETURN NEW;
END $$;

ALTER TABLE "DeliveryExecutionCommand" DROP CONSTRAINT execution_command_state;
ALTER TABLE "DeliveryExecutionCommand" ADD CONSTRAINT execution_command_state CHECK (state='APPLIED' OR (state='CLOSED_NO_EFFECTS' AND (operation ~ '^RESOLVE:[0-9a-fA-F-]{36}$' OR operation ~ '^APP_(ADVANCE|REPORT|DELIVER):[0-9a-f-]{36}$') AND hash='' AND response='{}'::jsonb));

-- Preserve uncertain pre-upgrade driver responses in the new assignment-scoped namespace.
-- Append aliases; never UPDATE/DELETE immutable historical receipts.
INSERT INTO "DeliveryExecutionCommand" ("dispatchId","actorUserId",operation,key,hash,response,state)
SELECT c."dispatchId",c."actorUserId",'APP_'||c.operation||':'||a.id::text,c.key,c.hash,c.response,c.state
FROM "DeliveryExecutionCommand" c
JOIN "DeliveryAssignment" a ON a."dispatchId"=c."dispatchId" AND a.id::text=CASE
 WHEN c.operation='ADVANCE' THEN c.response->>'activeAssignmentId'
 WHEN c.operation='REPORT' THEN c.response->'execution'->>'activeAssignmentId' END
JOIN "Driver" d ON d.id=a."driverId" AND d."userId"=c."actorUserId"
WHERE c.operation IN ('ADVANCE','REPORT') AND c.state='APPLIED';
