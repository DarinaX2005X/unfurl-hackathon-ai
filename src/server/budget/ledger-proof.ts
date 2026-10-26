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

export const LEDGER_PROOF_VERSION = "state-relative-ledger-proof-v2" as const;
export const LEDGER_PROOF_TEST_CASES = [
  "reserve_replay_dispatch_settle",
  "hundred_unknown_holds_allow_admission",
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
  caseRollbacks: LedgerCaseRollback[];
  inferenceCalls: 0;
  providerProofUsed: false;
}

export type LedgerFinancialSnapshot = LedgerProofSnapshot;
export interface LedgerCaseRollback {
  name: (typeof LEDGER_PROOF_TEST_CASES)[number];
  baseline: LedgerFinancialSnapshot;
  afterRollback: LedgerFinancialSnapshot;
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
  const probe = (await client.query<{ settled: string; reserved: string }>(`SELECT
    coalesce(sum(actual_micro_usd) FILTER(WHERE purpose='capability_probe' AND state='settled'),0)::text AS settled,
    coalesce(sum(reserved_micro_usd) FILTER(WHERE purpose='capability_probe' AND state IN (${heldStates})),0)::text AS reserved
    FROM unfurl.ai_provider_operations WHERE budget_id=$1`, [budgetId])).rows[0];
  if (!rows || !held || !probe) throw new Error("Ledger snapshot is incomplete");
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
    probe: { settledMicroUsd: probe.settled, reservedMicroUsd: probe.reserved },
  };
}

async function begin(client: LedgerProofClient, lockTimeout = "150ms"): Promise<void> {
  await client.query(`BEGIN; SET LOCAL ROLE service_role; SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='${lockTimeout}'`);
}

async function rollback(client: LedgerProofClient): Promise<void> {
  await client.query("ROLLBACK");
}

function financial(snapshot: LedgerProofSnapshot): LedgerFinancialSnapshot {
  return { campaign: snapshot.campaign, rows: snapshot.rows, held: snapshot.held, probe: snapshot.probe };
}

/** Each short proof owns only the campaign accounting lock. Other users' jobs need not pause.
 * Roll back its fixtures before comparing under that same lock; normal work may change between cases. */
async function isolatedCase(client: LedgerProofClient, budgetId: string, name: LedgerCaseRollback["name"], work: () => Promise<void>): Promise<LedgerCaseRollback> {
  await begin(client);
  try {
    const locked = await client.query("SELECT id FROM unfurl.ai_budgets WHERE id=$1 FOR UPDATE", [budgetId]);
    assert.equal(locked.rows.length, 1, "Fixed budget campaign is unavailable");
    const baseline = financial(await readSnapshot(client, budgetId));
    assert.equal(baseline.campaign.halted, false, "The campaign is halted");
    await client.query("SAVEPOINT ledger_case");
    await work();
    await client.query("ROLLBACK TO SAVEPOINT ledger_case");
    const afterRollback = financial(await readSnapshot(client, budgetId));
    assert.deepEqual(afterRollback, baseline, "Rollback case changed the durable financial ledger");
    return { name, baseline, afterRollback };
  } finally { await rollback(client); }
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
}

