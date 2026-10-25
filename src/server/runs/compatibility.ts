import "server-only";
import { z } from "zod";
import { OpenRouterAccounting } from "../ai/accounting";
import { PersistedCapabilityGate } from "../ai/capabilities";
import { ProviderFailure } from "../ai/failure";
import { OpenRouterRateCards } from "../ai/rate-card";
import type { PostgresBudget } from "../budget/postgres";

/** Historical compatibility is separate from current prices, funds, launch readiness and world proof.
 * This performs metadata/accounting reads only; it has no inference transport or retry allocation. */
export async function certifyRuntimeCompatibility(runtime:{gate:PersistedCapabilityGate;budget:PostgresBudget}){
  const rates=new OpenRouterRateCards();let endpoint:string|undefined;
  const accounting=new OpenRouterAccounting(runtime.budget,()=>process.env.OPENROUTER_API_KEY);
  const verified=new Map<string,{settled:boolean;searchFeeVerified:boolean}>();
  await runtime.gate.certifyHistoricalProofs(async(capability,evidence)=>{
    if(capability==="budget_accounting"||capability==="run_recovery")return{endpointName:null};
    if(!endpoint)endpoint=z.string().parse((await rates.current(AbortSignal.timeout(10000))).snapshot.endpointName);
    const operationId=z.uuid().parse(evidence.operationId);
    const target=await runtime.budget.reconciliationTarget(operationId);
    const rate=z.object({endpointName:z.string()}).safeParse(target?.rateCard);
    if(!target||target.purpose!=="capability_probe"||target.reservation.state!=="settled"||!rate.success||rate.data.endpointName!==endpoint)throw new ProviderFailure("unavailable");
    let proof=verified.get(operationId);
    if(!proof){proof=await accounting.reconcile(operationId,AbortSignal.timeout(10000));verified.set(operationId,proof);}
    if(!proof.settled||(capability==="research_search"&&!proof.searchFeeVerified))throw new ProviderFailure("unavailable");
    return{endpointName:endpoint};
  });
}
