-- Opaque resource scope intentionally has no Dispatch FK: closing an unknown UUID must neither
-- disclose a dispatch nor require current offer/ownership. It can never create operational state.
CREATE TABLE "IndependentDispatchAttempt" (
 "actorUserId" UUID NOT NULL REFERENCES "User"(id) ON DELETE RESTRICT,
 "dispatchId" UUID NOT NULL,
 operation TEXT NOT NULL CHECK (operation IN ('TAKE','RELEASE')),
 key UUID NOT NULL,
 state TEXT NOT NULL CHECK (state IN ('APPLIED','CLOSED_NO_EFFECTS')),
 hash TEXT NOT NULL,
 response JSONB NOT NULL,
 "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY ("actorUserId","dispatchId",operation,key),
 CHECK ((state='CLOSED_NO_EFFECTS' AND hash='' AND response='{}'::jsonb)
 OR (state='APPLIED' AND hash ~ '^[a-f0-9]{64}$' AND jsonb_typeof(response)='object'
 AND response->>'operation'=operation AND response->>'dispatchId'="dispatchId"::text))
);
-- Durable receipts and tombstones are never edited, deleted or purged by application code.
CREATE FUNCTION independent_attempt_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'INDEPENDENT_ATTEMPT_IMMUTABLE'; END $$;
CREATE TRIGGER independent_attempt_immutable BEFORE UPDATE OR DELETE ON "IndependentDispatchAttempt"
 FOR EACH ROW EXECUTE FUNCTION independent_attempt_immutable();
CREATE TRIGGER independent_attempt_truncate BEFORE TRUNCATE ON "IndependentDispatchAttempt"
 FOR EACH STATEMENT EXECUTE FUNCTION independent_attempt_immutable();
