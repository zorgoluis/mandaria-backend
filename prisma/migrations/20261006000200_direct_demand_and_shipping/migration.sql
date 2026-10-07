-- DropForeignKey
ALTER TABLE "AuthorizedQuoteAcceptance" DROP CONSTRAINT "AuthorizedQuoteAcceptance_deliveryRequestId_integrationCli_fkey";

-- DropForeignKey
ALTER TABLE "PrequoteConversion" DROP CONSTRAINT "PrequoteConversion_deliveryRequestId_integrationClientId_fkey";

-- DropForeignKey
ALTER TABLE "PrequoteConversion" DROP CONSTRAINT "PrequoteConversion_prequoteId_integrationClientId_fkey";

-- AlterTable
ALTER TABLE "ApiIdempotencyRecord" ADD COLUMN     "customerAccountId" UUID,
ALTER COLUMN "integrationClientId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "AuthorizedQuoteAcceptance" ADD COLUMN     "customerAccountId" UUID,
ADD COLUMN     "evidenceKind" TEXT NOT NULL DEFAULT 'B2B_ATTESTATION',
ADD COLUMN     "shippingTermsHash" TEXT,
ADD COLUMN     "userId" UUID,
ALTER COLUMN "integrationClientId" DROP NOT NULL,
ALTER COLUMN "credentialId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "DeliveryPrequote" ADD COLUMN     "customerAccountId" UUID,
ADD COLUMN     "shippingTerms" JSONB,
ALTER COLUMN "integrationClientId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "DeliveryRequest" ADD COLUMN     "customerAccountId" UUID,
ALTER COLUMN "integrationClientId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "IntegrationClient" ADD COLUMN     "defaultShippingPayer" TEXT NOT NULL DEFAULT 'RECIPIENT',
ADD COLUMN     "shippingPolicyRevision" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "PrequoteConsumptionPermit" ADD COLUMN     "customerAccountId" UUID,
ALTER COLUMN "integrationClientId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "PrequoteConversion" ADD COLUMN     "customerAccountId" UUID,
ADD COLUMN     "origin" TEXT NOT NULL DEFAULT 'B2B_MERCHANT',
ALTER COLUMN "integrationClientId" DROP NOT NULL,
ALTER COLUMN "goodsPaymentStatus" DROP NOT NULL,
ALTER COLUMN "goodsPaymentReference" DROP NOT NULL,
ALTER COLUMN "goodsPaymentConfirmedAt" DROP NOT NULL,
ALTER COLUMN "orderAcceptanceStatus" DROP NOT NULL,
ALTER COLUMN "orderAcceptanceReference" DROP NOT NULL,
ALTER COLUMN "orderAcceptedAt" DROP NOT NULL;

-- CreateTable
CREATE TABLE "DeliveryShippingTerms" (
    "deliveryRequestId" UUID NOT NULL,
    "payer" TEXT NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'CASH',
    "dueAt" TEXT NOT NULL,
    "component" TEXT NOT NULL DEFAULT 'DELIVERY_FEE',
    "termsVersion" INTEGER NOT NULL DEFAULT 1,
    "policyRevision" INTEGER,
    "termsHash" CHAR(64) NOT NULL,
    "payerContact" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeliveryShippingTerms_pkey" PRIMARY KEY ("deliveryRequestId")
);

-- CreateTable
CREATE TABLE "DirectRequestLifecycle" (
    "deliveryRequestId" UUID NOT NULL,
    "customerAccountId" UUID NOT NULL,
    "personalSlot" UUID,
    "closedAt" TIMESTAMP(3),
    "closureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DirectRequestLifecycle_pkey" PRIMARY KEY ("deliveryRequestId")
);

-- CreateTable
CREATE TABLE "ShippingCollectionDeclaration" (
    "deliveryRequestId" UUID NOT NULL,
    "dispatchId" UUID NOT NULL,
    "assignmentId" UUID NOT NULL,
    "driverUserId" UUID NOT NULL,
    "deliveryQuoteId" UUID NOT NULL,
    "termsHash" CHAR(64) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "receivedFrom" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShippingCollectionDeclaration_pkey" PRIMARY KEY ("deliveryRequestId")
);

