import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { JsonObject } from "../../src/domain/common";
import { PersistedCapabilityGate, type CapabilityTransaction } from "../../src/server/ai/capabilities";
import { CANDIDATE_MODEL_POLICY, type ModelPolicyId } from "../../src/server/ai/model-policy";
import { PROBE_LIMIT_MICRO_USD } from "../../src/server/budget/money";
import { PostgresBudget } from "../../src/server/budget/postgres";
import {
  assertCertifiableLedgerProof,
  LEDGER_PROOF_SOURCE_FILES,
  LEDGER_PROOF_VERSION,
  runStateRelativeLedgerProof,
  type LedgerProofClient,
  type StateRelativeLedgerProofReport,
} from "../../src/server/budget/ledger-proof";

const mode = process.env.BUDGET_LEDGER_OPERATOR_MODE;
const enabled = mode === "prove" || mode === "apply";
const reportPath = path.resolve(process.env.BUDGET_LEDGER_REPORT_PATH ?? ".cache/budget-ledger-state-relative-proof.json");

function databaseClient(label: string): Client {
  const projectRef = process.env.SUPABASE_PROJECT_REF;
  const url = new URL(process.env.DIRECT_DATABASE_URL ?? "");
  const username = decodeURIComponent(url.username);
  if (!projectRef || !["postgres:", "postgresql:"].includes(url.protocol) ||
      (!username.endsWith(`.${projectRef}`) && url.hostname !== `db.${projectRef}.supabase.co`) || url.port === "6543") {
    throw new Error("Invalid direct ledger proof database target");
  }
  for (const name of ["sslmode", "sslrootcert", "sslcert", "sslkey"]) url.searchParams.delete(name);
  const ca = process.env.DATABASE_SSL_CA?.replace(/\\n/g, "\n");
  return new Client({
    connectionString: url.toString(),
    ssl: { rejectUnauthorized: true, ...(ca ? { ca } : {}) },
    connectionTimeoutMillis: 5_000,
    application_name: `unfurl-ledger-proof-${label}`,
  });
}

function proofClient(client: Client): LedgerProofClient {
  return { query: (text, values) => client.query(text, values) } as LedgerProofClient;
}

