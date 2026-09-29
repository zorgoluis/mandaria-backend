-- CreateTable
CREATE TABLE "PrequoteConversion" (
    "id" UUID NOT NULL,
    "prequoteId" UUID NOT NULL,
    "deliveryRequestId" UUID NOT NULL,
    "deliveryQuoteId" UUID NOT NULL,
    "idempotencyRecordId" UUID NOT NULL,
    "integrationClientId" UUID NOT NULL,
    "convertedAt" TIMESTAMP(3) NOT NULL DEFAULT clock_timestamp(),
    "goodsPaymentStatus" TEXT NOT NULL,
    "goodsPaymentReference" TEXT NOT NULL,
    "goodsPaymentConfirmedAt" TIMESTAMP(3) NOT NULL,
    "orderAcceptanceStatus" TEXT NOT NULL,
    "orderAcceptanceReference" TEXT NOT NULL,
    "orderAcceptedAt" TIMESTAMP(3) NOT NULL,
    "collectionPayer" TEXT NOT NULL,
    "collectionMethod" TEXT NOT NULL,
    "collectionDueAt" TEXT NOT NULL,
    "collectionComponent" TEXT NOT NULL,
    "stopIds" UUID[],
    "packageIds" UUID[],
    "financialContextId" UUID NOT NULL,

    CONSTRAINT "PrequoteConversion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PrequoteConversion_prequoteId_key" ON "PrequoteConversion"("prequoteId");

-- CreateIndex
CREATE UNIQUE INDEX "PrequoteConversion_deliveryRequestId_key" ON "PrequoteConversion"("deliveryRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "PrequoteConversion_deliveryQuoteId_key" ON "PrequoteConversion"("deliveryQuoteId");

-- CreateIndex
CREATE UNIQUE INDEX "PrequoteConversion_idempotencyRecordId_key" ON "PrequoteConversion"("idempotencyRecordId");

-- CreateIndex
CREATE UNIQUE INDEX "PrequoteConversion_prequoteId_integrationClientId_key" ON "PrequoteConversion"("prequoteId", "integrationClientId");

-- CreateIndex
CREATE UNIQUE INDEX "PrequoteConversion_deliveryRequestId_integrationClientId_key" ON "PrequoteConversion"("deliveryRequestId", "integrationClientId");

-- CreateIndex
CREATE UNIQUE INDEX "PrequoteConversion_deliveryQuoteId_deliveryRequestId_key" ON "PrequoteConversion"("deliveryQuoteId", "deliveryRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryQuote_id_deliveryRequestId_key" ON "DeliveryQuote"("id", "deliveryRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryPrequote_id_integrationClientId_key" ON "DeliveryPrequote"("id", "integrationClientId");

-- AddForeignKey
ALTER TABLE "PrequoteConversion" ADD CONSTRAINT "PrequoteConversion_prequoteId_integrationClientId_fkey" FOREIGN KEY ("prequoteId", "integrationClientId") REFERENCES "DeliveryPrequote"("id", "integrationClientId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PrequoteConversion" ADD CONSTRAINT "PrequoteConversion_deliveryRequestId_integrationClientId_fkey" FOREIGN KEY ("deliveryRequestId", "integrationClientId") REFERENCES "DeliveryRequest"("id", "integrationClientId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PrequoteConversion" ADD CONSTRAINT "PrequoteConversion_deliveryQuoteId_deliveryRequestId_fkey" FOREIGN KEY ("deliveryQuoteId", "deliveryRequestId") REFERENCES "DeliveryQuote"("id", "deliveryRequestId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PrequoteConversion" ADD CONSTRAINT "PrequoteConversion_idempotencyRecordId_fkey" FOREIGN KEY ("idempotencyRecordId") REFERENCES "ApiIdempotencyRecord"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
-- B2: origins exist before destinations; only destination FKs are deferred.
ALTER TABLE "PrequoteConversion" ALTER CONSTRAINT "PrequoteConversion_deliveryRequestId_integrationClientId_fkey" DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "PrequoteConversion" ALTER CONSTRAINT "PrequoteConversion_deliveryQuoteId_deliveryRequestId_fkey" DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "PrequoteConversion" ALTER COLUMN "stopIds" SET NOT NULL;
ALTER TABLE "PrequoteConversion" ALTER COLUMN "packageIds" SET NOT NULL;
ALTER TABLE "PrequoteConversion" ADD CONSTRAINT "Conversion_facts" CHECK (
 "goodsPaymentStatus"='CONFIRMED_BY_MERCHANT' AND "orderAcceptanceStatus"='ACCEPTED_BY_MERCHANT'
 AND length(btrim("goodsPaymentReference")) BETWEEN 1 AND 100 AND "goodsPaymentReference"=btrim("goodsPaymentReference")
 AND length(btrim("orderAcceptanceReference")) BETWEEN 1 AND 100 AND "orderAcceptanceReference"=btrim("orderAcceptanceReference")
 AND "goodsPaymentConfirmedAt" <= "convertedAt" AND "orderAcceptedAt" <= "convertedAt"
 AND "collectionPayer"='RECIPIENT' AND "collectionMethod"='CASH' AND "collectionDueAt"='DELIVERY' AND "collectionComponent"='DELIVERY_FEE'
 AND cardinality("stopIds")=2 AND cardinality("packageIds") BETWEEN 1 AND 50
 AND array_position("stopIds",NULL) IS NULL AND array_position("packageIds",NULL) IS NULL
);
CREATE FUNCTION conversion_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q "DeliveryPrequote"; r "ApiIdempotencyRecord"; zone_status "ServiceZoneStatus";
BEGIN
 SELECT * INTO r FROM "ApiIdempotencyRecord" WHERE id=NEW."idempotencyRecordId" FOR UPDATE;
 IF r.id IS NULL OR r."integrationClientId"<>NEW."integrationClientId" OR r."resourceId"<>NEW.id
 OR r.operation<>'delivery_prequotes.convert' OR r."resourceType"<>'PrequoteConversion'
 OR EXISTS(SELECT 1 FROM "ApiIdempotencyExecution" WHERE "recordId"=r.id) THEN RAISE EXCEPTION 'CONVERSION_KEY_INVALID'; END IF;
 SELECT * INTO q FROM "DeliveryPrequote" WHERE id=NEW."prequoteId" AND "integrationClientId"=NEW."integrationClientId" FOR UPDATE;
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
END $$;
CREATE TRIGGER "Conversion_insert" BEFORE INSERT ON "PrequoteConversion" FOR EACH ROW EXECUTE FUNCTION conversion_insert_guard();
CREATE FUNCTION conversion_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'CONVERSION_IMMUTABLE'; END $$;
CREATE TRIGGER "Conversion_immutable" BEFORE UPDATE OR DELETE ON "PrequoteConversion" FOR EACH ROW EXECUTE FUNCTION conversion_immutable();

-- No transaction identifier or mutable construction flag. Every approved identity must be
-- occupied at COMMIT; PK + immutable children then make further INSERT impossible.
CREATE FUNCTION conversion_child_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c "PrequoteConversion"; rid uuid;
BEGIN
 IF TG_OP<>'INSERT' THEN
  IF EXISTS(SELECT 1 FROM "PrequoteConversion" WHERE "deliveryRequestId"=OLD."deliveryRequestId") THEN RAISE EXCEPTION 'CONVERSION_CONTENT_IMMUTABLE'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 rid:=NEW."deliveryRequestId";
 SELECT * INTO c FROM "PrequoteConversion" WHERE "deliveryRequestId"=rid;
 IF c.id IS NOT NULL THEN
  IF TG_OP<>'INSERT' OR (TG_TABLE_NAME='DeliveryStop' AND NOT NEW.id=ANY(c."stopIds"))
   OR (TG_TABLE_NAME='DeliveryPackage' AND NOT NEW.id=ANY(c."packageIds"))
   OR (TG_TABLE_NAME='DeliveryFinancialContext' AND NEW.id<>c."financialContextId") THEN RAISE EXCEPTION 'CONVERSION_CONTENT_IMMUTABLE'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "Conversion_child" BEFORE INSERT OR UPDATE OR DELETE ON "DeliveryStop" FOR EACH ROW EXECUTE FUNCTION conversion_child_guard();
CREATE TRIGGER "Conversion_child" BEFORE INSERT OR UPDATE OR DELETE ON "DeliveryPackage" FOR EACH ROW EXECUTE FUNCTION conversion_child_guard();
CREATE TRIGGER "Conversion_child" BEFORE INSERT OR UPDATE OR DELETE ON "DeliveryFinancialContext" FOR EACH ROW EXECUTE FUNCTION conversion_child_guard();
CREATE FUNCTION conversion_request_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM "PrequoteConversion" WHERE "deliveryRequestId"=OLD.id) THEN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'CONVERSION_CONTENT_IMMUTABLE'; END IF;
  IF (to_jsonb(NEW)-ARRAY['status','cancelledAt','cancellationReason','updatedAt']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','cancelledAt','cancellationReason','updatedAt'])
   OR NOT (NEW.status=OLD.status OR (OLD.status='CREATED' AND NEW.status='CANCELLED')) THEN RAISE EXCEPTION 'CONVERSION_CONTENT_IMMUTABLE'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "Conversion_request" BEFORE UPDATE OR DELETE ON "DeliveryRequest" FOR EACH ROW EXECUTE FUNCTION conversion_request_guard();
CREATE FUNCTION conversion_quote_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c "PrequoteConversion";
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
  IF NEW.status='ACCEPTED' OR NEW."acceptedAt" IS NOT NULL THEN RAISE EXCEPTION 'AUTHORIZED_ACCEPT_REQUIRED'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "Conversion_quote" BEFORE INSERT OR UPDATE OR DELETE ON "DeliveryQuote" FOR EACH ROW EXECUTE FUNCTION conversion_quote_guard();
CREATE FUNCTION conversion_dispatch_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM "PrequoteConversion" WHERE "deliveryRequestId"=NEW."deliveryRequestId" OR "deliveryQuoteId"=NEW."deliveryQuoteId") THEN RAISE EXCEPTION 'AUTHORIZED_ACCEPT_REQUIRED'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "Conversion_dispatch" BEFORE INSERT OR UPDATE ON "Dispatch" FOR EACH ROW EXECUTE FUNCTION conversion_dispatch_guard();
CREATE FUNCTION conversion_key_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.operation='delivery_prequotes.convert' OR OLD."resourceType"='PrequoteConversion'
 OR EXISTS(SELECT 1 FROM "PrequoteConversion" WHERE "idempotencyRecordId"=OLD.id) THEN RAISE EXCEPTION 'CONVERSION_KEY_IMMUTABLE'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 IF NEW.operation='delivery_prequotes.convert' OR NEW."resourceType"='PrequoteConversion' THEN RAISE EXCEPTION 'CONVERSION_KEY_IMMUTABLE'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "Conversion_key" BEFORE UPDATE OR DELETE ON "ApiIdempotencyRecord" FOR EACH ROW EXECUTE FUNCTION conversion_key_guard();

CREATE FUNCTION conversion_atomic_result() RETURNS trigger LANGUAGE plpgsql AS $$
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
 IF k.id IS NULL OR k.operation<>'delivery_prequotes.convert' OR k."resourceType"<>'PrequoteConversion' OR k."resourceId"<>c.id OR k."integrationClientId"<>c."integrationClientId"
 OR r.id IS NULL OR mq.id IS NULL OR f.id IS NULL OR q.id IS NULL OR r."integrationClientId"<>c."integrationClientId"
 OR mq."deliveryRequestId"<>r.id OR r.status<>'CREATED' OR mq.status<>'OFFERED' OR mq."acceptedAt" IS NOT NULL
 OR r."createdAt"<>c."convertedAt" OR r."requestedAt"<>c."convertedAt" OR mq."createdAt"<>c."convertedAt"
 OR f.id<>c."financialContextId" OR f."goodsPaymentMode"<>'PREPAID' OR f.currency<>'MXN'
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
END $$;
CREATE CONSTRAINT TRIGGER "Conversion_result" AFTER INSERT ON "PrequoteConversion" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION conversion_atomic_result();
CREATE CONSTRAINT TRIGGER "Conversion_record_result" AFTER INSERT ON "ApiIdempotencyRecord" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION conversion_atomic_result();
