import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { PersistedCapabilityGate, type CapabilityTransaction } from "../../src/server/ai/capabilities";

function gate(rows: { capability: string; passed: boolean; fresh: boolean; evidence: Record<string, never> }[]) {
  const transaction: CapabilityTransaction = async (work) => work({ query: vi.fn(async () => ({
    rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [],
  })) } as never);
  const budget = { assertAvailable: vi.fn(async () => undefined) };
  return { gate: new PersistedCapabilityGate("local", budget as never, transaction), budget };
}
describe("persisted capability admission", () => {
  it("does not infer working capabilities from configuration or missing observations", async () => {
    const h = gate([]);
    expect(h.gate.snapshot()).toMatchObject({ structured: false, text: false, search: false, rubric: false });
    await expect(h.gate.assertAvailable("model_text", { probe: false })).rejects.toThrow("provider.unavailable");
    await expect(h.gate.assertAvailable("model_text", { probe: true })).rejects.toThrow("provider.unavailable");
  });
  it("requires actual accounting proof even for the bounded first provider probe", async () => {
    const h = gate([{ capability: "budget_accounting", passed: true, fresh: true, evidence: {} }]);
    await h.gate.assertAvailable("model_text", { probe: true });
    expect(h.budget.assertAvailable).toHaveBeenCalledWith({ probe: true });
    await expect(h.gate.assertAvailable("model_text", { probe: false })).rejects.toThrow("provider.unavailable");
  });
  it("rejects expired/failed latest evidence and missing dispatcher or recovery proof", async () => {
    const rows = [{ capability: "budget_accounting", passed: true, fresh: true, evidence: {} },
      { capability: "model_text", passed: false, fresh: true, evidence: {} }];
    await expect(gate(rows).gate.assertAvailable("model_text", { probe: false })).rejects.toThrow("provider.unavailable");
    rows[1] = { capability: "model_text", passed: true, fresh: false, evidence: {} };
    await expect(gate(rows).gate.assertAvailable("model_text", { probe: false })).rejects.toThrow("provider.unavailable");
    rows[1] = { capability: "model_text", passed: true, fresh: true, evidence: {} };
    await expect(gate(rows).gate.assertExecutionAvailable(["model_text"])).rejects.toThrow("provider.unavailable");
  });
});
