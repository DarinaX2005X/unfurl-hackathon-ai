import "server-only";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { DbTransaction } from "../db";
import { jsonDigest } from "../ai/json";
import { modelPolicy } from "../ai/model-policy";
import type { BudgetTransactionRunner } from "./postgres";
import { PostgresBudget } from "./postgres";
import {
  FINAL_VERIFICATION_RESERVE_MICRO_USD,
  PROBE_LIMIT_MICRO_USD,
  SPENDABLE_LIMIT_MICRO_USD,
} from "./money";
import type { ProviderResponseReceipt, ReserveRequest } from "./ports";

export const LEDGER_PROOF_VERSION = "state-relative-ledger-proof-v1" as const;
export const LEDGER_PROOF_TEST_CASES = [
  "reserve_replay_dispatch_settle",
  "unknown_hold_two_slot_guard",
  "dynamic_campaign_and_probe_ceilings",
  "overrun_halts_inside_rollback",
  "real_peer_campaign_lock",
] as const;

/** Every file whose behavior is covered by, or can authorize, this proof. */
export const LEDGER_PROOF_SOURCE_FILES = [
  "src/server/budget/ledger-proof.ts",
  "src/server/budget/postgres.ts",
  "src/server/budget/calculations.ts",
  "src/server/budget/money.ts",
  "src/server/budget/ports.ts",
  "tests/budget/ledger-proof.test.ts",
  "tests/budget/ledger-proof.operator.test.ts",
  "scripts/budget-ledger-proof.mjs",
] as const;

export type LedgerProofClient = DbTransaction;

export interface LedgerProofSnapshot {
  campaign: {
    settledMicroUsd: string;
    reservedMicroUsd: string;
    halted: boolean;
    revision: string;
    updatedAt: string;
  };
  rows: {
    operations: number;
    responses: number;
    entries: number;
  };
  held: {
    total: number;
    terminalHttp400: number;
    effectivelyRetired: number;
    active: number;
  };
  paused: {
    runningJobs: number;
    runningSteps: number;
    activeJobLeases: number;
    activeStepLeases: number;
    pendingOutbox: number;
    activeCodeExecutions: number;
  };
  probe: {
    settledMicroUsd: string;
    reservedMicroUsd: string;
  };
}

export interface StateRelativeLedgerProofReport {
  version: typeof LEDGER_PROOF_VERSION;
  budgetId: string;
  observedAt: string;
  completedAt: string;
  sourceHash: string;
  testCases: Array<(typeof LEDGER_PROOF_TEST_CASES)[number]>;
  originalObservedState: LedgerProofSnapshot;
  postProofState: LedgerProofSnapshot;
  snapshotDigest: string;
  rollbackVerified: true;
  inferenceCalls: 0;
  providerProofUsed: false;
}

interface CampaignRow {
  settled_micro_usd: string;
  reserved_micro_usd: string;
  halted: boolean;
  revision: string;
  updated_at: Date | string;
}

interface ProofBudgetState {
  settled: bigint;
  reserved: bigint;
  probeSettled: bigint;
  probeReserved: bigint;
}

const activeCodeStatuses = "'reserved','creating','running','collecting','ambiguous','cleanup_pending'";
const heldStates = "'reserved','dispatched','unknown'";

function iso(value: Date | string): string {
  const result = new Date(value).toISOString();
  if (!Number.isFinite(Date.parse(result))) throw new Error("Invalid ledger timestamp");
  return result;
}

