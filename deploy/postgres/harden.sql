-- Takes away what every database role may do by default and a compromised
-- APP_ROLE=public instance could abuse (see docs/security-model.md). Run it as a
-- superuser in the target database; deploy/postgres/roles.sql includes it and
-- grants the advisory locks back to the app role. Idempotent.
--
-- - Advisory locks: the admin and worker instances serialise status and bundle
--   recomputes and history imports with fixed lock keys. A role that may take
--   them could hold those keys in its session (session locks outlive
--   statement_timeout) and stall that work on every instance, or fill the shared
--   lock table.
-- - Large objects: lo_create and friends store data outside any table, which a
--   restricted role could use to fill the disk.
-- - Temporary tables: the public role needs none.
-- - CREATE on the schema "public": PUBLIC holds it by default before PostgreSQL 15
--   (and on clusters upgraded or restored from such a version). Nobody but the
--   owner creates objects there; a public role that may is refused by the
--   instances (osp_grant_public_role, connection_restricted). If the tables live
--   in another schema, revoke CREATE on that one from PUBLIC as well.
--   A role that created its tables there only through PUBLIC's CREATE (the
--   migrating app role on PostgreSQL 14 or older without roles.sql) loses it, and
--   the next db:migrate that adds a table or index fails with "permission
--   denied": first run GRANT CREATE ON SCHEMA public TO <app role> (roles.sql
--   does). This script warns about every role that owns tables there and can no
--   longer create objects.
--
-- These privileges live in each database: run it again in every database you
-- create for OpenStatusPage. Other applications in the same database lose them too
-- unless you grant them back (see the end of roles.sql).

REVOKE EXECUTE ON FUNCTION
  pg_advisory_lock(bigint), pg_advisory_lock(integer, integer),
  pg_advisory_lock_shared(bigint), pg_advisory_lock_shared(integer, integer),
  pg_try_advisory_lock(bigint), pg_try_advisory_lock(integer, integer),
  pg_try_advisory_lock_shared(bigint), pg_try_advisory_lock_shared(integer, integer),
  pg_advisory_xact_lock(bigint), pg_advisory_xact_lock(integer, integer),
  pg_advisory_xact_lock_shared(bigint), pg_advisory_xact_lock_shared(integer, integer),
  pg_try_advisory_xact_lock(bigint), pg_try_advisory_xact_lock(integer, integer),
  pg_try_advisory_xact_lock_shared(bigint), pg_try_advisory_xact_lock_shared(integer, integer),
  pg_advisory_unlock(bigint), pg_advisory_unlock(integer, integer),
  pg_advisory_unlock_shared(bigint), pg_advisory_unlock_shared(integer, integer),
  pg_advisory_unlock_all(),
  lo_creat(integer), lo_create(oid), lo_from_bytea(oid, bytea),
  lo_import(text), lo_import(text, oid)
FROM PUBLIC;

DO $$
BEGIN
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
END
$$;

DO $$
BEGIN
  IF to_regnamespace('public') IS NOT NULL THEN
    REVOKE CREATE ON SCHEMA public FROM PUBLIC;
  END IF;
END
$$;

DO $$
DECLARE
  owner_name name;
BEGIN
  IF to_regnamespace('public') IS NOT NULL THEN
    FOR owner_name IN
      SELECT DISTINCT pg_get_userbyid(c.relowner)
      FROM pg_class c
      WHERE c.relnamespace = 'public'::regnamespace
        AND NOT has_schema_privilege(c.relowner, 'public', 'CREATE')
    LOOP
      RAISE WARNING 'role % owns tables in schema public but may no longer create objects there; run GRANT CREATE ON SCHEMA public TO % before the next migration if it runs them', owner_name, owner_name;
    END LOOP;
  END IF;
END
$$;