-- CreateTable
CREATE TABLE "ShippingPolicyAudit" (
    "id" UUID NOT NULL,
    "integrationClientId" UUID NOT NULL,
    "actorUserId" UUID NOT NULL,
    "key" UUID NOT NULL,
    "requestHash" CHAR(64) NOT NULL,
    "previousPayer" TEXT NOT NULL,
    "payer" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShippingPolicyAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DirectRequestLifecycle_personalSlot_key" ON "DirectRequestLifecycle"("personalSlot");

-- CreateIndex
CREATE INDEX "DirectRequestLifecycle_customerAccountId_closedAt_idx" ON "DirectRequestLifecycle"("customerAccountId", "closedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ShippingPolicyAudit_actorUserId_key_key" ON "ShippingPolicyAudit"("actorUserId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "ShippingPolicyAudit_integrationClientId_revision_key" ON "ShippingPolicyAudit"("integrationClientId", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "ApiIdempotencyRecord_customerAccountId_key_key" ON "ApiIdempotencyRecord"("customerAccountId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryPrequote_id_customerAccountId_key" ON "DeliveryPrequote"("id", "customerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryRequest_id_customerAccountId_key" ON "DeliveryRequest"("id", "customerAccountId");

-- AddForeignKey
ALTER TABLE "DeliveryRequest" ADD CONSTRAINT "DeliveryRequest_customerAccountId_fkey" FOREIGN KEY ("customerAccountId") REFERENCES "CustomerAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiIdempotencyRecord" ADD CONSTRAINT "ApiIdempotencyRecord_customerAccountId_fkey" FOREIGN KEY ("customerAccountId") REFERENCES "CustomerAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryPrequote" ADD CONSTRAINT "DeliveryPrequote_customerAccountId_fkey" FOREIGN KEY ("customerAccountId") REFERENCES "CustomerAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrequoteConsumptionPermit" ADD CONSTRAINT "PrequoteConsumptionPermit_customerAccountId_fkey" FOREIGN KEY ("customerAccountId") REFERENCES "CustomerAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrequoteConversion" ADD CONSTRAINT "PrequoteConversion_customerAccountId_fkey" FOREIGN KEY ("customerAccountId") REFERENCES "CustomerAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrequoteConversion" ADD CONSTRAINT "PrequoteConversion_prequoteId_fkey" FOREIGN KEY ("prequoteId") REFERENCES "DeliveryPrequote"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PrequoteConversion" ADD CONSTRAINT "PrequoteConversion_deliveryRequestId_fkey" FOREIGN KEY ("deliveryRequestId") REFERENCES "DeliveryRequest"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AuthorizedQuoteAcceptance" ADD CONSTRAINT "AuthorizedQuoteAcceptance_customerAccountId_fkey" FOREIGN KEY ("customerAccountId") REFERENCES "CustomerAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthorizedQuoteAcceptance" ADD CONSTRAINT "AuthorizedQuoteAcceptance_deliveryRequestId_fkey" FOREIGN KEY ("deliveryRequestId") REFERENCES "DeliveryRequest"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DeliveryShippingTerms" ADD CONSTRAINT "DeliveryShippingTerms_deliveryRequestId_fkey" FOREIGN KEY ("deliveryRequestId") REFERENCES "DeliveryRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DirectRequestLifecycle" ADD CONSTRAINT "DirectRequestLifecycle_deliveryRequestId_fkey" FOREIGN KEY ("deliveryRequestId") REFERENCES "DeliveryRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShippingCollectionDeclaration" ADD CONSTRAINT "ShippingCollectionDeclaration_deliveryRequestId_fkey" FOREIGN KEY ("deliveryRequestId") REFERENCES "DeliveryShippingTerms"("deliveryRequestId") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Owner-specific evidence; preserve existing B2B checks.
CREATE OR REPLACE FUNCTION public.prequote_evidence()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE z "ServiceZone"; p "RatePlan"; b "RateBand"; r "ApiIdempotencyRecord"; e "ApiIdempotencyExecution";
BEGIN
  SELECT * INTO r FROM "ApiIdempotencyRecord" WHERE id=NEW."idempotencyRecordId" FOR UPDATE;
  SELECT * INTO e FROM "ApiIdempotencyExecution" WHERE "recordId"=r.id FOR UPDATE;
  SELECT * INTO z FROM "ServiceZone" WHERE id=NEW."serviceZoneId" FOR SHARE;
  SELECT * INTO p FROM "RatePlan" WHERE id=NEW."ratePlanId" FOR SHARE;
  SELECT * INTO b FROM "RateBand" WHERE id=NEW."rateBandId" FOR SHARE;
  IF r."resourceId" IS DISTINCT FROM NEW.id OR ROW(r."integrationClientId",r."customerAccountId") IS DISTINCT FROM ROW(NEW."integrationClientId",NEW."customerAccountId")
     OR r.operation IS DISTINCT FROM 'delivery_prequotes.create' OR r."resourceType" IS DISTINCT FROM 'DeliveryPrequote'
     OR r."requestHash" IS DISTINCT FROM encode(sha256(convert_to(prequote_canonical_json(jsonb_build_object('operation',r.operation,'payload',CASE WHEN NEW."customerAccountId" IS NULL THEN NEW.conditions ELSE jsonb_build_object('conditions',NEW.conditions,'shippingPayer',NEW."shippingTerms"->>'payer') END)),'UTF8')),'hex')
     OR e.state IS DISTINCT FROM 'PROCESSING' OR e."leaseExpiresAt" <= (clock_timestamp() AT TIME ZONE 'UTC')
     OR z.status IS DISTINCT FROM 'ACTIVE' OR z.currency IS DISTINCT FROM NEW.currency
     OR z.code IS DISTINCT FROM NEW."zoneCode" OR z.name IS DISTINCT FROM NEW."zoneName" OR z.boundary IS DISTINCT FROM NEW."zoneBoundary"
     OR p.status IS DISTINCT FROM 'ACTIVE' OR p."serviceZoneId" IS DISTINCT FROM z.id OR p."serviceType" IS DISTINCT FROM NEW."serviceType"
     OR p."calculationType" IS DISTINCT FROM 'DISTANCE_BANDS' OR p.currency IS DISTINCT FROM NEW.currency
     OR b."ratePlanId" IS DISTINCT FROM p.id OR b.currency IS DISTINCT FROM NEW.currency OR b.amount IS DISTINCT FROM NEW.amount
     OR NEW."distanceMeters" < b."minDistanceMeters" OR NEW."distanceMeters" >= b."maxDistanceMeters"
     OR NEW."issuedAt" < (transaction_timestamp() AT TIME ZONE 'UTC') - interval '1 millisecond' OR NEW."issuedAt" > (clock_timestamp() AT TIME ZONE 'UTC') + interval '1 millisecond'
  THEN RAISE EXCEPTION 'PREQUOTE_EVIDENCE_INVALID'; END IF;
  RETURN NEW;
END $function$
;

-- Owner-specific evidence; preserve existing B2B checks.
CREATE OR REPLACE FUNCTION public.prequote_atomic_result()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE rid uuid; r "ApiIdempotencyRecord"; e "ApiIdempotencyExecution"; q "DeliveryPrequote";
BEGIN
  IF TG_TABLE_NAME='ApiIdempotencyRecord' THEN rid := NEW.id; ELSIF TG_TABLE_NAME='ApiIdempotencyExecution' THEN rid := NEW."recordId"; ELSE rid := NEW."idempotencyRecordId"; END IF;
  SELECT * INTO r FROM "ApiIdempotencyRecord" WHERE id=rid;
  IF r."resourceType" IS DISTINCT FROM 'DeliveryPrequote' THEN
    IF EXISTS(SELECT 1 FROM "ApiIdempotencyExecution" WHERE "recordId"=rid) THEN RAISE EXCEPTION 'DURABLE_RESOURCE_INVALID'; END IF;
    RETURN NULL;
  END IF;
  SELECT * INTO e FROM "ApiIdempotencyExecution" WHERE "recordId"=rid;
  SELECT * INTO q FROM "DeliveryPrequote" WHERE "idempotencyRecordId"=rid;
  IF e."recordId" IS NULL OR (e.state='SUCCEEDED') IS DISTINCT FROM (q.id IS NOT NULL)
     OR (q.id IS NOT NULL AND (q.id<>r."resourceId" OR ROW(q."integrationClientId",q."customerAccountId") IS DISTINCT FROM ROW(r."integrationClientId",r."customerAccountId"))) THEN RAISE EXCEPTION 'PREQUOTE_ATOMIC_RESULT'; END IF;
  RETURN NULL;
END $function$
;

-- Owner-specific evidence; preserve existing B2B checks.
CREATE OR REPLACE FUNCTION public.prequote_permit_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'PREQUOTE_PERMIT_HISTORY_IMMUTABLE'; END IF;
 IF TG_OP='INSERT' THEN
   IF NEW.state <> 'RESERVED' THEN RAISE EXCEPTION 'PREQUOTE_PERMIT_INITIAL_STATE'; END IF;
   RETURN NEW;
 END IF;
 IF (NEW.id,NEW."integrationClientId",NEW."customerAccountId",NEW."ownerHash",NEW."policyFingerprint",NEW.units,NEW."routingBudgetMs",NEW."reservedAt",NEW."reserveExpiresAt") IS DISTINCT FROM
    (OLD.id,OLD."integrationClientId",OLD."customerAccountId",OLD."ownerHash",OLD."policyFingerprint",OLD.units,OLD."routingBudgetMs",OLD."reservedAt",OLD."reserveExpiresAt")
 THEN RAISE EXCEPTION 'PREQUOTE_PERMIT_IDENTITY_IMMUTABLE'; END IF;
 IF OLD.state='RESERVED' THEN
   IF NEW.state NOT IN ('STARTED','CANCELLED','EXPIRED') THEN RAISE EXCEPTION 'PREQUOTE_PERMIT_TRANSITION'; END IF;
   IF NEW.state='STARTED' AND OLD."reserveExpiresAt" <= (clock_timestamp() AT TIME ZONE 'UTC') THEN RAISE EXCEPTION 'PREQUOTE_PERMIT_EXPIRED'; END IF;
   IF NEW.state='EXPIRED' AND OLD."reserveExpiresAt" > (clock_timestamp() AT TIME ZONE 'UTC') THEN RAISE EXCEPTION 'PREQUOTE_PERMIT_NOT_EXPIRED'; END IF;
 ELSIF OLD.state='STARTED' THEN
   IF NEW.state NOT IN ('FINISHED','ABANDONED') OR (NEW."startedAt",NEW."startBy",NEW."protectedUntil") IS DISTINCT FROM (OLD."startedAt",OLD."startBy",OLD."protectedUntil") THEN RAISE EXCEPTION 'PREQUOTE_PERMIT_CONSUMPTION_IMMUTABLE'; END IF;
   IF NEW.state='ABANDONED' AND OLD."protectedUntil" > (clock_timestamp() AT TIME ZONE 'UTC') THEN RAISE EXCEPTION 'PREQUOTE_PERMIT_STILL_PROTECTED'; END IF;
 ELSE RAISE EXCEPTION 'PREQUOTE_PERMIT_TERMINAL';
 END IF;
 RETURN NEW;
END $function$
;

-- Owner-specific evidence; preserve existing B2B checks.
CREATE OR REPLACE FUNCTION public.conversion_insert_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE q "DeliveryPrequote"; r "ApiIdempotencyRecord"; zone_status "ServiceZoneStatus";
BEGIN
 SELECT * INTO r FROM "ApiIdempotencyRecord" WHERE id=NEW."idempotencyRecordId" FOR UPDATE;
 IF r.id IS NULL OR ROW(r."integrationClientId",r."customerAccountId") IS DISTINCT FROM ROW(NEW."integrationClientId",NEW."customerAccountId") OR r."resourceId"<>NEW.id
 OR r.operation<>'delivery_prequotes.convert' OR r."resourceType"<>'PrequoteConversion'
 OR EXISTS(SELECT 1 FROM "ApiIdempotencyExecution" WHERE "recordId"=r.id) THEN RAISE EXCEPTION 'CONVERSION_KEY_INVALID'; END IF;
 SELECT * INTO q FROM "DeliveryPrequote" WHERE id=NEW."prequoteId" AND "integrationClientId" IS NOT DISTINCT FROM NEW."integrationClientId" AND "customerAccountId" IS NOT DISTINCT FROM NEW."customerAccountId" FOR UPDATE;
 IF q.id IS NULL THEN RAISE EXCEPTION 'CONVERSION_OWNER_INVALID'; END IF;
 IF EXISTS(SELECT 1 FROM "PrequoteConversion" WHERE "prequoteId"=q.id) THEN RAISE EXCEPTION 'PREQUOTE_ALREADY_CONVERTED'; END IF;
 SELECT status INTO zone_status FROM "ServiceZone" WHERE id=q."serviceZoneId" FOR SHARE;
 IF zone_status IS DISTINCT FROM 'ACTIVE' THEN RAISE EXCEPTION 'PREQUOTE_SERVICE_UNAVAILABLE'; END IF;
 NEW."convertedAt" := date_trunc('milliseconds',clock_timestamp() AT TIME ZONE 'UTC');
 IF NEW."convertedAt">=q."expiresAt" THEN RAISE EXCEPTION 'PREQUOTE_EXPIRED'; END IF;
 -- No adoption of a pre-existing request/quote, even in the same transaction.
 IF EXISTS(SELECT 1 FROM "DeliveryRequest" WHERE id=NEW."deliveryRequestId") OR EXISTS(SELECT 1 FROM "DeliveryQuote" WHERE id=NEW."deliveryQuoteId") THEN RAISE EXCEPTION 'CONVERSION_DESTINATION_EXISTS'; END IF;
 IF cardinality(NEW."stopIds")<>(SELECT count(DISTINCT v) FROM unnest(NEW."stopIds") v)
 OR cardinality(NEW."packageIds")<>(SELECT count(DISTINCT v) FROM unnest(NEW."packageIds") v) THEN RAISE EXCEPTION 'CONVERSION_MANIFEST_INVALID'; END IF;
 RETURN NEW;
END $function$
;

-- Owner-specific evidence; preserve existing B2B checks.
CREATE OR REPLACE FUNCTION public.conversion_atomic_result()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE c "PrequoteConversion"; q "DeliveryPrequote"; r "DeliveryRequest"; mq "DeliveryQuote"; f "DeliveryFinancialContext"; k "ApiIdempotencyRecord"; conditions jsonb; stop_list uuid[]; package_list uuid[];
BEGIN
 IF TG_TABLE_NAME='ApiIdempotencyRecord' THEN
  IF NEW.operation<>'delivery_prequotes.convert' AND NEW."resourceType"<>'PrequoteConversion' THEN RETURN NULL; END IF;
  SELECT * INTO c FROM "PrequoteConversion" WHERE "idempotencyRecordId"=NEW.id;
 ELSE SELECT * INTO c FROM "PrequoteConversion" WHERE id=NEW.id;
 END IF;
 IF c.id IS NULL THEN RAISE EXCEPTION 'CONVERSION_ATOMIC_RESULT'; END IF;
 SELECT * INTO k FROM "ApiIdempotencyRecord" WHERE id=c."idempotencyRecordId";
 SELECT * INTO q FROM "DeliveryPrequote" WHERE id=c."prequoteId";
 SELECT * INTO r FROM "DeliveryRequest" WHERE id=c."deliveryRequestId";
 SELECT * INTO mq FROM "DeliveryQuote" WHERE id=c."deliveryQuoteId";
 SELECT * INTO f FROM "DeliveryFinancialContext" WHERE "deliveryRequestId"=r.id;
 IF k.id IS NULL OR k.operation<>'delivery_prequotes.convert' OR k."resourceType"<>'PrequoteConversion' OR k."resourceId"<>c.id OR ROW(k."integrationClientId",k."customerAccountId") IS DISTINCT FROM ROW(c."integrationClientId",c."customerAccountId")
 OR r.id IS NULL OR mq.id IS NULL OR f.id IS NULL OR q.id IS NULL OR ROW(r."integrationClientId",r."customerAccountId") IS DISTINCT FROM ROW(c."integrationClientId",c."customerAccountId")
 OR mq."deliveryRequestId"<>r.id OR r.status<>'CREATED' OR mq.status<>'OFFERED' OR mq."acceptedAt" IS NOT NULL
 OR r."createdAt"<>c."convertedAt" OR r."requestedAt"<>c."convertedAt" OR mq."createdAt"<>c."convertedAt"
 OR f.id<>c."financialContextId" OR (c.origin='B2B_MERCHANT' AND f."goodsPaymentMode"<>'PREPAID') OR f.currency<>'MXN'
 OR EXISTS(SELECT 1 FROM "ApiIdempotencyExecution" WHERE "recordId"=k.id)
 OR EXISTS(SELECT 1 FROM "Dispatch" WHERE "deliveryRequestId"=r.id OR "deliveryQuoteId"=mq.id)
 OR (SELECT count(*) FROM "DeliveryQuote" WHERE "deliveryRequestId"=r.id)<>1 THEN RAISE EXCEPTION 'CONVERSION_ATOMIC_RESULT'; END IF;
 IF (clock_timestamp() AT TIME ZONE 'UTC')>=q."expiresAt" THEN RAISE EXCEPTION 'PREQUOTE_EXPIRED'; END IF;
 IF ROW(mq."serviceType",mq."serviceZoneId",mq."ratePlanId",mq."rateBandId",mq."distanceMeters",mq."durationSeconds",mq.amount,mq.currency,mq."routingProvider",mq."routeCalculatedAt",mq."expiresAt")
 IS DISTINCT FROM ROW(q."serviceType",q."serviceZoneId",q."ratePlanId",q."rateBandId",q."distanceMeters",q."durationSeconds",q.amount,q.currency,q."routingProvider",q."routeCalculatedAt",q."expiresAt") THEN RAISE EXCEPTION 'CONVERSION_SNAPSHOT_MISMATCH'; END IF;
 SELECT array_agg(id ORDER BY id) INTO stop_list FROM "DeliveryStop" WHERE "deliveryRequestId"=r.id;
 SELECT array_agg(id ORDER BY id) INTO package_list FROM "DeliveryPackage" WHERE "deliveryRequestId"=r.id;
 IF stop_list IS DISTINCT FROM (SELECT array_agg(v ORDER BY v) FROM unnest(c."stopIds") v)
 OR package_list IS DISTINCT FROM (SELECT array_agg(v ORDER BY v) FROM unnest(c."packageIds") v) THEN RAISE EXCEPTION 'CONVERSION_MANIFEST_INVALID'; END IF;
 SELECT jsonb_build_object('conditionsVersion',q."conditionsVersion",'serviceType',r."serviceType",
 'stops',(SELECT jsonb_agg(jsonb_build_object('type',s.type,'sequence',s.sequence,'latitude',s.latitude,'longitude',s.longitude) ORDER BY s.sequence) FROM "DeliveryStop" s WHERE s."deliveryRequestId"=r.id),
 'packages',(SELECT jsonb_agg(j ORDER BY prequote_canonical_json(j) COLLATE "C") FROM (SELECT jsonb_build_object('category',p.category,'quantity',p.quantity,'weightKg',p."weightKg",'lengthCm',p."lengthCm",'widthCm',p."widthCm",'heightCm',p."heightCm",'isFragile',p."isFragile") j FROM "DeliveryPackage" p WHERE p."deliveryRequestId"=r.id) items)) INTO conditions;
 IF conditions IS DISTINCT FROM q.conditions THEN RAISE EXCEPTION 'PREQUOTE_CONDITIONS_MISMATCH'; END IF;
 RETURN NULL;
END $function$
;

-- Owner-specific evidence; preserve existing B2B checks.
CREATE OR REPLACE FUNCTION public.authorized_acceptance_insert()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE c "PrequoteConversion"; mq "DeliveryQuote"; r "DeliveryRequest"; k "ApiIdempotencyRecord";
 ic "IntegrationClient"; cr "IntegrationCredential"; zs "ServiceZoneStatus";
BEGIN
 SELECT * INTO k FROM "ApiIdempotencyRecord" WHERE id=NEW."idempotencyRecordId" FOR UPDATE;
 IF k.id IS NULL OR k.operation<>'delivery_quotes.accept_authorized' OR k."resourceType"<>'AuthorizedQuoteAcceptance'
 OR k."resourceId"<>NEW.id OR ROW(k."integrationClientId",k."customerAccountId") IS DISTINCT FROM ROW(NEW."integrationClientId",NEW."customerAccountId")
 OR EXISTS(SELECT 1 FROM "ApiIdempotencyExecution" WHERE "recordId"=k.id) THEN RAISE EXCEPTION 'AUTHORIZED_ACCEPT_KEY_INVALID'; END IF;
 -- Uniform parent -> credential -> request -> quote -> zone order.
 SELECT * INTO ic FROM "IntegrationClient" WHERE id=NEW."integrationClientId" FOR SHARE;
 SELECT * INTO cr FROM "IntegrationCredential" WHERE id=NEW."credentialId" FOR SHARE;
 SELECT * INTO r FROM "DeliveryRequest" WHERE id=NEW."deliveryRequestId" FOR UPDATE;
 SELECT * INTO mq FROM "DeliveryQuote" WHERE id=NEW."deliveryQuoteId" FOR SHARE;
 SELECT * INTO c FROM "PrequoteConversion" WHERE id=NEW."conversionId";
 IF (NEW."conversionId" IS NOT NULL AND c.id IS NULL) OR r.id IS NULL OR mq.id IS NULL OR (c.id IS NOT NULL AND (c."deliveryRequestId"<>r.id OR c."deliveryQuoteId"<>mq.id))
 OR (c.id IS NOT NULL AND ROW(c."integrationClientId",c."customerAccountId") IS DISTINCT FROM ROW(NEW."integrationClientId",NEW."customerAccountId")) OR ROW(r."integrationClientId",r."customerAccountId") IS DISTINCT FROM ROW(NEW."integrationClientId",NEW."customerAccountId") OR mq."deliveryRequestId"<>r.id THEN RAISE EXCEPTION 'AUTHORIZED_ACCEPT_OWNER_INVALID'; END IF;
 IF EXISTS(SELECT 1 FROM "AuthorizedQuoteAcceptance" WHERE "deliveryQuoteId"=mq.id) THEN RAISE EXCEPTION 'QUOTE_ALREADY_AUTHORIZED'; END IF;
 IF r.status<>'CREATED' OR mq.status NOT IN ('OFFERED','EXPIRED') THEN RAISE EXCEPTION 'QUOTE_NOT_ACCEPTABLE'; END IF;
 SELECT status INTO zs FROM "ServiceZone" WHERE id=mq."serviceZoneId" FOR SHARE;
 IF zs IS DISTINCT FROM 'ACTIVE' THEN RAISE EXCEPTION 'AUTHORIZED_ACCEPT_SERVICE_UNAVAILABLE'; END IF;
 NEW."acceptedAt":=date_trunc('milliseconds',clock_timestamp() AT TIME ZONE 'UTC');
 IF mq.status='EXPIRED' OR NEW."acceptedAt">=mq."expiresAt" THEN RAISE EXCEPTION 'QUOTE_EXPIRED'; END IF;
 IF NEW."customerAccountId" IS NOT NULL THEN
   IF NEW."evidenceKind"<>'DIRECT_CUSTOMER' OR NOT EXISTS(SELECT 1 FROM "CustomerAccount" ca JOIN "User" u ON u.id=ca."userId" WHERE ca.id=NEW."customerAccountId" AND u.id=NEW."userId" AND ca.active AND u.active AND u."emailVerifiedAt" IS NOT NULL) OR NEW."authenticatedTokenExpiresAt"<=NEW."acceptedAt" THEN RAISE EXCEPTION 'AUTHORIZED_ACCEPT_AUTH_INVALID'; END IF;
 ELSE
  IF ic.status IS DISTINCT FROM 'ACTIVE' OR cr.id IS NULL OR cr."clientId"<>ic.id OR cr.status<>'ACTIVE'
 OR cr."revokedAt" IS NOT NULL OR cr."expiresAt"<=NEW."acceptedAt" OR NEW."authenticatedTokenExpiresAt"<=NEW."acceptedAt"
 OR NOT ('quotes:accept'=ANY(cr.scopes)) THEN RAISE EXCEPTION 'AUTHORIZED_ACCEPT_AUTH_INVALID'; END IF;
 END IF;
 IF NEW."customerAccountId" IS NOT NULL OR NEW."authorizationVersion"=2 THEN
   IF NOT EXISTS(SELECT 1 FROM "DeliveryShippingTerms" t WHERE t."deliveryRequestId"=r.id AND t."termsHash"=NEW."shippingTermsHash") THEN RAISE EXCEPTION 'CUSTOMER_AUTHORIZATION_MISMATCH'; END IF;
 END IF;
 IF EXISTS(SELECT 1 FROM "DeliveryShippingTerms" t WHERE t."deliveryRequestId"=r.id AND t.payer='REQUESTER') AND NEW."shippingTermsHash" IS NULL THEN RAISE EXCEPTION 'CUSTOMER_AUTHORIZATION_MISMATCH'; END IF;
 IF EXISTS(SELECT 1 FROM "DirectRequestLifecycle" WHERE "deliveryRequestId"=r.id AND "closedAt" IS NOT NULL) THEN RAISE EXCEPTION 'QUOTE_NOT_ACCEPTABLE'; END IF;

 IF ROW(NEW."authorizedAmount",NEW."authorizedCurrency",NEW."authorizedExpiresAt") IS DISTINCT FROM ROW(mq.amount,mq.currency,mq."expiresAt")
 OR NEW."authorizedAt"<mq."createdAt" OR NEW."authorizedAt">NEW."acceptedAt" THEN RAISE EXCEPTION 'CUSTOMER_AUTHORIZATION_MISMATCH'; END IF;
 IF EXISTS(SELECT 1 FROM "Dispatch" WHERE id=NEW."dispatchId" OR "deliveryQuoteId"=mq.id OR "deliveryRequestId"=r.id) THEN RAISE EXCEPTION 'AUTHORIZED_ACCEPT_DESTINATION_EXISTS'; END IF;
 RETURN NEW;
END $function$
;

-- Owner-specific evidence; preserve existing B2B checks.
CREATE OR REPLACE FUNCTION public.authorized_acceptance_atomic_result()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE a "AuthorizedQuoteAcceptance"; c "PrequoteConversion"; mq "DeliveryQuote"; r "DeliveryRequest"; d "Dispatch"; k "ApiIdempotencyRecord"; cr "IntegrationCredential"; now_at timestamp;
BEGIN
 IF TG_TABLE_NAME='ApiIdempotencyRecord' THEN
  IF NEW.operation<>'delivery_quotes.accept_authorized' AND NEW."resourceType"<>'AuthorizedQuoteAcceptance' THEN RETURN NULL; END IF;
  SELECT * INTO a FROM "AuthorizedQuoteAcceptance" WHERE "idempotencyRecordId"=NEW.id;
 ELSE SELECT * INTO a FROM "AuthorizedQuoteAcceptance" WHERE id=NEW.id;
 END IF;
 IF a.id IS NULL THEN RAISE EXCEPTION 'AUTHORIZED_ACCEPT_ATOMIC_RESULT'; END IF;
 SELECT * INTO c FROM "PrequoteConversion" WHERE id=a."conversionId";
 SELECT * INTO mq FROM "DeliveryQuote" WHERE id=a."deliveryQuoteId";
 SELECT * INTO r FROM "DeliveryRequest" WHERE id=a."deliveryRequestId";
 SELECT * INTO d FROM "Dispatch" WHERE id=a."dispatchId";
 SELECT * INTO k FROM "ApiIdempotencyRecord" WHERE id=a."idempotencyRecordId";
 IF (a."conversionId" IS NOT NULL AND c.id IS NULL) OR mq.id IS NULL OR r.id IS NULL OR d.id IS NULL OR k.id IS NULL
 OR (c.id IS NOT NULL AND (c."deliveryQuoteId"<>mq.id OR c."deliveryRequestId"<>r.id OR ROW(c."integrationClientId",c."customerAccountId") IS DISTINCT FROM ROW(a."integrationClientId",a."customerAccountId")))
 OR mq."deliveryRequestId"<>r.id OR ROW(r."integrationClientId",r."customerAccountId") IS DISTINCT FROM ROW(a."integrationClientId",a."customerAccountId")
 OR k.operation<>'delivery_quotes.accept_authorized' OR k."resourceType"<>'AuthorizedQuoteAcceptance' OR k."resourceId"<>a.id OR ROW(k."integrationClientId",k."customerAccountId") IS DISTINCT FROM ROW(a."integrationClientId",a."customerAccountId")
 OR mq.status<>'ACCEPTED' OR mq."acceptedAt" IS DISTINCT FROM a."acceptedAt" OR r.status<>'CREATED'
 OR d."deliveryRequestId"<>r.id OR d."deliveryQuoteId"<>mq.id OR d.status<>'OPEN' OR d."openedAt"<>a."acceptedAt"
 OR EXISTS(SELECT 1 FROM "ApiIdempotencyExecution" WHERE "recordId"=k.id)
 OR NOT EXISTS(SELECT 1 FROM "DispatchCreditSnapshot" WHERE "dispatchId"=d.id AND "actorType"='PROVIDER')
 OR NOT EXISTS(SELECT 1 FROM "DispatchCreditSnapshot" WHERE "dispatchId"=d.id AND "actorType"='INDEPENDENT_DRIVER')
 THEN RAISE EXCEPTION 'AUTHORIZED_ACCEPT_ATOMIC_RESULT'; END IF;
 IF ROW(a."authorizedAmount",a."authorizedCurrency",a."authorizedExpiresAt") IS DISTINCT FROM ROW(mq.amount,mq.currency,mq."expiresAt") OR a."authorizedAt"<mq."createdAt" THEN RAISE EXCEPTION 'CUSTOMER_AUTHORIZATION_MISMATCH'; END IF;
 now_at:=clock_timestamp() AT TIME ZONE 'UTC';
 IF now_at>=mq."expiresAt" THEN RAISE EXCEPTION 'QUOTE_EXPIRED'; END IF;
 IF a."customerAccountId" IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM "CustomerAccount" ca JOIN "User" u ON u.id=ca."userId" WHERE ca.id=a."customerAccountId" AND u.id=a."userId" AND ca.active AND u.active AND u."emailVerifiedAt" IS NOT NULL) OR a."authenticatedTokenExpiresAt"<=now_at THEN RAISE EXCEPTION 'AUTHORIZED_ACCEPT_AUTH_INVALID'; END IF;
 ELSE
 SELECT * INTO cr FROM "IntegrationCredential" WHERE id=a."credentialId";
 IF cr.id IS NULL OR cr."clientId"<>a."integrationClientId" OR cr.status<>'ACTIVE' OR cr."revokedAt" IS NOT NULL OR cr."expiresAt"<=now_at
 OR a."authenticatedTokenExpiresAt"<=now_at OR NOT ('quotes:accept'=ANY(cr.scopes))
 OR NOT EXISTS(SELECT 1 FROM "IntegrationClient" WHERE id=a."integrationClientId" AND status='ACTIVE') THEN RAISE EXCEPTION 'AUTHORIZED_ACCEPT_AUTH_INVALID'; END IF;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM "ServiceZone" WHERE id=mq."serviceZoneId" AND status='ACTIVE') THEN RAISE EXCEPTION 'AUTHORIZED_ACCEPT_SERVICE_UNAVAILABLE'; END IF;
 RETURN NULL;
END $function$
;

CREATE OR REPLACE FUNCTION public.prequote_conditions_valid(j jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE s jsonb; p jsonb; n numeric; field text; precision_limit integer; previous text; current_value text; i integer := 0;
BEGIN
  IF jsonb_typeof(j) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(j)) <> 4
     OR j->'conditionsVersion' IS DISTINCT FROM '1'::jsonb OR j->>'serviceType' IS DISTINCT FROM 'LOCAL_DELIVERY'
     OR jsonb_typeof(j->'stops') IS DISTINCT FROM 'array' OR jsonb_array_length(j->'stops') <> 2
     OR jsonb_typeof(j->'packages') IS DISTINCT FROM 'array' OR jsonb_array_length(j->'packages') NOT BETWEEN 1 AND 50 THEN RETURN false; END IF;
  FOR s IN SELECT value FROM jsonb_array_elements(j->'stops') LOOP
    i := i+1;
    IF jsonb_typeof(s) <> 'object' OR (SELECT count(*) FROM jsonb_object_keys(s)) <> 4
       OR s->>'type' IS DISTINCT FROM (CASE WHEN i=1 THEN 'PICKUP' ELSE 'DROPOFF' END)
       OR s->'sequence' IS DISTINCT FROM to_jsonb(i) THEN RETURN false; END IF;
    FOREACH field IN ARRAY ARRAY['latitude','longitude'] LOOP
      IF jsonb_typeof(s->field) IS DISTINCT FROM 'number' THEN RETURN false; END IF;
      n := (s->>field)::numeric;
      IF n <> trunc(n,6) OR abs(n) > (CASE WHEN field='latitude' THEN 90 ELSE 180 END) THEN RETURN false; END IF;
    END LOOP;
  END LOOP;
  FOR p IN SELECT value FROM jsonb_array_elements(j->'packages') LOOP
    IF jsonb_typeof(p) <> 'object' OR (SELECT count(*) FROM jsonb_object_keys(p)) <> 7
       OR (p->>'category' IS NULL OR p->>'category' NOT IN ('FOOD','GROCERIES','MEDICINE','DOCUMENT','PARCEL','MERCHANDISE','OTHER')) OR jsonb_typeof(p->'quantity') IS DISTINCT FROM 'number'
       OR jsonb_typeof(p->'isFragile') IS DISTINCT FROM 'boolean' THEN RETURN false; END IF;
    n := (p->>'quantity')::numeric;
    IF n <> trunc(n) OR n NOT BETWEEN 1 AND 10000 THEN RETURN false; END IF;
    FOREACH field IN ARRAY ARRAY['weightKg','lengthCm','widthCm','heightCm'] LOOP
      IF NOT p ? field THEN RETURN false; END IF;
      IF p->field <> 'null'::jsonb THEN
        IF jsonb_typeof(p->field) <> 'number' THEN RETURN false; END IF;
        n := (p->>field)::numeric;
        precision_limit := CASE WHEN field='weightKg' THEN 3 ELSE 2 END;
        IF n <= 0 OR n > 100000 OR n <> trunc(n,precision_limit) THEN RETURN false; END IF;
      END IF;
    END LOOP;
    current_value := prequote_canonical_json(p);
    IF previous IS NOT NULL AND current_value COLLATE "C" < previous COLLATE "C" THEN RETURN false; END IF;
    previous := current_value;
  END LOOP;
  RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $function$
;

CREATE OR REPLACE FUNCTION public.b2b_delivery_completed_required()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Dispatch" WHERE "id" = NEW."id" AND "status" = 'DELIVERED') THEN
    RETURN NULL;
  END IF;
  IF EXISTS(SELECT 1 FROM "DeliveryRequest" WHERE id=NEW."deliveryRequestId" AND "customerAccountId" IS NOT NULL AND "integrationClientId" IS NULL) THEN RETURN NULL; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "B2bOutboxEvent"
     WHERE "dispatchId" = NEW."id" AND "type" = 'DELIVERY_COMPLETED'
  ) THEN
    RAISE EXCEPTION 'B2B_EVENT_REQUIRED: dispatch % was delivered without recording delivery.completed', NEW."id";
  END IF;
  RETURN NULL;