async function readSnapshot(client: LedgerProofClient, budgetId: string): Promise<LedgerProofSnapshot> {
  const campaign = (await client.query<CampaignRow>(`SELECT settled_micro_usd::text,reserved_micro_usd::text,halted,
    revision::text,updated_at FROM unfurl.ai_budgets WHERE id=$1`, [budgetId])).rows[0];
  if (!campaign) throw new Error("Fixed budget campaign is unavailable");
  const rows = (await client.query<{ operations: number; responses: number; entries: number }>(`SELECT
    (SELECT count(*)::int FROM unfurl.ai_provider_operations WHERE budget_id=$1) AS operations,
    (SELECT count(*)::int FROM unfurl.ai_provider_responses r JOIN unfurl.ai_provider_operations o ON o.id=r.operation_id WHERE o.budget_id=$1) AS responses,
    (SELECT count(*)::int FROM unfurl.ai_budget_entries WHERE budget_id=$1) AS entries`, [budgetId])).rows[0];
  const held = (await client.query<{ total: number; terminal_http_400: number; effectively_retired: number; active: number }>(`WITH held AS (
    SELECT o.id,
      EXISTS(SELECT 1 FROM unfurl.ai_provider_terminal_http_400_receipts t WHERE t.operation_id=o.id) AS terminal_http_400,
      EXISTS(SELECT 1 FROM unfurl.ai_provider_attempt_retirements a WHERE a.operation_id=o.id AND
        (a.kind='ended_probe' OR EXISTS(SELECT 1 FROM unfurl.execution_job_retry_receipts retry
          WHERE retry.job_id=a.job_id AND retry.from_epoch=a.from_epoch AND retry.actor_id=a.actor_id))) AS effectively_retired
    FROM unfurl.ai_provider_operations o WHERE o.budget_id=$1 AND o.state IN (${heldStates})
  ) SELECT count(*)::int AS total,
    count(*) FILTER(WHERE terminal_http_400)::int AS terminal_http_400,
    count(*) FILTER(WHERE effectively_retired)::int AS effectively_retired,
    count(*) FILTER(WHERE NOT terminal_http_400 AND NOT effectively_retired)::int AS active FROM held`, [budgetId])).rows[0];
  const paused = (await client.query<{
    running_jobs: number; running_steps: number; active_job_leases: number; active_step_leases: number;
    pending_outbox: number; active_code_executions: number;
  }>(`SELECT
    (SELECT count(*)::int FROM unfurl.execution_jobs WHERE status='running') AS running_jobs,
    (SELECT count(*)::int FROM unfurl.run_steps WHERE status='running') AS running_steps,
    (SELECT count(*)::int FROM unfurl.execution_jobs WHERE status='running' AND lease_expires_at>statement_timestamp()) AS active_job_leases,
    (SELECT count(*)::int FROM unfurl.run_steps WHERE status='running' AND lease_expires_at>statement_timestamp()) AS active_step_leases,
    (SELECT count(*)::int FROM unfurl.outbox WHERE dispatched_at IS NULL) AS pending_outbox,
    (SELECT count(*)::int FROM unfurl.code_execution_runs WHERE status IN (${activeCodeStatuses})) AS active_code_executions`)).rows[0];
  const probe = (await client.query<{ settled: string; reserved: string }>(`SELECT
    coalesce(sum(actual_micro_usd) FILTER(WHERE purpose='capability_probe' AND state='settled'),0)::text AS settled,
    coalesce(sum(reserved_micro_usd) FILTER(WHERE purpose='capability_probe' AND state IN (${heldStates})),0)::text AS reserved
    FROM unfurl.ai_provider_operations WHERE budget_id=$1`, [budgetId])).rows[0];
  if (!rows || !held || !paused || !probe) throw new Error("Ledger snapshot is incomplete");
  return {
    campaign: {
      settledMicroUsd: campaign.settled_micro_usd,
      reservedMicroUsd: campaign.reserved_micro_usd,
      halted: campaign.halted,
      revision: campaign.revision,
      updatedAt: iso(campaign.updated_at),
    },
    rows,
    held: {
      total: held.total,
      terminalHttp400: held.terminal_http_400,
      effectivelyRetired: held.effectively_retired,
      active: held.active,
    },
    paused: {
      runningJobs: paused.running_jobs,
      runningSteps: paused.running_steps,
      activeJobLeases: paused.active_job_leases,
      activeStepLeases: paused.active_step_leases,
      pendingOutbox: paused.pending_outbox,
      activeCodeExecutions: paused.active_code_executions,
    },
    probe: { settledMicroUsd: probe.settled, reservedMicroUsd: probe.reserved },
  };
}

function assertPaused(snapshot: LedgerProofSnapshot): void {
  assert.equal(snapshot.campaign.halted, false, "The campaign is halted");
  assert.deepEqual(snapshot.paused, {
    runningJobs: 0,
    runningSteps: 0,
    activeJobLeases: 0,
    activeStepLeases: 0,
    pendingOutbox: 0,
    activeCodeExecutions: 0,
  });
  assert.equal(snapshot.held.active, 0, "An unretired paid operation is still active");
  assert.ok(snapshot.held.total > 0, "Expected historical financial holds are missing");
  assert.ok(snapshot.held.terminalHttp400 + snapshot.held.effectivelyRetired >= snapshot.held.total,
    "Every historical hold must have terminal or retirement evidence");
}

