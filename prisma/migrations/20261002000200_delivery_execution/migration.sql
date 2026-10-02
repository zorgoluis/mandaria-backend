BEGIN;
CREATE TABLE "DeliveryExecution" (
 "dispatchId" UUID PRIMARY KEY REFERENCES "Dispatch"(id) ON DELETE RESTRICT,
 "chainId" UUID NOT NULL, "assignmentId" UUID NOT NULL REFERENCES "DeliveryAssignment"(id),
 revision INTEGER NOT NULL CHECK(revision >= 0), phase INTEGER NOT NULL DEFAULT 0 CHECK(phase BETWEEN 0 AND 5),
 "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT (clock_timestamp() AT TIME ZONE 'UTC')
);
CREATE TABLE "DeliveryExecutionEvent" (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), "dispatchId" UUID NOT NULL REFERENCES "DeliveryExecution"("dispatchId"),
 "chainId" UUID NOT NULL, "assignmentId" UUID NOT NULL REFERENCES "DeliveryAssignment"(id),
 revision INTEGER NOT NULL, phase INTEGER NOT NULL CHECK(phase BETWEEN 0 AND 5),
 kind TEXT NOT NULL CHECK(kind IN ('ASSIGNED','ADVANCED','INCIDENT','TRANSFER','RETURN','DELIVERED','ENDED')),
 "actorUserId" UUID REFERENCES "User"(id), "actorRole" "Role",
 source TEXT NOT NULL CHECK(source IN ('PHONE_REPORT','SELF_REPORT','ADMIN_RESOLUTION','SYSTEM_CANCELLATION')),
 CHECK (("actorUserId" IS NULL AND "actorRole" IS NULL AND source='SYSTEM_CANCELLATION' AND kind='ENDED') OR ("actorUserId" IS NOT NULL AND "actorRole" IS NOT NULL AND source<>'SYSTEM_CANCELLATION')),
 "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT (clock_timestamp() AT TIME ZONE 'UTC'),
 UNIQUE("dispatchId",revision)
);
CREATE UNIQUE INDEX "ExecutionEvent_hito" ON "DeliveryExecutionEvent"("dispatchId","chainId",phase) WHERE kind='ADVANCED';
CREATE TABLE "DeliveryCustodyIncident" (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), "dispatchId" UUID NOT NULL REFERENCES "DeliveryExecution"("dispatchId"),
 "assignmentId" UUID NOT NULL REFERENCES "DeliveryAssignment"(id), "chainId" UUID NOT NULL,
 "reasonCode" TEXT NOT NULL CHECK("reasonCode" IN ('RECIPIENT_UNAVAILABLE','DELIVERY_REFUSED','VEHICLE_FAILURE','SAFETY_CONCERN','OTHER')),
 "reasonDetail" TEXT NOT NULL CHECK(length(btrim("reasonDetail")) BETWEEN 3 AND 500),
 "reportedByUserId" UUID NOT NULL REFERENCES "User"(id),
 "reportedAt" TIMESTAMP(3) NOT NULL DEFAULT (clock_timestamp() AT TIME ZONE 'UTC'),
 "resolvedAt" TIMESTAMP(3)
);
CREATE UNIQUE INDEX "CustodyIncident_open" ON "DeliveryCustodyIncident"("dispatchId") WHERE "resolvedAt" IS NULL;
CREATE TABLE "DeliveryCustodyResolution" (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), "incidentId" UUID NOT NULL UNIQUE REFERENCES "DeliveryCustodyIncident"(id),
 "dispatchId" UUID NOT NULL REFERENCES "DeliveryExecution"("dispatchId"),
 "fromAssignmentId" UUID NOT NULL UNIQUE REFERENCES "DeliveryAssignment"(id),
 "toAssignmentId" UUID UNIQUE,
 type TEXT NOT NULL CHECK(type IN ('RETURN_TO_ORIGIN','TRANSFER')),
 reason TEXT NOT NULL CHECK(length(btrim(reason)) BETWEEN 3 AND 500),
 "actorUserId" UUID NOT NULL REFERENCES "User"(id),
 "occurredAt" TIMESTAMP(3) NOT NULL, "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT (clock_timestamp() AT TIME ZONE 'UTC'),
 confirmations JSONB NOT NULL,
 CHECK((type='TRANSFER') = ("toAssignmentId" IS NOT NULL)),
 CHECK("occurredAt" <= "recordedAt")
);
ALTER TABLE "DeliveryAssignment" ADD COLUMN "custodyResolutionId" UUID UNIQUE REFERENCES "DeliveryCustodyResolution"(id);
ALTER TABLE "DeliveryCustodyResolution" ADD CONSTRAINT "CustodyResolution_recipient" FOREIGN KEY ("toAssignmentId") REFERENCES "DeliveryAssignment"(id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE "DeliveryExecutionCommand" (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), "dispatchId" UUID NOT NULL REFERENCES "Dispatch"(id),
 "actorUserId" UUID NOT NULL REFERENCES "User"(id), operation TEXT NOT NULL, key UUID NOT NULL,
 hash TEXT NOT NULL, response JSONB NOT NULL,
 "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT (clock_timestamp() AT TIME ZONE 'UTC'),
 UNIQUE("dispatchId","actorUserId",operation,key)
);

