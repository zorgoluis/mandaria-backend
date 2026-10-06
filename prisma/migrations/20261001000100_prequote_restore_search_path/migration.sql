-- pg_restore clears search_path. Pin dependencies for the validator and its
-- recursive canonicalizer so valid rows also pass CHECK during COPY/restore.
-- No data changes and no relaxation of Prequote_conditions.
ALTER FUNCTION public.prequote_canonical_json(jsonb)
  SET search_path = pg_catalog, public;
ALTER FUNCTION public.prequote_conditions_valid(jsonb)
  SET search_path = pg_catalog, public;