async function begin(client: LedgerProofClient, lockTimeout = "5s"): Promise<void> {
  await client.query(`BEGIN; SET LOCAL ROLE service_role; SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='${lockTimeout}'`);
}

async function rollback(client: LedgerProofClient): Promise<void> {
  await client.query("ROLLBACK");
}

function savepointRunner(client: LedgerProofClient): BudgetTransactionRunner {
  let sequence = 0;
  return async <T>(work: (tx: DbTransaction) => Promise<T>): Promise<T> => {
    sequence += 1;
    const name = `ledger_proof_${sequence}`;
    await client.query(`SAVEPOINT ${name}`);
    try {
      const result = await work(client);
      await client.query(`RELEASE SAVEPOINT ${name}`);
      return result;
    } catch (error) {
      await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
      await client.query(`RELEASE SAVEPOINT ${name}`);
      throw error;
    }
  };
}

function request(amount: bigint, probe = false): ReserveRequest {
  const policy = modelPolicy("kimi-digitalocean-v1");
  const rateCard = { model: policy.model, provider: policy.provider, policyVersion: policy.id, proof: LEDGER_PROOF_VERSION };
  return {
    reservationId: randomUUID(),
    logicalOperationId: randomUUID(),
    attempt: 1,
    runStepId: null,
    probe,
    purpose: probe ? "capability_probe" : "curriculum",
    amountMicroUsd: amount.toString(),
    requestDigest: randomUUID().replaceAll("-", "").padEnd(64, "0").slice(0, 64),
    rateCardDigest: jsonDigest(rateCard),
    rateCard,
  };
}

function response(): ProviderResponseReceipt {
  return {
    providerRequestId: `rollback-${randomUUID()}`,
    responseDigest: randomUUID().replaceAll("-", "").padEnd(64, "1").slice(0, 64),
    reportedCostUsd: "0.001",
    usage: { fixture: LEDGER_PROOF_VERSION },
    result: { fixture: LEDGER_PROOF_VERSION },
  };
}

async function campaign(client: LedgerProofClient, budgetId: string): Promise<{ settled: bigint; reserved: bigint; halted: boolean }> {
  const row = (await client.query<{ settled: string; reserved: string; halted: boolean }>(`SELECT settled_micro_usd::text AS settled,
    reserved_micro_usd::text AS reserved,halted FROM unfurl.ai_budgets WHERE id=$1`, [budgetId])).rows[0];
  if (!row) throw new Error("Fixed budget campaign is unavailable");
  return { settled: BigInt(row.settled), reserved: BigInt(row.reserved), halted: row.halted };
}

async function proofState(client: LedgerProofClient, budgetId: string): Promise<ProofBudgetState> {
  const row = (await client.query<{ settled: string; reserved: string; probe_settled: string; probe_reserved: string }>(`SELECT
    b.settled_micro_usd::text AS settled,b.reserved_micro_usd::text AS reserved,
    coalesce(sum(o.actual_micro_usd) FILTER(WHERE o.purpose='capability_probe' AND o.state='settled'),0)::text AS probe_settled,
    coalesce(sum(o.reserved_micro_usd) FILTER(WHERE o.purpose='capability_probe' AND o.state IN (${heldStates})),0)::text AS probe_reserved
    FROM unfurl.ai_budgets b LEFT JOIN unfurl.ai_provider_operations o ON o.budget_id=b.id WHERE b.id=$1
    GROUP BY b.id`, [budgetId])).rows[0];
  if (!row) throw new Error("Fixed budget campaign is unavailable");
  return { settled: BigInt(row.settled), reserved: BigInt(row.reserved),
    probeSettled: BigInt(row.probe_settled), probeReserved: BigInt(row.probe_reserved) };
}

