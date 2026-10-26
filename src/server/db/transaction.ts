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
      // These statements contain only fixed server-owned SQL. Sending them in one
      // simple query avoids three network round trips on every transaction.
      // BEGIN may succeed before a later setup statement fails, so always attempt
      // rollback after this query starts and discard an incompletely set-up client.
      begun = true;
      broken = true;
      await client.query(`BEGIN; SET LOCAL ROLE ${actor ? "authenticated" : "service_role"}; SET LOCAL statement_timeout = '15s'; SET LOCAL lock_timeout = '5s'`);
      broken = false;
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
