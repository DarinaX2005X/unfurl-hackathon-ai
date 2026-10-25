import {expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {getRuntime} from "../../src/server/runs/composition";
import {certifyRuntimeCompatibility} from "../../src/server/runs/compatibility";
import {withSystemTransaction} from "../../src/server/db";

/** Explicit unpaid migration of actual same-world proofs. No inference transport is permitted. */
it.skipIf(process.env.RUN_LIVE_COMPATIBILITY!=="1")("certifies actual saved proofs without a new inference or probe ledger change",async()=>{
  const runtime=getRuntime();
  const probeState=()=>withSystemTransaction("run_execution",async tx=>(await tx.query(`SELECT id,state,actual_micro_usd::text,reserved_micro_usd::text
    FROM unfurl.ai_provider_operations WHERE budget_id=$1 AND purpose='capability_probe' ORDER BY id`,[runtime.budget.budgetId])).rows);
  const before=await probeState();const original=globalThis.fetch;let inference=0;
  vi.stubGlobal("fetch",((url:RequestInfo|URL,init?:RequestInit)=>{
    if(String(url).includes("/chat/completions")){inference++;throw new Error("Inference forbidden during historical certification");}
    return original(url,init);
  }) as typeof fetch);
  try{
    await certifyRuntimeCompatibility(runtime);
    const available=await runtime.gate.refresh();
    for(const name of ["budget_accounting","run_recovery","model_structured","rubric","research_search"] as const)expect(available.has(name)).toBe(true);
    await runtime.rates.current(AbortSignal.timeout(10000));
    expect(await probeState()).toEqual(before);expect(inference).toBe(0);
  }finally{vi.unstubAllGlobals();}
},60000);