END $function$
;
ALTER TABLE "ApiIdempotencyRecord" ADD CONSTRAINT "ApiIdempotencyRecord_owner_xor" CHECK (("integrationClientId" IS NOT NULL) <> ("customerAccountId" IS NOT NULL));
ALTER TABLE "DeliveryRequest" ADD CONSTRAINT "DeliveryRequest_owner_xor" CHECK (("integrationClientId" IS NOT NULL) <> ("customerAccountId" IS NOT NULL));
ALTER TABLE "DeliveryPrequote" ADD CONSTRAINT "DeliveryPrequote_owner_xor" CHECK (("integrationClientId" IS NOT NULL) <> ("customerAccountId" IS NOT NULL));
ALTER TABLE "PrequoteConsumptionPermit" ADD CONSTRAINT "PrequoteConsumptionPermit_owner_xor" CHECK (("integrationClientId" IS NOT NULL) <> ("customerAccountId" IS NOT NULL));
ALTER TABLE "PrequoteConversion" ADD CONSTRAINT "PrequoteConversion_owner_xor" CHECK (("integrationClientId" IS NOT NULL) <> ("customerAccountId" IS NOT NULL));
ALTER TABLE "AuthorizedQuoteAcceptance" ADD CONSTRAINT "AuthorizedQuoteAcceptance_owner_xor" CHECK (("integrationClientId" IS NOT NULL) <> ("customerAccountId" IS NOT NULL));

