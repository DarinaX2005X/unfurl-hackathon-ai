import {describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {z} from "zod";
import {JsonValueSchema,type JsonObject} from "../../src/domain/common";
import {schemaHasLocalReferenceCycle,geminiNativeShapeV3} from "../../src/server/ai/wire-schema";
import {OpenRouterModel,buildProviderRequestBody,providerRequestDigest} from "../../src/server/ai/openrouter";
import {GEMINI_SCHEMA_V4_POLICY,schemaV4Policy,type ModelPolicyId} from "../../src/server/ai/model-policy";
import {approveEndpoint} from "../../src/server/ai/rate-card";
import {canonicalJson} from "../../src/server/ai/json";
import {KnowledgeCoverageReviewSchema} from "../../src/server/course-validation/knowledge";
import {ModuleReviewSchema} from "../../src/server/course-validation/module-review";
import {ContentReviewSchema} from "../../src/server/course-validation/content-review";
import {SpecializedReviewSchema} from "../../src/server/course-validation/specialized-review";
import {AuthoredTaskSchema,batchResponseSchema} from "../../src/server/course-generation/checkpoints";
import {AgentDecisionV3Schema} from "../../src/server/agent-tools/contracts";
import type {BudgetPort} from "../../src/server/budget/ports";
import type {ModelRequestBase} from "../../src/server/ai/ports";
import {id} from "../course-generation/fixtures";

function request(policy:ModelPolicyId=GEMINI_SCHEMA_V4_POLICY):ModelRequestBase{
  return {operationId:id(970),purpose:"content_review",instructionVersion:"wire-regression-v1",trustedInstructions:"Review the supplied evidence.",
    untrustedInput:{example:true},model:schemaV4Policy.model,modelPolicy:policy,maxOutputTokens:16384,executionProfile:"longform_content",deadlineAt:Date.now()+60000,
    budget:{logicalOperationId:id(970),reservationId:id(971),attempt:1,runStepId:id(972),probe:false}};
}
function modelHarness(status=200,content='{"answer":{},"label":"too long"}'){
  const budget={recover:vi.fn(async()=>null),reserve:vi.fn(async input=>({id:input.reservationId,budgetId:id(973),requestDigest:input.requestDigest,amountMicroUsd:input.amountMicroUsd,state:"reserved"})),
    claimDispatch:vi.fn(async()=>({kind:"dispatch"})),recordProviderIdentity:vi.fn(async()=>{}),recordResponse:vi.fn(async()=>{}),markUnknown:vi.fn(async()=>{}),
    releaseUnsent:vi.fn(async()=>{}),halt:vi.fn(async()=>{})} as unknown as BudgetPort;
  const identity={id:"gen-v4-synthetic",model:schemaV4Policy.model,provider:schemaV4Policy.providerName};
  const response=[{...identity,choices:[{index:0,delta:{content},finish_reason:null}]},
    {...identity,choices:[{index:0,delta:{},finish_reason:"stop"}],usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30,cost:0.0000525}}]
    .map(event=>`data: ${JSON.stringify(event)}\n\n`).join("")+"data: [DONE]\n\n";
  const fetcher=vi.fn<typeof fetch>(async()=>status===200?new Response(response,{headers:{"Content-Type":"text/event-stream"}}):
    new Response(JSON.stringify({error:{message:"Invalid schema",code:400}}),{status}));
  const rate=approveEndpoint({data:{endpoints:[{name:"Google AI Studio | google/gemini-3.8-flash",model_id:schemaV4Policy.model,provider_name:schemaV4Policy.providerName,
    tag:schemaV4Policy.provider,context_length:1048576,max_completion_tokens:65536,status:0,supported_parameters:["max_tokens","response_format","reasoning","tools","tool_choice"],pricing:schemaV4Policy.priceCaps}]}},Date.now(),GEMINI_SCHEMA_V4_POLICY);
  const model=new OpenRouterModel({apiKey:()=>"synthetic",budget,fetcher,rateCards:{current:async()=>rate},
    gate:{assertAvailable:async()=>{},snapshot:()=>({model:schemaV4Policy.model,provider:schemaV4Policy.provider,structured:true,text:true,search:false,rubric:false,limitations:[]})}});
  return {model,budget,fetcher};
}