CREATE FUNCTION execution_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' AND credit_history_purge_allowed() THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'EXECUTION_IMMUTABLE: execution history cannot be changed';
END $$;
CREATE TRIGGER execution_event_immutable BEFORE UPDATE OR DELETE ON "DeliveryExecutionEvent" FOR EACH ROW EXECUTE FUNCTION execution_history_guard();
CREATE TRIGGER execution_resolution_immutable BEFORE UPDATE OR DELETE ON "DeliveryCustodyResolution" FOR EACH ROW EXECUTE FUNCTION execution_history_guard();
CREATE TRIGGER execution_command_immutable BEFORE UPDATE OR DELETE ON "DeliveryExecutionCommand" FOR EACH ROW EXECUTE FUNCTION execution_history_guard();

-- Events are append-only and ordered; the materialized head is maintained only from these facts.
CREATE FUNCTION execution_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
  IF NOT ((u.role='PROVIDER_ADMIN' AND a.mode='FLEET' AND EXISTS(SELECT 1 FROM "ProviderMembership" WHERE "userId"=u.id AND "providerId"=a."providerId"))
   OR (u.role='DRIVER' AND a.mode='INDEPENDENT' AND EXISTS(SELECT 1 FROM "Driver" WHERE id=a."driverId" AND "userId"=u.id))) THEN RAISE EXCEPTION 'EXECUTION_FORBIDDEN'; END IF;
 ELSIF NEW.kind='ASSIGNED' THEN
  IF e.phase>=3 OR NEW.phase<>0 OR a.status<>'ACTIVE' OR a."custodyResolutionId" IS NOT NULL OR NEW."chainId"<>a.id THEN RAISE EXCEPTION 'CUSTODY_OPERATION_FORBIDDEN'; END IF;
 ELSE
  IF NEW.phase<>e.phase OR NEW."chainId"<>e."chainId" THEN RAISE EXCEPTION 'EXECUTION_CONFLICT'; END IF;
  IF NEW.kind='TRANSFER' THEN
   IF u.role<>'SUPER_ADMIN' OR a.status<>'ACTIVE' OR NOT EXISTS(SELECT 1 FROM "DeliveryCustodyResolution" r JOIN "DeliveryCustodyIncident" i ON i.id=r."incidentId" WHERE r.id=a."custodyResolutionId" AND r."toAssignmentId"=a.id AND r."fromAssignmentId"=e."assignmentId" AND r."dispatchId"=e."dispatchId" AND i."chainId"=e."chainId" AND r.type='TRANSFER') THEN RAISE EXCEPTION 'CUSTODY_TRANSFER_INVALID'; END IF;
  ELSE
   IF a.id<>e."assignmentId" THEN RAISE EXCEPTION 'EXECUTION_CONFLICT'; END IF;
   IF NEW.kind='RETURN' AND (u.role<>'SUPER_ADMIN' OR ds<>'RETURNED' OR a.status<>'RETURNED') THEN RAISE EXCEPTION 'CUSTODY_RETURN_INVALID'; END IF;
   IF NEW.kind='DELIVERED' AND (ds<>'DELIVERED' OR a.status<>'COMPLETED' OR e.phase<>5) THEN RAISE EXCEPTION 'EXECUTION_DELIVERY_INVALID'; END IF;
   IF NEW.kind='INCIDENT' AND NOT EXISTS(SELECT 1 FROM "DeliveryCustodyIncident" WHERE "dispatchId"=e."dispatchId" AND "assignmentId"=a.id AND "resolvedAt" IS NULL AND "reportedByUserId"=u.id) THEN RAISE EXCEPTION 'CUSTODY_INCIDENT_REQUIRED'; END IF;
   IF NEW.kind='ENDED' AND (e.phase>=3 OR a.status NOT IN ('CANCELLED','REASSIGNED')) THEN RAISE EXCEPTION 'EXECUTION_CONFLICT'; END IF;
  END IF;
 END IF;
 UPDATE "DeliveryExecution" SET revision=NEW.revision, phase=NEW.phase,"chainId"=NEW."chainId","assignmentId"=a.id,"recordedAt"=NEW."recordedAt" WHERE "dispatchId"=NEW."dispatchId";
 RETURN NEW;
