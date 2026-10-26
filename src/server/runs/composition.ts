import "server-only";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PersistedCapabilityGate } from "../ai/capabilities";
import { OpenRouterModel } from "../ai/openrouter";
import { ScopedRuntimeModel } from "../ai/scoped-runtime-model";
import { OpenRouterRateCards } from "../ai/rate-card";
import { PostgresBudget } from "../budget/postgres";
import { resolveActorFunding, resolveSiteFunding } from "../budget/funding";
import { OpenRouterResearch } from "../research/openrouter";
import { createAgentTurnHandler } from "../agent-turns/handler";
import { createCourseGenerationHandler } from "../course-generation/handler";
import { createLearningRunHandlers } from "../learning/handlers";
import { learningCapabilityRequirements, type LearningAdmission } from "../learning/queue";
import { PostgresPythonExecutionPersistence } from "../db/python-execution";
import { createPythonExecutionPort } from "../execution/python";
import { VercelOidcPythonCapabilityGate } from "../execution/python/capability";
import { PYTHON_RUNTIME_PROFILE } from "../execution/python/profile";
import type { MechanicRuntimeCapabilities } from "../mechanics/contracts";
import {assertModelPolicyAvailable,readActiveModelPolicy} from "../ai/active-policy";
import {withSystemTransaction} from "../db";
import type {ModelPolicyId,SearchPolicyId} from "../ai/model-policy";
import { MODEL_ID } from "../ai/constants";
import { turnFromRow } from "../curricula/repository";
import type { ConversationExecution } from "../conversations/execution";
import { unavailable } from "../auth/errors";
import { DurableRunExecutor } from "./executor";
import { RunHandlerRegistry } from "./registry";
import { cancelGenerationInTransaction, cancelTurnInTransaction, enqueueAcceptedRun } from "./enqueue";
import type { ExecutionKind, StepEffectContext } from "./ports";

