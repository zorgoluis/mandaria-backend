ALTER TABLE "DeliveryExecutionCommand" ADD COLUMN state TEXT NOT NULL DEFAULT 'APPLIED';
ALTER TABLE "DeliveryExecutionCommand" ADD CONSTRAINT execution_command_state CHECK (
 state = 'APPLIED' OR (state = 'CLOSED_NO_EFFECTS' AND operation ~ '^RESOLVE:[0-9a-fA-F-]{36}$' AND hash = '' AND response = '{}'::jsonb)
);
-- Existing immutable UPDATE/DELETE/TRUNCATE guards apply to closure receipts too.
-- Never expire these tombstones: delayed requests must remain fenced permanently.
