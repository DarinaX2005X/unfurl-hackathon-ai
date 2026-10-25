import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";

// Use a session/direct connection, for example:
// node --env-file=.env.local supabase/apply-migrations.mjs --project-ref <ref> --apply
// Without --apply this only validates the target and reports pending migrations.
const args = process.argv.slice(2);
const expectedRef = args[args.indexOf("--project-ref") + 1];
const apply = args.includes("--apply");
let currentMigration;
let client;

try {
  if (!args.includes("--project-ref") || !/^[a-z]{20}$/.test(expectedRef ?? "")) {
    throw new Error("explicit_project_ref_required");
  }
  const url = new URL(process.env.DIRECT_DATABASE_URL ?? "");
  const api = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
  if (process.env.SUPABASE_PROJECT_REF !== expectedRef || api.hostname !== `${expectedRef}.supabase.co`
    || !["postgres:", "postgresql:"].includes(url.protocol)
    || !(decodeURIComponent(url.username).endsWith(`.${expectedRef}`) || url.hostname === `db.${expectedRef}.supabase.co`)
    || url.port === "6543") {
    throw new Error("target_project_mismatch_or_transaction_pooler");
  }
  for (const key of ["sslmode", "sslrootcert", "sslcert", "sslkey"]) url.searchParams.delete(key);
  const ca = process.env.DATABASE_SSL_CA?.replace(/\\n/g, "\n");
  client = new pg.Client({
    connectionString: url.toString(), connectionTimeoutMillis: 10_000,
    ssl: { rejectUnauthorized: true, ...(ca ? { ca } : {}) },
    application_name: "unfurl-migrations",
  });
  await client.connect();
  await client.query("BEGIN");
  await client.query("SET LOCAL lock_timeout = '10s'");
  await client.query("SET LOCAL statement_timeout = '60s'");
  await client.query("SELECT pg_advisory_xact_lock(hashtext('unfurl-schema-migrations'))");
  const existing = await client.query("SELECT to_regclass('unfurl_meta.schema_migrations') IS NOT NULL AS present");
  const receipts = existing.rows[0].present
    ? (await client.query("SELECT version, sha256 FROM unfurl_meta.schema_migrations ORDER BY version")).rows
    : [];
  if (!receipts.length) {
    const tables = await client.query("SELECT count(*)::int AS count FROM pg_tables WHERE schemaname = 'unfurl'");
    if (tables.rows[0].count) throw new Error("untracked_existing_schema_refused");
  }
  const directory = fileURLToPath(new URL("./migrations/", import.meta.url));
  const names = (await readdir(directory)).filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort();
  const migrations = await Promise.all(names.map(async (name) => {
    // A checkout's Windows line endings must not change the migration identity.
    const sql = (await readFile(new URL(`./migrations/${name}`, import.meta.url), "utf8")).replace(/\r\n/g, "\n");
    return { name, sql, sha256: createHash("sha256").update(sql).digest("hex") };
  }));
  for (const receipt of receipts) {
    const migration = migrations.find((item) => item.name === receipt.version);
    if (!migration || migration.sha256 !== receipt.sha256) throw new Error("migration_history_mismatch");
  }
  const pending = migrations.filter((item) => !receipts.some((receipt) => receipt.version === item.name));
  console.log(JSON.stringify({ target: expectedRef, tlsAuthorized: client.connection.stream.authorized, applied: receipts.length, pending: pending.map((item) => item.name), mode: apply ? "apply" : "preview" }));
  if (apply && pending.length) {
    await client.query("CREATE SCHEMA IF NOT EXISTS unfurl_meta; REVOKE ALL ON SCHEMA unfurl_meta FROM PUBLIC, anon, authenticated;");
    await client.query("CREATE TABLE IF NOT EXISTS unfurl_meta.schema_migrations (version text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())");
    for (const migration of pending) {
      currentMigration = migration.name;
      await client.query(migration.sql);
      await client.query("INSERT INTO unfurl_meta.schema_migrations (version, sha256) VALUES ($1, $2)", [migration.name, migration.sha256]);
    }
    await client.query("COMMIT");
    console.log(JSON.stringify({ ok: true, applied: pending.map((item) => item.name) }));
  } else {
    await client.query("ROLLBACK");
    console.log(JSON.stringify({ ok: true, changed: false }));
  }
} catch (error) {
  if (client) await client.query("ROLLBACK").catch(() => undefined);
  // Never echo a connection string, provider response, SQL parameters, or row data.
  const safeCode = error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : error.code ?? "migration_failed";
  console.error(JSON.stringify({
    ok: false,
    code: safeCode,
    migration: currentMigration,
    ...(typeof error.position === "string" && /^\d+$/.test(error.position) ? { position: Number(error.position) } : {}),
  }));
  process.exitCode = 1;
} finally {
  await client?.end();
}
