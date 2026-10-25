import {readFile,writeFile} from "node:fs/promises";
import {expect,it,vi} from "vitest";
import {z} from "zod";
vi.mock("server-only",()=>({}));
import {diagnosticFetcher} from "./diagnostic-fetch";
import {PersistedCapabilityGate,CAPABILITY_TEST_VERSION} from "../../src/server/ai/capabilities";
import {OpenRouterModel} from "../../src/server/ai/openrouter";
import {OpenRouterRateCards} from "../../src/server/ai/rate-card";
import {OpenRouterAccounting} from "../../src/server/ai/accounting";
import {jsonDigest} from "../../src/server/ai/json";
import {boundedResponseText} from "../../src/server/ai/http";
import {PostgresBudget} from "../../src/server/budget/postgres";
import {stableExecutionId} from "../../src/server/runs/identity";
import {OpenRouterResearch} from "../../src/server/research/openrouter";
import {PostgresResearchRepository} from "../../src/server/research/repository";
import {withSystemTransaction} from "../../src/server/db";

it.skipIf(process.env.RUN_PAID_SEARCH!=="approved-one-search-v1")("proves one bounded real search, source reading and native fee accounting",async()=>{
  const proof=z.object({version:z.literal(1),kind:z.literal("single-search"),sourceDigest:z.string(),observedAt:z.iso.datetime(),passedTests:z.literal(5),maxPaidCalls:z.literal(1),maxProbeMicroUsd:z.literal("330224")})
    .parse(JSON.parse(await readFile(process.env.SEARCH_PREPARATION_PATH!,"utf8")));
  if(Date.now()-Date.parse(proof.observedAt)>1800000)throw new Error("Search preparation expired");
  const budgetId=z.uuid().parse(process.env.AI_BUDGET_ID),budget=new PostgresBudget(budgetId),gate=new PersistedCapabilityGate("local",budget);
  const logicalOperationId=stableExecutionId(budgetId,"provider-search-proof-v1");
  const operation={logicalOperationId,reservationId:stableExecutionId(logicalOperationId,"attempt:1"),attempt:1,runStepId:null,probe:true};
  const replayOnly=process.env.REPLAY_SEARCH_ONLY==="1";
  if(replayOnly)expect((await budget.reconciliationTarget(operation.reservationId))?.receipt?.normalizationEvidenceDigest).toMatch(/^[a-f0-9]{64}$/);
  const rates=new OpenRouterRateCards();let calls=0;
  const model=new OpenRouterModel({apiKey:()=>process.env.OPENROUTER_API_KEY,budget,gate,fetcher:async(input,init)=>{if(replayOnly)throw new Error("Inference transport disabled for search receipt replay");calls++;if(calls>1)throw new Error("Only one inference is authorized");const response=await diagnosticFetcher(input,init);
    if(response.ok){const data=JSON.parse(await boundedResponseText(response.clone()));await writeFile(".cache/provider-search-native-metadata.json",JSON.stringify({id:data.id,model:data.model,provider:data.provider,usage:data.usage,annotations:data.choices?.[0]?.message?.annotations??[]},null,2));}return response;},
    rateCards:{async current(signal){const rate=await rates.current(signal);if(rate.contextTokens>262144||rate.contextTokens<2048||rate.maxOutputTokens<2048)throw new Error("Search allocation exceeded");return rate;}}});
  try{
    const research=new OpenRouterResearch(model,{budget:operation,deadlineAt:Date.now()+90000,maxOutputTokens:2048});
    const search=await research.search({query:"Node.js AbortController AbortSignal official documentation",language:"en",domainHints:["nodejs.org"],limit:3},AbortSignal.timeout(90000));
    expect(calls).toBe(replayOnly?0:1);const hit=search.hits.find(item=>new URL(item.url).hostname==="nodejs.org");if(!hit)throw new Error("Primary source absent");
    const read=await research.read({url:hit.url},AbortSignal.timeout(15000));if(read.status!=="success")throw new Error("Primary source could not be read");
    const block=read.document.blocks.find(item=>item.text.includes("AbortController"));if(!block)throw new Error("Actual source passage absent");
    const start=block.text.indexOf("AbortController");const passage={id:stableExecutionId(read.document.id,"source-passage"),sourceId:read.document.id,blockId:block.id,start,end:start+15,quote:"AbortController"};
    const repository=new PostgresResearchRepository();await withSystemTransaction("run_execution",async tx=>{await repository.saveSearch(tx,search);await repository.saveSource(tx,read.document);await repository.savePassage(tx,passage);});
    const accounting=new OpenRouterAccounting(budget,()=>process.env.OPENROUTER_API_KEY);let charged:Awaited<ReturnType<typeof accounting.reconcile>>|null=null;
    for(let check=0;check<10;check++){charged=await accounting.reconcile(operation.reservationId,AbortSignal.timeout(10000));if(charged.settled)break;if(check<9)await new Promise(resolve=>setTimeout(resolve,1500));}
    if(!charged?.settled||!charged.searchFeeVerified)throw new Error("Native search fee remains unverified; preserve financial hold");
    await gate.observe({capability:"research_search",passed:true,testVersion:CAPABILITY_TEST_VERSION,ttlSeconds:86400,instanceId:"bounded-primary-source-search-v1",
      evidence:{operationId:operation.reservationId,searchId:search.id,sourceId:read.document.id,passageId:passage.id,searchFeeVerified:true,accountingEvidenceDigest:jsonDigest(charged.evidence)}});
  }finally{
    const result=await withSystemTransaction("run_execution",async tx=>(await tx.query("SELECT o.id,o.state,o.actual_micro_usd::text,o.reserved_micro_usd::text,o.provider_request_id,r.usage,r.result->'failure' AS failure FROM unfurl.ai_provider_operations o LEFT JOIN unfurl.ai_provider_responses r ON r.operation_id=o.id WHERE o.id=$1",[operation.reservationId])).rows[0]??null);
    await writeFile(".cache/provider-search-result.json",JSON.stringify({calls,result},null,2));console.log(JSON.stringify({calls,result}));
  }
},180000);
