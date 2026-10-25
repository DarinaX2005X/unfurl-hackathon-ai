import {randomUUID} from "node:crypto";
import {Client} from "pg";
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {PostgresBudget} from "../../src/server/budget/postgres";
import {jsonDigest} from "../../src/server/ai/json";
describe.skipIf(process.env.RUN_LIVE_TERMINAL_LEDGER!=="1")("terminal400 accounting boundary (rollback,no inference)",()=>{
 let client:Client;let budget:PostgresBudget;const budgetId=process.env.AI_BUDGET_ID!;
 beforeAll(async()=>{const url=new URL(process.env.DIRECT_DATABASE_URL!);for(const key of ["sslmode","sslrootcert","sslcert","sslkey"])url.searchParams.delete(key);
  client=new Client({connectionString:url.toString(),ssl:{rejectUnauthorized:true,...(process.env.DATABASE_SSL_CA?{ca:process.env.DATABASE_SSL_CA.replace(/\\n/g,"\n")}:{})}});await client.connect();
  budget=new PostgresBudget(budgetId,async work=>{await client.query("SAVEPOINT accounting_test");try{const result=await work(client);await client.query("RELEASE SAVEPOINT accounting_test");return result;}catch(error){await client.query("ROLLBACK TO SAVEPOINT accounting_test");throw error;}});});
 beforeEach(async()=>{await client.query("BEGIN");await client.query("SET LOCAL ROLE service_role");});afterEach(async()=>{await client.query("ROLLBACK");});afterAll(async()=>{await client?.end();});
 function input(amount="1000"){const rateCard={proof:"rollback"};return{reservationId:randomUUID(),logicalOperationId:randomUUID(),attempt:1,runStepId:null,probe:true,purpose:"capability_probe" as const,amountMicroUsd:amount,requestDigest:"a".repeat(64),rateCard,rateCardDigest:jsonDigest(rateCard)};}
 async function counters(){return(await client.query("SELECT reserved_micro_usd::text,settled_micro_usd::text FROM unfurl.ai_budgets WHERE id=$1",[budgetId])).rows[0];}
 it("retains all four old financial holds while only terminal400 frees its slot",async()=>{
  expect(await counters()).toEqual({reserved_micro_usd:"650448",settled_micro_usd:"0"});const one=await budget.reserve(input());await budget.claimDispatch(one);await budget.markUnknown(one,"timeout");
  await expect(budget.reserve(input())).rejects.toThrow("provider.budget_exhausted");expect(await counters()).toEqual({reserved_micro_usd:"651448",settled_micro_usd:"0"});
 },30000);
 it("records terminal400 proof atomically without settling/refunding and permits only one active new attempt",async()=>{
  const request=input();const one=await budget.reserve(request);await budget.claimDispatch(one);
  await budget.recordResponse(one,{providerRequestId:null,responseDigest:"b".repeat(64),reportedCostUsd:null,usage:{},result:{kind:"http_error",httpStatus:400}},null);
  expect((await client.query("SELECT http_status FROM unfurl.ai_provider_terminal_http_400_receipts WHERE operation_id=$1",[one.id])).rows[0]?.http_status).toBe(400);
  expect(await counters()).toEqual({reserved_micro_usd:"651448",settled_micro_usd:"0"});await budget.reserve(input());await expect(budget.reserve(input())).rejects.toThrow("provider.budget_exhausted");
 },30000);
 it("counts all held money against probe cap and settles a real-response fixture once",async()=>{
  await expect(budget.reserve(input("349553"))).rejects.toThrow("provider.budget_exhausted");const request=input();const one=await budget.reserve(request);await budget.claimDispatch(one);
  const receipt={providerRequestId:"rollback-"+randomUUID(),responseDigest:"c".repeat(64),reportedCostUsd:"0.0005",usage:{},result:{fixture:true}};
  await budget.recordResponse(one,receipt,"500");await budget.recordResponse(one,receipt,"500");expect(await counters()).toEqual({reserved_micro_usd:"650448",settled_micro_usd:"500"});
 },30000);
});
