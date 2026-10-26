import {randomUUID} from "node:crypto";
import {describe,expect,it,vi} from "vitest";
import {z} from "zod";
vi.mock("server-only",()=>({}));
import {OpenRouterModel,buildProviderRequestBody,providerRequestDigest} from "../../src/server/ai/openrouter";
import {candidatePolicy,CANDIDATE_MODEL_POLICY,executionTiming} from "../../src/server/ai/model-policy";
import {approveEndpoint} from "../../src/server/ai/rate-card";
import {jsonDigest} from "../../src/server/ai/json";
import {worstCaseMicroUsd} from "../../src/server/budget/calculations";
import type {BudgetPort,BudgetReservation,ProviderResponseReceipt} from "../../src/server/budget/ports";
import type {ModelRequestBase} from "../../src/server/ai/ports";

const endpoint={name:"Google AI Studio | google/gemini-3.8-flash-20260902",model_id:candidatePolicy.model,provider_name:candidatePolicy.providerName,
  tag:candidatePolicy.provider,context_length:1048576,max_completion_tokens:65536,status:0,
  supported_parameters:["max_tokens","response_format","reasoning","tools","tool_choice"],
  pricing:{prompt:"0.00000075",completion:"0.00000375",input_cache_read:"0.000000075",internal_reasoning:"0.00000375",image:"0.00000075",audio:"0.00000075",
    web_search:"0.014",input_cache_write:"0.0000000416666666666667",input_audio_cache:"0.000000075",discount:0.5}};
