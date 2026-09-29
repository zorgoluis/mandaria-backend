-- Explicit NOT NULL semantics: SQL CHECK accepts UNKNOWN, so a nullable error code
-- must not bypass the failure-state invariant. No existing rows are rewritten.
ALTER TABLE "ApiIdempotencyExecution" DROP CONSTRAINT "Execution_values";
ALTER TABLE "ApiIdempotencyExecution" ADD CONSTRAINT "Execution_values" CHECK (
  version >= 1 AND attempts = version AND "maxAttempts" BETWEEN 1 AND 5 AND attempts BETWEEN 1 AND "maxAttempts"
  AND ((state IN ('PROCESSING','SUCCEEDED') AND "errorCode" IS NULL) OR
       (state IN ('RETRYABLE_FAILED','FAILED') AND "errorCode" IS NOT NULL AND "errorCode" ~ '^[A-Z][A-Z0-9_]{0,63}$'))
  AND (state <> 'RETRYABLE_FAILED' OR attempts < "maxAttempts")
);
