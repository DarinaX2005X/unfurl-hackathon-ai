import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { readShareTokenConfiguration } from "../../src/server/sharing/config";
import { deriveShareToken, hashShareToken, sharePath } from "../../src/server/sharing/crypto";

const grantId = "10000000-0000-4000-8000-000000000001";
const key = Buffer.alloc(32, 7).toString("base64url");

describe("versioned share tokens", () => {
  it("parses a bounded key ring and derives a stable nonstored bearer token", () => {
    const config = readShareTokenConfiguration({
      SHARE_TOKEN_ACTIVE_KEY_VERSION: "v2", SHARE_TOKEN_KEYS_JSON: JSON.stringify({ v1: key, v2: key }),
    });
    expect(config?.keys.size).toBe(2);
    const token = deriveShareToken(grantId, "v2", config!);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(deriveShareToken(grantId, "v2", config!)).toBe(token);
    expect(hashShareToken(token)).toMatch(/^[a-f0-9]{64}$/);
    expect(sharePath(token)).toBe(`/s/${token}`);
    expect(hashShareToken(token)).not.toContain(token);
  });
  it("fails closed for partial, missing, short, noncanonical and oversized key rings", () => {
    const valid = { SHARE_TOKEN_ACTIVE_KEY_VERSION: "v1", SHARE_TOKEN_KEYS_JSON: JSON.stringify({ v1: key }) };
    expect(readShareTokenConfiguration(valid)).not.toBeNull();
    expect(readShareTokenConfiguration({})).toBeNull();
    expect(readShareTokenConfiguration({ ...valid, SHARE_TOKEN_ACTIVE_KEY_VERSION: "missing" })).toBeNull();
    expect(readShareTokenConfiguration({ ...valid, SHARE_TOKEN_KEYS_JSON: JSON.stringify({ v1: Buffer.alloc(31).toString("base64url") }) })).toBeNull();
    expect(readShareTokenConfiguration({ ...valid, SHARE_TOKEN_KEYS_JSON: JSON.stringify({ "../bad": key }) })).toBeNull();
    expect(readShareTokenConfiguration({ ...valid, SHARE_TOKEN_KEYS_JSON: JSON.stringify(Object.fromEntries(
      Array.from({ length: 17 }, (_, index) => [`v${index}`, key]),
    )) })).toBeNull();
  });
});