END $$;
CREATE TRIGGER execution_event_insert BEFORE INSERT ON "DeliveryExecutionEvent" FOR EACH ROW EXECUTE FUNCTION execution_event_guard();
CREATE UNIQUE INDEX "ExecutionEvent_close" ON "DeliveryExecutionEvent"("dispatchId","assignmentId",kind) WHERE kind IN ('ASSIGNED','TRANSFER','RETURN','DELIVERED','ENDED');
CREATE FUNCTION execution_assignment_ended() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e "DeliveryExecution"; u "User";
BEGIN
 IF OLD.status<>'ACTIVE' OR NEW.status NOT IN ('CANCELLED','REASSIGNED') THEN RETURN NEW; END IF;
 SELECT * INTO e FROM "DeliveryExecution" WHERE "dispatchId"=NEW."dispatchId" FOR UPDATE;
 IF NOT FOUND THEN RETURN NEW; END IF;
 SELECT * INTO u FROM "User" WHERE id=NEW."endedByUserId";
 INSERT INTO "DeliveryExecutionEvent" ("dispatchId","chainId","assignmentId",revision,phase,kind,"actorUserId","actorRole",source)
 VALUES (e."dispatchId",e."chainId",NEW.id,e.revision+1,e.phase,'ENDED',u.id,u.role,CASE WHEN u.id IS NULL THEN 'SYSTEM_CANCELLATION' WHEN u.role='SUPER_ADMIN' THEN 'ADMIN_RESOLUTION' WHEN u.role='DRIVER' THEN 'SELF_REPORT' ELSE 'PHONE_REPORT' END);
 RETURN NEW;
END $$;
CREATE TRIGGER execution_assignment_ended AFTER UPDATE ON "DeliveryAssignment" FOR EACH ROW EXECUTE FUNCTION execution_assignment_ended();

