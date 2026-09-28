-- CreateEnum
CREATE TYPE "IdempotencyExecutionState" AS ENUM ('PROCESSING', 'RETRYABLE_FAILED', 'FAILED', 'SUCCEEDED');

-- CreateTable
CREATE TABLE "ApiIdempotencyExecution" (
    "recordId" UUID NOT NULL,
    "state" "IdempotencyExecutionState" NOT NULL,
    "owner" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "attempts" INTEGER NOT NULL,
    "maxAttempts" INTEGER NOT NULL,
    "leaseExpiresAt" TIMESTAMP(3) NOT NULL,
    "errorCode" TEXT,

    CONSTRAINT "ApiIdempotencyExecution_pkey" PRIMARY KEY ("recordId")
);

-- CreateTable
CREATE TABLE "DeliveryPrequote" (
    "id" UUID NOT NULL,
    "publicId" TEXT NOT NULL,
    "idempotencyRecordId" UUID NOT NULL,
    "integrationClientId" UUID NOT NULL,
    "conditionsVersion" INTEGER NOT NULL,
    "conditions" JSONB NOT NULL,
    "serviceType" "ServiceType" NOT NULL,
    "serviceZoneId" UUID NOT NULL,
    "zoneCode" TEXT NOT NULL,
    "zoneName" TEXT NOT NULL,
    "zoneBoundary" JSONB NOT NULL,
    "ratePlanId" UUID NOT NULL,
    "rateBandId" UUID NOT NULL,
    "distanceMeters" INTEGER NOT NULL,
    "durationSeconds" INTEGER NOT NULL,
    "routingProvider" TEXT NOT NULL,
    "routeCalculatedAt" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeliveryPrequote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryPrequote_publicId_key" ON "DeliveryPrequote"("publicId");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryPrequote_idempotencyRecordId_key" ON "DeliveryPrequote"("idempotencyRecordId");

-- CreateIndex
CREATE INDEX "DeliveryPrequote_integrationClientId_issuedAt_idx" ON "DeliveryPrequote"("integrationClientId", "issuedAt");

-- AddForeignKey
ALTER TABLE "ApiIdempotencyExecution" ADD CONSTRAINT "ApiIdempotencyExecution_recordId_fkey" FOREIGN KEY ("recordId") REFERENCES "ApiIdempotencyRecord"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryPrequote" ADD CONSTRAINT "DeliveryPrequote_idempotencyRecordId_fkey" FOREIGN KEY ("idempotencyRecordId") REFERENCES "ApiIdempotencyRecord"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryPrequote" ADD CONSTRAINT "DeliveryPrequote_integrationClientId_fkey" FOREIGN KEY ("integrationClientId") REFERENCES "IntegrationClient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryPrequote" ADD CONSTRAINT "DeliveryPrequote_serviceZoneId_fkey" FOREIGN KEY ("serviceZoneId") REFERENCES "ServiceZone"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryPrequote" ADD CONSTRAINT "DeliveryPrequote_ratePlanId_serviceZoneId_fkey" FOREIGN KEY ("ratePlanId", "serviceZoneId") REFERENCES "RatePlan"("id", "serviceZoneId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryPrequote" ADD CONSTRAINT "DeliveryPrequote_rateBandId_ratePlanId_fkey" FOREIGN KEY ("rateBandId", "ratePlanId") REFERENCES "RateBand"("id", "ratePlanId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A3 invariants; historical migrations and rows remain untouched.
CREATE SEQUENCE "DeliveryPrequote_publicId_seq";
ALTER TABLE "ApiIdempotencyExecution" ADD CONSTRAINT "Execution_values" CHECK (
  version >= 1 AND attempts = version AND "maxAttempts" BETWEEN 1 AND 5 AND attempts BETWEEN 1 AND "maxAttempts"
  AND ((state IN ('PROCESSING','SUCCEEDED') AND "errorCode" IS NULL) OR
       (state IN ('RETRYABLE_FAILED','FAILED') AND "errorCode" ~ '^[A-Z][A-Z0-9_]{0,63}$'))
);
ALTER TABLE "DeliveryPrequote" ADD CONSTRAINT "Prequote_values" CHECK (
  "publicId" ~ '^MPQ-[0-9]{6,}$' AND "conditionsVersion" = 1 AND "serviceType" = 'LOCAL_DELIVERY'
  AND currency = 'MXN' AND amount > 0 AND "distanceMeters" >= 0 AND "durationSeconds" >= 0
  AND length(btrim("routingProvider")) BETWEEN 1 AND 100
  AND "routeCalculatedAt" <= "issuedAt" AND "expiresAt" > "issuedAt"
  AND "expiresAt" <= "issuedAt" + interval '24 hours'
);

-- Same deterministic JSON rules as canonicalJson; numeric insignificant zeros are removed.
CREATE FUNCTION prequote_canonical_json(j jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE result text;
BEGIN
  CASE jsonb_typeof(j)
    WHEN 'object' THEN SELECT '{' || coalesce(string_agg(to_jsonb(key)::text || ':' || prequote_canonical_json(value), ',' ORDER BY key COLLATE "C"),'') || '}' INTO result FROM jsonb_each(j);
    WHEN 'array' THEN SELECT '[' || coalesce(string_agg(prequote_canonical_json(value), ',' ORDER BY ord),'') || ']' INTO result FROM jsonb_array_elements(j) WITH ORDINALITY AS a(value,ord);
    WHEN 'number' THEN result := trim_scale((j #>> '{}')::numeric)::text;
    ELSE result := j::text;
  END CASE;
  RETURN result;
END $$;
CREATE FUNCTION prequote_conditions_valid(j jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
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
       OR p->>'category' IS DISTINCT FROM 'FOOD' OR jsonb_typeof(p->'quantity') IS DISTINCT FROM 'number'
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
END $$;
ALTER TABLE "DeliveryPrequote" ADD CONSTRAINT "Prequote_conditions" CHECK (prequote_conditions_valid(conditions));

CREATE FUNCTION prequote_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'PREQUOTE_IMMUTABLE'; END $$;
CREATE TRIGGER "Prequote_immutable" BEFORE UPDATE OR DELETE ON "DeliveryPrequote" FOR EACH ROW EXECUTE FUNCTION prequote_immutable();

CREATE FUNCTION prequote_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE z "ServiceZone"; p "RatePlan"; b "RateBand"; r "ApiIdempotencyRecord"; e "ApiIdempotencyExecution";
BEGIN
  SELECT * INTO r FROM "ApiIdempotencyRecord" WHERE id=NEW."idempotencyRecordId" FOR UPDATE;
  SELECT * INTO e FROM "ApiIdempotencyExecution" WHERE "recordId"=r.id FOR UPDATE;
  SELECT * INTO z FROM "ServiceZone" WHERE id=NEW."serviceZoneId" FOR SHARE;
  SELECT * INTO p FROM "RatePlan" WHERE id=NEW."ratePlanId" FOR SHARE;
  SELECT * INTO b FROM "RateBand" WHERE id=NEW."rateBandId" FOR SHARE;
  IF r."resourceId" IS DISTINCT FROM NEW.id OR r."integrationClientId" IS DISTINCT FROM NEW."integrationClientId"
     OR r.operation IS DISTINCT FROM 'delivery_prequotes.create' OR r."resourceType" IS DISTINCT FROM 'DeliveryPrequote'
     OR r."requestHash" IS DISTINCT FROM encode(sha256(convert_to(prequote_canonical_json(jsonb_build_object('operation',r.operation,'payload',NEW.conditions)),'UTF8')),'hex')
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
END $$;
CREATE TRIGGER "Prequote_evidence" BEFORE INSERT ON "DeliveryPrequote" FOR EACH ROW EXECUTE FUNCTION prequote_evidence();

CREATE FUNCTION prequote_execution_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'EXECUTION_IMMUTABLE'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.state <> 'PROCESSING' OR NEW.version <> 1 OR NEW.attempts <> 1 OR NEW."leaseExpiresAt" <= (clock_timestamp() AT TIME ZONE 'UTC') THEN RAISE EXCEPTION 'EXECUTION_INVALID_INITIAL_STATE'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.state IN ('SUCCEEDED','FAILED') OR NEW."recordId" <> OLD."recordId" OR NEW."maxAttempts" <> OLD."maxAttempts" THEN RAISE EXCEPTION 'EXECUTION_TERMINAL_OR_IDENTITY'; END IF;
  IF NEW.version = OLD.version+1 THEN
    IF NEW.state <> 'PROCESSING' OR NEW.owner = OLD.owner OR NEW.attempts <> OLD.attempts+1
       OR NOT (OLD.state='RETRYABLE_FAILED' OR (OLD.state='PROCESSING' AND OLD."leaseExpiresAt" <= (clock_timestamp() AT TIME ZONE 'UTC')))
       OR NEW."leaseExpiresAt" <= (clock_timestamp() AT TIME ZONE 'UTC') THEN RAISE EXCEPTION 'EXECUTION_INVALID_RECOVERY'; END IF;
  ELSE
    IF NEW.version <> OLD.version OR NEW.owner <> OLD.owner OR NEW.attempts <> OLD.attempts OR NEW."leaseExpiresAt" <> OLD."leaseExpiresAt"
       OR NEW.state NOT IN ('RETRYABLE_FAILED','FAILED','SUCCEEDED') THEN RAISE EXCEPTION 'EXECUTION_INVALID_TRANSITION'; END IF;
    IF NEW."errorCode" IS NOT DISTINCT FROM 'ATTEMPTS_EXHAUSTED' AND NEW.state='FAILED' THEN
      IF OLD.attempts < OLD."maxAttempts" OR (OLD.state='PROCESSING' AND OLD."leaseExpiresAt" > (clock_timestamp() AT TIME ZONE 'UTC')) THEN RAISE EXCEPTION 'EXECUTION_NOT_EXHAUSTED'; END IF;
    ELSIF OLD.state <> 'PROCESSING' OR OLD."leaseExpiresAt" <= (clock_timestamp() AT TIME ZONE 'UTC') THEN RAISE EXCEPTION 'EXECUTION_LEASE_LOST'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "Execution_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ApiIdempotencyExecution" FOR EACH ROW EXECUTE FUNCTION prequote_execution_guard();
CREATE FUNCTION prequote_key_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM "ApiIdempotencyExecution" WHERE "recordId"=OLD.id) THEN RAISE EXCEPTION 'DURABLE_KEY_IMMUTABLE'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "Durable_key_immutable" BEFORE UPDATE OR DELETE ON "ApiIdempotencyRecord" FOR EACH ROW EXECUTE FUNCTION prequote_key_immutable();

-- At COMMIT, a durable success and its single matching offer exist together or neither does.
CREATE FUNCTION prequote_atomic_result() RETURNS trigger LANGUAGE plpgsql AS $$
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
     OR (q.id IS NOT NULL AND (q.id<>r."resourceId" OR q."integrationClientId"<>r."integrationClientId")) THEN RAISE EXCEPTION 'PREQUOTE_ATOMIC_RESULT'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "Durable_record_result" AFTER INSERT ON "ApiIdempotencyRecord" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION prequote_atomic_result();
CREATE CONSTRAINT TRIGGER "Durable_execution_result" AFTER INSERT OR UPDATE ON "ApiIdempotencyExecution" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION prequote_atomic_result();
CREATE CONSTRAINT TRIGGER "Prequote_result" AFTER INSERT ON "DeliveryPrequote" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION prequote_atomic_result();
