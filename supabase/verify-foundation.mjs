import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import pg from "pg";
import { createClient } from "@supabase/supabase-js";

// Explicit live development proof. Credentials stay only in ignored .cache/.
// node --env-file=.env.local supabase/verify-foundation.mjs --project-ref <ref> --create-qa-accounts
const args = process.argv.slice(2);
const expectedRef = args[args.indexOf("--project-ref") + 1];
const origin = process.env.APP_ORIGIN;
const output = { checks: [], smtpVerified: false, emailDeliveryVerified: false };
let pool;
let phase = "configuration";
const check = (name, condition) => {
  assert.ok(condition, `check_failed:${name}`);
  output.checks.push(name);
  console.log(JSON.stringify({ check: name, ok: true }));
};
const credentialsPath = new URL(`../.cache/qa-accounts-${expectedRef}.json`, import.meta.url);

function jar() { return new Map(); }
async function request(path, cookies, { method = "GET", body, key } = {}) {
  const response = await fetch(new URL(path, origin), {
    method, redirect: "manual",
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json", Origin: origin }),
      ...(cookies.size ? { Cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join("; ") } : {}),
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const setCookies = response.headers.getSetCookie();
  for (const item of setCookies) {
    const [pair] = item.split(";");
    const delimiter = pair.indexOf("=");
    const name = pair.slice(0, delimiter), value = pair.slice(delimiter + 1);
    if (!value || /max-age=0(?:;|$)/i.test(item)) cookies.delete(name);
    else cookies.set(name, value);
  }
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  return { status: response.status, data: parsed?.data, error: parsed?.error, headers: response.headers, setCookies };
}

try {
  if (!args.includes("--project-ref") || !/^[a-z]{20}$/.test(expectedRef ?? "")) throw new Error("explicit_project_ref_required");
  const api = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
  const database = new URL(process.env.DIRECT_DATABASE_URL ?? "");
  if (process.env.SUPABASE_PROJECT_REF !== expectedRef || api.hostname !== `${expectedRef}.supabase.co`
    || !decodeURIComponent(database.username).endsWith(`.${expectedRef}`)
    || !/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(origin ?? "")) throw new Error("development_target_mismatch");
  for (const name of ["sslmode", "sslrootcert", "sslcert", "sslkey"]) database.searchParams.delete(name);
  pool = new pg.Pool({ connectionString: database.toString(), max: 2, connectionTimeoutMillis: 10_000,
    ssl: { rejectUnauthorized: true, ca: process.env.DATABASE_SSL_CA?.replace(/\\n/g, "\n") } });
  pool.on("error", () => undefined);
  const admin = createClient(api.toString(), process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  let saved;
  try { saved = JSON.parse(await readFile(credentialsPath, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (saved && saved.projectRef !== expectedRef) throw new Error("qa_project_mismatch");
  saved ??= { projectRef: expectedRef, accounts: [] };
  const save = async () => {
    await mkdir(new URL("../.cache/", import.meta.url), { recursive: true });
    await writeFile(credentialsPath, JSON.stringify(saved, null, 2), { mode: 0o600 });
  };
  phase = "qa_accounts";
  while (saved.accounts.length < 2) {
    if (!args.includes("--create-qa-accounts")) throw new Error("explicit_qa_creation_flag_required");
    const name = saved.accounts.length === 0 ? "QA account A" : "QA account B";
    const email = `unfurl.qa.${randomBytes(8).toString("hex")}@example.com`;
    const password = randomBytes(24).toString("base64url");
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { display_name: name } });
    if (created.error || !created.data.user) throw new Error("qa_account_creation_failed");
    saved.accounts.push({ id: created.data.user.id, email, password, name });
    await save();
  }
  const [a, b] = saved.accounts;
  const cookiesA = jar(), cookiesB = jar();
  phase = "http_sign_in";
  const guest = await request("/api/v1/me", jar());
  check("guest_has_no_session", guest.status === 200 && guest.data.session === null && guest.data.capabilities.cloudPersistence);
  const loginA = await request("/api/auth/sign-in", cookiesA, { method: "POST", body: { email: a.email, password: a.password, returnTo: "/library" } });
  check("http_sign_in_a", loginA.status === 200 && loginA.data?.session.identity.id === a.id);
  check("session_cookies_http_only", loginA.setCookies.length > 0 && loginA.setCookies.every((item) => /; httponly(?:;|$)/i.test(item)));
  const loginB = await request("/api/auth/sign-in", cookiesB, { method: "POST", body: { email: b.email, password: b.password } });
  check("http_sign_in_b", loginB.status === 200 && loginB.data?.session.identity.id === b.id);
  const reload = await request("/api/v1/me", cookiesA);
  check("session_reconnect", reload.status === 200 && reload.data?.session.identity.id === a.id);
  phase = "http_profile_idempotency";
  const revision = reload.data.session.profile.revision;
  const duplicateKey = randomUUID();
  const duplicateBody = { expectedRevision: revision, displayName: "Foundation QA A", defaultContentLanguage: "en" };
  const duplicated = await Promise.all([1, 2].map(() => request("/api/v1/me/profile", cookiesA, { method: "PATCH", body: duplicateBody, key: duplicateKey })));
  check("duplicate_request_same_receipt", duplicated.every((item) => item.status === 200) && JSON.stringify(duplicated[0].data) === JSON.stringify(duplicated[1].data) && duplicated[0].data.revision === revision + 1);
  const changed = await request("/api/v1/me/profile", cookiesA, { method: "PATCH", body: { ...duplicateBody, displayName: "Different payload" }, key: duplicateKey });
  check("changed_payload_rejected", changed.status === 409 && changed.error?.code === "idempotency_conflict");
  const raced = await Promise.all(["Revision contender A", "Revision contender B"].map((displayName) => request("/api/v1/me/profile", cookiesA,
    { method: "PATCH", body: { expectedRevision: revision + 1, displayName }, key: randomUUID() })));
  check("revision_race_one_winner", raced.filter((item) => item.status === 200).length === 1 && raced.filter((item) => item.status === 409 && item.error?.code === "revision_conflict").length === 1);
  const stored = await pool.query("SELECT p.revision, p.default_content_language, (SELECT count(*)::int FROM unfurl.idempotency i WHERE i.actor_id = p.id AND i.operation = 'profile.update' AND i.key = $2) AS receipts FROM unfurl.profiles p WHERE p.id = $1", [a.id, duplicateKey]);
  check("database_receipt_and_revision_persisted", stored.rows[0]?.revision === revision + 2 && stored.rows[0]?.receipts === 1 && stored.rows[0]?.default_content_language === "en");
  const meB = await request("/api/v1/me", cookiesB);
  check("second_actor_profile_unchanged", meB.data?.session.profile.id === b.id && meB.data?.session.profile.revision === loginB.data.session.profile.revision);
  phase = "database_rls";
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE authenticated");
    const claims = async (id) => client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: id, role: "authenticated", session_id: randomUUID() })]);
    await claims(a.id);
    const conversation = randomUUID(), branch = randomUUID(), message = randomUUID();
    await client.query("INSERT INTO unfurl.conversations (id, owner_id, title, active_branch_id) VALUES ($1, $2, 'Foundation QA rollback probe', $3)", [conversation, a.id, branch]);
    await client.query("INSERT INTO unfurl.conversation_branches (id, conversation_id) VALUES ($1, $2)", [branch, conversation]);
    await client.query("INSERT INTO unfurl.messages (id, conversation_id, branch_id, role, status, parts, client_request_id) VALUES ($1, $2, $3, 'user', 'complete', '[]', $4)", [message, conversation, branch, randomUUID()]);
    await client.query("INSERT INTO unfurl.composer_drafts (conversation_id, text) VALUES ($1, 'QA draft')", [conversation]);
    check("owner_can_save_conversation", (await client.query("SELECT id FROM unfurl.conversations WHERE id=$1", [conversation])).rowCount === 1);
    await claims(b.id);
    const other = await client.query("SELECT (SELECT count(*)::int FROM unfurl.profiles WHERE id=$1) AS profiles, (SELECT count(*)::int FROM unfurl.conversations WHERE id=$2) AS conversations, (SELECT count(*)::int FROM unfurl.messages WHERE conversation_id=$2) AS messages, (SELECT count(*)::int FROM unfurl.composer_drafts WHERE conversation_id=$2) AS drafts", [a.id, conversation]);
    check("other_actor_reads_zero_rows", Object.values(other.rows[0]).every((value) => value === 0));
    const updateOther = await client.query("UPDATE unfurl.conversations SET title='Forbidden' WHERE id=$1 RETURNING id", [conversation]);
    check("other_actor_update_has_no_effect", updateOther.rowCount === 0);
    const denied = async (name, sql, values = []) => {
      await client.query("SAVEPOINT denied_probe");
      let code;
      try { await client.query(sql, values); } catch (error) { code = error.code; }
      await client.query("ROLLBACK TO SAVEPOINT denied_probe");
      check(name, code === "42501");
    };
    await denied("other_actor_insert_denied", "INSERT INTO unfurl.composer_drafts (conversation_id, text) VALUES ($1, 'Forbidden')", [conversation]);
    await denied("private_evaluator_data_denied", "SELECT * FROM unfurl.tasks_private LIMIT 1");
    await denied("private_activity_state_denied", "SELECT * FROM unfurl.activity_sessions LIMIT 1");
    await client.query("SET LOCAL ROLE anon");
    await denied("anonymous_schema_denied", "SELECT * FROM unfurl.profiles LIMIT 1");
    await client.query("ROLLBACK");
  } finally { await client.query("ROLLBACK").catch(() => undefined); client.release(); }
  phase = "callback_recovery";
  const nextConfig = await readFile(new URL("../next.config.ts", import.meta.url), "utf8");
  if (!/incomingRequests\s*:\s*false/.test(nextConfig)) throw new Error("callback_request_logging_must_be_disabled");
  const link = await admin.auth.admin.generateLink({ type: "recovery", email: a.email });
  if (link.error || !link.data.properties?.hashed_token) throw new Error("recovery_link_generation_failed");
  const recoveryCookies = jar();
  const callbackPath = `/auth/callback?${new URLSearchParams({ token_hash: link.data.properties.hashed_token, type: "recovery", returnTo: "/account" })}`;
  const callback = await request(callbackPath, recoveryCookies);
  const destination = new URL(callback.headers.get("location") ?? "/", origin);
  check("recovery_callback_redirects", callback.status === 303 && destination.pathname === "/reset-password" && destination.searchParams.get("returnTo") === "/account");
  check("callback_suppresses_referrer", callback.headers.get("referrer-policy") === "no-referrer");
  const recovered = await request("/api/v1/me", recoveryCookies);
  check("recovery_session_authenticated", recovered.data?.session.identity.id === a.id);
  const newPassword = randomBytes(24).toString("base64url");
  const password = await request("/api/auth/reset-password", recoveryCookies, { method: "POST", body: { password: newPassword, returnTo: "/account" } });
  check("password_update_confirmed", password.status === 200 && password.data?.status === "password_updated");
  a.password = newPassword;
  await save();
  const replay = await request(callbackPath, jar());
  const replayDestination = new URL(replay.headers.get("location") ?? "/", origin);
  check("consumed_callback_rejected", replay.status === 303 && replayDestination.pathname === "/login" && replayDestination.searchParams.get("error") === "expired_link");
  phase = "http_sign_out";
  for (const cookies of [cookiesA, cookiesB, recoveryCookies]) await request("/api/auth/sign-out", cookies, { method: "POST", body: {} });
  const signedOut = await request("/api/v1/me", cookiesA);
  check("sign_out_clears_session", signedOut.status === 200 && signedOut.data.session === null && cookiesA.size === 0);
  const freshCookies = jar();
  const fresh = await request("/api/auth/sign-in", freshCookies, { method: "POST", body: { email: a.email, password: a.password } });
  check("new_password_reconnects_to_saved_profile", fresh.status === 200 && fresh.data?.session.profile.revision === revision + 2 && fresh.data.session.profile.defaultContentLanguage === "en");
  await request("/api/auth/sign-out", freshCookies, { method: "POST", body: {} });
  output.ok = true;
  await mkdir(new URL("../.cache/", import.meta.url), { recursive: true });
  await writeFile(new URL("../.cache/foundation-live-results.json", import.meta.url), JSON.stringify(output, null, 2));
  console.log(JSON.stringify({ ok: true, checks: output.checks.length, smtpVerified: false, emailDeliveryVerified: false, qaCredentialsRetainedPrivately: true }));
} catch (error) {
  const code = error instanceof assert.AssertionError ? error.message : (error.code ?? "live_check_failed");
  console.error(JSON.stringify({ ok: false, phase, code }));
  process.exitCode = 1;
} finally {
  await pool?.end();
}