-- The final head must have a matching event, even for direct SQL writes.
CREATE FUNCTION execution_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target UUID; e "DeliveryExecution"; a "DeliveryAssignment"; d "Dispatch"; r "DeliveryCustodyResolution"; i "DeliveryCustodyIncident";
BEGIN
 IF credit_history_purge_allowed() THEN RETURN NULL; END IF;
 IF TG_TABLE_NAME='Dispatch' THEN target:=NEW.id;
 ELSE target:=NEW."dispatchId"; END IF;
 SELECT * INTO e FROM "DeliveryExecution" WHERE "dispatchId"=target;
 IF NOT FOUND THEN
  IF EXISTS(SELECT 1 FROM "DeliveryAssignment" WHERE "dispatchId"=target AND "custodyResolutionId" IS NOT NULL)
    OR EXISTS(SELECT 1 FROM "Dispatch" WHERE id=target AND status='RETURNED') THEN RAISE EXCEPTION 'EXECUTION_HEAD_REQUIRED'; END IF;
  RETURN NULL;
 END IF;
 SELECT * INTO STRICT a FROM "DeliveryAssignment" WHERE id=e."assignmentId";
 SELECT * INTO STRICT d FROM "Dispatch" WHERE id=target;
 IF NOT EXISTS(SELECT 1 FROM "DeliveryExecutionEvent" v WHERE v."dispatchId"=target AND v.revision=e.revision AND v.phase=e.phase AND v."chainId"=e."chainId" AND v."assignmentId"=a.id)
  OR a."dispatchId"<>target THEN RAISE EXCEPTION 'EXECUTION_HEAD_INVALID'; END IF;
 IF NOT EXISTS(SELECT 1 FROM "DeliveryExecutionEvent" WHERE "dispatchId"=target AND "chainId"=e."chainId" AND kind='ASSIGNED' AND phase=0)
  OR (SELECT count(*) FROM "DeliveryExecutionEvent" WHERE "dispatchId"=target AND "chainId"=e."chainId" AND kind='ADVANCED' AND phase BETWEEN 1 AND e.phase)<>e.phase
  OR e.revision<>(SELECT max(revision) FROM "DeliveryExecutionEvent" WHERE "dispatchId"=target) THEN RAISE EXCEPTION 'EXECUTION_CHAIN_INVALID'; END IF;
 IF e.phase>=3 AND d.status='CLAIMED' AND (a.status<>'ACTIVE' OR (SELECT count(*) FROM "DeliveryAssignment" WHERE "dispatchId"=target AND status='ACTIVE')<>1) THEN RAISE EXCEPTION 'CUSTODY_OWNER_REQUIRED'; END IF;
 IF e.phase>=3 AND d.status NOT IN ('CLAIMED','DELIVERED','RETURNED') THEN RAISE EXCEPTION 'CUSTODY_OPERATION_FORBIDDEN'; END IF;
 IF d.status='DELIVERED' AND (e.phase<>5 OR a.status<>'COMPLETED' OR EXISTS(SELECT 1 FROM "DeliveryCustodyIncident" WHERE "dispatchId"=target AND "resolvedAt" IS NULL)) THEN RAISE EXCEPTION 'EXECUTION_DELIVERY_INVALID'; END IF;
 FOR r IN SELECT * FROM "DeliveryCustodyResolution" WHERE "dispatchId"=target LOOP
  SELECT * INTO STRICT i FROM "DeliveryCustodyIncident" WHERE id=r."incidentId";
  IF i."dispatchId"<>target OR i."assignmentId"<>r."fromAssignmentId" OR i."resolvedAt" IS NULL
   OR NOT EXISTS(SELECT 1 FROM "DeliveryExecutionEvent" WHERE "dispatchId"=target AND "chainId"=i."chainId" AND kind='ADVANCED' AND phase=3 AND "recordedAt"<=r."occurredAt")
   THEN RAISE EXCEPTION 'CUSTODY_RESOLUTION_INVALID'; END IF;
  IF r.type='TRANSFER' THEN
   IF NOT EXISTS(SELECT 1 FROM "DeliveryAssignment" predecessor JOIN "DeliveryAssignment" dest ON dest.id=r."toAssignmentId"
    WHERE predecessor.id=r."fromAssignmentId" AND predecessor.status='TRANSFERRED' AND dest."dispatchId"=target AND dest."custodyResolutionId"=r.id AND predecessor."driverId"<>dest."driverId" AND dest."assignedAt">=predecessor."assignedAt") THEN RAISE EXCEPTION 'CUSTODY_TRANSFER_INVALID'; END IF;
  ELSE
   IF d.status<>'RETURNED' OR a.status<>'RETURNED' OR a.id<>r."fromAssignmentId" OR d."deliveredAt" IS NOT NULL
    OR EXISTS(SELECT 1 FROM "DeliveryAssignment" WHERE "dispatchId"=target AND status='ACTIVE') THEN RAISE EXCEPTION 'CUSTODY_RETURN_INVALID'; END IF;
  END IF;
 END LOOP;
 IF d.status='RETURNED' AND NOT EXISTS(SELECT 1 FROM "DeliveryCustodyResolution" WHERE "dispatchId"=target AND type='RETURN_TO_ORIGIN') THEN RAISE EXCEPTION 'CUSTODY_RETURN_REQUIRED'; END IF;
 IF d.status='RETURNED' AND NOT EXISTS(SELECT 1 FROM "DeliveryRequest" WHERE id=d."deliveryRequestId" AND status='CANCELLED' AND "cancellationReason"='RETURNED_TO_ORIGIN') THEN RAISE EXCEPTION 'CUSTODY_RETURN_INVALID'; END IF;
 IF EXISTS(SELECT 1 FROM "DeliveryAssignment" x WHERE x."dispatchId"=target AND x.status='TRANSFERRED' AND NOT EXISTS(SELECT 1 FROM "DeliveryCustodyResolution" z WHERE z."fromAssignmentId"=x.id AND z.type='TRANSFER')) THEN RAISE EXCEPTION 'CUSTODY_TRANSFER_REQUIRED'; END IF;
 IF EXISTS(SELECT 1 FROM "DeliveryAssignment" x WHERE x."dispatchId"=target AND x."custodyResolutionId" IS NOT NULL AND NOT EXISTS(SELECT 1 FROM "DeliveryCustodyResolution" z WHERE z.id=x."custodyResolutionId" AND z.type='TRANSFER' AND z."toAssignmentId"=x.id AND z."dispatchId"=target)) THEN RAISE EXCEPTION 'CUSTODY_TRANSFER_REQUIRED'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER execution_head_check AFTER INSERT OR UPDATE ON "DeliveryExecution" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION execution_integrity();
CREATE CONSTRAINT TRIGGER execution_assignment_check AFTER INSERT OR UPDATE ON "DeliveryAssignment" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION execution_integrity();
CREATE CONSTRAINT TRIGGER execution_dispatch_check AFTER INSERT OR UPDATE ON "Dispatch" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION execution_integrity();
CREATE CONSTRAINT TRIGGER execution_resolution_check AFTER INSERT ON "DeliveryCustodyResolution" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION execution_integrity();

