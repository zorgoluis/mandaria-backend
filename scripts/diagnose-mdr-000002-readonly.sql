-- ONLY READS. Execute through an existing authorized PostgreSQL connection.
-- Never pass a connection URL/password in shell output. No accept/seed/migration/reset.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '5s';
SET LOCAL lock_timeout = '1s';
SET LOCAL TIME ZONE 'UTC';

SELECT current_timestamp AS observed_at_utc,
       current_setting('transaction_read_only') AS read_only;

-- Current state, not proof of state on September 28. No names/contacts/addresses/references.
SELECT r.id, r."publicId", r.status, r."serviceType", r."createdAt", r."updatedAt",
       c.status AS integration_status
FROM "DeliveryRequest" r JOIN "IntegrationClient" c ON c.id = r."integrationClientId"
WHERE r."publicId" = 'MDR-000002'
  AND r."integrationClientId" = 'fd9312fc-500a-44bb-912f-5d69e5efed91'::uuid;

SELECT q.id, q."publicId", q.status, q."serviceType", q."distanceMeters",
       q.amount, q.currency, q."createdAt", q."expiresAt", q."acceptedAt",
       q."expiredAt", q."cancelledAt", q."updatedAt",
       q."expiresAt" > TIMESTAMP '2026-09-28 04:48:51.060' AS in_window_first_attempt,
       q."expiresAt" > TIMESTAMP '2026-09-28 04:50:00.515' AS in_window_second_attempt,
       q."serviceZoneId", q."ratePlanId", q."rateBandId"
FROM "DeliveryQuote" q JOIN "DeliveryRequest" r ON r.id = q."deliveryRequestId"
WHERE r."publicId" = 'MDR-000002'
  AND r."integrationClientId" = 'fd9312fc-500a-44bb-912f-5d69e5efed91'::uuid
ORDER BY q."createdAt", q.id LIMIT 30;

SELECT d.id, q."publicId" AS quote, d.status, d."creditMode", d."openedAt", d."expiresAt",
       d."deliveryRequestId" = q."deliveryRequestId" AS same_request,
       (SELECT count(*) FROM "DispatchCandidate" c WHERE c."dispatchId" = d.id) AS candidates,
       (SELECT count(*) FROM "DispatchCreditSnapshot" s WHERE s."dispatchId" = d.id) AS snapshots
FROM "Dispatch" d JOIN "DeliveryQuote" q ON q.id = d."deliveryQuoteId"
JOIN "DeliveryRequest" r ON r.id = q."deliveryRequestId"
WHERE r."publicId" = 'MDR-000002'
  AND r."integrationClientId" = 'fd9312fc-500a-44bb-912f-5d69e5efed91'::uuid
ORDER BY d."openedAt" LIMIT 30;

-- Monetary RatePlan/amount is separate from CreditPolicy. Both actors are required for LOCAL_DELIVERY.
-- Historical effective windows help investigation; current ACTIVE alone cannot prove past state.
SELECT p.id, p."serviceType", p."actorType", p.version, p.status, p."calculationType",
       p."creditsPerKm", p."minimumCredits", p."flatCredits", p."effectiveFrom", p."effectiveUntil",
       p."effectiveFrom" <= TIMESTAMP '2026-09-28 04:48:51.060'
         AND (p."effectiveUntil" IS NULL OR p."effectiveUntil" > TIMESTAMP '2026-09-28 04:48:51.060') AS effective_at_attempt,
       (SELECT json_agg(json_build_object('position', b.position, 'minMeters', b."minDistanceMeters",
          'maxMeters', b."maxDistanceMeters", 'credits', b.credits) ORDER BY b.position)
        FROM "CreditPolicyRange" b WHERE b."creditPolicyId" = p.id) AS ranges
FROM "CreditPolicy" p
WHERE p."serviceType" IN (SELECT r."serviceType" FROM "DeliveryRequest" r
 WHERE r."publicId" = 'MDR-000002' AND r."integrationClientId" = 'fd9312fc-500a-44bb-912f-5d69e5efed91'::uuid)
 AND p."actorType" IN ('PROVIDER', 'INDEPENDENT_DRIVER')
ORDER BY p."actorType", p.version DESC LIMIT 30;

-- Aggregate only: never select secretHash, tokens, webhook keys or credential identifiers.
SELECT count(*) AS credentials,
 count(*) FILTER (WHERE status = 'ACTIVE' AND "revokedAt" IS NULL
   AND ("expiresAt" IS NULL OR "expiresAt" > CURRENT_TIMESTAMP AT TIME ZONE 'UTC')) AS usable_now,
 count(*) FILTER (WHERE status = 'ACTIVE' AND 'quotes:accept' = ANY(scopes)) AS active_with_accept_scope
FROM "IntegrationCredential"
WHERE "clientId" = 'fd9312fc-500a-44bb-912f-5d69e5efed91'::uuid;

-- Relevant DB metadata only; a missing column/table is deployment evidence: stop, do not repair here.
SELECT migration_name, started_at, finished_at, rolled_back_at
FROM "_prisma_migrations"
WHERE migration_name IN ('20260915000600_routing_pricing_quotes', '20260917000800_dispatch_engine',
 '20260922001300_credit_policies', '20260922001400_dispatch_credit_snapshots',
 '20260923000100_dispatch_credit_consumption', '20260923000200_award_integrity_boundary',
 '20260923001600_delivery_completion_rules') ORDER BY migration_name;
SELECT tablename, indexname, indexdef FROM pg_indexes
WHERE schemaname = current_schema() AND tablename IN ('DeliveryQuote','Dispatch','DispatchCandidate','DispatchCreditSnapshot','CreditPolicy')
 AND indexdef LIKE 'CREATE UNIQUE%' ORDER BY tablename, indexname;
SELECT c.relname AS table_name, t.tgname, t.tgenabled, t.tgdeferrable, t.tginitdeferred
FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = current_schema() AND NOT t.tgisinternal
 AND c.relname IN ('DeliveryQuote','Dispatch','DispatchCandidate','DispatchCreditSnapshot')
ORDER BY c.relname, t.tgname;
ROLLBACK;