function request():ModelRequestBase{
  const operationId=randomUUID();return {operationId,purpose:"turn_planning",instructionVersion:"test-v1",trustedInstructions:"Return a decision.",untrustedInput:{data:"untrusted"},
    model:candidatePolicy.model,modelPolicy:CANDIDATE_MODEL_POLICY,maxOutputTokens:32768,executionProfile:"longform_curriculum",deadlineAt:Date.now()+60000,
    budget:{logicalOperationId:operationId,reservationId:randomUUID(),attempt:1,runStepId:null,probe:false}};
}
function harness(interrupted=false){
  let saved:{reservation:BudgetReservation;receipt:ProviderResponseReceipt}|null=null;
  const order:string[]=[];
  const budget:BudgetPort={assertAvailable:async()=>{},recover:vi.fn(async()=>saved),
    reserve:vi.fn(async input=>({id:input.reservationId,budgetId:randomUUID(),requestDigest:input.requestDigest,amountMicroUsd:input.amountMicroUsd,state:"reserved" as const})),
    claimDispatch:async()=>({kind:"dispatch"}),recordProviderIdentity:vi.fn(async()=>{order.push("identity");}),
    recordResponse:vi.fn(async(reservation,receipt)=>{order.push("receipt");saved={reservation,receipt};}),markUnknown:vi.fn(async()=>{order.push("unknown");}),releaseUnsent:async()=>{},halt:async()=>{}};
  const id="gen-policy-test",identity={id,model:candidatePolicy.model,provider:candidatePolicy.providerName};
  const events=[{...identity,choices:[{index:0,delta:{content:'{"answer":"ok"}'},finish_reason:null}]},
    {...identity,choices:[{index:0,delta:{},finish_reason:"stop"}],usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30,cost:0.0000525}}];
  const body=events.slice(0,interrupted?1:2).map(event=>`data: ${JSON.stringify(event)}\n\n`).join("")+(interrupted?"":"data: [DONE]\n\n");
  const fetcher=vi.fn<typeof fetch>(async()=>new Response(body,{headers:{"Content-Type":"text/event-stream","X-Generation-Id":id}}));
  const model=new OpenRouterModel({apiKey:()=>"test",budget,fetcher,gate:{snapshot:()=>({model:candidatePolicy.model,provider:candidatePolicy.provider,structured:true,text:true,search:false,rubric:false,limitations:[]}),assertAvailable:async()=>{}},
    rateCards:{current:async()=>approveEndpoint({data:{endpoints:[endpoint]}},Date.now(),CANDIDATE_MODEL_POLICY)}});
  return {model,budget,order,fetcher};
}
describe("explicit model operation policy",()=>{
  it("keeps legacy request bytes free of new transport and reasoning fields",()=>{
    const legacy:ModelRequestBase={...request(),model:"moonshotai/kimi-k2.6"};delete legacy.modelPolicy;
    const body=buildProviderRequestBody(legacy);
    expect(body).toMatchObject({model:"moonshotai/kimi-k2.6",stream:false,provider:{only:["digitalocean"],allow_fallbacks:false,max_price:{prompt:0.60,completion:2.60}}});
    expect(body).not.toHaveProperty("reasoning");expect(body).not.toHaveProperty("response_format");
    expect(providerRequestDigest(legacy)).toBe(jsonDigest({body,purpose:legacy.purpose,instructionVersion:legacy.instructionVersion}));
  });
  it("pins native schema, low planner thinking, streaming and exact single-provider route",()=>{
    const body=buildProviderRequestBody(request(),{schema:{type:"object",properties:{answer:{type:"string"}},required:["answer"],additionalProperties:false},schemaName:"answer_1"});
    expect(body).toMatchObject({stream:true,reasoning:{effort:"low",exclude:true},stream_options:{include_usage:true},provider:{only:["google-ai-studio"],allow_fallbacks:false,max_price:{prompt:0.75,completion:3.75}},response_format:{type:"json_schema",json_schema:{strict:true,name:"answer_1"}}});
    expect(buildProviderRequestBody({...request(),purpose:"curriculum"})).toMatchObject({reasoning:{effort:"medium"}});
  });
  it("reserves the complete candidate context and output without treating unused multimodal prices as text charges",()=>{
    const rate=approveEndpoint({data:{endpoints:[endpoint]}},Date.now(),CANDIDATE_MODEL_POLICY);
    expect(worstCaseMicroUsd({contextTokens:rate.contextTokens,outputTokens:32768,inferencePasses:1,searches:0,priceCaps:candidatePolicy.priceCaps})).toBe(909312n);
    expect(()=>approveEndpoint({data:{endpoints:[{...endpoint,pricing:{...endpoint.pricing,request:"0.01"}}]}},Date.now(),CANDIDATE_MODEL_POLICY)).toThrow();
  });
  it("persists early identity before the full receipt and fully validates the assembled schema",async()=>{
    const h=harness(),input={...request(),schema:z.object({answer:z.string()}).strict(),schemaId:"answer",schemaVersion:1};
    expect((await h.model.generateStructured(input,new AbortController().signal)).data).toEqual({answer:"ok"});
    expect(h.order).toEqual(["identity","identity","receipt"]);
    expect(h.budget.reserve).toHaveBeenCalledWith(expect.objectContaining({amountMicroUsd:"909312",rateCard:expect.objectContaining({model:candidatePolicy.model,provider:candidatePolicy.provider})}));
    await h.model.generateStructured(input,new AbortController().signal);expect(h.fetcher).toHaveBeenCalledTimes(1);
  });
  it("retains early identity and the full hold after a truncated stream without fabricating a response",async()=>{
    const h=harness(true);await expect(h.model.complete(request(),new AbortController().signal)).rejects.toThrow();
    expect(h.order).toEqual(["identity","identity","unknown"]);expect(h.budget.recordResponse).not.toHaveBeenCalled();
  });
  it("uses trusted deployment environment for transport, effect and lease timing",()=>{
    vi.stubEnv("VERCEL","1");expect(executionTiming()).toEqual({providerMs:260000,stepMs:270000,stepLeaseSeconds:285,jobLeaseSeconds:295});
    vi.stubEnv("VERCEL","");expect(executionTiming()).toEqual({providerMs:1800000,stepMs:1810000,stepLeaseSeconds:1825,jobLeaseSeconds:1835});vi.unstubAllEnvs();
  });
});