CREATE FUNCTION custody_operation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e "DeliveryExecution"; target UUID;
BEGIN
 IF TG_TABLE_NAME='DeliveryAssignment' THEN target:=OLD."dispatchId"; ELSE target:=OLD.id; END IF;
 SELECT * INTO e FROM "DeliveryExecution" WHERE "dispatchId"=target FOR UPDATE;
 IF NOT FOUND OR e.phase<3 THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='DeliveryAssignment' THEN
  IF NEW.status IN ('CANCELLED','REASSIGNED') THEN RAISE EXCEPTION 'CUSTODY_OPERATION_FORBIDDEN'; END IF;
 ELSE
  IF NEW.status IN ('OPEN','EXPIRED','CANCELLED') OR NEW."claimedByProviderId" IS DISTINCT FROM OLD."claimedByProviderId" OR NEW."claimedByIndependentDriverId" IS DISTINCT FROM OLD."claimedByIndependentDriverId" THEN RAISE EXCEPTION 'CUSTODY_OPERATION_FORBIDDEN'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER custody_assignment_guard BEFORE UPDATE ON "DeliveryAssignment" FOR EACH ROW EXECUTE FUNCTION custody_operation_guard();
CREATE TRIGGER custody_dispatch_guard BEFORE UPDATE ON "Dispatch" FOR EACH ROW EXECUTE FUNCTION custody_operation_guard();
-- Further replacements below retain the prior guards and add narrow, relational exceptions.

