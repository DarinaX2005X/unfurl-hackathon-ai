import {it,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {authorizeProviderProofPortability,listProviderPortabilitySources,type ProviderPortabilityStage} from "../../src/server/ai/provider-proof-portability";

it.skipIf(!["list","verify","apply"].includes(process.env.PROVIDER_PORTABILITY_OPERATOR??""))("explicitly inspects or authorizes provider portability without inference",async()=>{
  let stage:ProviderPortabilityStage="input";
  try{
    const budgetId=process.env.AI_BUDGET_ID!;
    if(process.env.PROVIDER_PORTABILITY_OPERATOR==="list"){
      console.log(JSON.stringify({sources:await listProviderPortabilitySources(budgetId),inferenceCalls:0}));return;
    }
    const result=await authorizeProviderProofPortability({sourceReceiptId:process.env.PROVIDER_PORTABILITY_SOURCE_ID!,budgetId,targetWorld:"vercel"},
      {apply:process.env.PROVIDER_PORTABILITY_OPERATOR==="apply",onStage:value=>{stage=value;}});
    const p=result.portability;
    console.log(JSON.stringify({applied:result.applied,receiptId:result.receiptId,capability:p.capability,modelPolicy:p.modelPolicy,sourceReceiptId:p.sourceReceiptId,
      sourceWorld:p.sourceWorld,targetWorld:p.targetWorld,sourceObservedAt:p.sourceObservedAt,checkedAt:p.checkedAt,credentialBindingBasis:p.credentialBindingBasis,
      ...(p.searchAccounting?{searchAccountingSourceVersion:p.searchAccounting.sourceVersion}:{}),inferenceCalls:0}));
  }catch{throw new Error(`Provider portability rejected at ${stage}; no inference was attempted. Review the original proof and target contract.`);}
},60000);