ALTER TABLE "PrequoteConversion" ALTER CONSTRAINT "PrequoteConversion_deliveryRequestId_fkey" DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "PrequoteConversion" ADD CONSTRAINT conversion_direct_owner FOREIGN KEY ("deliveryRequestId","customerAccountId") REFERENCES "DeliveryRequest"(id,"customerAccountId") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "PrequoteConversion" ADD CONSTRAINT conversion_b2b_owner FOREIGN KEY ("deliveryRequestId","integrationClientId") REFERENCES "DeliveryRequest"(id,"integrationClientId") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "PrequoteConversion" ADD CONSTRAINT conversion_prequote_direct FOREIGN KEY ("prequoteId","customerAccountId") REFERENCES "DeliveryPrequote"(id,"customerAccountId");
ALTER TABLE "PrequoteConversion" ADD CONSTRAINT conversion_prequote_b2b FOREIGN KEY ("prequoteId","integrationClientId") REFERENCES "DeliveryPrequote"(id,"integrationClientId");
ALTER TABLE "IntegrationClient" ADD CONSTRAINT shipping_policy_valid CHECK ("defaultShippingPayer" IN ('REQUESTER','RECIPIENT') AND "shippingPolicyRevision">0);
ALTER TABLE "AuthorizedQuoteAcceptance" ADD CONSTRAINT acceptance_origin CHECK (("evidenceKind"='DIRECT_CUSTOMER' AND "customerAccountId" IS NOT NULL AND "userId" IS NOT NULL AND "credentialId" IS NULL AND "shippingTermsHash" IS NOT NULL) OR ("evidenceKind"='B2B_ATTESTATION' AND "integrationClientId" IS NOT NULL AND "userId" IS NULL AND "credentialId" IS NOT NULL));
ALTER TABLE "AuthorizedQuoteAcceptance" ADD CONSTRAINT acceptance_user FOREIGN KEY ("userId") REFERENCES "User"(id);
ALTER TABLE "PrequoteConversion" DROP CONSTRAINT "Conversion_facts";
ALTER TABLE "PrequoteConversion" ADD CONSTRAINT "Conversion_facts" CHECK (
 ((origin='DIRECT_CUSTOMER' AND "customerAccountId" IS NOT NULL AND "goodsPaymentStatus" IS NULL AND "goodsPaymentReference" IS NULL AND "goodsPaymentConfirmedAt" IS NULL AND "orderAcceptanceStatus" IS NULL AND "orderAcceptanceReference" IS NULL AND "orderAcceptedAt" IS NULL)
 OR (origin='B2B_MERCHANT' AND "integrationClientId" IS NOT NULL AND "goodsPaymentStatus" IS NOT NULL AND "orderAcceptanceStatus" IS NOT NULL AND "goodsPaymentReference" IS NOT NULL AND "orderAcceptanceReference" IS NOT NULL AND "goodsPaymentConfirmedAt" IS NOT NULL AND "orderAcceptedAt" IS NOT NULL
 AND "goodsPaymentStatus"='CONFIRMED_BY_MERCHANT' AND "orderAcceptanceStatus"='ACCEPTED_BY_MERCHANT' AND length(btrim("goodsPaymentReference")) BETWEEN 1 AND 100 AND "goodsPaymentReference"=btrim("goodsPaymentReference") AND length(btrim("orderAcceptanceReference")) BETWEEN 1 AND 100 AND "orderAcceptanceReference"=btrim("orderAcceptanceReference") AND "goodsPaymentConfirmedAt"<="convertedAt" AND "orderAcceptedAt"<="convertedAt"))
 AND (("collectionPayer"='REQUESTER' AND "collectionDueAt"='PICKUP') OR ("collectionPayer"='RECIPIENT' AND "collectionDueAt"='DELIVERY')) AND "collectionMethod"='CASH' AND "collectionComponent"='DELIVERY_FEE'
 AND cardinality("stopIds")=2 AND cardinality("packageIds") BETWEEN 1 AND 50 AND array_position("stopIds",NULL) IS NULL AND array_position("packageIds",NULL) IS NULL);
