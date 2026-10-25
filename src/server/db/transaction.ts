import "server-only";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import type { Actor } from "../auth/actor";

export interface DbTransaction {
  query<Row extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<Row>>;
}

export type SystemTransactionPurpose =
  | "run_execution"
  | "evaluation"
  | "public_projection"
  | "course_access"
  | "publication"
  | "learning_activity";
export interface TransactionPool { connect(): Promise<Pick<PoolClient, "query" | "release">> }

export function createTransactionRunner(pool: TransactionPool) {
  async function run<T>(actor: Actor | null, work: (transaction: DbTransaction) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    let begun = false;
    let broken = false;
    try {
      await client.query("BEGIN");
      begun = true;
      await client.query(actor ? "SET LOCAL ROLE authenticated" : "SET LOCAL ROLE service_role");
      await client.query("SET LOCAL statement_timeout = '15s'");
      await client.query("SET LOCAL lock_timeout = '5s'");
      if (actor) {
        await client.query("SELECT set_config('request.jwt.claims', $1, true)", [
          JSON.stringify({ sub: actor.id, role: "authenticated", session_id: actor.sessionId }),
        ]);
      }
      const transaction: DbTransaction = {
        query: <Row extends QueryResultRow>(text: string, values?: unknown[]) => client.query<Row>(text, values),
      };
      const result = await work(transaction);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      if (begun) {
        try { await client.query("ROLLBACK"); } catch { broken = true; }
      } else broken = true;
      throw error;
    } finally {
      client.release(broken);
    }
  }

  return {
    withActorTransaction: <T>(actor: Actor, work: (transaction: DbTransaction) => Promise<T>) => run(actor, work),
    withSystemTransaction: <T>(_purpose: SystemTransactionPurpose, work: (transaction: DbTransaction) => Promise<T>) => run(null, work),
  };
}
