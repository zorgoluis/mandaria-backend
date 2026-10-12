BEGIN;
LOCK TABLE "CustomerAccount", "DeliveryRequest", "DirectRequestLifecycle" IN ACCESS EXCLUSIVE MODE;
-- AlterTable
ALTER TABLE "CustomerAccount" ADD COLUMN     "businessAccessState" TEXT NOT NULL DEFAULT 'NONE',
ADD COLUMN     "businessReapplicationBlockedByGrantId" UUID;

-- CreateTable
CREATE TABLE "BusinessApplication" (
    "id" UUID NOT NULL,
    "customerAccountId" UUID NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "snapshot" JSONB NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "publicReason" TEXT,
    "internalNote" TEXT,
    "decisionActorId" UUID,

    CONSTRAINT "BusinessApplication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessAccessGrant" (
    "id" UUID NOT NULL,
    "customerAccountId" UUID NOT NULL,
    "applicationId" UUID NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'MANUAL_ADMIN',
    "grantedByUserId" UUID NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "revokedAt" TIMESTAMP(3),
    "revocationCause" TEXT,
    "publicReason" TEXT,

    CONSTRAINT "BusinessAccessGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessAccessEvent" (
    "id" UUID NOT NULL,
    "customerAccountId" UUID NOT NULL,
    "actorUserId" UUID,
    "operation" TEXT NOT NULL,
    "applicationId" UUID,
    "grantId" UUID,
    "previousRevision" INTEGER NOT NULL,
    "accountRevision" INTEGER NOT NULL,
    "publicReason" TEXT,
    "internalNote" TEXT,
    "receiptId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BusinessAccessEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessCommandReceipt" (
    "id" UUID NOT NULL,
    "namespace" TEXT NOT NULL,
    "ownerId" UUID NOT NULL,
    "customerAccountId" UUID NOT NULL,
    "actorUserId" UUID NOT NULL,
    "key" VARCHAR(255) NOT NULL,
    "operation" TEXT NOT NULL,
    "target" UUID,
    "requestHash" CHAR(64),
    "outcome" TEXT NOT NULL,
    "code" TEXT,
    "httpStatus" INTEGER NOT NULL,
    "resourceId" UUID,
    "result" JSONB NOT NULL,
    "committedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BusinessCommandReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessPolicyCutover" (
    "version" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BusinessPolicyCutover_pkey" PRIMARY KEY ("version")
);

-- CreateTable
CREATE TABLE "BusinessAdmissionEvidence" (
    "deliveryRequestId" UUID NOT NULL,
    "customerAccountId" UUID NOT NULL,
    "basis" TEXT NOT NULL,
    "cutoverId" INTEGER,
    "grantId" UUID,
    "accountRevision" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BusinessAdmissionEvidence_pkey" PRIMARY KEY ("deliveryRequestId")
);

-- CreateIndex
CREATE INDEX "BusinessApplication_customerAccountId_submittedAt_idx" ON "BusinessApplication"("customerAccountId", "submittedAt");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessAccessGrant_applicationId_key" ON "BusinessAccessGrant"("applicationId");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessAccessEvent_receiptId_key" ON "BusinessAccessEvent"("receiptId");

-- CreateIndex
CREATE INDEX "BusinessAccessEvent_customerAccountId_createdAt_idx" ON "BusinessAccessEvent"("customerAccountId", "createdAt");

-- CreateIndex
CREATE INDEX "BusinessCommandReceipt_customerAccountId_committedAt_idx" ON "BusinessCommandReceipt"("customerAccountId", "committedAt");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessCommandReceipt_namespace_ownerId_key_key" ON "BusinessCommandReceipt"("namespace", "ownerId", "key");
-- Ownership and structural constraints supplement the Prisma scalar models.
ALTER TABLE "CustomerAccount" ADD CONSTRAINT business_access_state CHECK ("businessAccessState" IN ('NONE','REVIEW_REQUIRED','ACTIVE','RESTRICTED'));
ALTER TABLE "BusinessApplication" ADD CONSTRAINT business_application_account FOREIGN KEY ("customerAccountId") REFERENCES "CustomerAccount"(id), ADD CONSTRAINT business_application_state CHECK (status IN ('PENDING','APPROVED','REJECTED','WITHDRAWN')), ADD CONSTRAINT business_application_resolution CHECK ((status='PENDING' AND "resolvedAt" IS NULL AND revision=1) OR (status<>'PENDING' AND "resolvedAt" IS NOT NULL AND revision=2)), ADD CONSTRAINT business_application_pair UNIQUE(id,"customerAccountId");
CREATE UNIQUE INDEX business_one_pending ON "BusinessApplication"("customerAccountId") WHERE status='PENDING';
ALTER TABLE "BusinessAccessGrant" ADD CONSTRAINT business_grant_application FOREIGN KEY ("applicationId","customerAccountId") REFERENCES "BusinessApplication"(id,"customerAccountId"), ADD CONSTRAINT business_grant_pair UNIQUE(id,"customerAccountId"), ADD CONSTRAINT business_grant_actor FOREIGN KEY("grantedByUserId") REFERENCES "User"(id), ADD CONSTRAINT business_grant_state CHECK ((status='ACTIVE' AND "revokedAt" IS NULL AND "revocationCause" IS NULL) OR (status='REVOKED' AND "revokedAt" IS NOT NULL AND "revocationCause" IN ('ADMIN_REVOCATION','VOLUNTARY_DOWNGRADE'))), ADD CONSTRAINT business_grant_source CHECK(source='MANUAL_ADMIN');
CREATE UNIQUE INDEX business_one_active_grant ON "BusinessAccessGrant"("customerAccountId") WHERE status='ACTIVE';
ALTER TABLE "CustomerAccount" ADD CONSTRAINT business_block_grant FOREIGN KEY ("businessReapplicationBlockedByGrantId",id) REFERENCES "BusinessAccessGrant"(id,"customerAccountId") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "BusinessCommandReceipt" ADD CONSTRAINT business_receipt_account FOREIGN KEY("customerAccountId") REFERENCES "CustomerAccount"(id), ADD CONSTRAINT business_receipt_actor FOREIGN KEY("actorUserId") REFERENCES "User"(id), ADD CONSTRAINT business_receipt_outcome CHECK(outcome IN ('APPLIED','REJECTED','CLOSED')), ADD CONSTRAINT business_receipt_namespace CHECK ((namespace='BUSINESS_CUSTOMER' AND "ownerId"="customerAccountId" AND operation IN ('SUBMIT','WITHDRAW','DOWNGRADE')) OR (namespace='BUSINESS_ADMIN' AND "ownerId"="actorUserId" AND operation IN ('DECIDE','REVOKE','ALLOW_REAPPLICATION'))), ADD CONSTRAINT business_receipt_hash CHECK ((outcome='CLOSED' AND "requestHash" IS NULL AND code='BUSINESS_ATTEMPT_CLOSED') OR (outcome<>'CLOSED' AND "requestHash" IS NOT NULL)), ADD CONSTRAINT business_receipt_pair UNIQUE(id,"customerAccountId");
ALTER TABLE "BusinessAccessEvent" ADD CONSTRAINT business_event_account FOREIGN KEY("customerAccountId") REFERENCES "CustomerAccount"(id), ADD CONSTRAINT business_event_application FOREIGN KEY("applicationId","customerAccountId") REFERENCES "BusinessApplication"(id,"customerAccountId"), ADD CONSTRAINT business_event_grant FOREIGN KEY("grantId","customerAccountId") REFERENCES "BusinessAccessGrant"(id,"customerAccountId"), ADD CONSTRAINT business_event_receipt FOREIGN KEY("receiptId","customerAccountId") REFERENCES "BusinessCommandReceipt"(id,"customerAccountId") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "BusinessAdmissionEvidence" ADD CONSTRAINT business_admission_request FOREIGN KEY("deliveryRequestId") REFERENCES "DeliveryRequest"(id), ADD CONSTRAINT business_admission_account FOREIGN KEY("customerAccountId") REFERENCES "CustomerAccount"(id), ADD CONSTRAINT business_admission_grant FOREIGN KEY("grantId","customerAccountId") REFERENCES "BusinessAccessGrant"(id,"customerAccountId"), ADD CONSTRAINT business_admission_cutover FOREIGN KEY("cutoverId") REFERENCES "BusinessPolicyCutover"(version) DEFERRABLE INITIALLY DEFERRED, ADD CONSTRAINT business_admission_basis CHECK ((basis='PRE_REVIEW_COMMITMENT' AND "cutoverId"=1 AND "grantId" IS NULL) OR (basis='MANUAL_GRANT' AND "cutoverId" IS NULL AND "grantId" IS NOT NULL));
ALTER TABLE "BusinessPolicyCutover" ADD CONSTRAINT business_cutover_version CHECK(version=1);
-- Durable cutover; no application or grant is fabricated for existing accounts.
INSERT INTO "BusinessAccessEvent"(id,"customerAccountId",operation,"previousRevision","accountRevision") SELECT gen_random_uuid(),id,'LEGACY_REVIEW',revision,revision+1 FROM "CustomerAccount" WHERE type='BUSINESS';
INSERT INTO "BusinessAdmissionEvidence"("deliveryRequestId","customerAccountId",basis,"cutoverId","accountRevision") SELECT l."deliveryRequestId",c.id,'PRE_REVIEW_COMMITMENT',1,c.revision FROM "CustomerAccount" c JOIN "DirectRequestLifecycle" l ON l."customerAccountId"=c.id JOIN "PrequoteConversion" pc ON pc."deliveryRequestId"=l."deliveryRequestId" WHERE c.type='BUSINESS' AND l."closedAt" IS NULL;
UPDATE "CustomerAccount" SET "businessAccessState"='REVIEW_REQUIRED',revision=revision+1 WHERE type='BUSINESS';
INSERT INTO "BusinessPolicyCutover"(version) VALUES(1);

CREATE FUNCTION business_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'BUSINESS_HISTORY_IMMUTABLE'; END $$;
CREATE TRIGGER business_receipt_immutable BEFORE UPDATE OR DELETE ON "BusinessCommandReceipt" FOR EACH ROW EXECUTE FUNCTION business_immutable();
CREATE TRIGGER business_event_immutable BEFORE UPDATE OR DELETE ON "BusinessAccessEvent" FOR EACH ROW EXECUTE FUNCTION business_immutable();
CREATE TRIGGER business_evidence_immutable BEFORE UPDATE OR DELETE ON "BusinessAdmissionEvidence" FOR EACH ROW EXECUTE FUNCTION business_immutable();
CREATE TRIGGER business_cutover_immutable BEFORE UPDATE OR DELETE ON "BusinessPolicyCutover" FOR EACH ROW EXECUTE FUNCTION business_immutable();
CREATE FUNCTION business_application_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'BUSINESS_HISTORY_IMMUTABLE'; END IF;
 PERFORM id FROM "CustomerAccount" WHERE id=NEW."customerAccountId" FOR UPDATE;
 IF TG_OP='UPDATE' AND (OLD.status<>'PENDING' OR NEW.id<>OLD.id OR NEW."customerAccountId"<>OLD."customerAccountId" OR NEW.snapshot<>OLD.snapshot OR NEW."submittedAt"<>OLD."submittedAt" OR NEW.status='PENDING') THEN RAISE EXCEPTION 'BUSINESS_HISTORY_IMMUTABLE'; END IF;
 IF TG_OP='INSERT' AND (NEW.status<>'PENDING' OR EXISTS(SELECT 1 FROM "CustomerAccount" WHERE id=NEW."customerAccountId" AND ("businessAccessState"='ACTIVE' OR "businessReapplicationBlockedByGrantId" IS NOT NULL))) THEN RAISE EXCEPTION 'BUSINESS_APPLICATION_FORBIDDEN'; END IF;
 IF NEW.status='APPROVED' AND (EXISTS(SELECT 1 FROM "DirectRequestLifecycle" WHERE "customerAccountId"=NEW."customerAccountId" AND "closedAt" IS NULL) OR EXISTS(SELECT 1 FROM "CustomerAccount" WHERE id=NEW."customerAccountId" AND "businessReapplicationBlockedByGrantId" IS NOT NULL)) THEN RAISE EXCEPTION 'CUSTOMER_ACTIVE_REQUESTS'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER business_application_guard BEFORE INSERT OR UPDATE OR DELETE ON "BusinessApplication" FOR EACH ROW EXECUTE FUNCTION business_application_guard();
CREATE FUNCTION business_grant_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'BUSINESS_HISTORY_IMMUTABLE'; END IF;
 PERFORM id FROM "CustomerAccount" WHERE id=NEW."customerAccountId" FOR UPDATE;
 IF TG_OP='INSERT' AND NEW.status<>'ACTIVE' THEN RAISE EXCEPTION 'BUSINESS_GRANT_INVALID'; END IF;
 IF TG_OP='UPDATE' AND (OLD.status<>'ACTIVE' OR NEW.status<>'REVOKED' OR NEW.id<>OLD.id OR NEW."customerAccountId"<>OLD."customerAccountId" OR NEW."applicationId"<>OLD."applicationId" OR NEW."grantedAt"<>OLD."grantedAt" OR NEW."grantedByUserId"<>OLD."grantedByUserId" OR NEW.source<>OLD.source) THEN RAISE EXCEPTION 'BUSINESS_HISTORY_IMMUTABLE'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER business_grant_guard BEFORE INSERT OR UPDATE OR DELETE ON "BusinessAccessGrant" FOR EACH ROW EXECUTE FUNCTION business_grant_guard();
-- Every commercial mutation must have a matching immutable command/event at commit.
CREATE FUNCTION business_consistency() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cid uuid; c "CustomerAccount"; r "BusinessCommandReceipt"; a "BusinessApplication"; g "BusinessAccessGrant";
BEGIN
 cid := CASE WHEN TG_TABLE_NAME='CustomerAccount' THEN (to_jsonb(NEW)->>'id')::uuid ELSE (to_jsonb(NEW)->>'customerAccountId')::uuid END;
 SELECT * INTO c FROM "CustomerAccount" WHERE id=cid;
 SELECT * INTO g FROM "BusinessAccessGrant" WHERE "customerAccountId"=cid AND status='ACTIVE';
 IF (c.type='PERSONAL' AND (c."businessAccessState"<>'NONE' OR g.id IS NOT NULL)) OR (c.type='BUSINESS' AND c."businessAccessState"='NONE') OR (c."businessAccessState"='ACTIVE' AND g.id IS NULL) OR (g.id IS NOT NULL AND c."businessAccessState"<>'ACTIVE') THEN RAISE EXCEPTION 'BUSINESS_ACCESS_INCONSISTENT'; END IF;
 IF c."businessAccessState"='REVIEW_REQUIRED' AND NOT EXISTS(SELECT 1 FROM "BusinessAccessEvent" WHERE "customerAccountId"=cid AND operation='LEGACY_REVIEW') THEN RAISE EXCEPTION 'BUSINESS_REVIEW_EVIDENCE_REQUIRED'; END IF;
 IF c."businessAccessState"='RESTRICTED' AND NOT EXISTS(SELECT 1 FROM "BusinessAccessEvent" e WHERE e."customerAccountId"=cid AND (e.operation='REVOKE' OR (e.operation='DECIDE' AND EXISTS(SELECT 1 FROM "BusinessApplication" app WHERE app.id=e."applicationId" AND app.status='REJECTED')))) THEN RAISE EXCEPTION 'BUSINESS_RESTRICTION_EVIDENCE_REQUIRED'; END IF;
 IF c."businessReapplicationBlockedByGrantId" IS NOT NULL AND NOT EXISTS(SELECT 1 FROM "BusinessAccessGrant" WHERE id=c."businessReapplicationBlockedByGrantId" AND "customerAccountId"=cid AND status='REVOKED' AND "revocationCause"='ADMIN_REVOCATION') THEN RAISE EXCEPTION 'BUSINESS_BLOCK_INVALID'; END IF;
 IF EXISTS(SELECT 1 FROM "BusinessAccessGrant" blocked_grant WHERE blocked_grant."customerAccountId"=cid AND blocked_grant."revocationCause"='ADMIN_REVOCATION' AND c."businessReapplicationBlockedByGrantId" IS DISTINCT FROM blocked_grant.id AND NOT EXISTS(SELECT 1 FROM "BusinessAccessEvent" allowed_event WHERE allowed_event."grantId"=blocked_grant.id AND allowed_event.operation='ALLOW_REAPPLICATION')) THEN RAISE EXCEPTION 'BUSINESS_READMISSION_REQUIRED'; END IF;
 IF TG_TABLE_NAME='CustomerAccount' AND TG_OP='UPDATE' THEN
  IF (NEW.type,NEW."businessAccessState",NEW."businessReapplicationBlockedByGrantId") IS DISTINCT FROM (OLD.type,OLD."businessAccessState",OLD."businessReapplicationBlockedByGrantId") AND NOT EXISTS(SELECT 1 FROM "BusinessAccessEvent" e JOIN "BusinessCommandReceipt" x ON x.id=e."receiptId" WHERE e."customerAccountId"=cid AND e."previousRevision"=OLD.revision AND e."accountRevision"=NEW.revision AND x.outcome='APPLIED' AND NEW.revision=OLD.revision+1) THEN RAISE EXCEPTION 'BUSINESS_COMMAND_REQUIRED'; END IF;
  IF OLD."businessReapplicationBlockedByGrantId" IS NOT NULL AND NEW."businessReapplicationBlockedByGrantId" IS NULL AND NOT EXISTS(SELECT 1 FROM "BusinessAccessEvent" WHERE "customerAccountId"=cid AND operation='ALLOW_REAPPLICATION' AND "grantId"=OLD."businessReapplicationBlockedByGrantId" AND "previousRevision"=OLD.revision AND "accountRevision"=NEW.revision) THEN RAISE EXCEPTION 'BUSINESS_READMISSION_REQUIRED'; END IF;
 END IF;
 IF TG_TABLE_NAME='BusinessApplication' THEN
  IF NOT EXISTS(SELECT 1 FROM "BusinessAccessEvent" e JOIN "BusinessCommandReceipt" x ON x.id=e."receiptId" WHERE e."applicationId"=NEW.id AND x.outcome='APPLIED' AND ((NEW.status='PENDING' AND e.operation='SUBMIT') OR (NEW.status='WITHDRAWN' AND e.operation IN ('WITHDRAW','DOWNGRADE')) OR (NEW.status IN ('APPROVED','REJECTED') AND e.operation='DECIDE'))) THEN RAISE EXCEPTION 'BUSINESS_COMMAND_REQUIRED'; END IF;
  IF NEW.status='APPROVED' AND NOT EXISTS(SELECT 1 FROM "BusinessAccessGrant" WHERE "applicationId"=NEW.id) THEN RAISE EXCEPTION 'BUSINESS_GRANT_REQUIRED'; END IF;
 END IF;
 IF TG_TABLE_NAME='BusinessAccessGrant' THEN
  SELECT * INTO a FROM "BusinessApplication" WHERE id=NEW."applicationId";
  IF a.status<>'APPROVED' OR a."customerAccountId"<>cid OR a."decisionActorId"<>NEW."grantedByUserId" THEN RAISE EXCEPTION 'BUSINESS_APPROVAL_REQUIRED'; END IF;
  IF NOT EXISTS(SELECT 1 FROM "BusinessAccessEvent" e JOIN "BusinessCommandReceipt" x ON x.id=e."receiptId" WHERE e."grantId"=NEW.id AND x.outcome='APPLIED' AND ((NEW.status='ACTIVE' AND e.operation='DECIDE') OR (NEW.status='REVOKED' AND e.operation IN ('REVOKE','DOWNGRADE')))) THEN RAISE EXCEPTION 'BUSINESS_COMMAND_REQUIRED'; END IF;
 END IF;
 IF TG_TABLE_NAME='BusinessAccessEvent' THEN
  SELECT * INTO r FROM "BusinessCommandReceipt" WHERE id=NEW."receiptId";
  IF r.id IS NULL OR r.outcome<>'APPLIED' OR r.operation<>NEW.operation OR r."actorUserId"<>NEW."actorUserId" OR r."customerAccountId"<>cid THEN RAISE EXCEPTION 'BUSINESS_EVENT_RECEIPT_REQUIRED'; END IF;
 END IF;
 IF TG_TABLE_NAME='BusinessCommandReceipt' AND to_jsonb(NEW)->>'outcome'='APPLIED' AND NOT EXISTS(SELECT 1 FROM "BusinessAccessEvent" WHERE "receiptId"=NEW.id) THEN RAISE EXCEPTION 'BUSINESS_EVENT_REQUIRED'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER business_account_consistent AFTER INSERT OR UPDATE ON "CustomerAccount" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION business_consistency();
CREATE CONSTRAINT TRIGGER business_application_consistent AFTER INSERT OR UPDATE ON "BusinessApplication" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION business_consistency();
CREATE CONSTRAINT TRIGGER business_grant_consistent AFTER INSERT OR UPDATE ON "BusinessAccessGrant" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION business_consistency();
CREATE CONSTRAINT TRIGGER business_event_consistent AFTER INSERT ON "BusinessAccessEvent" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION business_consistency();
CREATE CONSTRAINT TRIGGER business_receipt_consistent AFTER INSERT ON "BusinessCommandReceipt" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION business_consistency();
CREATE FUNCTION business_actor_guard() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE u "User"; BEGIN
 SELECT * INTO u FROM "User" WHERE id=NEW."actorUserId" FOR SHARE;
 IF NOT u.active OR (NEW.namespace='BUSINESS_ADMIN' AND u.role<>'SUPER_ADMIN') OR (NEW.namespace='BUSINESS_CUSTOMER' AND NOT EXISTS(SELECT 1 FROM "CustomerAccount" WHERE id=NEW."customerAccountId" AND "userId"=u.id)) THEN RAISE EXCEPTION 'BUSINESS_ACTOR_FORBIDDEN'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER business_actor_guard BEFORE INSERT ON "BusinessCommandReceipt" FOR EACH ROW EXECUTE FUNCTION business_actor_guard();
-- New demand admission is separate from operational authority and recovery.
CREATE FUNCTION business_demand_guard() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE c "CustomerAccount"; BEGIN
 IF NEW."customerAccountId" IS NULL THEN RETURN NEW; END IF;
 SELECT * INTO c FROM "CustomerAccount" WHERE id=NEW."customerAccountId" FOR UPDATE;
 IF c.type='BUSINESS' AND (c."businessAccessState"<>'ACTIVE' OR NOT EXISTS(SELECT 1 FROM "BusinessAccessGrant" WHERE "customerAccountId"=c.id AND status='ACTIVE')) THEN RAISE EXCEPTION 'BUSINESS_ACCESS_RESTRICTED'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER business_prequote_admission BEFORE INSERT ON "DeliveryPrequote" FOR EACH ROW EXECUTE FUNCTION business_demand_guard();
CREATE TRIGGER business_conversion_admission BEFORE INSERT ON "PrequoteConversion" FOR EACH ROW EXECUTE FUNCTION business_demand_guard();
CREATE FUNCTION business_capture_admission() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE c "CustomerAccount"; gid uuid; BEGIN
 SELECT * INTO c FROM "CustomerAccount" WHERE id=NEW."customerAccountId" FOR UPDATE;
 IF c.type='BUSINESS' THEN
 SELECT id INTO gid FROM "BusinessAccessGrant" WHERE "customerAccountId"=c.id AND status='ACTIVE';
 IF c."businessAccessState"<>'ACTIVE' OR gid IS NULL THEN RAISE EXCEPTION 'BUSINESS_ACCESS_RESTRICTED'; END IF;
 INSERT INTO "BusinessAdmissionEvidence"("deliveryRequestId","customerAccountId",basis,"grantId","accountRevision") VALUES(NEW."deliveryRequestId",c.id,'MANUAL_GRANT',gid,c.revision);
 END IF; RETURN NEW;
END $$;
CREATE TRIGGER business_capture_admission AFTER INSERT ON "DirectRequestLifecycle" FOR EACH ROW EXECUTE FUNCTION business_capture_admission();
CREATE FUNCTION business_evidence_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.basis<>'MANUAL_GRANT' OR NOT EXISTS(SELECT 1 FROM "BusinessAccessGrant" g JOIN "CustomerAccount" c ON c.id=g."customerAccountId" JOIN "DeliveryRequest" r ON r."customerAccountId"=c.id WHERE g.id=NEW."grantId" AND g.status='ACTIVE' AND c."businessAccessState"='ACTIVE' AND c.revision=NEW."accountRevision" AND r.id=NEW."deliveryRequestId" AND r."customerAccountId"=NEW."customerAccountId" AND r.xmin::text=pg_current_xact_id()::text) THEN RAISE EXCEPTION 'BUSINESS_ADMISSION_INVALID'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER business_evidence_guard BEFORE INSERT ON "BusinessAdmissionEvidence" FOR EACH ROW EXECUTE FUNCTION business_evidence_guard();
COMMIT;