ALTER TABLE "DeliveryPrequote" ADD CONSTRAINT prequote_b2b_food CHECK ("integrationClientId" IS NULL OR NOT jsonb_path_exists(conditions,'$.packages[*] ? (@.category != "FOOD")'));
ALTER TABLE "DirectRequestLifecycle" ADD CONSTRAINT lifecycle_owner FOREIGN KEY ("deliveryRequestId","customerAccountId") REFERENCES "DeliveryRequest"(id,"customerAccountId");
ALTER TABLE "DirectRequestLifecycle" ADD CONSTRAINT lifecycle_shape CHECK (("closedAt" IS NULL AND "closureReason" IS NULL AND ("personalSlot" IS NULL OR "personalSlot"="customerAccountId")) OR ("closedAt" IS NOT NULL AND "closureReason" IN ('CANCELLED','DELIVERED','RETURNED','EXPIRED') AND "personalSlot" IS NULL));
ALTER TABLE "DeliveryShippingTerms" ADD CONSTRAINT shipping_terms_valid CHECK ("termsVersion"=1 AND method='CASH' AND component='DELIVERY_FEE' AND ((payer='REQUESTER' AND "dueAt"='PICKUP' AND "payerContact" IS NOT NULL) OR (payer='RECIPIENT' AND "dueAt"='DELIVERY')) AND "termsHash" ~ '^[a-f0-9]{64}$');
CREATE FUNCTION demand_owner_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW."integrationClientId",NEW."customerAccountId") IS DISTINCT FROM ROW(OLD."integrationClientId",OLD."customerAccountId") THEN RAISE EXCEPTION 'DEMAND_OWNER_IMMUTABLE'; END IF; RETURN NEW; END $$;
CREATE TRIGGER demand_owner_immutable BEFORE UPDATE ON "DeliveryRequest" FOR EACH ROW EXECUTE FUNCTION demand_owner_immutable();
CREATE TRIGGER demand_receipt_owner_immutable BEFORE UPDATE ON "ApiIdempotencyRecord" FOR EACH ROW EXECUTE FUNCTION demand_owner_immutable();
CREATE FUNCTION direct_lifecycle_validate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE rid uuid; r "DeliveryRequest"; l "DirectRequestLifecycle"; c "CustomerAccount"; terminal text;
BEGIN
 IF TG_TABLE_NAME='DeliveryRequest' THEN rid:=NEW.id; ELSE rid:=NEW."deliveryRequestId"; END IF;
 SELECT * INTO r FROM "DeliveryRequest" WHERE id=rid;
 IF r."customerAccountId" IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO c FROM "CustomerAccount" WHERE id=r."customerAccountId" FOR UPDATE;
 SELECT * INTO l FROM "DirectRequestLifecycle" WHERE "deliveryRequestId"=rid;
 SELECT CASE WHEN d.status='RETURNED' THEN 'RETURNED' WHEN r.status='CANCELLED' THEN 'CANCELLED' ELSE d.status::text END INTO terminal FROM (SELECT 1) stub LEFT JOIN "Dispatch" d ON d."deliveryRequestId"=rid AND d.status IN ('DELIVERED','RETURNED','EXPIRED') ORDER BY d."openedAt" DESC LIMIT 1;
 IF l."deliveryRequestId" IS NULL OR l."customerAccountId"<>c.id OR NOT EXISTS(SELECT 1 FROM "DeliveryShippingTerms" WHERE "deliveryRequestId"=rid) OR NOT EXISTS(SELECT 1 FROM "PrequoteConversion" WHERE "deliveryRequestId"=rid AND origin='DIRECT_CUSTOMER') THEN RAISE EXCEPTION 'DIRECT_REQUEST_INCOMPLETE'; END IF;
 IF terminal IS NULL THEN
   IF l."closedAt" IS NOT NULL OR (c.type='PERSONAL' AND l."personalSlot" IS DISTINCT FROM c.id) OR (c.type='BUSINESS' AND l."personalSlot" IS NOT NULL) THEN RAISE EXCEPTION 'DIRECT_LIFECYCLE_INVALID'; END IF;
 ELSE
   IF l."closedAt" IS NULL OR l."personalSlot" IS NOT NULL OR l."closureReason" IS DISTINCT FROM terminal THEN RAISE EXCEPTION 'DIRECT_LIFECYCLE_INVALID'; END IF;
 END IF; RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER direct_request_complete AFTER INSERT OR UPDATE ON "DeliveryRequest" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION direct_lifecycle_validate();