async function sourceHash(root: string): Promise<string> {
  const digest = createHash("sha256");
  for (const file of LEDGER_PROOF_SOURCE_FILES) {
    digest.update(file);
    digest.update("\0");
    digest.update(await readFile(path.join(root, file)));
    digest.update("\0");
  }
  return digest.digest("hex");
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function durableTransaction(client: LedgerProofClient): CapabilityTransaction {
  return async <T>(work: Parameters<CapabilityTransaction>[0]): Promise<T> => {
    let begun = false;
    try {
      begun = true;
      await client.query("BEGIN; SET LOCAL ROLE service_role; SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='5s'");
      const value = await work(client) as T;
      await client.query("COMMIT");
      begun = false;
      return value;
    } catch (error) {
      if (begun) await client.query("ROLLBACK");
      throw error;
    }
  };
}

async function applyCertification(
  client: LedgerProofClient,
  report: StateRelativeLedgerProofReport,
  reportSha256: string,
  approvedReportSha256: string,
): Promise<void> {
  const policies: readonly ModelPolicyId[] = ["kimi-digitalocean-v1", CANDIDATE_MODEL_POLICY];
  for (const policy of policies) {
    const gate = new PersistedCapabilityGate(
      "vercel",
      new PostgresBudget(report.budgetId),
      durableTransaction(client),
      policy,
    );
    await gate.observe({
      capability: "budget_accounting",
      passed: true,
      testVersion: LEDGER_PROOF_VERSION,
      ttlSeconds: 86_400,
      instanceId: `${LEDGER_PROOF_VERSION}:${policy}`,
      evidence: {
        protocolVersion: LEDGER_PROOF_VERSION,
        modelPolicy: policy,
        configurationDigest: gate.configurationDigest,
        proofObservedAt: report.observedAt,
        proofCompletedAt: report.completedAt,
        certifiedAt: new Date().toISOString(),
        sourceHash: report.sourceHash,
        proofReportSha256: reportSha256,
        approvedReportSha256,
        snapshotDigest: report.snapshotDigest,
        testCases: report.testCases,
        originalObservedState: report.originalObservedState as unknown as JsonObject,
        isolatedCaseRollbacksVerified: true,
        caseRollbacks: report.caseRollbacks as unknown as JsonObject[],
        rollbackVerified: true,
        inferenceCalls: 0,
        providerProofUsed: false,
        financialForgiveness: false,
        historicalFinancialHoldsPreserved: report.originalObservedState.held.total,
        currentProbeCeilingMicroUsd: PROBE_LIMIT_MICRO_USD.toString(),
      },
    });
  }
}

describe.skipIf(!enabled)("budget ledger state-relative operator", () => {
  it("proves with rollback or explicitly certifies the approved report", { timeout: 120_000 }, async () => {
    assert.ok(mode === "prove" || mode === "apply");
    const budgetId = process.env.AI_BUDGET_ID ?? "";
    const currentSourceHash = await sourceHash(process.cwd());
    const primaryConnection = databaseClient("primary");
    const peerConnection = databaseClient("peer");
    await primaryConnection.connect();
    await peerConnection.connect();
    const primary = proofClient(primaryConnection);
    const peer = proofClient(peerConnection);
    try {
      if (mode === "prove") {
        const report = await runStateRelativeLedgerProof({ budgetId, primary, peer, sourceHash: currentSourceHash });
        assert.equal(await sourceHash(process.cwd()), currentSourceHash, "Proof source changed while the proof ran");
        const serialized = `${JSON.stringify(report, null, 2)}\n`;
        await mkdir(path.dirname(reportPath), { recursive: true });
        await writeFile(reportPath, serialized, { encoding: "utf8", flag: "w" });
        const reportSha256 = sha256(Buffer.from(serialized));
        console.info(JSON.stringify({ reportPath, reportSha256, sourceHash: currentSourceHash }));
        expect(report.rollbackVerified).toBe(true);
        return;
      }

      const savedBytes = await readFile(reportPath);
      const reportSha256 = sha256(savedBytes);
      assert.equal(process.env.BUDGET_LEDGER_APPROVED_SHA256, reportSha256, "The reviewed proof report hash was not explicitly approved");
      const saved = JSON.parse(savedBytes.toString("utf8")) as StateRelativeLedgerProofReport;
      assertCertifiableLedgerProof(saved, { sourceHash: currentSourceHash, reportSha256 });

      const fresh = await runStateRelativeLedgerProof({ budgetId, primary, peer, sourceHash: currentSourceHash });
      assert.equal(await sourceHash(process.cwd()), currentSourceHash, "Proof source changed while the proof ran");
      // Live accounting may progress between reviewed proof and apply. Certify only a fresh run
      // of that exact source-bound protocol, preserving the reviewed report's hash in the receipt.
      const freshBytes = Buffer.from(`${JSON.stringify(fresh, null, 2)}\n`);
      const freshReportSha256 = sha256(freshBytes);
      assertCertifiableLedgerProof(fresh, { sourceHash: currentSourceHash, reportSha256: freshReportSha256 });
      const freshReportPath = `${reportPath}.fresh.json`;
      await writeFile(freshReportPath, freshBytes);
      await applyCertification(primary, fresh, freshReportSha256, reportSha256);
      console.info(JSON.stringify({ certified: true, world: "vercel", policies: ["kimi-digitalocean-v1", CANDIDATE_MODEL_POLICY],
        reportSha256: freshReportSha256, approvedReportSha256: reportSha256, freshReportPath }));
    } finally {
      await Promise.allSettled([primaryConnection.end(), peerConnection.end()]);
    }
  });
});
