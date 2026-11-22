import { PostgresAdapter, sql, type Kysely } from 'kysely';

/**
 * Takes away CREATE on the table schema and on osp_public from the public role by
 * itself, so upgrading needs no manual step. A no-op on SQLite.
 *
 * 0012 pinned every SECURITY DEFINER function to `search_path = pg_catalog,
 * pg_temp`, which already closes the hijack through objects in the table schema.
 * On top of that it refused a public role that may CREATE there (in 0.3.0 the
 * migrating instance did not start until the operator ran harden.sql). This
 * migration turns that refusal into an automatic fix plus a warning:
 *
 * - `osp_harden_schema_create(role)`, run as the migrating role, for the table
 *   schema and osp_public:
 *   - when PUBLIC may CREATE there: makes sure the migrating role keeps CREATE
 *     (GRANT to itself where it may), then REVOKE CREATE ... FROM PUBLIC. The
 *     revoke is left out when the migrating role would lose CREATE by it;
 *   - REVOKE CREATE ... FROM the role itself (a direct grant);
 *   - a role it is a member of that may CREATE there is only reported (the
 *     memberships of other roles are not changed).
 *   Every statement runs in its own block that catches insufficient_privilege,
 *   and GRANT/REVOKE without the grant option only warn: what is still possible
 *   afterwards is checked again and returned as the commands an operator can run
 *   as the schema owner or a superuser (also raised as WARNING).
 * - The migration runs it for every registered public role. Nothing changes for
 *   databases without a public role (APP_ROLE=all only).
 * - osp_grant_public_role runs it too and no longer raises: instances that
 *   migrate log what is left on every start (setUpPublicRole).
 * - osp_public.connection_restricted is true again for every registered public
 *   role (as in 0007); osp_public.connection_create_schemas() lists the schemas
 *   the public role may still create objects in, which a public instance logs as
 *   a warning.
 *
 * Kysely runs all pending migrations in one transaction and the instances call
 * osp_grant_public_role only after it, so a 0.2.x database (0010 to 0013 in one
 * go) and one where 0.3.0 stopped at the refusal (0012 applied) both reach the
 * new function first.
 *
 * When osp_public does not exist yet, its part (relaxPublicSchema) runs in
 * ensurePublicSchema (db/public-role.ts) right after the schema is created.
 */

const PIN = 'SET search_path = pg_catalog, pg_temp';
const PUBLIC_SCHEMA = 'osp_public';

const ident = (name: string) => `"${name.replaceAll('"', '""')}"`;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

interface Schema {
  /** Quoted name of the table schema. */
  b: string;
  /** Its plain name. */
  name: string;
}

async function isPostgres(db: Kysely<any>): Promise<boolean> {
  return db.getExecutor().adapter instanceof PostgresAdapter;
}

async function tableSchema(db: Kysely<any>): Promise<Schema> {
  const { rows } = await sql<{ schema: string }>`select current_schema() as schema`.execute(db);
  const name = rows[0]!.schema;
  return { b: ident(name), name };
}

async function publicSchemaExists(db: Kysely<any>): Promise<boolean> {
  const { rows } = await sql<{ found: boolean }>`select to_regnamespace(${PUBLIC_SCHEMA}) is not null as found`.execute(db);
  return rows[0]?.found === true;
}

/** The ACL entries of the schema with oid `nsp` that give `grantee` (an oid, 0 = PUBLIC) CREATE. */
const createGrantedTo = (nsp: string, grantee: string) =>
  `EXISTS (SELECT 1 FROM pg_namespace n, aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) a
     WHERE n.oid = ${nsp} AND a.grantee = ${grantee} AND a.privilege_type = 'CREATE')`;

/** The migrating role may CREATE in the schema `nsp` without PUBLIC's grant. */
const ownCreate = (nsp: string) =>
  `(EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = current_user AND r.rolsuper)
    OR EXISTS (SELECT 1 FROM pg_namespace n WHERE n.oid = ${nsp} AND pg_has_role(current_user, n.nspowner, 'USAGE'))
    OR EXISTS (SELECT 1 FROM pg_namespace n, aclexplode(n.nspacl) a
      WHERE n.oid = ${nsp} AND a.grantee <> 0 AND a.privilege_type = 'CREATE' AND pg_has_role(current_user, a.grantee, 'USAGE')))`;

