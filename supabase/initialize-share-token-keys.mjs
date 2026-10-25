import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

// One-time local development initialization. Existing versions are validated and preserved.
// Never prints key material.
const envPath = new URL("../.env.local", import.meta.url);
const text = await readFile(envPath, "utf8");
const activeMatch = text.match(/^SHARE_TOKEN_ACTIVE_KEY_VERSION=(.*)$/m);
const keysMatch = text.match(/^SHARE_TOKEN_KEYS_JSON=(.*)$/m);
const active = activeMatch?.[1].trim() ?? "";
const encoded = keysMatch?.[1].trim() ?? "";
const versionPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

function parseKeys(value) {
  let keys;
  try { keys = JSON.parse(value); } catch { throw new Error("invalid_share_token_keys_json"); }
  if (!keys || Array.isArray(keys) || typeof keys !== "object") throw new Error("invalid_share_token_keys_json");
  const entries = Object.entries(keys);
  if (entries.length < 1 || entries.length > 16) throw new Error("invalid_share_token_key_count");
  for (const [version, key] of entries) {
    if (!versionPattern.test(version) || typeof key !== "string" || !/^[A-Za-z0-9_-]{43,128}$/.test(key)) {
      throw new Error("invalid_share_token_key_entry");
    }
  }
  return keys;
}

if (active || encoded) {
  if (!active || !encoded || !versionPattern.test(active)) throw new Error("partial_share_token_configuration");
  const keys = parseKeys(encoded);
  if (!(active in keys)) throw new Error("active_share_token_key_missing");
  console.log(JSON.stringify({ ok: true, created: false, versions: Object.keys(keys).length, activeConfigured: true }));
} else {
  const version = "1";
  const keys = JSON.stringify({ [version]: randomBytes(32).toString("base64url") });
  const suffix = `SHARE_TOKEN_ACTIVE_KEY_VERSION=${version}\nSHARE_TOKEN_KEYS_JSON=${keys}\n`;
  await writeFile(envPath, `${text.replace(/\s*$/, "")}\n${suffix}`, { mode: 0o600 });
  console.log(JSON.stringify({ ok: true, created: true, versions: 1, activeConfigured: true }));
}
