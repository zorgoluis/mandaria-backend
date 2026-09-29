-- CreateTable
CREATE TABLE "AuthorizedQuoteAcceptance" (
    "id" UUID NOT NULL,
    "conversionId" UUID NOT NULL,
    "deliveryRequestId" UUID NOT NULL,
    "deliveryQuoteId" UUID NOT NULL,
    "integrationClientId" UUID NOT NULL,
    "dispatchId" UUID NOT NULL,
    "idempotencyRecordId" UUID NOT NULL,
    "credentialId" UUID NOT NULL,
    "authenticatedTokenExpiresAt" TIMESTAMP(3) NOT NULL,
    "authorizationVersion" INTEGER NOT NULL,
    "authorizationStatus" TEXT NOT NULL,
    "authorizationReference" VARCHAR(100) NOT NULL,
    "authorizedAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT clock_timestamp(),
    "authorizedAmount" DECIMAL(14,2) NOT NULL,
    "authorizedCurrency" CHAR(3) NOT NULL,
    "authorizedExpiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuthorizedQuoteAcceptance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AuthorizedQuoteAcceptance_conversionId_key" ON "AuthorizedQuoteAcceptance"("conversionId");

-- CreateIndex
CREATE UNIQUE INDEX "AuthorizedQuoteAcceptance_deliveryRequestId_key" ON "AuthorizedQuoteAcceptance"("deliveryRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "AuthorizedQuoteAcceptance_deliveryQuoteId_key" ON "AuthorizedQuoteAcceptance"("deliveryQuoteId");

-- CreateIndex
CREATE UNIQUE INDEX "AuthorizedQuoteAcceptance_dispatchId_key" ON "AuthorizedQuoteAcceptance"("dispatchId");

-- CreateIndex
CREATE UNIQUE INDEX "AuthorizedQuoteAcceptance_idempotencyRecordId_key" ON "AuthorizedQuoteAcceptance"("idempotencyRecordId");

-- CreateIndex
CREATE UNIQUE INDEX "AuthorizedQuoteAcceptance_deliveryRequestId_integrationClie_key" ON "AuthorizedQuoteAcceptance"("deliveryRequestId", "integrationClientId");

-- CreateIndex
CREATE UNIQUE INDEX "AuthorizedQuoteAcceptance_deliveryQuoteId_deliveryRequestId_key" ON "AuthorizedQuoteAcceptance"("deliveryQuoteId", "deliveryRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "AuthorizedQuoteAcceptance_dispatchId_deliveryRequestId_key" ON "AuthorizedQuoteAcceptance"("dispatchId", "deliveryRequestId");

-- AddForeignKey
ALTER TABLE "AuthorizedQuoteAcceptance" ADD CONSTRAINT "AuthorizedQuoteAcceptance_conversionId_fkey" FOREIGN KEY ("conversionId") REFERENCES "PrequoteConversion"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AuthorizedQuoteAcceptance" ADD CONSTRAINT "AuthorizedQuoteAcceptance_deliveryRequestId_integrationCli_fkey" FOREIGN KEY ("deliveryRequestId", "integrationClientId") REFERENCES "DeliveryRequest"("id", "integrationClientId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AuthorizedQuoteAcceptance" ADD CONSTRAINT "AuthorizedQuoteAcceptance_deliveryQuoteId_deliveryRequestI_fkey" FOREIGN KEY ("deliveryQuoteId", "deliveryRequestId") REFERENCES "DeliveryQuote"("id", "deliveryRequestId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AuthorizedQuoteAcceptance" ADD CONSTRAINT "AuthorizedQuoteAcceptance_dispatchId_deliveryRequestId_fkey" FOREIGN KEY ("dispatchId", "deliveryRequestId") REFERENCES "Dispatch"("id", "deliveryRequestId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AuthorizedQuoteAcceptance" ADD CONSTRAINT "AuthorizedQuoteAcceptance_idempotencyRecordId_fkey" FOREIGN KEY ("idempotencyRecordId") REFERENCES "ApiIdempotencyRecord"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AuthorizedQuoteAcceptance" ADD CONSTRAINT "AuthorizedQuoteAcceptance_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "IntegrationCredential"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
-- Evidence precedes dispatch, but neither may commit alone. No backfill or flags in SQL.
ALTER TABLE "AuthorizedQuoteAcceptance" ALTER CONSTRAINT "AuthorizedQuoteAcceptance_dispatchId_deliveryRequestId_fkey" DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "AuthorizedQuoteAcceptance" ADD CONSTRAINT "AuthorizedAcceptance_facts" CHECK (
 "authorizationVersion"=1 AND "authorizationStatus"='AUTHORIZED_BY_CUSTOMER'
 AND length(btrim("authorizationReference")) BETWEEN 1 AND 100 AND "authorizationReference"=btrim("authorizationReference")
 AND "authorizedAmount">=0 AND "authorizedCurrency"='MXN'
 AND "authorizedAt"<="acceptedAt" AND "acceptedAt"<"authorizedExpiresAt" AND "acceptedAt"<"authenticatedTokenExpiresAt"
);
CREATE FUNCTION authorized_acceptance_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c "PrequoteConversion"; mq "DeliveryQuote"; r "DeliveryRequest"; k "ApiIdempotencyRecord";
 ic "IntegrationClient"; cr "IntegrationCredential"; zs "ServiceZoneStatus";
BEGIN
 SELECT * INTO k FROM "ApiIdempotencyRecord" WHERE id=NEW."idempotencyRecordId" FOR UPDATE;
 IF k.id IS NULL OR k.operation<>'delivery_quotes.accept_authorized' OR k."resourceType"<>'AuthorizedQuoteAcceptance'
 OR k."resourceId"<>NEW.id OR k."integrationClientId"<>NEW."integrationClientId"
 OR EXISTS(SELECT 1 FROM "ApiIdempotencyExecution" WHERE "recordId"=k.id) THEN RAISE EXCEPTION 'AUTHORIZED_ACCEPT_KEY_INVALID'; END IF;
 -- Uniform parent -> credential -> request -> quote -> zone order.
 SELECT * INTO ic FROM "IntegrationClient" WHERE id=NEW."integrationClientId" FOR SHARE;
 SELECT * INTO cr FROM "IntegrationCredential" WHERE id=NEW."credentialId" FOR SHARE;
 SELECT * INTO r FROM "DeliveryRequest" WHERE id=NEW."deliveryRequestId" FOR UPDATE;
 SELECT * INTO mq FROM "DeliveryQuote" WHERE id=NEW."deliveryQuoteId" FOR SHARE;
 SELECT * INTO c FROM "PrequoteConversion" WHERE id=NEW."conversionId";
 IF c.id IS NULL OR r.id IS NULL OR mq.id IS NULL OR c."deliveryRequestId"<>r.id OR c."deliveryQuoteId"<>mq.id
 OR c."integrationClientId"<>NEW."integrationClientId" OR r."integrationClientId"<>NEW."integrationClientId" OR mq."deliveryRequestId"<>r.id THEN RAISE EXCEPTION 'AUTHORIZED_ACCEPT_OWNER_INVALID'; END IF;
 IF EXISTS(SELECT 1 FROM "AuthorizedQuoteAcceptance" WHERE "deliveryQuoteId"=mq.id) THEN RAISE EXCEPTION 'QUOTE_ALREADY_AUTHORIZED'; END IF;
 IF r.status<>'CREATED' OR mq.status NOT IN ('OFFERED','EXPIRED') THEN RAISE EXCEPTION 'QUOTE_NOT_ACCEPTABLE'; END IF;
 SELECT status INTO zs FROM "ServiceZone" WHERE id=mq."serviceZoneId" FOR SHARE;
 IF zs IS DISTINCT FROM 'ACTIVE' THEN RAISE EXCEPTION 'AUTHORIZED_ACCEPT_SERVICE_UNAVAILABLE'; END IF;
 NEW."acceptedAt":=date_trunc('milliseconds',clock_timestamp() AT TIME ZONE 'UTC');
 IF mq.status='EXPIRED' OR NEW."acceptedAt">=mq."expiresAt" THEN RAISE EXCEPTION 'QUOTE_EXPIRED'; END IF;
 IF ic.status IS DISTINCT FROM 'ACTIVE' OR cr.id IS NULL OR cr."clientId"<>ic.id OR cr.status<>'ACTIVE'
 OR cr."revokedAt" IS NOT NULL OR cr."expiresAt"<=NEW."acceptedAt" OR NEW."authenticatedTokenExpiresAt"<=NEW."acceptedAt"
 OR NOT ('quotes:accept'=ANY(cr.scopes)) THEN RAISE EXCEPTION 'AUTHORIZED_ACCEPT_AUTH_INVALID'; END IF;
 IF ROW(NEW."authorizedAmount",NEW."authorizedCurrency",NEW."authorizedExpiresAt") IS DISTINCT FROM ROW(mq.amount,mq.currency,mq."expiresAt")
 OR NEW."authorizedAt"<mq."createdAt" OR NEW."authorizedAt">NEW."acceptedAt" THEN RAISE EXCEPTION 'CUSTOMER_AUTHORIZATION_MISMATCH'; END IF;
 IF EXISTS(SELECT 1 FROM "Dispatch" WHERE id=NEW."dispatchId" OR "deliveryQuoteId"=mq.id OR "deliveryRequestId"=r.id) THEN RAISE EXCEPTION 'AUTHORIZED_ACCEPT_DESTINATION_EXISTS'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "AuthorizedAcceptance_insert" BEFORE INSERT ON "AuthorizedQuoteAcceptance" FOR EACH ROW EXECUTE FUNCTION authorized_acceptance_insert();
CREATE FUNCTION authorized_acceptance_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'AUTHORIZED_ACCEPT_IMMUTABLE'; END $$;
CREATE TRIGGER "AuthorizedAcceptance_immutable" BEFORE UPDATE OR DELETE ON "AuthorizedQuoteAcceptance" FOR EACH ROW EXECUTE FUNCTION authorized_acceptance_immutable();

CREATE OR REPLACE FUNCTION conversion_quote_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c "PrequoteConversion"; a "AuthorizedQuoteAcceptance";
BEGIN
 IF TG_OP<>'INSERT' THEN
  IF EXISTS(SELECT 1 FROM "PrequoteConversion" WHERE "deliveryQuoteId"=OLD.id) THEN
   IF TG_OP='DELETE' THEN RAISE EXCEPTION 'CONVERSION_CONTENT_IMMUTABLE'; END IF;
   IF NEW.id<>OLD.id OR NEW."deliveryRequestId"<>OLD."deliveryRequestId" THEN RAISE EXCEPTION 'CONVERSION_CONTENT_IMMUTABLE'; END IF;
  END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 SELECT * INTO c FROM "PrequoteConversion" WHERE "deliveryRequestId"=NEW."deliveryRequestId";
 IF c.id IS NOT NULL THEN
  IF c."deliveryQuoteId"<>NEW.id THEN RAISE EXCEPTION 'PREQUOTE_REQUOTE_NOT_ALLOWED'; END IF;
  IF NEW.status='ACCEPTED' OR NEW."acceptedAt" IS NOT NULL THEN
   SELECT * INTO a FROM "AuthorizedQuoteAcceptance" WHERE "conversionId"=c.id;
   IF a.id IS NULL OR a."deliveryQuoteId"<>NEW.id OR a."deliveryRequestId"<>NEW."deliveryRequestId"
   OR NEW.status<>'ACCEPTED' OR NEW."acceptedAt" IS DISTINCT FROM a."acceptedAt" THEN RAISE EXCEPTION 'AUTHORIZED_ACCEPT_REQUIRED'; END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER "Conversion_dispatch" ON "Dispatch";
CREATE OR REPLACE FUNCTION conversion_dispatch_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a "AuthorizedQuoteAcceptance"; c "PrequoteConversion";
BEGIN
 IF TG_OP<>'INSERT' THEN
  IF EXISTS(SELECT 1 FROM "PrequoteConversion" WHERE "deliveryRequestId"=OLD."deliveryRequestId" OR "deliveryQuoteId"=OLD."deliveryQuoteId") THEN
   IF TG_OP='DELETE' THEN RAISE EXCEPTION 'AUTHORIZED_ACCEPT_IMMUTABLE'; END IF;
   IF NEW.id<>OLD.id OR NEW."deliveryRequestId"<>OLD."deliveryRequestId" OR NEW."deliveryQuoteId"<>OLD."deliveryQuoteId" THEN RAISE EXCEPTION 'AUTHORIZED_ACCEPT_IMMUTABLE'; END IF;
  END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 SELECT * INTO c FROM "PrequoteConversion" WHERE "deliveryRequestId"=NEW."deliveryRequestId" OR "deliveryQuoteId"=NEW."deliveryQuoteId";
 IF c.id IS NOT NULL THEN
  SELECT * INTO a FROM "AuthorizedQuoteAcceptance" WHERE "conversionId"=c.id;
  IF a.id IS NULL OR a."dispatchId"<>NEW.id OR a."deliveryRequestId"<>NEW."deliveryRequestId" OR a."deliveryQuoteId"<>NEW."deliveryQuoteId" THEN RAISE EXCEPTION 'AUTHORIZED_ACCEPT_REQUIRED'; END IF;
  IF TG_OP='INSERT' AND NOT EXISTS(SELECT 1 FROM "DeliveryRequest" WHERE id=a."deliveryRequestId" AND status='CREATED') THEN RAISE EXCEPTION 'QUOTE_NOT_ACCEPTABLE'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "Conversion_dispatch" BEFORE INSERT OR UPDATE OR DELETE ON "Dispatch" FOR EACH ROW EXECUTE FUNCTION conversion_dispatch_guard();
CREATE FUNCTION authorized_acceptance_key_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.operation='delivery_quotes.accept_authorized' OR OLD."resourceType"='AuthorizedQuoteAcceptance'
 OR EXISTS(SELECT 1 FROM "AuthorizedQuoteAcceptance" WHERE "idempotencyRecordId"=OLD.id) THEN RAISE EXCEPTION 'AUTHORIZED_ACCEPT_KEY_IMMUTABLE'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 IF NEW.operation='delivery_quotes.accept_authorized' OR NEW."resourceType"='AuthorizedQuoteAcceptance' THEN RAISE EXCEPTION 'AUTHORIZED_ACCEPT_KEY_IMMUTABLE'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "AuthorizedAcceptance_key" BEFORE UPDATE OR DELETE ON "ApiIdempotencyRecord" FOR EACH ROW EXECUTE FUNCTION authorized_acceptance_key_guard();
CREATE FUNCTION authorized_acceptance_execution_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM "ApiIdempotencyRecord" WHERE id=NEW."recordId" AND (operation='delivery_quotes.accept_authorized' OR "resourceType"='AuthorizedQuoteAcceptance')) THEN RAISE EXCEPTION 'AUTHORIZED_ACCEPT_KEY_INVALID'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "AuthorizedAcceptance_execution" BEFORE INSERT OR UPDATE ON "ApiIdempotencyExecution" FOR EACH ROW EXECUTE FUNCTION authorized_acceptance_execution_guard();

-- Creation-time only. Historical lifecycle does NOT revalidate original token/quote expiry.
CREATE FUNCTION authorized_acceptance_atomic_result() RETURNS trigger LANGUAGE plpgsql AS $$
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
 IF c.id IS NULL OR mq.id IS NULL OR r.id IS NULL OR d.id IS NULL OR k.id IS NULL
 OR c."deliveryQuoteId"<>mq.id OR c."deliveryRequestId"<>r.id OR c."integrationClientId"<>a."integrationClientId"
 OR mq."deliveryRequestId"<>r.id OR r."integrationClientId"<>a."integrationClientId"
 OR k.operation<>'delivery_quotes.accept_authorized' OR k."resourceType"<>'AuthorizedQuoteAcceptance' OR k."resourceId"<>a.id OR k."integrationClientId"<>a."integrationClientId"
 OR mq.status<>'ACCEPTED' OR mq."acceptedAt" IS DISTINCT FROM a."acceptedAt" OR r.status<>'CREATED'
 OR d."deliveryRequestId"<>r.id OR d."deliveryQuoteId"<>mq.id OR d.status<>'OPEN' OR d."openedAt"<>a."acceptedAt"
 OR EXISTS(SELECT 1 FROM "ApiIdempotencyExecution" WHERE "recordId"=k.id)
 OR NOT EXISTS(SELECT 1 FROM "DispatchCreditSnapshot" WHERE "dispatchId"=d.id AND "actorType"='PROVIDER')
 OR NOT EXISTS(SELECT 1 FROM "DispatchCreditSnapshot" WHERE "dispatchId"=d.id AND "actorType"='INDEPENDENT_DRIVER')
 THEN RAISE EXCEPTION 'AUTHORIZED_ACCEPT_ATOMIC_RESULT'; END IF;
 IF ROW(a."authorizedAmount",a."authorizedCurrency",a."authorizedExpiresAt") IS DISTINCT FROM ROW(mq.amount,mq.currency,mq."expiresAt") OR a."authorizedAt"<mq."createdAt" THEN RAISE EXCEPTION 'CUSTOMER_AUTHORIZATION_MISMATCH'; END IF;
 now_at:=clock_timestamp() AT TIME ZONE 'UTC';
 IF now_at>=mq."expiresAt" THEN RAISE EXCEPTION 'QUOTE_EXPIRED'; END IF;
 SELECT * INTO cr FROM "IntegrationCredential" WHERE id=a."credentialId";
 IF cr.id IS NULL OR cr."clientId"<>a."integrationClientId" OR cr.status<>'ACTIVE' OR cr."revokedAt" IS NOT NULL OR cr."expiresAt"<=now_at
 OR a."authenticatedTokenExpiresAt"<=now_at OR NOT ('quotes:accept'=ANY(cr.scopes))
 OR NOT EXISTS(SELECT 1 FROM "IntegrationClient" WHERE id=a."integrationClientId" AND status='ACTIVE') THEN RAISE EXCEPTION 'AUTHORIZED_ACCEPT_AUTH_INVALID'; END IF;
 IF NOT EXISTS(SELECT 1 FROM "ServiceZone" WHERE id=mq."serviceZoneId" AND status='ACTIVE') THEN RAISE EXCEPTION 'AUTHORIZED_ACCEPT_SERVICE_UNAVAILABLE'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "AuthorizedAcceptance_result" AFTER INSERT ON "AuthorizedQuoteAcceptance" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION authorized_acceptance_atomic_result();
CREATE CONSTRAINT TRIGGER "AuthorizedAcceptance_record_result" AFTER INSERT ON "ApiIdempotencyRecord" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION authorized_acceptance_atomic_result();
