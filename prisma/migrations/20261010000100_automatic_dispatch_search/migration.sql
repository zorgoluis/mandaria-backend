-- Central DB clock; never controlled by HTTP, process clocks or a session GUC.
CREATE FUNCTION dispatch_search_now() RETURNS timestamp(3) LANGUAGE sql VOLATILE AS $$ SELECT clock_timestamp() AT TIME ZONE 'UTC' $$;
ALTER TABLE "IntegrationClient" ADD COLUMN "automaticDispatchSearch" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Dispatch"
 ADD COLUMN "searchMaxAttempts" INTEGER NOT NULL DEFAULT 1,
 ADD COLUMN "searchAttempt" INTEGER NOT NULL DEFAULT 1,
 ADD COLUMN "searchWindowSeconds" INTEGER,
 ADD COLUMN "searchStoppedReason" TEXT;
ALTER TABLE "Dispatch" ADD CONSTRAINT "Dispatch_search_shape" CHECK (
 ("searchMaxAttempts"=1 AND "searchAttempt"=1 AND "searchWindowSeconds" IS NULL AND "searchStoppedReason" IS NULL)
 OR ("searchMaxAttempts"=5 AND "searchAttempt" BETWEEN 1 AND 5 AND "searchWindowSeconds" IS NOT NULL AND "searchWindowSeconds" BETWEEN 60 AND 86400
 AND ("searchStoppedReason" IS NULL OR "searchStoppedReason" IN ('EXECUTOR_FOUND','REQUEST_CANCELLED','EXHAUSTED','SERVICE_UNAVAILABLE','INTEGRATION_UNAVAILABLE'))));
CREATE TABLE "DispatchSearchRound" (
 "dispatchId" UUID NOT NULL REFERENCES "Dispatch"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
 attempt INTEGER NOT NULL CHECK(attempt BETWEEN 1 AND 5),
 "openedAt" TIMESTAMP(3) NOT NULL,
 "expiresAt" TIMESTAMP(3) NOT NULL,
 "providerIds" UUID[] NOT NULL,
 PRIMARY KEY("dispatchId",attempt),
 CHECK("expiresAt">"openedAt")
);
CREATE FUNCTION dispatch_search_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE now_at TIMESTAMP(3):=dispatch_search_now(); request_status "DeliveryRequestStatus";
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW."searchMaxAttempts"=5 THEN
   IF NEW."searchAttempt"<>1 OR NEW."searchStoppedReason" IS NOT NULL OR NOT EXISTS (
    SELECT 1 FROM "AuthorizedQuoteAcceptance" a JOIN "IntegrationClient" i ON i.id=a."integrationClientId"
    WHERE a."dispatchId"=NEW.id AND i."automaticDispatchSearch" AND i.status='ACTIVE'
   ) THEN RAISE EXCEPTION 'DISPATCH_SEARCH_NOT_AUTHORIZED'; END IF;
   IF NEW."expiresAt"<>NEW."openedAt"+make_interval(secs=>NEW."searchWindowSeconds") THEN RAISE EXCEPTION 'DISPATCH_SEARCH_WINDOW_INVALID'; END IF;
  END IF;
  RETURN NEW;
 END IF;
 IF ROW(NEW."searchMaxAttempts",NEW."searchWindowSeconds") IS DISTINCT FROM ROW(OLD."searchMaxAttempts",OLD."searchWindowSeconds") THEN RAISE EXCEPTION 'DISPATCH_SEARCH_POLICY_IMMUTABLE'; END IF;
 IF OLD."searchMaxAttempts"=1 THEN
  IF NEW."expiresAt"<>OLD."expiresAt" THEN RAISE EXCEPTION 'DISPATCH_IMMUTABLE'; END IF;
  RETURN NEW;
 END IF;
 SELECT status INTO request_status FROM "DeliveryRequest" WHERE id=OLD."deliveryRequestId";
 IF OLD."searchStoppedReason" IS NOT NULL AND NEW."searchStoppedReason" IS DISTINCT FROM OLD."searchStoppedReason" THEN RAISE EXCEPTION 'DISPATCH_SEARCH_HISTORY_IMMUTABLE'; END IF;
 IF NEW."searchAttempt"<>OLD."searchAttempt" THEN
  IF OLD.status<>'OPEN' OR NEW.status<>'OPEN' OR OLD."searchStoppedReason" IS NOT NULL
   OR OLD."claimedAt" IS NOT NULL OR request_status<>'CREATED' OR now_at<OLD."expiresAt"
   OR NEW."searchAttempt"<>OLD."searchAttempt"+1 OR NEW."searchAttempt">5
   OR NEW."searchStoppedReason" IS NOT NULL THEN RAISE EXCEPTION 'DISPATCH_SEARCH_RETRY_INVALID'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "DeliveryRequest" r JOIN "IntegrationClient" i ON i.id=r."integrationClientId" WHERE r.id=OLD."deliveryRequestId" AND i.status='ACTIVE')
   OR NOT EXISTS (SELECT 1 FROM "DeliveryQuote" q JOIN "ServiceZone" z ON z.id=q."serviceZoneId" WHERE q.id=OLD."deliveryQuoteId" AND z.status='ACTIVE') THEN RAISE EXCEPTION 'DISPATCH_SEARCH_UNAVAILABLE'; END IF;
  NEW."expiresAt":=now_at+make_interval(secs=>OLD."searchWindowSeconds");
 ELSIF NEW."expiresAt"<>OLD."expiresAt" THEN RAISE EXCEPTION 'DISPATCH_SEARCH_WINDOW_IMMUTABLE';
 END IF;
 IF OLD.status='OPEN' AND NEW.status='CLAIMED' THEN
  IF now_at>=OLD."expiresAt" THEN
   IF OLD."searchAttempt"<5 AND OLD."searchStoppedReason" IS NULL THEN RAISE EXCEPTION 'DISPATCH_SEARCH_CLAIM_RETRY_PENDING'; END IF;
   RAISE EXCEPTION 'DISPATCH_SEARCH_CLAIM_EXPIRED';
  END IF;
  NEW."searchStoppedReason":=COALESCE(OLD."searchStoppedReason",'EXECUTOR_FOUND');
 ELSIF OLD."searchStoppedReason" IS NULL AND (NEW.status='CANCELLED' OR request_status='CANCELLED') THEN
  NEW."searchStoppedReason":='REQUEST_CANCELLED';
 ELSIF OLD."searchStoppedReason" IS NULL AND NEW.status='EXPIRED' THEN
  IF NEW."searchStoppedReason" IS NULL THEN
   IF OLD."searchAttempt"<5 OR now_at<OLD."expiresAt" THEN RAISE EXCEPTION 'DISPATCH_SEARCH_RETRY_PENDING'; END IF;
   NEW."searchStoppedReason":='EXHAUSTED';
  ELSIF NEW."searchStoppedReason" NOT IN ('SERVICE_UNAVAILABLE','INTEGRATION_UNAVAILABLE') THEN RAISE EXCEPTION 'DISPATCH_SEARCH_STOP_INVALID'; END IF;
 ELSIF OLD."searchStoppedReason" IS NULL AND NEW."searchStoppedReason" IS NOT NULL THEN RAISE EXCEPTION 'DISPATCH_SEARCH_STOP_INVALID';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "Dispatch_search_guard" BEFORE INSERT OR UPDATE ON "Dispatch" FOR EACH ROW EXECUTE FUNCTION dispatch_search_guard();
