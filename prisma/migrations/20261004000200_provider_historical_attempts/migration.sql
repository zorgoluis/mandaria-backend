-- Immutable historical ADVANCE receipts remain under the original actor/dispatch/key namespace.
-- A tombstone never grants the provider permission to advance again.
ALTER TABLE "DeliveryExecutionCommand" DROP CONSTRAINT execution_command_state;
ALTER TABLE "DeliveryExecutionCommand" ADD CONSTRAINT execution_command_state CHECK (
 state='APPLIED' OR (state='CLOSED_NO_EFFECTS' AND
 (operation='ADVANCE' OR operation ~ '^RESOLVE:[0-9a-fA-F-]{36}$' OR operation ~ '^APP_(ADVANCE|REPORT|DELIVER):[0-9a-f-]{36}$')
 AND hash='' AND response='{}'::jsonb)
);