CREATE CONSTRAINT TRIGGER direct_lifecycle_complete AFTER INSERT OR UPDATE ON "DirectRequestLifecycle" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION direct_lifecycle_validate();
CREATE FUNCTION direct_lifecycle_close() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE rid uuid; reason text;
BEGIN
 IF TG_TABLE_NAME='DeliveryRequest' THEN rid:=NEW.id; IF NEW.status='CANCELLED' THEN reason:='CANCELLED'; END IF;
 ELSE rid:=NEW."deliveryRequestId"; IF NEW.status IN ('DELIVERED','RETURNED','EXPIRED') THEN reason:=NEW.status::text; END IF; END IF;
 IF reason IS NOT NULL THEN UPDATE "DirectRequestLifecycle" SET "closedAt"=clock_timestamp(),"closureReason"=reason,"personalSlot"=NULL WHERE "deliveryRequestId"=rid AND "closedAt" IS NULL; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER direct_close_request AFTER UPDATE ON "DeliveryRequest" FOR EACH ROW EXECUTE FUNCTION direct_lifecycle_close();
CREATE TRIGGER direct_close_dispatch AFTER UPDATE ON "Dispatch" FOR EACH ROW EXECUTE FUNCTION direct_lifecycle_close();
CREATE FUNCTION direct_type_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.type<>OLD.type AND EXISTS(SELECT 1 FROM "DirectRequestLifecycle" WHERE "customerAccountId"=NEW.id AND "closedAt" IS NULL) THEN RAISE EXCEPTION 'CUSTOMER_ACTIVE_REQUESTS'; END IF; RETURN NEW; END $$;
CREATE TRIGGER direct_type_guard BEFORE UPDATE ON "CustomerAccount" FOR EACH ROW EXECUTE FUNCTION direct_type_guard();
CREATE FUNCTION shipping_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SHIPPING_EVIDENCE_IMMUTABLE'; END $$;
CREATE TRIGGER shipping_terms_immutable BEFORE UPDATE OR DELETE ON "DeliveryShippingTerms" FOR EACH ROW EXECUTE FUNCTION shipping_immutable();
CREATE TRIGGER shipping_declaration_immutable BEFORE UPDATE OR DELETE ON "ShippingCollectionDeclaration" FOR EACH ROW EXECUTE FUNCTION shipping_immutable();
CREATE FUNCTION shipping_tracking_changed() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE "PublicDeliveryTracking" SET version=version+1,snapshot=NULL WHERE "deliveryRequestId"=NEW."deliveryRequestId"; RETURN NEW; END $$;
CREATE TRIGGER shipping_terms_tracking AFTER INSERT ON "DeliveryShippingTerms" FOR EACH ROW EXECUTE FUNCTION shipping_tracking_changed();
CREATE TRIGGER shipping_declaration_tracking AFTER INSERT ON "ShippingCollectionDeclaration" FOR EACH ROW EXECUTE FUNCTION shipping_tracking_changed();
UPDATE "PublicDeliveryTracking" SET version=version+1,snapshot=NULL;