async function reserveReplaySettle(client: LedgerProofClient, budgetId: string): Promise<void> {
  await begin(client);
  try {
    const ledger = new PostgresBudget(budgetId, savepointRunner(client));
    const before = await campaign(client, budgetId);
    const counts = (await client.query<{ operations: number; responses: number; entries: number }>(`SELECT
      (SELECT count(*)::int FROM unfurl.ai_provider_operations WHERE budget_id=$1) AS operations,
      (SELECT count(*)::int FROM unfurl.ai_provider_responses r JOIN unfurl.ai_provider_operations o ON o.id=r.operation_id WHERE o.budget_id=$1) AS responses,
      (SELECT count(*)::int FROM unfurl.ai_budget_entries WHERE budget_id=$1) AS entries`, [budgetId])).rows[0]!;
    const input = request(10_000n);
    const reserved = await ledger.reserve(input);
    assert.deepEqual(await ledger.reserve(input), reserved);
    await assert.rejects(ledger.reserve({ ...input, requestDigest: "c".repeat(64) }), /provider\.unavailable/);
    assert.deepEqual(await ledger.claimDispatch(reserved), { kind: "dispatch" });
    const receipt = response();
    await ledger.recordResponse(reserved, receipt, "1000");
    await ledger.recordResponse(reserved, receipt, "1000");
    assert.deepEqual(await ledger.recover(input, input.requestDigest), { reservation: { ...reserved, state: "settled" }, receipt });
    assert.deepEqual(await ledger.claimDispatch({ ...reserved, state: "settled" }), { kind: "replay", receipt });
    const after = await campaign(client, budgetId);
    assert.equal(after.settled, before.settled + 1_000n);
    assert.equal(after.reserved, before.reserved);
    assert.equal(after.halted, false);
    const afterCounts = (await client.query<{ operations: number; responses: number; entries: number }>(`SELECT
      (SELECT count(*)::int FROM unfurl.ai_provider_operations WHERE budget_id=$1) AS operations,
      (SELECT count(*)::int FROM unfurl.ai_provider_responses r JOIN unfurl.ai_provider_operations o ON o.id=r.operation_id WHERE o.budget_id=$1) AS responses,
      (SELECT count(*)::int FROM unfurl.ai_budget_entries WHERE budget_id=$1) AS entries`, [budgetId])).rows[0]!;
    assert.equal(afterCounts.operations, counts.operations + 1);
    assert.equal(afterCounts.responses, counts.responses + 1);
    assert.equal(afterCounts.entries, counts.entries + 2);
  } finally {
    await rollback(client);
  }
}

async function unknownSlotGuard(client: LedgerProofClient, budgetId: string): Promise<void> {
  await begin(client);
  try {
    const ledger = new PostgresBudget(budgetId, savepointRunner(client));
    const before = await campaign(client, budgetId);
    for (let index = 0; index < 2; index += 1) {
      const held = await ledger.reserve(request(1_000n));
      assert.deepEqual(await ledger.claimDispatch(held), { kind: "dispatch" });
      await ledger.markUnknown(held, "timeout");
    }
    await assert.rejects(ledger.reserve(request(1n)), /provider\.budget_exhausted/);
    const after = await campaign(client, budgetId);
    assert.equal(after.settled, before.settled);
    assert.equal(after.reserved, before.reserved + 2_000n);
  } finally {
    await rollback(client);
  }
}

async function dynamicCeilings(client: LedgerProofClient, budgetId: string): Promise<void> {
  await begin(client);
  try {
    const ledger = new PostgresBudget(budgetId, savepointRunner(client));
    const before = await proofState(client, budgetId);
    const campaignHeadroom = SPENDABLE_LIMIT_MICRO_USD - before.settled - before.reserved;
    assert.ok(campaignHeadroom > 0n, "No normal campaign headroom remains");
    const campaignReservation = await ledger.reserve(request(campaignHeadroom));
    await assert.rejects(ledger.reserve(request(1n)), /provider\.budget_exhausted/);
    await ledger.releaseUnsent(campaignReservation);
    const probeCampaignHeadroom = SPENDABLE_LIMIT_MICRO_USD - FINAL_VERIFICATION_RESERVE_MICRO_USD - before.settled - before.reserved;
    const probePolicyHeadroom = PROBE_LIMIT_MICRO_USD - before.probeSettled - before.probeReserved;
    assert.ok(probePolicyHeadroom > 0n, "No probe headroom remains");
    assert.ok(probePolicyHeadroom <= probeCampaignHeadroom, "Current campaign state cannot isolate the probe ceiling");
    const probeReservation = await ledger.reserve(request(probePolicyHeadroom, true));
    await assert.rejects(ledger.reserve(request(1n, true)), /provider\.budget_exhausted/);
    await ledger.releaseUnsent(probeReservation);
    assert.deepEqual(await proofState(client, budgetId), before);
  } finally {
    await rollback(client);
  }
}

