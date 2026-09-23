-- CHECK V1.10-A fix. The ledger purge switch (SET LOCAL mandaria.ledger_purge = 'test-fixtures')
-- was meant only for disposable test databases, but it worked in any database and for any role
-- with DELETE privilege: setting a namespaced GUC needs no privilege at all, so running the
-- application with a non-owner role did not close it. The switch now only works in a database
-- whose name ends in _test, the same rule scripts/test-database-url.ts enforces for test
-- databases. Everywhere else the ledger refuses DELETE unconditionally. UPDATE and TRUNCATE are
-- unchanged (always refused).
CREATE OR REPLACE FUNCTION "credit_ledger_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE'
    AND current_setting('mandaria.ledger_purge', true) = 'test-fixtures'
    AND right(current_database(), 5) = '_test' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'CREDIT_LEDGER_IMMUTABLE: ledger entries cannot be % once written', lower(TG_OP);
END $$ LANGUAGE plpgsql;