describe("immutable Gemini schema v4 JSON-mode selection",()=>{
  it.each([
    ["self ref",{$ref:"#"}],
    ["array items",{type:"object",properties:{items:{type:"array",items:{$ref:"#"}}}}],
    ["additionalProperties",{$defs:{json:{anyOf:[{type:"string"},{type:"object",additionalProperties:{$ref:"#/$defs/json"}}]}},$ref:"#/$defs/json"}],
    ["mutual definitions",{$defs:{a:{$ref:"#/$defs/b"},b:{$ref:"#/$defs/a"}},type:"object"}],
    ["escaped names",{$defs:{"a~/b":{$ref:"#/$defs/a~0~1b"}},type:"object"}],
    ["encoded fragment",{$defs:{"a b":{$ref:"#%2F$defs%2Fa%20b"}},type:"object"}],
    ["array pointer",{$defs:{node:{anyOf:[{$ref:"#/$defs/node/anyOf/0"},{type:"null"}]}},type:"object"}],
    ["unused definition",{type:"object",$defs:{unused:{$ref:"#/$defs/unused"}}}],
  ] as const)("recognizes %s as a real cycle",(_name,schema)=>{
    expect(schemaHasLocalReferenceCycle(schema as unknown as JsonObject)).toBe(true);
  });
  it.each([
    ["repeated refs",{type:"object",properties:{a:{$ref:"#/$defs/value"},b:{$ref:"#/$defs/value"}},$defs:{value:{type:"string"}}}],
    ["definition back to nonrecursive root",{type:"object",$defs:{unused:{$ref:"#"}}}],
    ["schema-like property names",{type:"object",properties:{$ref:{type:"string"},$defs:{type:"string"},properties:{type:"string"}},default:{$ref:"#"}}],
    ["unknown local ref",{type:"object",properties:{x:{$ref:"#/$defs/missing"}}}],
    ["external ref",{type:"object",properties:{x:{$ref:"https://example.invalid/schema"}}}],
    ["malformed pointer",{$defs:{"bad~2":{$ref:"#/$defs/bad~2"}},type:"object"}],
  ] as const)("does not invent recursion for %s",(_name,schema)=>{
    expect(schemaHasLocalReferenceCycle(schema as unknown as JsonObject)).toBe(false);
  });
  it.each([['coverage',KnowledgeCoverageReviewSchema],['module',ModuleReviewSchema],['content',ContentReviewSchema],['specialized',SpecializedReviewSchema],
    ['content batch',batchResponseSchema(ContentReviewSchema)],['task config',AuthoredTaskSchema],['task batch',batchResponseSchema(AuthoredTaskSchema)]] as const)(
    "uses only json_object for the actual recursive %s schema while retaining all canonical instructions",(_name,shape)=>{
      const schema=z.toJSONSchema(shape) as JsonObject,before=canonicalJson(schema),body=buildProviderRequestBody(request(),{schema,schemaName:"actual_3"});
      expect(body.response_format).toEqual({type:"json_object"});expect(body.messages[0]!.content).toContain(before);
      const previous=buildProviderRequestBody(request("gemini-flash-google-schema-v3"),{schema,schemaName:"actual_3"});
      expect(body.messages).toEqual(previous.messages);expect(canonicalJson(schema)).toBe(before);
      expect(body.provider).toEqual(previous.provider);expect(body.max_tokens).toBe(previous.max_tokens);
    });
  it("keeps the exact v3 native format for an acyclic real agent decision schema",()=>{
    const schema=z.toJSONSchema(AgentDecisionV3Schema) as JsonObject,options={schema,schemaName:"agent_3"};
    expect(schemaHasLocalReferenceCycle(schema)).toBe(false);
    expect(buildProviderRequestBody(request(),options)).toEqual(buildProviderRequestBody(request("gemini-flash-google-schema-v3"),options));
    expect(buildProviderRequestBody(request(),options).response_format).toEqual({type:"json_schema",json_schema:{name:"agent_3",strict:true,schema:geminiNativeShapeV3(schema)}});
  });
  it("preserves the full v1/v2/v3 request digests",()=>{
    const schema=z.toJSONSchema(KnowledgeCoverageReviewSchema) as JsonObject,options={schema,schemaName:"coverage_3"};
    const hashes=Object.fromEntries((["gemini-flash-google-v1","gemini-flash-google-schema-v2","gemini-flash-google-schema-v3"] as const)
      .map(policy=>[policy,providerRequestDigest(request(policy),options)]));
    expect(hashes).toEqual({"gemini-flash-google-v1":"26ca7a5bfe71f4aadd8b0d52293cbd6706fa880cdbbeb89bb223ae3b57365ddd",
      "gemini-flash-google-schema-v2":"911ff2b193ebc9396b687e2cbc78f5ad800520c06f7578761ed563447d7753d4",
      "gemini-flash-google-schema-v3":"52b3d76e50200b5fff95a4676656bbbd9fc395af0f0a55fedc2cf3829c185b5b"});
  });
  it("rejects locally invalid JSON-mode output after persisting the only provider response",async()=>{
    const h=modelHarness(),input={...request(),schema:z.object({answer:JsonValueSchema,label:z.string().max(1)}).strict(),schemaId:"answer",schemaVersion:1};
    await expect(h.model.generateStructured(input,new AbortController().signal)).rejects.toThrow("provider.invalid_output");
    expect(h.fetcher).toHaveBeenCalledTimes(1);expect(h.budget.recordResponse).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(h.fetcher.mock.calls[0]![1]?.body)).response_format).toEqual({type:"json_object"});
  });
  it("never retries or falls back after HTTP 400",async()=>{
    const h=modelHarness(400),schema=z.toJSONSchema(KnowledgeCoverageReviewSchema) as JsonObject;
    await expect(h.model.complete(request(),new AbortController().signal,{schema,schemaName:"coverage_3"})).rejects.toThrow();
    expect(h.fetcher).toHaveBeenCalledTimes(1);expect(h.budget.reserve).toHaveBeenCalledTimes(1);expect(h.budget.markUnknown).toHaveBeenCalledTimes(1);
  });
});