async function overrunHalts(client: LedgerProofClient, budgetId: string): Promise<void> {
  await begin(client);
  try {
    const ledger = new PostgresBudget(budgetId, savepointRunner(client));
    const before = await campaign(client, budgetId);
    const input = request(100n);
    const reserved = await ledger.reserve(input);
    await ledger.claimDispatch(reserved);
    await ledger.recordResponse(reserved, response(), "101");
    const after = await campaign(client, budgetId);
    assert.equal(after.settled, before.settled + 101n);
    assert.equal(after.reserved, before.reserved);
    assert.equal(after.halted, true);
    await assert.rejects(ledger.reserve(request(1n)), /provider\.budget_exhausted/);
  } finally {
    await rollback(client);
  }
}

async function peerLock(client: LedgerProofClient, peer: LedgerProofClient, budgetId: string): Promise<void> {
  let primaryBegun = false;
  let peerBegun = false;
  try {
    await begin(client); primaryBegun = true;
    const primary = new PostgresBudget(budgetId, savepointRunner(client));
    await primary.reserve(request(1_000n));
    await begin(peer, "150ms"); peerBegun = true;
    const competing = new PostgresBudget(budgetId, savepointRunner(peer));
    await assert.rejects(competing.reserve(request(1_000n)), (error: unknown) =>
      typeof error === "object" && error !== null && "code" in error && error.code === "55P03");
    await rollback(client); primaryBegun = false;
    assert.equal((await competing.reserve(request(1_000n))).state, "reserved");
  } finally {
    if (primaryBegun) await rollback(client);
    if (peerBegun) await rollback(peer);
  }
}

export async function runStateRelativeLedgerProof(input: {
  budgetId: string;
  primary: LedgerProofClient;
  peer: LedgerProofClient;
  sourceHash: string;
  now?: () => Date;
}): Promise<StateRelativeLedgerProofReport> {
  if (!/^[0-9a-f-]{36}$/i.test(input.budgetId) || !/^[a-f0-9]{64}$/.test(input.sourceHash)) throw new Error("Invalid ledger proof identity");
  const clock = input.now ?? (() => new Date());
  const observedAt = clock().toISOString();
  const originalObservedState = await readSnapshot(input.primary, input.budgetId);
  assertPaused(originalObservedState);
  await reserveReplaySettle(input.primary, input.budgetId);
  await unknownSlotGuard(input.primary, input.budgetId);
  await dynamicCeilings(input.primary, input.budgetId);
  await overrunHalts(input.primary, input.budgetId);
  await peerLock(input.primary, input.peer, input.budgetId);
  const postProofState = await readSnapshot(input.primary, input.budgetId);
  assert.deepEqual(postProofState, originalObservedState, "Rollback proof changed the durable ledger");
  return {
    version: LEDGER_PROOF_VERSION,
    budgetId: input.budgetId,
    observedAt,
    completedAt: clock().toISOString(),
    sourceHash: input.sourceHash,
    testCases: [...LEDGER_PROOF_TEST_CASES],
    originalObservedState,
    postProofState,
    snapshotDigest: jsonDigest(originalObservedState),
    rollbackVerified: true,
    inferenceCalls: 0,
    providerProofUsed: false,
  };
}

export function assertCertifiableLedgerProof(report: StateRelativeLedgerProofReport, input: {
  sourceHash: string;
  reportSha256: string;
  now?: Date;
  maximumAgeMs?: number;
}): void {
  const now = input.now ?? new Date();
  const maximumAgeMs = input.maximumAgeMs ?? 30 * 60 * 1_000;
  assert.equal(report.version, LEDGER_PROOF_VERSION);
  assert.match(report.budgetId, /^[0-9a-f-]{36}$/i);
  assert.deepEqual(report.testCases, [...LEDGER_PROOF_TEST_CASES]);
  assert.match(report.sourceHash, /^[a-f0-9]{64}$/);
  assert.equal(report.sourceHash, input.sourceHash);
  assert.match(input.reportSha256, /^[a-f0-9]{64}$/);
  assert.equal(report.rollbackVerified, true);
  assert.equal(report.inferenceCalls, 0);
  assert.equal(report.providerProofUsed, false);
  assert.deepEqual(report.postProofState, report.originalObservedState);
  assert.equal(report.snapshotDigest, jsonDigest(report.originalObservedState));
  assertPaused(report.originalObservedState);
  const duration = Date.parse(report.completedAt) - Date.parse(report.observedAt);
  assert.ok(Number.isFinite(duration) && duration >= 0, "Ledger proof timestamps are invalid");
  const age = now.getTime() - Date.parse(report.completedAt);
  assert.ok(Number.isFinite(age) && age >= 0 && age <= maximumAgeMs, "Ledger proof is stale");
}