function baseStatements(schema: Schema): string[] {
  const { b } = schema;
  const out: string[] = [];
  out.push(`CREATE OR REPLACE FUNCTION ${b}.osp_harden_schema_create(p_role text) RETURNS text[]
    LANGUAGE plpgsql VOLATILE ${PIN} AS $$
    DECLARE
      v_role oid;
      v_schema text;
      v_nsp oid;
      v_left text[] := ARRAY[]::text[];
      v_command text;
      v_groups text;
    BEGIN
      SELECT r.oid INTO v_role FROM pg_roles r WHERE r.rolname = p_role;
      IF v_role IS NULL THEN
        RETURN v_left;
      END IF;
      FOREACH v_schema IN ARRAY ARRAY[${literal(schema.name)}, ${literal(PUBLIC_SCHEMA)}] LOOP
        SELECT n.oid INTO v_nsp FROM pg_namespace n WHERE n.nspname = v_schema;
        CONTINUE WHEN v_nsp IS NULL;

        -- CREATE granted to PUBLIC (the default before PostgreSQL 15 on the schema "public").
        IF ${createGrantedTo('v_nsp', '0')} THEN
          -- The migrating role must keep CREATE (later migrations add tables and indexes).
          IF NOT ${ownCreate('v_nsp')} THEN
            BEGIN
              EXECUTE format('GRANT CREATE ON SCHEMA %I TO %I', v_schema, current_user);
            EXCEPTION WHEN insufficient_privilege THEN
              NULL;
            END;
          END IF;
          IF ${ownCreate('v_nsp')} THEN
            BEGIN
              EXECUTE format('REVOKE CREATE ON SCHEMA %I FROM PUBLIC', v_schema);
            EXCEPTION WHEN insufficient_privilege THEN
              NULL;
            END;
          END IF;
          IF ${createGrantedTo('v_nsp', '0')} THEN
            v_command := CASE WHEN ${ownCreate('v_nsp')} THEN ''
              ELSE format('GRANT CREATE ON SCHEMA %I TO %I; ', v_schema, current_user) END
              || format('REVOKE CREATE ON SCHEMA %I FROM PUBLIC;', v_schema);
            v_left := v_left || v_command;
          END IF;
        END IF;

        -- CREATE granted to the public role itself.
        IF ${createGrantedTo('v_nsp', 'v_role')} THEN
          BEGIN
            EXECUTE format('REVOKE CREATE ON SCHEMA %I FROM %I', v_schema, p_role);
          EXCEPTION WHEN insufficient_privilege THEN
            NULL;
          END;
          IF ${createGrantedTo('v_nsp', 'v_role')} THEN
            v_left := v_left || format('REVOKE CREATE ON SCHEMA %I FROM %I;', v_schema, p_role);
          END IF;
        END IF;

        -- Through a role it is a member of: only reported.
        IF NOT ${createGrantedTo('v_nsp', '0')} AND NOT ${createGrantedTo('v_nsp', 'v_role')}
          AND has_schema_privilege(v_role, v_nsp, 'CREATE') THEN
          SELECT string_agg(quote_ident(g.rolname), ', ' ORDER BY g.rolname) INTO v_groups
            FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid WHERE m.member = v_role;
          v_left := v_left || CASE WHEN v_groups IS NULL
            THEN format('-- %I may create objects in schema %I: take that privilege away from it', p_role, v_schema)
            ELSE format('REVOKE %s FROM %I;', v_groups, p_role) END;
        END IF;
      END LOOP;
      FOREACH v_command IN ARRAY v_left LOOP
        RAISE WARNING 'OpenStatusPage: the public database role "%" may still create objects in a schema of the application; run as the schema owner or a superuser: %',
          p_role, v_command;
      END LOOP;
      RETURN v_left;
    END
    $$`);
  out.push(`REVOKE ALL ON FUNCTION ${b}.osp_harden_schema_create(text) FROM PUBLIC`);

  // 0012 raised here; now the grant fixes what it can and the instance logs the rest.
  out.push(`CREATE OR REPLACE FUNCTION ${b}.osp_grant_public_role(p_role text) RETURNS boolean
    LANGUAGE plpgsql VOLATILE ${PIN} AS $$
    BEGIN
      IF NOT ${b}.osp_grant_public_role_privileges(p_role) THEN
        RETURN false;
      END IF;
      PERFORM ${b}.osp_harden_schema_create(p_role);
      RETURN true;
    END
    $$`);
  out.push(`REVOKE ALL ON FUNCTION ${b}.osp_grant_public_role(text) FROM PUBLIC`);
  return out;
}