CREATE FUNCTION dispatch_search_record() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ids UUID[]; starts TIMESTAMP(3);
BEGIN
 IF NEW."searchMaxAttempts"<>5 THEN RETURN NULL; END IF;
 IF TG_OP='UPDATE' AND NEW."searchAttempt"=OLD."searchAttempt" THEN RETURN NULL; END IF;
 starts:=CASE WHEN NEW."searchAttempt"=1 THEN NEW."openedAt" ELSE NEW."expiresAt"-make_interval(secs=>NEW."searchWindowSeconds") END;
 SELECT COALESCE(array_agg(p.id ORDER BY p.id),ARRAY[]::uuid[]) INTO ids
 FROM "DeliveryProvider" p JOIN "ProviderServiceCoverage" c ON c."providerId"=p.id
 JOIN "DeliveryQuote" q ON q.id=NEW."deliveryQuoteId" AND q."serviceZoneId"=c."serviceZoneId" AND q."serviceType"=c."serviceType"
 WHERE p.status='ACTIVE' AND c.status='ACTIVE';
 INSERT INTO "DispatchSearchRound" VALUES(NEW.id,NEW."searchAttempt",starts,NEW."expiresAt",ids);
 RETURN NULL;
END $$;
CREATE TRIGGER "Dispatch_search_record" AFTER INSERT OR UPDATE ON "Dispatch" FOR EACH ROW EXECUTE FUNCTION dispatch_search_record();
CREATE FUNCTION dispatch_search_round_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d "Dispatch";
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'DISPATCH_SEARCH_HISTORY_IMMUTABLE'; END IF;
 SELECT * INTO d FROM "Dispatch" WHERE id=NEW."dispatchId";
 IF d."searchMaxAttempts"<>5 OR d.status<>'OPEN' OR NEW.attempt<>d."searchAttempt" OR NEW."expiresAt"<>d."expiresAt"
 OR NEW."openedAt"<>d."expiresAt"-make_interval(secs=>d."searchWindowSeconds") THEN RAISE EXCEPTION 'DISPATCH_SEARCH_ROUND_INVALID'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "DispatchSearchRound_guard" BEFORE INSERT OR UPDATE OR DELETE ON "DispatchSearchRound" FOR EACH ROW EXECUTE FUNCTION dispatch_search_round_guard();

-- All existing lifecycle/identity guards retained; window is enforced by Dispatch_search_guard.
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
    OR NEW."openedAt" <> OLD."openedAt" OR NEW."createdAt" <> OLD."createdAt"
  THEN
    RAISE EXCEPTION 'DISPATCH_IMMUTABLE: dispatch identity and window cannot change';
  END IF;
  IF NEW."status" <> OLD."status" AND NOT (
    (OLD."status" = 'OPEN' AND NEW."status" IN ('CLAIMED', 'EXPIRED', 'CANCELLED'))
    OR (OLD."status" = 'CLAIMED' AND NEW."status" IN ('OPEN', 'EXPIRED', 'CANCELLED', 'DELIVERED'))
  ) THEN
    RAISE EXCEPTION 'DISPATCH_IMMUTABLE: invalid status transition';
  END IF;
  IF OLD."status" IN ('EXPIRED', 'CANCELLED', 'DELIVERED') THEN
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
  IF NEW."status" = 'CLAIMED' AND NEW."claimedByIndependentDriverId" IS NOT NULL AND NOT EXISTS (
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