ALTER TABLE "AuthorizedQuoteAcceptance" ALTER COLUMN "conversionId" DROP NOT NULL;
ALTER TABLE "AuthorizedQuoteAcceptance" ADD CONSTRAINT acceptance_nonconverted CHECK ("conversionId" IS NOT NULL OR ("integrationClientId" IS NOT NULL AND "authorizationVersion"=2 AND "shippingTermsHash" IS NOT NULL));
ALTER TABLE "AuthorizedQuoteAcceptance" DROP CONSTRAINT "AuthorizedAcceptance_facts";
ALTER TABLE "AuthorizedQuoteAcceptance" ADD CONSTRAINT "AuthorizedAcceptance_facts" CHECK (
 "authorizationVersion" IN (1,2) AND "authorizationStatus"='AUTHORIZED_BY_CUSTOMER'
 AND length(btrim("authorizationReference")) BETWEEN 1 AND 100 AND "authorizationReference"=btrim("authorizationReference")
 AND "authorizedAmount">=0 AND "authorizedCurrency"='MXN' AND "authorizedAt"<="acceptedAt" AND "acceptedAt"<"authorizedExpiresAt" AND "acceptedAt"<"authenticatedTokenExpiresAt"
);
ALTER TABLE "DeliveryExecutionCommand" DROP CONSTRAINT execution_command_state;
ALTER TABLE "DeliveryExecutionCommand" ADD CONSTRAINT execution_command_state CHECK (state='APPLIED' OR (state='CLOSED_NO_EFFECTS' AND (operation='ADVANCE' OR operation ~ '^RESOLVE:[0-9a-fA-F-]{36}$' OR operation ~ '^APP_(ADVANCE|REPORT|DELIVER|COLLECT_SHIPPING):[0-9a-f-]{36}$') AND hash='' AND response='{}'::jsonb));
ALTER TABLE "ShippingCollectionDeclaration" ADD CONSTRAINT collection_assignment FOREIGN KEY ("assignmentId") REFERENCES "DeliveryAssignment"(id);
ALTER TABLE "ShippingCollectionDeclaration" ADD CONSTRAINT collection_actor FOREIGN KEY ("driverUserId") REFERENCES "User"(id);
ALTER TABLE "ShippingCollectionDeclaration" ADD CONSTRAINT collection_quote FOREIGN KEY ("deliveryQuoteId") REFERENCES "DeliveryQuote"(id);
ALTER TABLE "ShippingCollectionDeclaration" ADD CONSTRAINT collection_dispatch FOREIGN KEY ("dispatchId") REFERENCES "Dispatch"(id);
ALTER TABLE "ShippingCollectionDeclaration" ADD CONSTRAINT collection_shape CHECK (amount>=0 AND currency='MXN' AND "receivedFrom" IN ('REQUESTER','AUTHORIZED_REPRESENTATIVE') AND "occurredAt"<="recordedAt");
CREATE FUNCTION shipping_collection_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d "Dispatch"; a "DeliveryAssignment"; e "DeliveryExecution"; t "DeliveryShippingTerms"; q "DeliveryQuote";
BEGIN
 SELECT * INTO d FROM "Dispatch" WHERE id=NEW."dispatchId" FOR UPDATE;
 SELECT * INTO e FROM "DeliveryExecution" WHERE "dispatchId"=d.id;
 SELECT * INTO a FROM "DeliveryAssignment" WHERE id=NEW."assignmentId";
 SELECT * INTO t FROM "DeliveryShippingTerms" WHERE "deliveryRequestId"=d."deliveryRequestId";
 SELECT * INTO q FROM "DeliveryQuote" WHERE id=d."deliveryQuoteId";
 IF d.status IS DISTINCT FROM 'CLAIMED' OR a.status IS DISTINCT FROM 'ACTIVE' OR a."dispatchId" IS DISTINCT FROM d.id OR e."assignmentId" IS DISTINCT FROM a.id OR e.phase IS DISTINCT FROM 2 OR t.payer IS DISTINCT FROM 'REQUESTER' OR NEW."deliveryRequestId" IS DISTINCT FROM d."deliveryRequestId" OR NEW."deliveryQuoteId" IS DISTINCT FROM q.id OR NEW."termsHash" IS DISTINCT FROM t."termsHash" OR NEW.amount IS DISTINCT FROM q.amount OR NEW.currency IS DISTINCT FROM q.currency OR NOT EXISTS(SELECT 1 FROM "Driver" dr JOIN "User" u ON u.id=dr."userId" WHERE dr.id=a."driverId" AND u.id=NEW."driverUserId" AND u.active AND u.role='DRIVER') THEN RAISE EXCEPTION 'SHIPPING_COLLECTION_INVALID'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER shipping_collection_guard BEFORE INSERT ON "ShippingCollectionDeclaration" FOR EACH ROW EXECUTE FUNCTION shipping_collection_guard();
