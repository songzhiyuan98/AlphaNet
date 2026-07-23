\set ON_ERROR_STOP on

CREATE TEMPORARY TABLE recovery_manifest (
  relation_name text PRIMARY KEY,
  row_count bigint NOT NULL,
  checksum_primary bigint NOT NULL,
  checksum_secondary bigint NOT NULL
);

BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;

SET LOCAL statement_timeout = 0;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = pg_catalog;

DO $$
DECLARE
  relation_record record;
  relation_row_count bigint;
  relation_checksum_primary bigint;
  relation_checksum_secondary bigint;
BEGIN
  FOR relation_record IN
    SELECT
      namespace.nspname AS schema_name,
      relation.relname AS table_name
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    WHERE relation.relkind IN ('r', 'p')
      AND namespace.nspname IN ('auth', 'platform', 'system')
    ORDER BY namespace.nspname, relation.relname
  LOOP
    EXECUTE pg_catalog.format(
      'SELECT count(*)::bigint,
              COALESCE(bit_xor(hashtextextended(row_to_json(source_row)::text, 0)), 0)::bigint,
              COALESCE(bit_xor(hashtextextended(row_to_json(source_row)::text, 7046029254386353131)), 0)::bigint
         FROM %I.%I AS source_row',
      relation_record.schema_name,
      relation_record.table_name
    )
    INTO
      relation_row_count,
      relation_checksum_primary,
      relation_checksum_secondary;

    INSERT INTO pg_temp.recovery_manifest (
      relation_name,
      row_count,
      checksum_primary,
      checksum_secondary
    )
    VALUES (
      pg_catalog.format(
        '%I.%I',
        relation_record.schema_name,
        relation_record.table_name
      ),
      relation_row_count,
      relation_checksum_primary,
      relation_checksum_secondary
    );
  END LOOP;
END;
$$;

\copy (SELECT relation_name, row_count, checksum_primary, checksum_secondary FROM pg_temp.recovery_manifest ORDER BY relation_name) TO STDOUT WITH (FORMAT csv, HEADER true)

ROLLBACK;

DROP TABLE pg_temp.recovery_manifest;
