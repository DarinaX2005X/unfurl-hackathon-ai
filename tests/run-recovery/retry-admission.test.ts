import {describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
const flow=vi.hoisted(()=>({events:[] as string[],outstanding:2,conflict:false}));
vi.mock("../../src/server/db",()=>({withSystemTransaction:async(_kind:unknown,work:(tx:unknown)=>Promise<unknown>)=>work({})}));
vi.mock("../../src/server/runs/receipt-resume",()=>({
  reconcileSavedSearchBeforeRetry:async()=>{flow.events.push("owned-receipt-proof");if(flow.conflict)throw new Error("receipt-conflict");flow.outstanding--;},
  resumeSavedAgentDecision:async()=>{throw new Error("No retry write permitted in admission test");},
}));
vi.mock("../../src/server/runs/composition",()=>({getRuntimeAdmission:()=>({assertAvailable:async()=>{
  flow.events.push("admission");if(flow.outstanding>=2)throw new Error("budget-concurrency");throw new Error("admission-reached-after-proof");
}})}));
import {retryRun} from "../../src/server/runs/retry";
const actor={id:"00000000-0000-4000-8000-000000000001",sessionId:"test",email:null};
describe("public retry admission order",()=>{
  it("can recover an existing charge when it occupies the last concurrency slot",async()=>{
    flow.events=[];flow.outstanding=2;flow.conflict=false;
    await expect(retryRun(actor,"run","agent_turn","key")).rejects.toThrow("admission-reached-after-proof");
    expect(flow.events).toEqual(["owned-receipt-proof","admission"]);expect(flow.outstanding).toBe(1);
  });
  it("never enters admission after a conflicting saved receipt",async()=>{
    flow.events=[];flow.outstanding=2;flow.conflict=true;
    await expect(retryRun(actor,"run","agent_turn","key")).rejects.toThrow("receipt-conflict");
    expect(flow.events).toEqual(["owned-receipt-proof"]);expect(flow.outstanding).toBe(2);
  });
  it("does not reconcile an unrelated generation retry",async()=>{
    flow.events=[];flow.outstanding=2;flow.conflict=false;
    await expect(retryRun(actor,"run","generation","key")).rejects.toThrow("budget-concurrency");
    expect(flow.events).toEqual(["admission"]);expect(flow.outstanding).toBe(2);
  });
});
