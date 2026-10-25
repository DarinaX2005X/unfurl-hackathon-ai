import "server-only";
import { Pool } from "pg";
import { unavailable } from "../auth/errors";
import type { Actor } from "../auth/actor";
import { createTransactionRunner, type DbTransaction, type SystemTransactionPurpose } from "./transaction";

export type { DbTransaction, SystemTransactionPurpose } from "./transaction";

let pool: Pool | undefined;

function database() {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw unavailable("storage.unavailable");
    let parsed: URL;
    try { parsed = new URL(connectionString); } catch { throw unavailable("storage.unavailable"); }
    if (!["postgres:", "postgresql:"].includes(parsed.protocol)) throw unavailable("storage.unavailable");
    // Explicit TLS configuration cannot be weakened by URI sslmode parameters.
    for (const name of ["sslmode", "sslrootcert", "sslcert", "sslkey"]) parsed.searchParams.delete(name);
    const ca = process.env.DATABASE_SSL_CA?.replace(/\\n/g, "\n");
    pool = new Pool({
      connectionString: parsed.toString(), max: 1, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 20_000,
      ssl: { rejectUnauthorized: true, ...(ca ? { ca } : {}) },
      application_name: "unfurl",
    });
    // Idle connection errors are handled by the pool; never print connection strings.
    pool.on("error", () => undefined);
  }
  return createTransactionRunner(pool);
}

export function withActorTransaction<T>(actor: Actor, work: (transaction: DbTransaction) => Promise<T>): Promise<T> {
  return database().withActorTransaction(actor, work);
}

export function withSystemTransaction<T>(purpose: SystemTransactionPurpose, work: (transaction: DbTransaction) => Promise<T>): Promise<T> {
  return database().withSystemTransaction(purpose, work);
}
