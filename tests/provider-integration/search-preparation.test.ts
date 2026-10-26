import {expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {withSystemTransaction} from "../../src/server/db";
import {PostgresBudget} from "../../src/server/budget/postgres";
import {PersistedCapabilityGate} from "../../src/server/ai/capabilities";
import {OpenRouterRateCards} from "../../src/server/ai/rate-card";
import {canReserve} from "../../src/server/budget/calculations";
import {stableExecutionId} from "../../src/server/runs/identity";

it.skipIf(process.env.RUN_SEARCH_PREPARE!=="1")("proves one bounded search fits the existing campaign and actual settled rubric proof",async()=>{
  const budgetId=process.env.AI_BUDGET_ID!;const root=stableExecutionId(budgetId,"provider-search-proof-v1");
  await withSystemTransaction("run_execution",async tx=>{
    const campaign=(await tx.query("SELECT settled_micro_usd::text,reserved_micro_usd::text,halted FROM unfurl.ai_budgets WHERE id=$1",[budgetId])).rows[0];
    if(!campaign)throw new Error("Fixed campaign absent");
    const rows=(await tx.query("SELECT o.id,o.state,o.purpose,o.actual_micro_usd::text,o.reserved_micro_usd::text,t.operation_id AS terminal FROM unfurl.ai_provider_operations o LEFT JOIN unfurl.ai_provider_terminal_http_400_receipts t ON t.operation_id=o.id WHERE o.budget_id=$1",[budgetId])).rows;
    expect(rows.some(row=>row.id===stableExecutionId(root,"attempt:1"))).toBe(false);
    expect(campaign).toMatchObject({settled_micro_usd:"4909",reserved_micro_usd:"650448",halted:false});
    const held=rows.filter(row=>["reserved","dispatched","unknown"].includes(row.state));
    const sum=(items:typeof rows,key:string)=>items.reduce((n,row)=>n+BigInt(row[key]??0),0n);
    expect(held).toHaveLength(4);expect(held.filter(row=>!row.terminal)).toHaveLength(1);
    expect(canReserve({settled:BigInt(campaign.settled_micro_usd),reserved:BigInt(campaign.reserved_micro_usd),halted:campaign.halted,
      probeSettled:sum(rows.filter(row=>row.state==="settled"&&row.purpose==="capability_probe"),"actual_micro_usd"),
      probeReserved:sum(held.filter(row=>row.purpose==="capability_probe"),"reserved_micro_usd")},330224n,true)).toEqual({allowed:true});
  });
  const gate=new PersistedCapabilityGate("local",new PostgresBudget(budgetId));const available=await gate.refresh();
  expect(available.has("model_structured")).toBe(true);expect(available.has("rubric")).toBe(true);
  const rate=await new OpenRouterRateCards().current(AbortSignal.timeout(10000));
  expect(rate.contextTokens).toBeLessThanOrEqual(262144);expect(rate.contextTokens).toBeGreaterThanOrEqual(2048);expect(rate.maxOutputTokens).toBeGreaterThanOrEqual(2048);
},30000);
