import "server-only";
import { z } from "zod";
import { NextResponse, type NextRequest } from "next/server";
import { IdSchema } from "../../domain/common";
import { privateResponse } from "./client";
import { requireAuthConfiguration } from "./config";
import { ServiceFault, unavailable } from "./errors";

export function requestIdFor(request: Request): string {
  const id = request.headers.get("x-request-id");
  return IdSchema.safeParse(id).success ? id! : crypto.randomUUID();
}

export function assertSameOrigin(request: Request): void {
  const { origin } = requireAuthConfiguration();
  if (request.headers.get("origin") !== origin || request.headers.get("sec-fetch-site") === "cross-site") {
    throw new ServiceFault(403, "forbidden", "auth.originRejected");
  }
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) {
    throw new ServiceFault(400, "invalid_input", "auth.invalidInput");
  }
}

export async function readInput<T>(request: Request, schema: z.ZodType<T>, options?: { maxBytes: number }): Promise<T> {
  const maximum = options?.maxBytes ?? 16_384;
  const declared = request.headers.get("content-length");
  if (declared && Number(declared) > maximum) throw new ServiceFault(400, "invalid_input", "auth.invalidInput");
  const reader = request.body?.getReader();
  if (!reader) throw new ServiceFault(400, "invalid_input", "auth.invalidInput");
  let length = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > maximum) {
        await reader.cancel();
        throw new ServiceFault(400, "invalid_input", "auth.invalidInput");
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch {
    throw new ServiceFault(400, "invalid_input", "auth.invalidInput");
  }
  const result = schema.safeParse(value);
  if (!result.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of result.error.issues) {
      const field = issue.path[0];
      if (typeof field === "string" && !Object.hasOwn(fieldErrors, field)) fieldErrors[field] = "auth.invalidField";
    }
    throw new ServiceFault(400, "invalid_input", "auth.invalidInput", false, { fieldErrors });
  }
  return result.data;
}

export function success<T>(data: T, status = 200): NextResponse {
  return privateResponse(NextResponse.json({ data }, { status }));
}

export function failure(error: unknown, request: NextRequest): NextResponse {
  const fault = error instanceof ServiceFault ? error : unavailable();
  const requestId = requestIdFor(request);
  const response = privateResponse(NextResponse.json(fault.toApiError(requestId), { status: fault.status }));
  response.headers.set("X-Request-Id", requestId);
  return response;
}
