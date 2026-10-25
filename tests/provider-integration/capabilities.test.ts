import { afterEach,describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { PersistedCapabilityGate, type CapabilityTransaction } from "../../src/server/ai/capabilities";
import {jsonDigest} from "../../src/server/ai/json";

function gate(rows: { capability: string; passed: boolean; fresh: boolean; evidence: Record<string, unknown>;invalidated?:boolean }[]) {
  const transaction: CapabilityTransaction = async (work) => work({ query: vi.fn(async () => ({
    rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [],
  })) } as never);
  const budget = { assertAvailable: vi.fn(async () => undefined) };
  return { gate: new PersistedCapabilityGate("local", budget as never, transaction), budget };
}
afterEach(()=>vi.unstubAllEnvs());
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
  it("keeps an old verified compatibility proof while still requiring current launch and budget",async()=>{
    vi.stubEnv("OPENROUTER_API_KEY","unit-test-key");
    const compatibility={version:"historical-compatibility-v1",proofReceiptId:"00000000-0000-4000-8000-000000000001",
      proofObservedAt:"2026-10-01T00:00:00.000Z",checkedAt:"2026-10-25T00:00:00.000Z",credentialDigest:jsonDigest({credential:"unit-test-key"}),
      endpointName:"DigitalOcean | moonshotai/kimi-k2.6-20260420",baseUrl:"https://openrouter.ai/api/v1"};
    const rows=[{capability:"budget_accounting",passed:true,fresh:false,evidence:{compatibility:{...compatibility,credentialDigest:null,endpointName:null}}},
      {capability:"model_structured",passed:true,fresh:false,evidence:{compatibility}}];
    const h=gate(rows);await expect(h.gate.assertAvailable("model_structured",{probe:false})).resolves.toBeUndefined();
    expect(h.budget.assertAvailable).toHaveBeenCalledWith({probe:false});
    await expect(h.gate.assertExecutionAvailable(["model_structured"])).rejects.toThrow("provider.unavailable");
    await expect(h.gate.assertEndpointCompatible("DigitalOcean | moonshotai/kimi-k2.6-20260421")).rejects.toThrow("provider.unavailable");
    vi.stubEnv("OPENROUTER_API_KEY","rotated-key");
    await expect(h.gate.assertAvailable("model_structured",{probe:false})).rejects.toThrow("provider.unavailable");
  });
  it("invalidates a certified proof after an actual provider contract failure",async()=>{
    vi.stubEnv("OPENROUTER_API_KEY","unit-test-key");
    const rows=[{capability:"budget_accounting",passed:true,fresh:true,evidence:{}},
      {capability:"model_structured",passed:true,fresh:true,evidence:{},invalidated:true}];
    await expect(gate(rows).gate.assertAvailable("model_structured",{probe:false})).rejects.toThrow("provider.unavailable");
  });
  it("preserves the original proof timestamp when appending unpaid validation and never upgrades a later failure",async()=>{
    const source={id:"00000000-0000-4000-8000-000000000001",observed_at:new Date("2026-10-01T00:00:00Z"),capability:"run_recovery",passed:true,fresh:false,evidence:{workflowRunId:"actual-proof"}};
    let latestId=source.id;
    const query=vi.fn(async(sql:string)=>({rows:sql.includes("SELECT id FROM")?[{id:latestId}]:sql.includes("DISTINCT ON")?[source]:[],rowCount:1}));
    const transaction:CapabilityTransaction=async work=>work({query} as never);
    const instance=new PersistedCapabilityGate("vercel",{} as never,transaction);
    const verify=vi.fn(async()=>({endpointName:null}));await instance.certifyHistoricalProofs(verify);
    const inserted=query.mock.calls.find(([sql])=>sql.includes("INSERT INTO"));expect(inserted).toBeDefined();
    const evidence=JSON.parse((inserted as unknown as [string,unknown[]])[1][7] as string);
    expect(evidence.compatibility).toMatchObject({proofReceiptId:source.id,proofObservedAt:"2026-10-01T00:00:00.000Z"});
    query.mockClear();latestId="00000000-0000-4000-8000-000000000002";await instance.certifyHistoricalProofs(verify);
    expect(query.mock.calls.some(([sql])=>sql.includes("INSERT INTO"))).toBe(false);
  });
});