CREATE OR REPLACE FUNCTION "dispatch_guard"() RETURNS trigger AS $$
DECLARE quote_status "DeliveryQuoteStatus"; quote_request UUID;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT "status", "deliveryRequestId" INTO quote_status, quote_request
      FROM "DeliveryQuote" WHERE "id" = NEW."deliveryQuoteId";
    IF NEW."status" <> 'OPEN' OR quote_status IS DISTINCT FROM 'ACCEPTED'
      OR quote_request IS DISTINCT FROM NEW."deliveryRequestId" THEN
      RAISE EXCEPTION 'DISPATCH_INVALID: dispatch must open for an ACCEPTED quote of its request';
    END IF;
    IF NEW."deliveredAt" IS NOT NULL OR NEW."deliveredByUserId" IS NOT NULL THEN
      RAISE EXCEPTION 'DISPATCH_INVALID: a dispatch cannot open already delivered';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."deliveryRequestId" <> OLD."deliveryRequestId" OR NEW."deliveryQuoteId" <> OLD."deliveryQuoteId"
    OR NEW."openedAt" <> OLD."openedAt" OR NEW."expiresAt" <> OLD."expiresAt" OR NEW."createdAt" <> OLD."createdAt"
  THEN
    RAISE EXCEPTION 'DISPATCH_IMMUTABLE: dispatch identity and window cannot change';
  END IF;
  IF NEW."status" <> OLD."status" AND NOT (
    (OLD."status" = 'OPEN' AND NEW."status" IN ('CLAIMED', 'EXPIRED', 'CANCELLED'))
    OR (OLD."status" = 'CLAIMED' AND NEW."status" IN ('OPEN', 'EXPIRED', 'CANCELLED', 'DELIVERED', 'RETURNED'))
  ) THEN
    RAISE EXCEPTION 'DISPATCH_IMMUTABLE: invalid status transition';
  END IF;
  IF OLD."status" IN ('EXPIRED', 'CANCELLED', 'DELIVERED', 'RETURNED') THEN
    RAISE EXCEPTION 'DISPATCH_IMMUTABLE: resolved dispatches cannot change';
  END IF;
  -- The delivery stamp belongs to the transition that writes it: it appears exactly once, with the
  -- claim owner untouched, and can never be rewritten or cleared afterwards.
  IF OLD."deliveredAt" IS NOT NULL OR OLD."deliveredByUserId" IS NOT NULL THEN
    RAISE EXCEPTION 'DISPATCH_IMMUTABLE: the delivery record cannot change';
  END IF;
  IF NEW."status" = 'DELIVERED' AND (
    NEW."claimedByProviderId" IS DISTINCT FROM OLD."claimedByProviderId"
    OR NEW."claimedByIndependentDriverId" IS DISTINCT FROM OLD."claimedByIndependentDriverId"
    OR NEW."claimedAt" IS DISTINCT FROM OLD."claimedAt"
  ) THEN
    RAISE EXCEPTION 'DISPATCH_INVALID: a delivery keeps the actor that was awarded the service';
  END IF;
  IF NEW."status" <> 'DELIVERED' AND (NEW."deliveredAt" IS NOT NULL OR NEW."deliveredByUserId" IS NOT NULL) THEN
    RAISE EXCEPTION 'DISPATCH_INVALID: only a delivered dispatch carries a delivery record';
  END IF;
  IF NEW."status" = 'CLAIMED' AND NEW."claimedByProviderId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "DispatchCandidate" c WHERE c."dispatchId" = NEW."id"
      AND c."providerId" = NEW."claimedByProviderId" AND c."status" = 'CLAIMED'
  ) THEN
    RAISE EXCEPTION 'DISPATCH_INVALID: claim owner must be a CLAIMED candidate';
  END IF;
  IF NEW."status" = 'CLAIMED' AND OLD."status" <> 'CLAIMED' AND NEW."claimedByIndependentDriverId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "IndependentDriverProfile" p
      WHERE p."driverId" = NEW."claimedByIndependentDriverId" AND p."status" = 'APPROVED'
  ) THEN
    RAISE EXCEPTION 'DISPATCH_INVALID: independent claim owner must be an APPROVED independent driver';
  END IF;
  IF OLD."status" = 'CLAIMED' AND NEW."status" <> 'CLAIMED' AND EXISTS (
    SELECT 1 FROM "DeliveryAssignment" a WHERE a."dispatchId" = NEW."id" AND a."status" = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'DISPATCH_HAS_ACTIVE_ASSIGNMENT: end the active delivery assignment first';
  END IF;
  -- A delivery is the end of a service that was really dispatched to a driver and a vehicle.
  IF NEW."status" = 'DELIVERED' AND NOT EXISTS (
    SELECT 1 FROM "DeliveryAssignment" a
     WHERE a."dispatchId" = NEW."id" AND a."status" = 'COMPLETED' AND a."endedAt" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'DISPATCH_INVALID: a delivered dispatch must close its delivery assignment';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION "delivery_assignment_guard"() RETURNS trigger AS $$
DECLARE
  d_status "DispatchStatus"; d_provider UUID; d_independent UUID;
  v_provider UUID; v_independent UUID; dr_provider UUID;
  p_driver UUID; p_status "IndependentDriverStatus";
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT "status", "claimedByProviderId", "claimedByIndependentDriverId"
      INTO d_status, d_provider, d_independent
      FROM "Dispatch" WHERE "id" = NEW."dispatchId";
    IF NEW."status" <> 'ACTIVE' OR d_status IS DISTINCT FROM 'CLAIMED' THEN
      RAISE EXCEPTION 'DELIVERY_ASSIGNMENT_INVALID: assignments are ACTIVE for a CLAIMED dispatch';
    END IF;
    SELECT "providerId", "independentDriverProfileId" INTO v_provider, v_independent
      FROM "Vehicle" WHERE "id" = NEW."vehicleId";
    IF NEW."mode" = 'FLEET' THEN
      SELECT "providerId" INTO dr_provider FROM "Driver" WHERE "id" = NEW."driverId";
      IF d_provider IS DISTINCT FROM NEW."providerId" AND NEW."custodyResolutionId" IS NULL THEN
        RAISE EXCEPTION 'DELIVERY_ASSIGNMENT_INVALID: assignments are ACTIVE for a dispatch CLAIMED by the same provider';
      END IF;
      IF dr_provider IS DISTINCT FROM NEW."providerId" OR v_provider IS DISTINCT FROM NEW."providerId" THEN
        RAISE EXCEPTION 'DELIVERY_ASSIGNMENT_INVALID: driver and vehicle must belong to the provider';
      END IF;
    ELSE
      SELECT "driverId", "status" INTO p_driver, p_status
        FROM "IndependentDriverProfile" WHERE "id" = NEW."independentDriverProfileId";
      IF p_status IS DISTINCT FROM 'APPROVED' OR p_driver IS DISTINCT FROM NEW."driverId" THEN
        RAISE EXCEPTION 'DELIVERY_ASSIGNMENT_INVALID: independent profile must be APPROVED and own the driver';
      END IF;
      IF d_independent IS DISTINCT FROM NEW."driverId" AND NEW."custodyResolutionId" IS NULL THEN
        RAISE EXCEPTION 'DELIVERY_ASSIGNMENT_INVALID: assignments are ACTIVE for a dispatch CLAIMED by the same independent driver';
      END IF;
      IF v_independent IS DISTINCT FROM NEW."independentDriverProfileId" THEN
        RAISE EXCEPTION 'DELIVERY_ASSIGNMENT_INVALID: vehicle must belong to the independent driver';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."custodyResolutionId" IS DISTINCT FROM OLD."custodyResolutionId" OR NEW."dispatchId" <> OLD."dispatchId" OR NEW."mode" <> OLD."mode"
    OR NEW."providerId" IS DISTINCT FROM OLD."providerId"
    OR NEW."independentDriverProfileId" IS DISTINCT FROM OLD."independentDriverProfileId"
    OR NEW."driverId" <> OLD."driverId" OR NEW."vehicleId" <> OLD."vehicleId"
    OR NEW."assignedAt" <> OLD."assignedAt" OR NEW."assignedByUserId" <> OLD."assignedByUserId"
    OR NEW."createdAt" <> OLD."createdAt"
  THEN
    RAISE EXCEPTION 'DELIVERY_ASSIGNMENT_IMMUTABLE: assignment history cannot be overwritten';
  END IF;
  IF OLD."status" <> 'ACTIVE' THEN
    RAISE EXCEPTION 'DELIVERY_ASSIGNMENT_IMMUTABLE: ended assignments cannot change';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION "dispatch_award_refund_required"() RETURNS trigger AS $$
DECLARE
  account_id UUID;
  award RECORD;
BEGIN
  IF OLD."status" <> 'CLAIMED' THEN
    RETURN NULL;
  END IF;
  IF NEW."status" IN ('DELIVERED', 'RETURNED') THEN
    RETURN NULL;
  END IF;
  -- Nothing to settle while the same actor still holds the service (an assignment change, for
  -- example, leaves the claim exactly where it was).
  IF NEW."status" = 'CLAIMED'
    AND NEW."claimedByProviderId" IS NOT DISTINCT FROM OLD."claimedByProviderId"
    AND NEW."claimedByIndependentDriverId" IS NOT DISTINCT FROM OLD."claimedByIndependentDriverId" THEN
    RETURN NULL;
  END IF;
  SELECT a."id" INTO account_id FROM "CreditAccount" a
   WHERE (OLD."claimedByProviderId" IS NOT NULL AND a."providerId" = OLD."claimedByProviderId")
      OR (OLD."claimedByIndependentDriverId" IS NOT NULL
          AND a."independentDriverProfileId" = (SELECT "id" FROM "IndependentDriverProfile" WHERE "driverId" = OLD."claimedByIndependentDriverId"));
  IF account_id IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT "id" INTO award FROM "CreditLedgerEntry"
   WHERE "type" = 'SERVICE_AWARD' AND "referenceId" = OLD."id" AND "creditAccountId" = account_id;
  -- No award means this service was never charged (LEGACY or a pre-enforcement claim): there is
  -- nothing to give back and no credit is invented.
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "CreditLedgerEntry"
     WHERE "type" = 'SERVICE_REFUND' AND "reversesEntryId" = award."id"
  ) THEN
    RAISE EXCEPTION 'CREDIT_REFUND_REQUIRED: dispatch % was reversed without returning the credits of its award', OLD."id";
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION "dispatch_public_execution_guard"() RETURNS trigger AS $$
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
       AND (a."custodyResolutionId" IS NOT NULL OR (a.mode = 'FLEET' AND a."providerId" = NEW."claimedByProviderId")
         OR (a.mode = 'INDEPENDENT' AND a."driverId" = NEW."claimedByIndependentDriverId"));
    NEW."publicExecutionSnapshot" := identity;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
ALTER TABLE "DeliveryAssignment" DROP CONSTRAINT "DeliveryAssignment_values_check";
ALTER TABLE "DeliveryAssignment" ADD CONSTRAINT "DeliveryAssignment_values_check"
  CHECK (
    ("status" = 'ACTIVE' AND "endedAt" IS NULL AND "endedByUserId" IS NULL
      AND "endReason" IS NULL AND "endReasonDetail" IS NULL)
    OR ("status" IN ('REASSIGNED', 'CANCELLED') AND "endedAt" IS NOT NULL AND "endReason" IS NOT NULL
      AND "endedAt" >= "assignedAt")
    OR ("status" IN ('COMPLETED', 'TRANSFERRED', 'RETURNED') AND "endedAt" IS NOT NULL AND "endedByUserId" IS NOT NULL
      AND "endReason" IS NULL AND "endReasonDetail" IS NULL AND "endedAt" >= "assignedAt")
  );

CREATE OR REPLACE VIEW "dispatch_operational_awards" AS
 SELECT c."dispatchId", 'PROVIDER'::"CreditAccountOwnerType" AS "actorType", c."providerId" AS "actorId", c."claimedAt" AS "awardedAt" FROM "DispatchCandidate" c WHERE c."claimedAt" IS NOT NULL
 UNION ALL SELECT x."dispatchId", 'INDEPENDENT_DRIVER'::"CreditAccountOwnerType", x."driverId", x."assignedAt" FROM "DeliveryAssignment" x WHERE x.mode='INDEPENDENT' AND x."custodyResolutionId" IS NULL;
DROP INDEX "DeliveryAssignment_independent_award_key";
CREATE UNIQUE INDEX "DeliveryAssignment_independent_award_key" ON "DeliveryAssignment"("dispatchId","driverId") WHERE mode='INDEPENDENT' AND "custodyResolutionId" IS NULL;
CREATE FUNCTION custody_resolution_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i "DeliveryCustodyIncident"; e "DeliveryExecution";
BEGIN
 SELECT * INTO STRICT i FROM "DeliveryCustodyIncident" WHERE id=NEW."incidentId" FOR UPDATE;
 SELECT * INTO STRICT e FROM "DeliveryExecution" WHERE "dispatchId"=NEW."dispatchId" FOR UPDATE;
 IF i."resolvedAt" IS NOT NULL OR i."dispatchId"<>e."dispatchId" OR i."assignmentId"<>e."assignmentId" OR NEW."fromAssignmentId"<>e."assignmentId" OR e.phase<3
  OR NOT EXISTS(SELECT 1 FROM "User" WHERE id=NEW."actorUserId" AND active AND role='SUPER_ADMIN') THEN RAISE EXCEPTION 'CUSTODY_RESOLUTION_INVALID'; END IF;
 IF NEW.type='TRANSFER' THEN
  IF NEW.confirmations->>'releasingCustodianConfirmed' IS DISTINCT FROM 'true' OR NEW.confirmations->>'receivingCustodianConfirmed' IS DISTINCT FROM 'true' OR NEW.confirmations->>'atCurrentStageLocation' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'CUSTODY_CONFIRMATION_REQUIRED'; END IF;
 ELSE
  IF NEW.confirmations->>'custodianConfirmed' IS DISTINCT FROM 'true' OR NEW.confirmations->>'originConfirmed' IS DISTINCT FROM 'true'
    OR COALESCE(length(btrim(NEW.confirmations->>'originContactLabel')),0) NOT BETWEEN 1 AND 100
    OR COALESCE(length(btrim(NEW.confirmations->>'originContactRole')),0) NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'CUSTODY_CONFIRMATION_REQUIRED'; END IF;
 END IF;
 IF NEW.confirmations->>'confirmationMethod' IS DISTINCT FROM 'PHONE' THEN RAISE EXCEPTION 'CUSTODY_CONFIRMATION_REQUIRED'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER custody_resolution_insert BEFORE INSERT ON "DeliveryCustodyResolution" FOR EACH ROW EXECUTE FUNCTION custody_resolution_guard();
CREATE FUNCTION custody_incident_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e "DeliveryExecution";
BEGIN
 IF TG_OP='DELETE' THEN
  IF credit_history_purge_allowed() THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'EXECUTION_IMMUTABLE';
 END IF;
 IF TG_OP='UPDATE' THEN
  IF OLD."resolvedAt" IS NOT NULL OR NEW."resolvedAt" IS NULL OR (to_jsonb(NEW)-'resolvedAt') IS DISTINCT FROM (to_jsonb(OLD)-'resolvedAt')
   OR NOT EXISTS(SELECT 1 FROM "DeliveryCustodyResolution" WHERE "incidentId"=OLD.id) THEN RAISE EXCEPTION 'EXECUTION_IMMUTABLE'; END IF;
  RETURN NEW;
 END IF;
 SELECT * INTO STRICT e FROM "DeliveryExecution" WHERE "dispatchId"=NEW."dispatchId" FOR UPDATE;
 IF e.phase<3 OR NEW."chainId"<>e."chainId" OR NEW."assignmentId"<>e."assignmentId" OR NEW."resolvedAt" IS NOT NULL
   OR NOT EXISTS(SELECT 1 FROM "Dispatch" WHERE id=e."dispatchId" AND status='CLAIMED') THEN RAISE EXCEPTION 'CUSTODY_INCIDENT_REQUIRED'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER custody_incident_write BEFORE INSERT OR UPDATE OR DELETE ON "DeliveryCustodyIncident" FOR EACH ROW EXECUTE FUNCTION custody_incident_guard();
CREATE TRIGGER execution_head_delete BEFORE DELETE ON "DeliveryExecution" FOR EACH ROW EXECUTE FUNCTION execution_history_guard();
CREATE TRIGGER execution_head_truncate BEFORE TRUNCATE ON "DeliveryExecution" EXECUTE FUNCTION execution_history_guard();
CREATE TRIGGER execution_event_truncate BEFORE TRUNCATE ON "DeliveryExecutionEvent" EXECUTE FUNCTION execution_history_guard();
CREATE TRIGGER execution_incident_truncate BEFORE TRUNCATE ON "DeliveryCustodyIncident" EXECUTE FUNCTION execution_history_guard();
CREATE TRIGGER execution_resolution_truncate BEFORE TRUNCATE ON "DeliveryCustodyResolution" EXECUTE FUNCTION execution_history_guard();
CREATE TRIGGER execution_command_truncate BEFORE TRUNCATE ON "DeliveryExecutionCommand" EXECUTE FUNCTION execution_history_guard();
COMMIT;
