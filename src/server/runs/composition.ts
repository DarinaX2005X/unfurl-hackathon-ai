import "server-only";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { PersistedCapabilityGate } from "../ai/capabilities";
import { OpenRouterModel } from "../ai/openrouter";
import { OpenRouterRateCards } from "../ai/rate-card";
import { PostgresBudget } from "../budget/postgres";
import { OpenRouterResearch } from "../research/openrouter";
import { createAgentTurnHandler } from "../agent-turns/handler";
import { turnFromRow } from "../curricula/repository";
import type { ConversationExecution } from "../conversations/execution";
import { unavailable } from "../auth/errors";
import { DurableRunExecutor } from "./executor";
import { RunHandlerRegistry } from "./registry";
import { enqueueAcceptedRun } from "./enqueue";
import type { ExecutionKind, StepEffectContext } from "./ports";

let runtime: ReturnType<typeof createRuntime> | undefined;
function createRuntime() {
  const budgetId=z.uuid().safeParse(process.env.AI_BUDGET_ID);if(!budgetId.success)throw unavailable("generation.unavailable");
  const budget=new PostgresBudget(budgetId.data);const gate=new PersistedCapabilityGate(process.env.VERCEL?"vercel":"local",budget);
  const rates=new OpenRouterRateCards();const model=new OpenRouterModel({apiKey:()=>process.env.OPENROUTER_API_KEY,budget,gate,rateCards:rates});
  const researchForStep=(step:StepEffectContext)=>new OpenRouterResearch(model,{budget:step.budgetOperation("research_search"),deadlineAt:step.deadlineAt});
  const registry=new RunHandlerRegistry([createAgentTurnHandler({model,researchForStep})]);
  return {budget,gate,rates,model,researchForStep,registry,executor:new DurableRunExecutor(registry)};
}
export function getRuntime(){return runtime??=createRuntime();}
export function getRuntimeAdmission(){return {async assertAvailable(kind:ExecutionKind){
  const runtime=getRuntime();if(!runtime.registry.has(kind))throw unavailable("generation.unavailable");
  await runtime.gate.assertExecutionAvailable(kind==="agent_turn"?["model_structured","research_search"]:["model_structured","research_search","rubric"]);
  await runtime.rates.current(AbortSignal.timeout(10000));
}};}
export function getConversationExecution():ConversationExecution{return {
  assertAvailable:async()=>getRuntimeAdmission().assertAvailable("agent_turn"),
  async enqueue(tx,{actor,conversation,message}){
    const id=randomUUID();
    await tx.query("INSERT INTO unfurl.agent_turn_runs(id,owner_id,conversation_id,branch_id,input_message_id,status) VALUES($1,$2,$3,$4,$5,'queued')",[id,actor.id,conversation.id,conversation.activeBranchId,message.id]);
    await enqueueAcceptedRun(tx,{kind:"agent_turn",runId:id});
    const row=(await tx.query("SELECT * FROM unfurl.agent_turn_runs WHERE id=$1",[id])).rows[0];
    return turnFromRow(row as Parameters<typeof turnFromRow>[0]);
  },
};}
