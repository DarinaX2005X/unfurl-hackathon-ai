import {afterEach,describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {z} from "zod";
import {createCourseGenerationHandler} from "@/server/course-generation/handler";
import {GenerationEvidenceRepository} from "@/server/course-generation/repository";
import {COURSE_GENERATION_POLICY_KEY,COURSE_GENERATION_SCHEMA_DIGEST,COURSE_VALIDATION_POLICY_DIGEST,CourseGenerationPolicyCheckpointSchema} from "@/server/course-generation/checkpoints";
import {getCapabilityCatalogDigest} from "@/server/mechanics/catalog";
import {withCapturedModelPolicy} from "@/server/ai/captured-policy";
import {CANDIDATE_MODEL_POLICY,GEMINI_SCHEMA_V2_POLICY,modelPolicy} from "@/server/ai/model-policy";
import {jsonDigest} from "@/server/ai/json";
import type {ApprovedBuildBinding} from "@/server/curricula/build-binding";
import type {RunContext} from "@/server/runs/ports";
import type {ModelPort,StructuredRequest} from "@/server/ai/ports";
import {fixture,id,digest} from "./fixtures";

afterEach(()=>vi.restoreAllMocks());
function harness(started:boolean){
  const data=fixture(),binding={run:{id:id(930)},course:{id:data.draft.courseId,ownerId:data.context.ownerId},approval:{id:id(931),draftRevision:1,contentDigest:digest},draft:data.draft} as ApprovedBuildBinding;
  const old={kind:"course.generation.policy",version:"course-generation-batch-v2",batchSize:5,maxOutputTokens:16384,approvalDigest:digest,modelPolicy:GEMINI_SCHEMA_V2_POLICY};
  const saved={key:COURSE_GENERATION_POLICY_KEY,status:"succeeded",result:old,schema:COURSE_GENERATION_SCHEMA_DIGEST,validationPolicy:COURSE_VALIDATION_POLICY_DIGEST,capability:getCapabilityCatalogDigest(),approval:digest};
  const writes:unknown[]=[];let selections=0;
  const query=vi.fn(async(sql:string)=>{
    if(sql.includes("jsonb_agg"))return {rows:[{id:binding.run.id,retry_of_run_id:id(929),depth:0,steps:started?[saved]:[]},{id:id(929),retry_of_run_id:null,depth:1,steps:[saved]}]};
    if(sql.startsWith("SELECT id,step_key"))return {rows:started?[{id:id(932),step_key:COURSE_GENERATION_POLICY_KEY}]:[]};
    if(sql.includes("SELECT step.id"))return {rows:[{id:id(932),input_digest:jsonDigest({approvalDigest:digest}),result_reference:old,schema_digest:COURSE_GENERATION_SCHEMA_DIGEST,validation_policy_digest:COURSE_VALIDATION_POLICY_DIGEST,capability_digest:getCapabilityCatalogDigest(),approval_digest:digest}]};
    if(sql.startsWith("SELECT proof.id")){selections++;return {rows:[{id:id(933)}]};}
    throw new Error("Unexpected capture query");
  });
  const tx={query};
  vi.spyOn(GenerationEvidenceRepository.prototype,"loadBinding").mockResolvedValue(binding);
  const model={generateStructured:vi.fn(),streamText:vi.fn(),capabilities:vi.fn()} as unknown as ModelPort;
  const runtime=vi.fn(async()=>{throw new Error("stop-after-policy-binding");});
  const handler=createCourseGenerationHandler({model,research:vi.fn(),runtime});
  const context={claim:{jobId:id(934),target:{kind:"generation",runId:binding.run.id,ownerId:data.context.ownerId}},
    read:async(reader:(transaction:unknown)=>Promise<unknown>)=>reader(tx),
    step:async(spec:{commit:(transaction:unknown,output:null)=>Promise<unknown>})=>{const value=await spec.commit(tx,null);writes.push(CourseGenerationPolicyCheckpointSchema.parse(value));},
  } as unknown as RunContext;
  return {handler,context,old,writes,selections:()=>selections,runtime};
}

describe("generation model capture and fresh retries",()=>{
  it("captures certified v3 for a fresh run after a failed v2 ancestor without rewriting its capture",async()=>{
    const h=harness(false),before=structuredClone(h.old);
    await expect(h.handler.advance(h.context)).resolves.toEqual({status:"continue"});
    expect(h.writes).toHaveLength(1);expect(h.writes[0]).toMatchObject({modelPolicy:CANDIDATE_MODEL_POLICY});expect(h.old).toEqual(before);
    expect(h.selections()).toBe(1);expect(h.runtime).not.toHaveBeenCalled();
  });
  it("keeps an already-started v2 capture even when v3 becomes available",async()=>{
    const h=harness(true);await expect(h.handler.advance(h.context)).rejects.toThrow("stop-after-policy-binding");
    expect(h.writes).toHaveLength(0);expect(h.selections()).toBe(0);expect(h.old.modelPolicy).toBe(GEMINI_SCHEMA_V2_POLICY);
  });
  it("binds only uncaptured non-rubric requests and leaves historical missing captures untouched",async()=>{
    const generateStructured=vi.fn<(request:StructuredRequest<unknown>,signal:AbortSignal)=>Promise<{data:object;evidence:object}>>(async()=>({data:{},evidence:{}})),model={generateStructured,streamText:vi.fn(),capabilities:vi.fn()} as unknown as ModelPort;
    const request:StructuredRequest<unknown>={operationId:id(940),purpose:"content_review",instructionVersion:"capture",trustedInstructions:"Check.",untrustedInput:{},
      model:"moonshotai/kimi-k2.6",maxOutputTokens:10,deadlineAt:0,schema:z.object({}),schemaId:"check",schemaVersion:1,
      budget:{logicalOperationId:id(940),reservationId:id(941),attempt:1,runStepId:id(942),probe:false}};
    expect(withCapturedModelPolicy(model,undefined)).toBe(model);
    await withCapturedModelPolicy(model,GEMINI_SCHEMA_V2_POLICY).generateStructured(request,new AbortController().signal);
    expect(generateStructured.mock.calls[0]?.[0]).toMatchObject({modelPolicy:GEMINI_SCHEMA_V2_POLICY,model:modelPolicy(GEMINI_SCHEMA_V2_POLICY).model});
    await withCapturedModelPolicy(model,CANDIDATE_MODEL_POLICY).generateStructured({...request,purpose:"rubric_grading"},new AbortController().signal);
    expect(generateStructured.mock.calls[1]?.[0]).not.toHaveProperty("modelPolicy");
    await withCapturedModelPolicy(model,CANDIDATE_MODEL_POLICY).generateStructured({...request,modelPolicy:GEMINI_SCHEMA_V2_POLICY},new AbortController().signal);
    expect(generateStructured.mock.calls[2]?.[0]).toMatchObject({modelPolicy:GEMINI_SCHEMA_V2_POLICY});
  });
});
