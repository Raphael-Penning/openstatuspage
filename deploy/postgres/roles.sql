-- Database roles for a split deployment of OpenStatusPage on PostgreSQL.
-- See docs/security-model.md for what each role may do.
--
--   app role     (admin and worker instances): owns the tables and runs the
--                migrations. Created here only when app_password is given; an
--                existing role (e.g. the database owner) works as well.
--   public role  (APP_ROLE=public instances): a plain login without any table.
--                The admin/worker instances grant it the osp_public schema on
--                every start (DB_PUBLIC_ROLE, default osp_public).
--
-- Run it once as a superuser (or a role with CREATEROLE) in the target database.
-- It is idempotent: existing roles keep their passwords unless you pass new ones.
--
--   psql "postgres://postgres@db.example.org/openstatuspage" \
--     -v public_password='<public password>' \
--     -v app_password='<app password>' \
--     -f deploy/postgres/roles.sql
--
-- Optional: -v public_role=<name> (default osp_public, must match DB_PUBLIC_ROLE)
--           -v app_role=<name>    (default osp_app; also when you keep an existing
--                                  role for admin and worker: it gets the advisory
--                                  locks that harden.sql takes from everyone else)
-- It also runs harden.sql (next to this file): no advisory locks, large objects,
-- temporary tables or CREATE on the schema "public" for the public role. Rerun it after an upgrade that changes it.
-- The passwords above are placeholders: never commit real ones, read them from your
-- secret store when you run the script.

\set ON_ERROR_STOP on

\if :{?public_role}
\else
  \set public_role osp_public
\endif
\if :{?app_role}
\else
  \set app_role osp_app
\endif
\if :{?public_password}
\else
  DO $$ BEGIN RAISE EXCEPTION 'public_password is required: psql -v public_password=... -f roles.sql'; END $$;
\endif

-- The public role: login only. No SUPERUSER, no BYPASSRLS, no membership in other roles.
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', :'public_role')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'public_role') \gexec
SELECT format('ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
  :'public_role', :'public_password') \gexec
-- Its queries read the views of osp_public (the app sets the same search_path itself).
SELECT format('ALTER ROLE %I SET search_path = osp_public', :'public_role') \gexec
-- Bounds what a compromised public instance can make the database do.
SELECT format('ALTER ROLE %I SET statement_timeout = %L', :'public_role', '10s') \gexec
SELECT format('ALTER ROLE %I SET idle_in_transaction_session_timeout = %L', :'public_role', '30s') \gexec
SELECT format('ALTER ROLE %I CONNECTION LIMIT 50', :'public_role') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), :'public_role') \gexec

-- The app role of the admin and worker instances (optional).
\if :{?app_password}
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', :'app_role')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_role') \gexec
SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L', :'app_role', :'app_password') \gexec
SELECT format('GRANT CONNECT, CREATE ON DATABASE %I TO %I', current_database(), :'app_role') \gexec
-- The tables live in the schema "public" by default: the app role creates them there.
SELECT format('GRANT USAGE, CREATE ON SCHEMA public TO %I', :'app_role') \gexec
\endif

-- No advisory locks, large objects, temporary tables or CREATE on the schema
-- "public" for roles that do not need them.
\ir harden.sql
-- The admin and worker instances serialise work with advisory locks (and the
-- migrations take one): grant them back to the app role. A superuser needs no
-- grant; if admin and worker use another role that is not a superuser, pass it
-- as -v app_role=<name>.
SELECT format('GRANT EXECUTE ON FUNCTION %s TO %I', p.oid::regprocedure, :'app_role')
FROM pg_proc p
WHERE p.pronamespace = 'pg_catalog'::regnamespace AND p.proname LIKE 'pg\_%advisory\_%'
  AND EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = :'app_role') \gexec
