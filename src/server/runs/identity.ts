import "server-only";
import { createHash } from "node:crypto";

/** Stable private operation identity; never use this hash as proof of authorization. */
export function stableExecutionId(namespace: string, name: string): string {
  if (!namespace || namespace.length > 256 || !name || name.length > 256) throw new RangeError("Invalid execution identity");
  const bytes = createHash("sha256").update(`${namespace.length}:${namespace}:${name}`).digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const value = bytes.subarray(0, 16).toString("hex");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

/** Epoch zero preserves every existing paid identity. Later epochs require a durable explicit retry receipt. */
export function agentOperationId(stepId:string,name:string,retryEpoch:number):string{
  if(!Number.isSafeInteger(retryEpoch)||retryEpoch<0)throw new RangeError("Invalid retry epoch");
  return stableExecutionId(retryEpoch===0?stepId:stableExecutionId(stepId,`retry-epoch:${retryEpoch}`),name);
}
