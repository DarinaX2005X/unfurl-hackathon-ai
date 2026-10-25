import "server-only";
import { Buffer } from "node:buffer";
import { unavailable } from "../auth/errors";

const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const KEY = /^[A-Za-z0-9_-]{43,128}$/;

export interface ShareTokenConfiguration {
  activeVersion: string;
  keys: ReadonlyMap<string, Uint8Array>;
}

export function readShareTokenConfiguration(env: Record<string, string | undefined> = process.env): ShareTokenConfiguration | null {
  const activeVersion = env.SHARE_TOKEN_ACTIVE_KEY_VERSION?.trim() ?? "";
  const encoded = env.SHARE_TOKEN_KEYS_JSON?.trim() ?? "";
  if (!activeVersion || !encoded || !VERSION.test(activeVersion)) return null;
  let value: unknown;
  try { value = JSON.parse(encoded); } catch { return null; }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.length < 1 || entries.length > 16) return null;
  const keys = new Map<string, Uint8Array>();
  for (const [version, raw] of entries) {
    if (!VERSION.test(version) || typeof raw !== "string" || !KEY.test(raw)) return null;
    const bytes = Buffer.from(raw, "base64url");
    if (bytes.byteLength < 32 || bytes.byteLength > 96 || bytes.toString("base64url") !== raw) return null;
    keys.set(version, new Uint8Array(bytes));
  }
  if (!keys.has(activeVersion)) return null;
  return { activeVersion, keys };
}

export function requireShareTokenConfiguration(): ShareTokenConfiguration {
  const config = readShareTokenConfiguration();
  if (!config) throw unavailable("sharing.unavailable");
  return config;
}