function publicStatements(schema: Schema): string[] {
  const { b } = schema;
  const s = ident(PUBLIC_SCHEMA);
  const out: string[] = [];
  // Restricted: a registered public role (as in 0007). CREATE is reported separately.
  out.push(`CREATE OR REPLACE FUNCTION ${s}.connection_restricted() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER ${PIN} AS $$
      SELECT ${b}.osp_is_public_role(session_user)
    $$`);
  out.push(`CREATE OR REPLACE FUNCTION ${s}.connection_create_schemas() RETURNS text[]
    LANGUAGE sql STABLE ${PIN} AS $$
      SELECT COALESCE(array_agg(n.nspname::text ORDER BY n.nspname), ARRAY[]::text[]) FROM pg_namespace n
      WHERE n.nspname IN (${literal(schema.name)}, ${literal(PUBLIC_SCHEMA)})
        AND has_schema_privilege(session_user, n.oid, 'CREATE')
    $$`);
  out.push(`REVOKE ALL ON FUNCTION ${s}.connection_create_schemas() FROM PUBLIC`);
  // A public instance may start before the next grant (which grants every function of osp_public).
  out.push(`DO $$
    DECLARE
      v_role text;
    BEGIN
      FOR v_role IN SELECT r.role_name FROM ${b}.osp_public_roles r
        WHERE EXISTS (SELECT 1 FROM pg_catalog.pg_roles x WHERE x.rolname = r.role_name) LOOP
        EXECUTE format('GRANT EXECUTE ON FUNCTION ${s}.connection_create_schemas() TO %I', v_role);
      END LOOP;
    END
    $$`);
  return out;
}

/**
 * The osp_public part of this migration (idempotent). Called by the migration when
 * the schema exists and by ensurePublicSchema right after it created the schema.
 */
export async function relaxPublicSchema(db: Kysely<any>): Promise<void> {
  for (const statement of publicStatements(await tableSchema(db))) {
    await sql.raw(statement).execute(db);
  }
}

export async function up(db: Kysely<any>): Promise<void> {
  if (!(await isPostgres(db))) return;
  const schema = await tableSchema(db);
  for (const statement of baseStatements(schema)) {
    await sql.raw(statement).execute(db);
  }
  if (await publicSchemaExists(db)) await relaxPublicSchema(db);
  // Registered public roles: fixed now, and whatever is left is raised as WARNING here and
  // logged by the next start of an instance that migrates.
  await sql
    .raw(`SELECT ${schema.b}.osp_harden_schema_create(r.role_name) FROM ${schema.b}.osp_public_roles r ORDER BY r.role_name`)
    .execute(db);
}

/** Restores osp_grant_public_role and connection_restricted of 0012. */
export async function down(db: Kysely<any>): Promise<void> {
  if (!(await isPostgres(db))) return;
  const { b, name } = await tableSchema(db);
  const mayCreate = (role: string) =>
    `(has_schema_privilege(${role}, ${literal(name)}, 'CREATE')
      OR (to_regnamespace(${literal(PUBLIC_SCHEMA)}) IS NOT NULL AND has_schema_privilege(${role}, ${literal(PUBLIC_SCHEMA)}, 'CREATE')))`;
  await sql
    .raw(
      `CREATE OR REPLACE FUNCTION ${b}.osp_grant_public_role(p_role text) RETURNS boolean
    LANGUAGE plpgsql VOLATILE ${PIN} AS $$
    BEGIN
      IF NOT ${b}.osp_grant_public_role_privileges(p_role) THEN
        RETURN false;
      END IF;
      IF ${mayCreate('p_role')} THEN
        RAISE EXCEPTION 'The public database role "%" may create objects in the schema % or osp_public (CREATE granted to PUBLIC, the default before PostgreSQL 15): run REVOKE CREATE ON SCHEMA % FROM PUBLIC (deploy/postgres/harden.sql)',
          p_role, ${literal(name)}, ${literal(b)} USING ERRCODE = '42501';
      END IF;
      RETURN true;
    END
    $$`,
    )
    .execute(db);
  await sql.raw(`DROP FUNCTION IF EXISTS ${b}.osp_harden_schema_create(text)`).execute(db);
  if (await publicSchemaExists(db)) {
    await sql.raw(`DROP FUNCTION IF EXISTS ${ident(PUBLIC_SCHEMA)}.connection_create_schemas()`).execute(db);
    await sql
      .raw(
        `CREATE OR REPLACE FUNCTION ${ident(PUBLIC_SCHEMA)}.connection_restricted() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER ${PIN} AS $$
      SELECT ${b}.osp_is_public_role(session_user) AND NOT ${mayCreate('session_user')}
    $$`,
      )
      .execute(db);
  }
}
