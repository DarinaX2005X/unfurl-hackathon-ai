import {describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {createAgentTurnHandler,type AgentJournal} from "../../src/server/agent-turns/handler";
import {captureContext,ContextSnapshotSchema,type ContextSnapshot} from "../../src/server/agent-turns/repository";
import {attachSearchMemory} from "../../src/server/agent-turns/search-memory";
import {OpenRouterModel} from "../../src/server/ai/openrouter";
import type {BudgetPort} from "../../src/server/budget/ports";
import type {StructuredRequest} from "../../src/server/ai/ports";
import type {RunContext,StepEffectContext} from "../../src/server/runs/ports";
import {currentReaderCapabilities,ReaderCapabilitiesSchema,sourceReadFailureObservation} from "../../src/server/research/reader-capabilities";
import {SourceDocumentSchema} from "../../src/server/research/ports";
import {executeAgentTool} from "../../src/server/agent-tools/executor";
import {jsonDigest} from "../../src/server/ai/json";
import type {DbTransaction} from "../../src/server/db";
import type {ModelPort} from "../../src/server/ai/ports";
import {legacyReaderCapabilities} from "./fixtures";

const id="00000000-0000-4000-8000-000000000001";
function snapshot(version:1|2|3):ContextSnapshot{
  const base={kind:"context",index:0,now:"2026-01-01T00:00:00.000Z",currentMessage:"Teach the full foundations and both applied branches.",recentMessages:[],artifacts:[],sources:[],recentTools:[],languageIntent:null};
  return ContextSnapshotSchema.parse(version===1?base:{...attachSearchMemory(base,[]),...(version===3?{agentProtocol:"conversational-v3"}:{})});
}
async function plannerRequest(capture:ContextSnapshot){
  let digest:string|undefined,request:StructuredRequest<unknown>|undefined;
  const stop=new Error("Captured request; no network or reservation");
  const recover=vi.fn(async(_context:unknown,requestDigest:string)=>{digest=requestDigest;throw stop;});
  const model=new OpenRouterModel({budget:{recover} as unknown as BudgetPort,apiKey:()=>undefined,
    gate:{snapshot:()=>{throw stop;},assertAvailable:async()=>{throw stop;}},rateCards:{current:async()=>{throw stop;}}});
  const generate=model.generateStructured.bind(model);
  model.generateStructured=async(input,signal)=>{request=input as StructuredRequest<unknown>;return generate(input,signal);};
  const target={kind:"agent_turn" as const,runId:id,ownerId:id,conversationId:id,branchId:id,inputMessageId:id};
  const effect={stepId:id,signal:new AbortController().signal,deadlineAt:Date.now()+60000,
    stepFence:{retryEpoch:0,jobId:id,jobLeaseOwner:id,jobFencingToken:"1",stepId:id,stepLeaseOwner:id,stepFencingToken:"1"},
    budgetOperation:()=>({reservationId:id,logicalOperationId:id,attempt:1,runStepId:id,probe:false})} as StepEffectContext;
  const context={claim:{jobId:id,retryEpoch:0,target},read:async(work:(tx:unknown)=>Promise<unknown>)=>work(null),
    step:async(spec:{effect:(effect:StepEffectContext,input:unknown)=>Promise<unknown>;input:unknown})=>spec.effect(effect,spec.input)} as unknown as RunContext;
  const journal={position:async()=>({index:0,stage:"decision"}),receipt:async()=>capture} as unknown as AgentJournal;
  await expect(createAgentTurnHandler({model,researchForStep:()=>{throw stop;}},{journal}).advance(context)).rejects.toBe(stop);
  expect(recover).toHaveBeenCalledTimes(1);
  return{digest,request:request!};
}
describe("captured reader capability policy",()=>{
  it("preserves the existing v1/v2/v3 wire requests byte for byte",async()=>{
    const hashes=[];
    for(const version of [1,2,3] as const)hashes.push((await plannerRequest(snapshot(version))).digest);
    expect(hashes).toMatchInlineSnapshot(`
      [
        "18c24c8c0e8b8e841aca9e673bbe20e8a4a8890bdc4110f562c2a2237631cb53",
        "393f7b8cf4ba5c2baa0fecc58a8f721f87cbd7d24972ea3fea2ea9fc5bfde885",
        "523f9a99ec4a8d293de68d57766ffa50462590e5b23de4d824cbe5bdb47fd38c",
      ]
    `);
  });
  it("adds the captured format policy only to new decisions without changing their output schema",async()=>{
    const original=snapshot(3),before=JSON.stringify(original),old=await plannerRequest(original);
    const next=ContextSnapshotSchema.parse({...original,readerCapabilities:legacyReaderCapabilities()});
    const fresh=await plannerRequest(next);
    expect(fresh.digest).not.toBe(old.digest);
    expect(old.request.instructionVersion).toBe("adaptive-course-agent-v3");
    expect(old.request.trustedInstructions).not.toContain("PDF");
    expect(fresh.request.instructionVersion).toBe("adaptive-course-agent-v3:text-sources-v1");
    expect(fresh.request.trustedInstructions).toContain("PDF documents cannot be read");
    expect(fresh.request.trustedInstructions).toContain("Preserve the full course goal and depth");
    expect(fresh.request.untrustedInput).toMatchObject({readerCapabilities:legacyReaderCapabilities()});
    expect(fresh.request.schema).toBe(old.request.schema);expect(fresh.request.maxOutputTokens).toBe(32768);
    expect(JSON.stringify(original)).toBe(before);expect(ContextSnapshotSchema.parse(original)).not.toHaveProperty("readerCapabilities");
  });
  it("writes current capabilities into an actually constructed new capture",async()=>{
    const tx={query:async(sql:string)=>({rows:sql.startsWith("SELECT parts FROM unfurl.messages")?[{parts:[{type:"text",text:"Teach the full foundations and both branches."}]}]:[],rowCount:0})} as DbTransaction;
    const fresh=await captureContext(tx,{kind:"agent_turn",runId:id,ownerId:id,conversationId:id,branchId:id,inputMessageId:id},id,1,"2026-01-01T00:00:00.000Z");
    expect(fresh.readerCapabilities).toEqual(currentReaderCapabilities());
    expect(fresh.agentProtocol).toBe("conversational-pdf-v4");expect(fresh.planningPolicy?.maxOutputTokens).toBe(32768);
    expect(fresh.currentMessage).toContain("both branches");
  });
  it("declares exactly the accepted source media types and rejects guessed PDF support or future versions",()=>{
    expect(currentReaderCapabilities().supportedMediaTypes).toEqual(SourceDocumentSchema.shape.mediaType.options);
    expect(ReaderCapabilitiesSchema.safeParse({...legacyReaderCapabilities(),pdf:true}).success).toBe(false);
    expect(ReaderCapabilitiesSchema.safeParse({...currentReaderCapabilities(),pdf:false}).success).toBe(false);
    expect(ReaderCapabilitiesSchema.safeParse({...currentReaderCapabilities(),version:"future"}).success).toBe(false);
  });
  it("returns useful unsupported-format guidance to the model without technical payloads in public events",async()=>{
    const captured=ContextSnapshotSchema.parse({...snapshot(3),readerCapabilities:legacyReaderCapabilities()});
    const tx={query:async()=>({rows:[],rowCount:0})} as unknown as DbTransaction;
    const target={kind:"agent_turn" as const,runId:id,ownerId:id,conversationId:id,branchId:id,inputMessageId:id};
    const publicEvents:unknown[]=[];
    const context={claim:{jobId:id,target},read:(work:(tx:DbTransaction,targetValue:typeof target)=>Promise<unknown>)=>work(tx,target),
      step:async(spec:{input:unknown;effect:(step:unknown,input:unknown)=>Promise<unknown>;commit:(tx:DbTransaction,output:unknown)=>Promise<unknown>})=>spec.commit(tx,await spec.effect({signal:new AbortController().signal},spec.input)),
      emitChat:async(_tx:unknown,event:unknown)=>{publicEvents.push(event);}} as unknown as RunContext;
    const failure={status:"unsupported" as const,requestedUrl:"https://example.org/book.pdf"};
    const read=vi.fn(async()=>failure);
    const observation=await executeAgentTool(context,{kind:"decision",index:0,invocationId:id,decision:{tool:"read_source",commentary:null,input:{kind:"url",url:failure.requestedUrl}},
      capturedDraft:null,capturedCourseRevision:null,preparationError:null},captured,{model:{} as ModelPort,researchForStep:()=>({read,search:async()=>{throw new Error("No search allowed");}})});
    expect(read).toHaveBeenCalledTimes(1);
    expect(observation).toMatchObject({ok:false,sourceIds:[],data:{status:"unsupported",requestedUrl:failure.requestedUrl,reason:"unsupported_format_encoding_or_text_extraction",readerCapabilities:legacyReaderCapabilities()}});
    expect(observation.summary).not.toContain("text/html");expect(JSON.stringify(publicEvents)).not.toContain("supportedMediaTypes");
    expect(JSON.stringify(publicEvents)).not.toContain("unsupported_format_encoding");
    const legacy=sourceReadFailureObservation(failure,undefined);
    expect(legacy).toEqual({summary:"This source could not be read (unsupported).",data:failure});
    expect(jsonDigest(sourceReadFailureObservation({status:"unavailable",requestedUrl:failure.requestedUrl},currentReaderCapabilities())))
      .toBe(jsonDigest(sourceReadFailureObservation({status:"unavailable",requestedUrl:failure.requestedUrl},undefined)));
  });
});