async function manyUnknownHolds(client: LedgerProofClient, budgetId: string): Promise<void> {
    const ledger = new PostgresBudget(budgetId, savepointRunner(client));
    const before = await campaign(client, budgetId);
    const fixture = request(1_000n);
    // Seed only new rollback fixtures in one statement, avoiding 100 network round-trip sequences
    // while live accounts use the same campaign. Actual admission/reservation still use PostgresBudget.
    await client.query(`WITH inserted AS (
      INSERT INTO unfurl.ai_provider_operations(id,budget_id,logical_operation_id,attempt,request_digest,purpose,state,
        reserved_micro_usd,model_id,provider_tag,rate_card_digest,rate_card,dispatched_at,safe_failure_code)
      SELECT gen_random_uuid(),$1,gen_random_uuid(),1,$2,'curriculum','unknown',1000,$3,$4,$5,$6,now(),'timeout'
      FROM generate_series(1,100) RETURNING id
    ), entries AS (
      INSERT INTO unfurl.ai_budget_entries(id,budget_id,operation_id,effect_key,kind,reserved_delta_micro_usd,settled_delta_micro_usd,evidence_digest)
      SELECT gen_random_uuid(),$1,id,id::text||':reserve','reserve',1000,0,$2 FROM inserted RETURNING id
    ) UPDATE unfurl.ai_budgets SET reserved_micro_usd=reserved_micro_usd+100000,revision=revision+100,updated_at=now()
      WHERE id=$1 AND (SELECT count(*) FROM entries)=100`,
    [budgetId,fixture.requestDigest,fixture.rateCard.model,fixture.rateCard.provider,fixture.rateCardDigest,JSON.stringify(fixture.rateCard)]);
    const held = (await client.query<{ count: number }>("SELECT count(*)::int AS count FROM unfurl.ai_provider_operations WHERE budget_id=$1 AND state='unknown'", [budgetId])).rows[0]!;
    assert.ok(held.count >= 100);
    await ledger.assertAvailable({ probe: false });
    const admitted = await ledger.reserve(request(1n));
    assert.equal(admitted.state, "reserved");
    const after = await campaign(client, budgetId);
    assert.equal(after.settled, before.settled);
    assert.equal(after.reserved, before.reserved + 100_001n);
    await assert.rejects(ledger.reserve(request(SPENDABLE_LIMIT_MICRO_USD - after.settled - after.reserved + 1n)), /provider\.budget_exhausted/);
}

async function dynamicCeilings(client: LedgerProofClient, budgetId: string): Promise<void> {
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
}

async function overrunHalts(client: LedgerProofClient, budgetId: string): Promise<void> {
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
}

async function peerLock(client: LedgerProofClient, peer: LedgerProofClient, budgetId: string): Promise<void> {
  let peerBegun = false;
  try {
    const primary = new PostgresBudget(budgetId, savepointRunner(client));
    await primary.reserve(request(1_000n));
    await begin(peer, "150ms"); peerBegun = true;
    const competing = new PostgresBudget(budgetId, savepointRunner(peer));
    await assert.rejects(competing.reserve(request(1_000n)), (error: unknown) =>
      typeof error === "object" && error !== null && "code" in error && error.code === "55P03");
  } finally {
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
  const work = [
    () => reserveReplaySettle(input.primary, input.budgetId),
    () => manyUnknownHolds(input.primary, input.budgetId),
    () => dynamicCeilings(input.primary, input.budgetId),
    () => overrunHalts(input.primary, input.budgetId),
    () => peerLock(input.primary, input.peer, input.budgetId),
  ];
  const caseRollbacks: LedgerCaseRollback[] = [];
  for (const [index, name] of LEDGER_PROOF_TEST_CASES.entries()) {
    caseRollbacks.push(await isolatedCase(input.primary, input.budgetId, name, work[index]!));
  }
  const postProofState = await readSnapshot(input.primary, input.budgetId);
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
    caseRollbacks,
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
  assert.equal(report.snapshotDigest, jsonDigest(report.originalObservedState));
  assert.deepEqual(report.caseRollbacks.map(proof => proof.name), [...LEDGER_PROOF_TEST_CASES]);
  for (const proof of report.caseRollbacks) {
    assert.equal(proof.baseline.campaign.halted, false);
    assert.deepEqual(proof.afterRollback, proof.baseline, "A proof case changed its financial baseline");
  }
  const duration = Date.parse(report.completedAt) - Date.parse(report.observedAt);
  assert.ok(Number.isFinite(duration) && duration >= 0, "Ledger proof timestamps are invalid");
  const age = now.getTime() - Date.parse(report.completedAt);
  assert.ok(Number.isFinite(age) && age >= 0 && age <= maximumAgeMs, "Ledger proof is stale");
}
