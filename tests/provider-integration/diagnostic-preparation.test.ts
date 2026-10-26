import { expect,it,vi } from "vitest";
vi.mock("server-only",()=>({}));
import { withSystemTransaction } from "../../src/server/db";
import { OpenRouterRateCards } from "../../src/server/ai/rate-card";
import { canReserve } from "../../src/server/budget/calculations";
import { stableExecutionId } from "../../src/server/runs/identity";

it.skipIf(process.env.RUN_DIAGNOSTIC_PREPARE!=="1")("reads preserved hold and proves room for exactly one bounded diagnostic dispatch",async()=>{
  const budgetId=process.env.AI_BUDGET_ID!;
  const root=stableExecutionId(budgetId,"provider-diagnostic-rubric-v4");
  const reservationId=stableExecutionId(root,"attempt:1");
  await withSystemTransaction("run_execution",async tx=>{
    const campaign=(await tx.query("SELECT settled_micro_usd::text,reserved_micro_usd::text,halted FROM unfurl.ai_budgets WHERE id=$1",[budgetId])).rows[0];
    if(!campaign)throw new Error("Fixed campaign unavailable");
    const operations=(await tx.query("SELECT id,state,purpose,actual_micro_usd::text,reserved_micro_usd::text FROM unfurl.ai_provider_operations WHERE budget_id=$1",[budgetId])).rows;
    expect(operations.some(row=>row.id===reservationId)).toBe(false);
    expect(operations.find(row=>row.id==="a4175e61-42f4-5c0d-99c3-b57934a0b3cc")).toMatchObject({state:"unknown",actual_micro_usd:null,reserved_micro_usd:"162612"});
    const terminal=(await tx.query("SELECT operation_id FROM unfurl.ai_provider_terminal_http_400_receipts")).rows.map(row=>row.operation_id);
    const outstanding=operations.filter(row=>["reserved","dispatched","unknown"].includes(row.state));
    const active=outstanding.filter(row=>!terminal.includes(row.id));
    const sum=(rows:typeof operations,key:string)=>rows.reduce((total,row)=>total+BigInt(row[key]??0),0n);
    const state={settled:BigInt(campaign.settled_micro_usd),reserved:BigInt(campaign.reserved_micro_usd),halted:campaign.halted,
      probeSettled:sum(operations.filter(row=>row.purpose==="capability_probe"&&row.state==="settled"),"actual_micro_usd"),
      probeReserved:sum(outstanding.filter(row=>row.purpose==="capability_probe"),"reserved_micro_usd")};
    expect(canReserve(state,162612n,true).allowed).toBe(true);
    expect(active.length).toBe(1);expect(outstanding.length).toBe(4);expect(campaign.reserved_micro_usd).toBe("650448");expect(campaign.settled_micro_usd).toBe("0");
  });
  const rates=await new OpenRouterRateCards().current(AbortSignal.timeout(15000));
  expect(rates.contextTokens).toBeLessThanOrEqual(262144);expect(rates.contextTokens).toBeGreaterThanOrEqual(2048);expect(rates.maxOutputTokens).toBeGreaterThanOrEqual(2048);
},30000);