CREATE FUNCTION shipping_pickup_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.phase>=3 AND EXISTS(SELECT 1 FROM "Dispatch" d JOIN "DeliveryShippingTerms" t ON t."deliveryRequestId"=d."deliveryRequestId" WHERE d.id=NEW."dispatchId" AND t.payer='REQUESTER' AND NOT EXISTS(SELECT 1 FROM "ShippingCollectionDeclaration" c WHERE c."deliveryRequestId"=d."deliveryRequestId")) THEN RAISE EXCEPTION 'SHIPPING_COLLECTION_REQUIRED'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER shipping_pickup_guard BEFORE INSERT OR UPDATE ON "DeliveryExecution" FOR EACH ROW EXECUTE FUNCTION shipping_pickup_guard();
CREATE FUNCTION shipping_authorized_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM "DeliveryShippingTerms" t WHERE t."deliveryRequestId"=NEW."deliveryRequestId" AND t.payer='REQUESTER') AND NOT EXISTS(SELECT 1 FROM "AuthorizedQuoteAcceptance" a WHERE a."dispatchId"=NEW.id AND a."deliveryRequestId"=NEW."deliveryRequestId" AND a."deliveryQuoteId"=NEW."deliveryQuoteId") THEN RAISE EXCEPTION 'AUTHORIZED_ACCEPT_REQUIRED'; END IF;
 IF EXISTS(SELECT 1 FROM "DirectRequestLifecycle" WHERE "deliveryRequestId"=NEW."deliveryRequestId" AND "closedAt" IS NOT NULL) THEN RAISE EXCEPTION 'DIRECT_REQUEST_CLOSED'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER shipping_authorized_guard BEFORE INSERT ON "Dispatch" FOR EACH ROW EXECUTE FUNCTION shipping_authorized_guard();
CREATE TRIGGER shipping_policy_history BEFORE UPDATE OR DELETE ON "ShippingPolicyAudit" FOR EACH ROW EXECUTE FUNCTION shipping_immutable();
ALTER TABLE "ShippingPolicyAudit" ADD CONSTRAINT shipping_policy_actor FOREIGN KEY ("actorUserId") REFERENCES "User"(id);
ALTER TABLE "ShippingPolicyAudit" ADD CONSTRAINT shipping_policy_client FOREIGN KEY ("integrationClientId") REFERENCES "IntegrationClient"(id);

-- These rows are durable evidence, not removable reservations. Terminal state cannot reopen.
CREATE FUNCTION direct_lifecycle_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'DIRECT_LIFECYCLE_IMMUTABLE'; END IF;
 IF ROW(NEW."deliveryRequestId",NEW."customerAccountId",NEW."createdAt") IS DISTINCT FROM ROW(OLD."deliveryRequestId",OLD."customerAccountId",OLD."createdAt") OR (OLD."closedAt" IS NOT NULL AND NEW IS DISTINCT FROM OLD) THEN RAISE EXCEPTION 'DIRECT_LIFECYCLE_IMMUTABLE'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER direct_lifecycle_immutable BEFORE UPDATE OR DELETE ON "DirectRequestLifecycle" FOR EACH ROW EXECUTE FUNCTION direct_lifecycle_immutable();

-- Validate the canonical financial terms independently of the application serializer.
CREATE FUNCTION shipping_terms_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r "DeliveryRequest"; p jsonb; base jsonb; expected text; captured jsonb;
BEGIN
 SELECT * INTO r FROM "DeliveryRequest" WHERE id=NEW."deliveryRequestId";
 IF NEW."policyRevision" IS NULL OR NEW."policyRevision"<1 THEN RAISE EXCEPTION 'SHIPPING_TERMS_INVALID'; END IF;
 base:=jsonb_build_object('payer',NEW.payer,'method',NEW.method,'dueAt',NEW."dueAt",'component',NEW.component,'termsVersion',NEW."termsVersion",'policyRevision',NEW."policyRevision");
 expected:=encode(sha256(convert_to(prequote_canonical_json(jsonb_build_object('operation','shipping.terms','payload',base)),'UTF8')),'hex');
 captured:=base || jsonb_build_object('termsHash',expected);
 SELECT q."shippingTerms" INTO p FROM "PrequoteConversion" c JOIN "DeliveryPrequote" q ON q.id=c."prequoteId" WHERE c."deliveryRequestId"=r.id;
 IF p IS NOT NULL AND p IS DISTINCT FROM captured THEN RAISE EXCEPTION 'SHIPPING_SNAPSHOT_MISMATCH'; END IF;
 IF NEW."payerContact" IS NOT NULL THEN
   IF jsonb_typeof(NEW."payerContact") IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(NEW."payerContact"))<>3 OR length(NEW."payerContact"->>'name') NOT BETWEEN 1 AND 100 OR NEW."payerContact"->>'phone' !~ '^\+?[0-9 ()-]{7,25}$' OR NEW."payerContact"->>'capacity' NOT IN ('REQUESTER','AUTHORIZED_REPRESENTATIVE') THEN RAISE EXCEPTION 'SHIPPING_CONTACT_INVALID'; END IF;
   expected:=encode(sha256(convert_to(prequote_canonical_json(jsonb_build_object('operation','shipping.final_terms','payload',jsonb_build_object('terms',captured,'payerContact',NEW."payerContact"))),'UTF8')),'hex');
 END IF;
 IF NEW."termsHash" IS DISTINCT FROM expected THEN RAISE EXCEPTION 'SHIPPING_TERMS_HASH_INVALID'; END IF;
 IF r."customerAccountId" IS NOT NULL AND EXISTS(SELECT 1 FROM "CustomerAccount" WHERE id=r."customerAccountId" AND type='PERSONAL') AND NEW.payer<>'REQUESTER' THEN RAISE EXCEPTION 'SHIPPING_PAYER_NOT_ALLOWED'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER shipping_terms_check BEFORE INSERT ON "DeliveryShippingTerms" FOR EACH ROW EXECUTE FUNCTION shipping_terms_check();

CREATE FUNCTION shipping_declaration_receipt_required() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM "DeliveryExecutionCommand" WHERE "dispatchId"=NEW."dispatchId" AND "actorUserId"=NEW."driverUserId" AND operation='APP_COLLECT_SHIPPING:'||NEW."assignmentId"::text AND state='APPLIED') THEN RAISE EXCEPTION 'SHIPPING_RECEIPT_REQUIRED'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER shipping_declaration_receipt_required AFTER INSERT ON "ShippingCollectionDeclaration" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION shipping_declaration_receipt_required();
CREATE FUNCTION shipping_detailed_assignment_required() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM "Dispatch" d JOIN "DeliveryShippingTerms" t ON t."deliveryRequestId"=d."deliveryRequestId" WHERE d.id=NEW."dispatchId" AND t.payer='REQUESTER') AND NOT EXISTS(SELECT 1 FROM "DeliveryExecution" WHERE "dispatchId"=NEW."dispatchId") THEN RAISE EXCEPTION 'SHIPPING_DETAILED_EXECUTION_REQUIRED'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER shipping_detailed_assignment_required AFTER INSERT ON "DeliveryAssignment" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION shipping_detailed_assignment_required();
