\set ON_ERROR_STOP on

-- Reconciliation is deliberately coupled to verification in the same psql
-- transaction. If a release has a stale or incomplete inventory, every REVOKE
-- and GRANT below is rolled back before the database task exits non-zero.
\ir runtime-privileges.sql
\ir verify-runtime-privileges.sql

\echo 'AlphaNet runtime privileges reconciled and verified atomically.'
