import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { IdSchema, JsonValueSchema, type JsonValue } from "../../domain/common";
import type { Actor } from "../auth/actor";
import { ServiceFault, unavailable } from "../auth/errors";
import { withActorTransaction, type DbTransaction } from "../db";

export interface MutationReceipt<T> {
  status: 200 | 201 | 202 | 204;
  data: T;
}
export interface IdempotentCommand<T> {
  operation: string;
  key: string;
  body: unknown;
  parseResult: z.ZodType<T>;
}

function canonical(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function requestDigest(body: unknown): string {
  const parsed = JsonValueSchema.safeParse(body);
  if (!parsed.success) throw new ServiceFault(400, "invalid_input", "request.invalidInput");
  return createHash("sha256").update(canonical(parsed.data)).digest("hex");
}

export async function executeIdempotentInTransaction<T>(
  tx: DbTransaction, actor: Actor, command: IdempotentCommand<T>,
  mutation: (transaction: DbTransaction) => Promise<MutationReceipt<T>>,
): Promise<MutationReceipt<T> & { replayed: boolean }> {
  if (!IdSchema.safeParse(command.key).success || !/^[a-z][a-z0-9_.:-]{1,100}$/.test(command.operation)) {
    throw new ServiceFault(400, "invalid_input", "request.invalidIdempotencyKey");
  }
  const digest = requestDigest(command.body);
  const inserted = await tx.query<{ key: string }>(
    `INSERT INTO unfurl.idempotency (actor_id, operation, key, request_digest)
     VALUES ($1, $2, $3, $4) ON CONFLICT (actor_id, operation, key) DO NOTHING RETURNING key`,
    [actor.id, command.operation, command.key, digest],
  );
  if (!inserted.rows.length) {
    const existing = await tx.query<{ request_digest: string; response_status: number | null; response_data: unknown }>(
      "SELECT request_digest, response_status, response_data FROM unfurl.idempotency WHERE actor_id = $1 AND operation = $2 AND key = $3 FOR UPDATE",
      [actor.id, command.operation, command.key],
    );
    const row = existing.rows[0];
    if (!row || row.response_status === null) throw unavailable("storage.unavailable");
    if (row.request_digest !== digest) throw new ServiceFault(409, "idempotency_conflict", "request.idempotencyConflict");
    const status = z.union([z.literal(200), z.literal(201), z.literal(202), z.literal(204)]).parse(row.response_status);
    return { status, data: command.parseResult.parse(row.response_data), replayed: true };
  }
  const result = await mutation(tx);
  const data = command.parseResult.parse(result.data);
  await tx.query(
    `UPDATE unfurl.idempotency SET response_status = $4, response_data = $5::jsonb, completed_at = now()
     WHERE actor_id = $1 AND operation = $2 AND key = $3`,
    [actor.id, command.operation, command.key, result.status, JSON.stringify(data)],
  );
  return { status: result.status, data, replayed: false };
}

export function executeIdempotent<T>(
  actor: Actor, command: IdempotentCommand<T>, mutation: (transaction: DbTransaction) => Promise<MutationReceipt<T>>,
): Promise<MutationReceipt<T> & { replayed: boolean }> {
  return withActorTransaction(actor, (tx) => executeIdempotentInTransaction(tx, actor, command, mutation));
}