let runtime: ReturnType<typeof createRuntime> | undefined;
function pythonProjectId():string|null{
  const configured=process.env.VERCEL_PROJECT_ID;if(configured&&/^prj_[A-Za-z0-9]+$/.test(configured))return configured;
  if(process.env.VERCEL)return null;
  try{const linked=z.object({projectId:z.string().regex(/^prj_[A-Za-z0-9]+$/)}).parse(JSON.parse(readFileSync(resolve(process.cwd(),".vercel/project.json"),"utf8")));return linked.projectId;}catch{return null;}
}
function createRuntime() {
  const budgetId=z.uuid().safeParse(process.env.AI_BUDGET_ID);if(!budgetId.success)throw unavailable("generation.unavailable");
  const budget=new PostgresBudget(budgetId.data);const gate=new PersistedCapabilityGate(process.env.VERCEL?"vercel":"local",budget);
  const metadata=new OpenRouterRateCards();
  const rates={async current(signal:AbortSignal,policyId?:ModelPolicyId){const card=await metadata.current(signal,policyId);if(!policyId||policyId==="kimi-digitalocean-v1")await gate.assertEndpointCompatible(card.snapshot.endpointName);return card;}};
  const transports = new Map<string, OpenRouterModel>();
  const budgets = new Map<string, PostgresBudget>([[budgetId.data,budget]]);
  const budgetForId = (id:string) => {let value=budgets.get(id);if(!value){value=new PostgresBudget(id);budgets.set(id,value);}return value;};
  const modelForBudget=(id:string)=>{
    const prior=transports.get(id);if(prior)return prior;
    const budget=budgetForId(id);
    const fundingGate=id===budgetId.data?gate:new PersistedCapabilityGate(process.env.VERCEL?"vercel":"local",budget);
    const transport=new OpenRouterModel({assertPolicy:assertModelPolicyAvailable,apiKey:()=>process.env.OPENROUTER_API_KEY,budget,gate:fundingGate,rateCards:rates,
    async resolvePolicy(request,options){
      const existing=await budget.existingModelPolicy(request.budget);if(existing)return existing;
      if(request.modelPolicy)return request.modelPolicy;
      // The real-schema planner proof does not certify a different native search engine or rubric behavior.
      if(options.search||request.purpose==="rubric_grading")return "kimi-digitalocean-v1";
      // V3 requires an explicit new capture. Historical unmarked requests keep
      // their previous selection rules, even after a newer proof is installed.
      return withSystemTransaction("run_execution",tx=>readActiveModelPolicy(tx,{allowSchemaV3:false}));
    }});
    transports.set(id,transport);return transport;
  };
  const model=new ScopedRuntimeModel(modelForBudget,()=>gate.snapshot());
  const researchForStep=(step:StepEffectContext,searchPolicy?:SearchPolicyId)=>new OpenRouterResearch(model,{budget:step.budgetOperation("research_search"),deadlineAt:step.deadlineAt,...(searchPolicy?{searchPolicy}:{})});
  const projectId=pythonProjectId();const python=projectId?createPythonExecutionPort({persistence:new PostgresPythonExecutionPersistence(),projectId}):undefined;
  const pythonGate=projectId?new VercelOidcPythonCapabilityGate(projectId):null;
  const registry=new RunHandlerRegistry([createAgentTurnHandler({model,researchForStep}),createCourseGenerationHandler({model,research:researchForStep,runtime:getMechanicRuntimeCapabilities,...(python?{python}:{})}),...createLearningRunHandlers({model,...(python?{python}:{})})]);
  return {budget,budgetForId,gate,rates,model,researchForStep,python,pythonGate,registry,executor:new DurableRunExecutor(registry)};
}
export function getRuntime(){return runtime??=createRuntime();}
export async function getRuntimeCapabilityProjection(){
  try{await (await import("./dispatcher")).ensureDispatchReady();const runtime=getRuntime();const available=await runtime.gate.refresh();
    if(!runtime.registry.has("agent_turn")||!runtime.registry.has("generation")||!["budget_accounting","dispatcher","run_recovery","model_structured","research_search","rubric"].every(key=>available.has(key as Parameters<typeof available.has>[0])))return{generation:false};
    await runtime.budgetForId((await resolveSiteFunding()).budgetId).assertAvailable({probe:false});return{generation:true};
  }catch{return{generation:false};}
}
export function getRuntimeAdmission(){return {async assertAvailable(kind:ExecutionKind,options:{deferBudget?:boolean;actorId?:string}={}){
  await (await import("./dispatcher")).ensureDispatchReady();
  const runtime=getRuntime();if(!runtime.registry.has(kind))throw unavailable("generation.unavailable");
  await runtime.gate.assertExecutionAvailable(kind==="agent_turn"?["model_structured","research_search"]:["model_structured","research_search","rubric"],{deferBudget:true});
  if(!options.deferBudget){const funding=options.actorId?await resolveActorFunding(options.actorId):await resolveSiteFunding();await runtime.budgetForId(funding.budgetId).assertAvailable({probe:false});}
  await runtime.rates.current(AbortSignal.timeout(10000));
}};}
export function getLearningRuntimeAdmission():LearningAdmission{return {async assertAvailable(input){
  await (await import("./dispatcher")).ensureDispatchReady();
  const runtime=getRuntime();if(!runtime.registry.has(input.kind))throw unavailable("learning.unavailable");
  const needed=learningCapabilityRequirements(input);
  if(needed.model){await runtime.gate.assertExecutionAvailable(needed.rubric?["model_structured","rubric"]:["model_structured"],{deferBudget:true});const funding=input.actorId?await resolveActorFunding(input.actorId):await resolveSiteFunding();await runtime.budgetForId(funding.budgetId).assertAvailable({probe:false});await runtime.rates.current(AbortSignal.timeout(10000));}
  else {const capabilities=await runtime.gate.refresh();if(!capabilities.has("dispatcher")||!capabilities.has("run_recovery"))throw unavailable("learning.unavailable");}
  if(needed.python&&(!runtime.pythonGate||(await runtime.pythonGate.inspect(AbortSignal.timeout(10000))).status!=="available"))throw unavailable("learning.executionUnavailable");
}};}
export async function getMechanicRuntimeCapabilities():Promise<MechanicRuntimeCapabilities>{
  const runtime=getRuntime();const capabilities=await runtime.gate.refresh();
  // This port is injected only into an already claimed generation handler. Native Workflow
  // continuation is independent of a recent HTTP dispatcher request or an open browser.
  const durable=capabilities.has("run_recovery")&&runtime.registry.has("activity_action");
  const model=capabilities.has("model_structured")&&capabilities.has("rubric");
  let budget=false;try{await runtime.budgetForId((await resolveSiteFunding()).budgetId).assertAvailable({probe:false});budget=true;}catch{/* Retain unavailable capability. */}
  const sandbox=runtime.pythonGate?(await runtime.pythonGate.inspect(AbortSignal.timeout(10000))).status==="available":false;
  return {model:{modelId:MODEL_ID,available:model},activity:{durable,supportedActions:durable?["run","prediction.commit","experiment.query","intervention.apply","dialogue.turn"]:[],dialogue:durable&&model&&budget},
    sandbox:{available:sandbox,profiles:sandbox?[PYTHON_RUNTIME_PROFILE]:[]},budget:{available:budget}};
}
export function getConversationExecution():ConversationExecution{return {
  assertAvailable:async(actor)=>getRuntimeAdmission().assertAvailable("agent_turn",{actorId:actor.id}),
  async cancelConversation(tx,actor,conversationId){
    const turns=(await tx.query<{id:string}>("SELECT id FROM unfurl.agent_turn_runs WHERE conversation_id=$1 AND owner_id=$2 AND status IN ('queued','running') ORDER BY id",[conversationId,actor.id])).rows;
    const generations=(await tx.query<{id:string}>("SELECT id FROM unfurl.generation_runs WHERE conversation_id=$1 AND owner_id=$2 AND status IN ('queued','running','awaiting_user') ORDER BY id",[conversationId,actor.id])).rows;
    for(const turn of turns)await cancelTurnInTransaction(tx,{runId:turn.id,ownerId:actor.id,reason:"user"});
    for(const generation of generations)await cancelGenerationInTransaction(tx,{runId:generation.id,ownerId:actor.id,reason:"user"});
  },
  async enqueue(tx,{actor,conversation,message}){
    const id=randomUUID();
    await tx.query("INSERT INTO unfurl.agent_turn_runs(id,owner_id,conversation_id,branch_id,input_message_id,status) VALUES($1,$2,$3,$4,$5,'queued')",[id,actor.id,conversation.id,conversation.activeBranchId,message.id]);
    await enqueueAcceptedRun(tx,{kind:"agent_turn",runId:id});
    const row=(await tx.query("SELECT * FROM unfurl.agent_turn_runs WHERE id=$1",[id])).rows[0];
    return turnFromRow(row as Parameters<typeof turnFromRow>[0]);
  },
};}
