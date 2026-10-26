import {randomUUID} from "node:crypto";
import {describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {readAgentDecisionModelRetryPolicy,readAgentDecisionRetryPolicy,saveAgentDecisionRetryPolicy,type AgentDecisionRetryBinding} from "../../src/server/runs/decision-policy";
import {jsonDigest} from "../../src/server/ai/json";

const binding=():AgentDecisionRetryBinding=>({jobId:randomUUID(),runId:randomUUID(),decisionStepId:randomUUID(),retryEpoch:2,
  inputDigest:"a".repeat(64),schemaDigest:"b".repeat(64)});
async function harness(){
  const input=binding();
  let row:Record<string,unknown>={};
  let modelRow:Record<string,unknown>={};
  const query=vi.fn(async(sql:string,values:unknown[]=[])=>{
    if(sql.startsWith("INSERT")){
      const inserted={id:values[0],input_digest:values[3],schema_digest:values[4],capability_digest:values[4],validation_policy_digest:values[4],
        status:"succeeded",result_reference:JSON.parse(String(values[5])),semantic_target:{kind:"agent_turn",runId:input.runId}};
      if(String(values[2]).startsWith("agent-retry-policy.v1"))row=inserted;else modelRow=inserted;
      return{rows:[],rowCount:1};
    }
    if(String(values[1]).startsWith("agent-retry-model.v2"))return{rows:[modelRow]};
    expect(values).toEqual([input.jobId,`agent-retry-policy.v1:${input.decisionStepId}:${input.retryEpoch}`,input.retryEpoch]);
    return{rows:[row]};
  });
  const tx={query} as never;await saveAgentDecisionRetryPolicy(tx,input,"kimi-digitalocean-v1");
  return{input,tx,query,row,modelRow};
}
describe("durable decision retry allocation",()=>{
  it("reuses the bound 32k policy after restart without changing the original capture",async()=>{
    const h=await harness(),before=jsonDigest(h.input);
    expect(await readAgentDecisionRetryPolicy(h.tx,h.input)).toBe(32768);
    expect(await readAgentDecisionRetryPolicy(h.tx,h.input)).toBe(32768);
    expect(jsonDigest(h.input)).toBe(before);
    expect(h.query.mock.calls.filter(([sql])=>sql.startsWith("INSERT"))).toHaveLength(2);
  });
  it("records a Kimi retry override and reader policy even if the original capture selected Gemini",async()=>{
    const h=await harness();
    expect(await readAgentDecisionModelRetryPolicy(h.tx,h.input)).toMatchObject({modelPolicy:"kimi-digitalocean-v1",readerCapabilities:{version:"text-sources-v1"}});
  });
  it("rejects a journal policy that differs from its immutable ambiguous-attempt authorization",async()=>{
    const h=await harness();h.modelRow.authorized_model_policy="gemini-flash-google-v1";
    h.modelRow.reader_policy_digest=jsonDigest((h.modelRow.result_reference as Record<string,unknown>).readerCapabilities);
    await expect(readAgentDecisionModelRetryPolicy(h.tx,h.input)).rejects.toThrow();
  });
  it("leaves old epochs without a policy on their historical request bytes",async()=>{
    const query=vi.fn(async()=>({rows:[]})),tx={query} as never,input=binding();
    expect(await readAgentDecisionRetryPolicy(tx,{...input,retryEpoch:0})).toBeNull();expect(query).not.toHaveBeenCalled();
    expect(await readAgentDecisionRetryPolicy(tx,{...input,retryEpoch:1})).toBeNull();
  });
  it.each(["missing audit","wrong run","wrong step","wrong epoch","wrong input","wrong schema","unknown policy","missing bound","wrong state"])("rejects %s",async(reason)=>{
    const h=await harness(),receipt=h.row.result_reference as Record<string,unknown>;
    if(reason==="missing audit")h.row.semantic_target=null;
    if(reason==="wrong run")h.row.semantic_target={kind:"agent_turn",runId:randomUUID()};
    if(reason==="wrong step")receipt.decisionStepId=randomUUID();
    if(reason==="wrong epoch")receipt.retryEpoch=3;
    if(reason==="wrong input")receipt.inputDigest="c".repeat(64);
    if(reason==="wrong schema")receipt.schemaDigest="c".repeat(64);
    if(reason==="unknown policy")receipt.version="future-policy";
    if(reason==="missing bound")delete receipt.maxOutputTokens;
    if(reason==="wrong state")h.row.status="pending";
    await expect(readAgentDecisionRetryPolicy(h.tx,h.input)).rejects.toThrow();
  });
});
