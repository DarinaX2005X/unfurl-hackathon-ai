import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import type { DbTransaction } from "../../../src/server/db";
import { PostgresPythonExecutionPersistence, PythonExecutionConflictError } from "../../../src/server/db/python-execution";
import { pythonSourceDigest, type PythonExecutionFence } from "../../../src/server/execution/python/contracts";
import { pythonExecutionResourceName } from "../../../src/server/execution/python/vercel";
import { executionRequest } from "./fixtures";

type Row = Record<string, unknown>;
const id = (value: number) => `10000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
function independentRequest(value: number, sameLearner = false) {
  const original = executionRequest();
  return executionRequest({ executionId: id(value * 10), idempotencyKey: id(value * 10 + 1), logicalExecutionId: id(value * 10 + 2),
    job: { ...original.job, jobId: id(value * 10 + 3) }, target: { kind: "activity_action", activityActionId: id(value * 10 + 4) },
    authority: { ...original.authority, learnerId: sameLearner ? original.authority.learnerId : id(value * 10 + 5) } });
}

/** Isolated SQL-port harness. PostgreSQL constraints are covered separately by migration checks. */
function database() {
  const admissions = new Map<unknown, Row>();
  const runs = new Map<unknown, Row>();
  let authorized = true;
  let insertError: Error | null = null;
  const result = (rows: Row[] = []) => ({ rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] });
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    if (sql.includes("SELECT EXISTS(")) return result([{ ok: authorized }]);
    if (sql.includes("SELECT * FROM unfurl.python_execution_admissions")) {
      const row = [...admissions.values()].find((entry) => entry.idempotency_key === values[0] || entry.execution_id === values[1]
        || (entry.logical_execution_id === values[2] && entry.execution_attempt === values[3]));
      return result(row ? [row] : []);
    }
    if (sql.includes("INSERT INTO unfurl.python_execution_admissions")) {
      const duplicate = [...admissions.values()].some((entry) => entry.idempotency_key === values[0] || entry.execution_id === values[1]
        || (entry.logical_execution_id === values[9] && entry.execution_attempt === values[10]));
      if (duplicate) return result();
      const names = ["idempotency_key", "execution_id", "job_id", "job_lease_owner", "job_fencing_token", "job_retry_epoch",
        "step_id", "step_lease_owner", "step_fencing_token", "logical_execution_id", "execution_attempt", "request_digest"];
      const row: Row = { ...Object.fromEntries(names.map((name, index) => [name, values[index]])), state: "assessing", result: null };
      admissions.set(values[0], row);
      return result([row]);
    }
    if (sql.includes("SELECT statement_timestamp()")) return result([{ now: new Date(), expired: Date.parse(values[0] as string) <= Date.now() }]);
    if (/^(SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT)/.test(sql)) return result();
    if (sql.includes("INSERT INTO unfurl.code_execution_runs")) {
      if (insertError) throw insertError;
      const columns = sql.match(/\(([\s\S]+?)\)\s*VALUES/)![1]!.split(",").map((name) => name.trim());
      const row: Row = { ...Object.fromEntries(columns.slice(0, 39).map((name, index) => [name, values[index]])),
        status: "creating", resource_name: pythonExecutionResourceName(values[0] as string), execution_cases: JSON.parse(values[20] as string),
        provider_sandbox_id: null, provider_session_id: null, provider_command_ids: [], safe_error: null, result: null, audit: null, capability_evidence: null };
      runs.set(values[0], row);
      return result([row]);
    }
    if (sql.includes("UPDATE unfurl.python_execution_admissions")) {
      const row = admissions.get(values[0])!;
      row.state = sql.includes("state='dispatch'") ? "dispatch" : "unavailable";
      if (row.state === "unavailable") row.result = JSON.parse(values[1] as string);
      return result([row]);
    }
    if (sql.includes("SELECT * FROM unfurl.code_execution_runs")) return result(runs.has(values[0]) ? [runs.get(values[0])!] : []);
    if (sql.includes("UPDATE unfurl.code_execution_runs SET status='cleanup_pending'")) {
      const row = runs.get(values[0])!;
      row.status = "cleanup_pending";
      return result([row]);
    }
    throw new Error(`Unhandled SQL: ${sql}`);
  });
  const tx = { query } as unknown as DbTransaction;
  return { admissions, runs, query, persistence: new PostgresPythonExecutionPersistence((work) => work(tx)),
    denyAuthority() { authorized = false; }, failInsert() { insertError = Object.assign(new Error("legacy capacity constraint"), { constraint: "code_execution_one_global_active" }); } };
}

describe("independent Python admissions", () => {
  it("admits independent simultaneous executions beyond the former global and learner daily caps", async () => {
    const db = database();
    const requests = Array.from({ length: 75 }, (_, index) => independentRequest(index + 1, index < 25));
    const results = await Promise.all(requests.map((request) => db.persistence.reserveCreate(request)));
    expect(results.every((result) => result.status === "dispatch")).toBe(true);
    expect(db.runs.size).toBe(75);
    expect(new Set(results.filter((result) => result.status === "dispatch").map((result) => result.resourceName)).size).toBe(75);
  });
  it("deduplicates simultaneous delivery of the same execution", async () => {
    const db = database();
    const request = independentRequest(1);
    const results = await Promise.all(Array.from({ length: 8 }, () => db.persistence.reserveCreate(request)));
    expect(results.filter((result) => result.status === "dispatch")).toHaveLength(1);
    expect(db.runs.size).toBe(1);
    expect(results.filter((result) => result.status !== "dispatch").every((result) => result.result.status === "unavailable"
      && result.result.reason === "cleanup_pending")).toBe(true);
  });
  it("keeps uncertain cleanup attached to its execution while another execution can proceed", async () => {
    const db = database();
    const pending = independentRequest(1, true);
    await db.persistence.reserveCreate(pending);
    const fence: PythonExecutionFence = { kind: "learning", executionId: pending.executionId, jobId: pending.job.jobId,
      leaseOwner: pending.job.leaseOwner, fencingToken: pending.job.fencingToken, retryEpoch: pending.job.retryEpoch };
    await db.persistence.recordCleanupPending(fence, { at: new Date().toISOString(), error: null });
    expect(await db.persistence.reserveCreate(pending)).toMatchObject({ status: "unavailable", result: { reason: "cleanup_pending", retryable: false } });
    expect(await db.persistence.reserveCreate(independentRequest(2, true))).toMatchObject({ status: "dispatch" });
    expect(db.runs.get(pending.executionId)?.status).toBe("cleanup_pending");
    await expect(db.persistence.recordCleanupPending({ ...fence, fencingToken: "999" }, { at: new Date().toISOString(), error: null }))
      .rejects.toBeInstanceOf(PythonExecutionConflictError);
  });
  it("rejects a changed immutable request without creating a second execution", async () => {
    const db = database();
    const original = independentRequest(1);
    await db.persistence.reserveCreate(original);
    const source = "def solve(payload):\n    return 99\n";
    await expect(db.persistence.reserveCreate(executionRequest({ ...original, source, sourceDigest: pythonSourceDigest(source) })))
      .rejects.toBeInstanceOf(PythonExecutionConflictError);
    expect(db.runs.size).toBe(1);
  });
  it("retains deadline and job authority gates", async () => {
    const db = database();
    const expired = executionRequest({ ...independentRequest(1), deadlineAt: "2020-01-01T00:00:00.000Z" });
    expect(await db.persistence.reserveCreate(expired)).toMatchObject({ status: "unavailable", result: { reason: "deadline_expired" } });
    expect(await db.persistence.reserveCreate(expired)).toMatchObject({ status: "replay", result: { reason: "deadline_expired" } });
    expect(db.runs.size).toBe(0);
    db.denyAuthority();
    await expect(db.persistence.reserveCreate(independentRequest(2))).rejects.toBeInstanceOf(PythonExecutionConflictError);
  });
  it("replays an existing quota-denial receipt without rewriting its historical outcome", async () => {
    const db = database();
    const request = executionRequest({ ...independentRequest(1), deadlineAt: "2020-01-01T00:00:00.000Z" });
    await db.persistence.reserveCreate(request);
    const receipt = db.admissions.get(request.idempotencyKey)!;
    receipt.result = { ...(receipt.result as Row), reason: "quota" };
    const before = structuredClone(receipt);
    expect(await db.persistence.reserveCreate(request)).toMatchObject({ status: "replay", result: { reason: "quota" } });
    expect(receipt).toEqual(before);
    expect(db.runs.size).toBe(0);
  });
  it("does not turn a database insertion failure into a provider quota receipt", async () => {
    const db = database();
    db.failInsert();
    await expect(db.persistence.reserveCreate(independentRequest(1))).rejects.toBeInstanceOf(PythonExecutionConflictError);
    expect(db.query.mock.calls.some(([sql]) => sql.includes("SET state='unavailable'"))).toBe(false);
  });
});
