import "server-only";
import { createHash, createHmac } from "node:crypto";
import { IdSchema } from "../../domain/common";
import type { ShareTokenConfiguration } from "./config";
import { unavailable } from "../auth/errors";

export const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function deriveShareToken(grantId: string, keyVersion: string, config: ShareTokenConfiguration): string {
  const id = IdSchema.parse(grantId);
  const key = config.keys.get(keyVersion);
  if (!key) throw unavailable("sharing.unavailable");
  return createHmac("sha256", key).update(`unfurl.share.v1:${id}`, "utf8").digest("base64url");
}

export function hashShareToken(token: string): string {
  if (!SHARE_TOKEN_PATTERN.test(token)) throw new RangeError("Invalid share token");
  return createHash("sha256").update(token, "ascii").digest("hex");
}

export function sharePath(token: string): `/s/${string}` {
  if (!SHARE_TOKEN_PATTERN.test(token)) throw new RangeError("Invalid share token");
  return `/s/${token}`;
}
