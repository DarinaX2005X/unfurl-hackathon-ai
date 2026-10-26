import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  assertCertifiableLedgerProof,
  LEDGER_PROOF_TEST_CASES,
  LEDGER_PROOF_VERSION,
  type LedgerProofSnapshot,
  type StateRelativeLedgerProofReport,
} from "../../src/server/budget/ledger-proof";
import { jsonDigest } from "../../src/server/ai/json";

const snapshot: LedgerProofSnapshot = {
  campaign: {
    settledMicroUsd: "1225946",
    reservedMicroUsd: "1802244",
    halted: false,
    revision: "19",
    updatedAt: "2026-10-26T06:00:00.000Z",
  },
  rows: { operations: 8, responses: 2, entries: 14 },
  held: { total: 6, terminalHttp400: 4, effectivelyRetired: 2, active: 0 },
  paused: {
    runningJobs: 0,
    runningSteps: 0,
    activeJobLeases: 0,
    activeStepLeases: 0,
    pendingOutbox: 0,
    activeCodeExecutions: 0,
  },
  probe: { settledMicroUsd: "225946", reservedMicroUsd: "802244" },
};

function report(): StateRelativeLedgerProofReport {
  const state = structuredClone(snapshot);
  return {
    version: LEDGER_PROOF_VERSION,
    budgetId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    observedAt: "2026-10-26T06:29:00.000Z",
    completedAt: "2026-10-26T06:30:00.000Z",
    sourceHash: "a".repeat(64),
    testCases: [...LEDGER_PROOF_TEST_CASES],
    originalObservedState: state,
    postProofState: structuredClone(state),
    snapshotDigest: jsonDigest(state),
    rollbackVerified: true,
    inferenceCalls: 0,
    providerProofUsed: false,
  };
}

describe("state-relative ledger proof certification", () => {
  it("accepts a fresh rollback proof bound to its source", () => {
    expect(() => assertCertifiableLedgerProof(report(), {
      sourceHash: "a".repeat(64),
      reportSha256: "b".repeat(64),
      now: new Date("2026-10-26T06:31:00.000Z"),
    })).not.toThrow();
  });

  it("rejects stale, source-changed, or state-changing proof reports", () => {
    expect(() => assertCertifiableLedgerProof(report(), {
      sourceHash: "c".repeat(64),
      reportSha256: "b".repeat(64),
      now: new Date("2026-10-26T06:31:00.000Z"),
    })).toThrow();
    expect(() => assertCertifiableLedgerProof(report(), {
      sourceHash: "a".repeat(64),
      reportSha256: "b".repeat(64),
      now: new Date("2026-10-26T07:01:00.001Z"),
    })).toThrow("Ledger proof is stale");

    const changed = report();
    changed.postProofState.campaign.revision = "20";
    expect(() => assertCertifiableLedgerProof(changed, {
      sourceHash: "a".repeat(64),
      reportSha256: "b".repeat(64),
      now: new Date("2026-10-26T06:31:00.000Z"),
    })).toThrow();
  });

  it("rejects a proof while any paid effect is active", () => {
    const active = report();
    active.originalObservedState.held.active = 1;
    active.postProofState.held.active = 1;
    active.snapshotDigest = jsonDigest(active.originalObservedState);
    expect(() => assertCertifiableLedgerProof(active, {
      sourceHash: "a".repeat(64),
      reportSha256: "b".repeat(64),
      now: new Date("2026-10-26T06:31:00.000Z"),
    })).toThrow("An unretired paid operation is still active");
  });
});
