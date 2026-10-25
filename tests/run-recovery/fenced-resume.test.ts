import {randomUUID} from "node:crypto";
import {describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {resumeSavedAgentDecision} from "../../src/server/runs/receipt-resume";
import {agentOperationId,stableExecutionId} from "../../src/server/runs/identity";
import {jsonDigest} from "../../src/server/ai/json";
import type {GenerationRow} from "../../src/server/curricula/repository";

function fixture(content:string,options:{v2?:boolean;schemaDigest?:string}={}){
  const actor={id:randomUUID(),sessionId:randomUUID(),email:null},jobId=randomUUID(),stepId=randomUUID();
  const run={id:randomUUID(),status:"failed",error:{messageKey:"generation.invalidResponse"},conversation_id:randomUUID(),branch_id:randomUUID(),input_message_id:randomUUID()} as GenerationRow;
  const capture={kind:"context",...(options.v2?{searchMemory:[]}:{})};
  const logical=agentOperationId(stepId,"agent_decision",1),digest="a".repeat(64);
  const result={model:"moonshotai/kimi-k2.6",provider:"DigitalOcean",finishReason:"stop",failure:null,content,rateCardDigest:digest};
  const query=vi.fn(async(sql:string,parameters:unknown[]=[])=>{
    if(sql.startsWith("SELECT id,status,retry_epoch"))return{rows:[{id:jobId,status:"failed",retry_epoch:1}]};
    if(sql.includes("o.state IN")||sql.includes("FROM unfurl.code_execution_runs"))return{rows:[]};
    if(sql.includes("status<>'succeeded'"))return{rows:[{id:stepId,step_key:"agent.v1:000011:decision",input_digest:jsonDigest(capture),schema_digest:options.schemaDigest??jsonDigest({version:options.v2?"agent-decision-v2":"agent-decision-v1"}),status:"failed"}]};
    if(sql.includes("SELECT result_reference"))return{rows:[{result_reference:capture}]};
    if(sql.includes("SELECT o.id,o.logical_operation_id")){expect(parameters).toEqual([stepId,logical]);return{rows:[{id:stableExecutionId(logical,"attempt:1"),logical_operation_id:logical,attempt:1,state:"settled",purpose:"turn_planning",provider_request_id:"gen-saved",response_provider_id:"gen-saved",request_digest:digest,rate_card_digest:digest,result}]};}
    if(sql.includes("advance_execution_job_retry"))return{rows:[{epoch:2}]};
    if(sql.includes("RETURNING last_seq"))return{rows:[{last_seq:29,updated_at:new Date()}]};
    return{rows:[],rowCount:1};
  });
  return{actor,run,query,result,stepId};
}
const valid={tool:"read_source",input:{kind:"blocks",sourceId:"00000000-0000-4000-8000-000000000001",blockIds:[]}};
const fence=(value:unknown)=>` \n\x60\x60\x60json\n${JSON.stringify(value)}\n\x60\x60\x60\n`;
describe("known paid fence-only decision recovery",()=>{
  it("reuses epoch1 and the exact saved response after full original-schema validation",async()=>{
    const content=fence(valid),h=fixture(content),before=JSON.stringify(h.result);
    expect(await resumeSavedAgentDecision({query:h.query} as never,h.actor,h.run)).toBe(true);
    expect(h.query.mock.calls.some(([sql])=>sql.includes("advance_execution_job_retry"))).toBe(false);
    expect(h.query.mock.calls.find(([sql])=>sql.startsWith("UPDATE unfurl.run_steps"))?.[1]).toEqual([h.stepId]);
    expect(JSON.stringify(h.result)).toBe(before);
  });
  it.each([
    ["wrong decision schema",fence({...valid,forbidden:true}),{}],
    ["forbidden tool",fence({tool:"publish",input:{}}),{}],
    ["leading prose",`Explanation\n${fence(valid)}`,{}],
    ["multiple fences",`${fence(valid)}${fence(valid)}`,{}],
    ["malformed JSON","```json\n{\n```",{}],
    ["changed saved schema",fence(valid),{schemaDigest:"b".repeat(64)}],
    ["new tool under legacy capture",fence({tool:"read_source",input:{kind:"search_result",searchId:valid.input.sourceId,offset:0,limit:1}}),{}],
  ] as const)("keeps %s on the explicit paid retry path",async(_name,content,options)=>{
    const h=fixture(content,options);await resumeSavedAgentDecision({query:h.query} as never,h.actor,h.run);
    const advanced=h.query.mock.calls.filter(([sql])=>sql.includes("advance_execution_job_retry"));expect(advanced).toHaveLength(1);
    expect(advanced[0]![1]![3]).toBe(1);
  });
  it("uses the v2 schema only for a capture that actually exposed search memory",async()=>{
    const h=fixture(fence({tool:"read_source",input:{kind:"search_result",searchId:valid.input.sourceId,offset:0,limit:1}}),{v2:true});
    await resumeSavedAgentDecision({query:h.query} as never,h.actor,h.run);
    expect(h.query.mock.calls.some(([sql])=>sql.includes("advance_execution_job_retry"))).toBe(false);
  });
});
