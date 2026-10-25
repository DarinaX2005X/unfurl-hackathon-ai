import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
vi.mock("server-only", () => ({}));
import { DurableRunExecutor } from "../../src/server/runs/executor";
import { RunHandlerRegistry } from "../../src/server/runs/registry";
import { claimJob, type RuntimeTransaction } from "../../src/server/runs/store";
import { enqueueAcceptedRun } from "../../src/server/runs/enqueue";
import type { RunContext, RunHandler } from "../../src/server/runs/ports";

describe.skipIf(process.env.RUN_LIVE_RUN_EXECUTOR !== "1")("actual fenced executor (rollback fixtures, no provider calls)", () => {
  let client: Client; let transaction: RuntimeTransaction;
  let run: string; let job: string; let branch: string;
  const digests = {schema:"a".repeat(64),capability:"b".repeat(64),validationPolicy:"c".repeat(64),approval:null};
  beforeAll(async () => {
    const url = new URL(process.env.DIRECT_DATABASE_URL ?? "");
    for (const name of ["sslmode","sslrootcert","sslcert","sslkey"]) url.searchParams.delete(name);
    client = new Client({connectionString:url.toString(),ssl:{rejectUnauthorized:true,...(process.env.DATABASE_SSL_CA?{ca:process.env.DATABASE_SSL_CA.replace(/\\n/g,"\n")}:{})},connectionTimeoutMillis:5000});
    await client.connect();
    let queue: Promise<unknown> = Promise.resolve();
    transaction = work => { const next = queue.then(async () => { await client.query("SAVEPOINT runner_operation"); try { const result = await work(client); await client.query("RELEASE SAVEPOINT runner_operation"); return result; } catch(error) { await client.query("ROLLBACK TO SAVEPOINT runner_operation"); throw error; } }); queue=next.catch(()=>undefined); return next; };
  },30000);
  beforeEach(async () => {
    await client.query("BEGIN"); await client.query("SET LOCAL ROLE service_role");
    const owner = (await client.query("SELECT id FROM unfurl.profiles ORDER BY created_at LIMIT 1")).rows[0].id;
    const conversation = randomUUID(); branch=randomUUID(); const message=randomUUID(); run=randomUUID();
    await client.query("INSERT INTO unfurl.conversations(id,owner_id,title,active_branch_id) VALUES($1,$2,'Rollback executor',$3)",[conversation,owner,branch]);
    await client.query("INSERT INTO unfurl.conversation_branches(id,conversation_id) VALUES($1,$2)",[branch,conversation]);
    await client.query("INSERT INTO unfurl.messages(id,conversation_id,branch_id,role,status,parts,client_request_id) VALUES($1,$2,$3,'user','complete','[]',$4)",[message,conversation,branch,randomUUID()]);
    await client.query("INSERT INTO unfurl.agent_turn_runs(id,owner_id,conversation_id,branch_id,input_message_id,status) VALUES($1,$2,$3,$4,$5,'queued')",[run,owner,conversation,branch,message]);
    job=(await enqueueAcceptedRun(client,{kind:"agent_turn",runId:run})).jobId;
  },30000);
  afterEach(async()=>{await client.query("ROLLBACK");});
  afterAll(async()=>{await client?.end();});
  function handler(advance:(context:RunContext)=>ReturnType<RunHandler["advance"]>):RunHandler { return {kind:"agent_turn",version:"rollback-proof",assertAuthority:async()=>undefined,advance}; }
  it("commits a durable step once, replays it, and atomically completes a later step", async () => {
    let effects=0;
    const h=handler(async ctx=>{
      const first=await ctx.step({key:"first",input:{value:4},digests,outputSchema:z.object({value:z.number()}),resultSchema:z.object({value:z.number()}),
        effect:async()=>{effects++;return{value:4};},commit:async(_tx,output)=>output});
      await ctx.step({key:"final",input:first,digests,outputSchema:z.object({value:z.number()}),resultSchema:z.object({done:z.boolean()}),
        effect:async()=>{effects++;return first;},commit:async tx=>{await ctx.completeTurn(tx,{status:"succeeded"});return{done:true};}});
      return{status:"succeeded"};
    });
    const executor=new DurableRunExecutor(new RunHandlerRegistry([h]),transaction);
    expect(await executor.advance(job)).toEqual({status:"continue"}); expect(effects).toBe(1);
    expect(await executor.advance(job)).toEqual({status:"finished"}); expect(effects).toBe(2);
    expect(await executor.advance(job)).toEqual({status:"finished"}); expect(effects).toBe(2);
    expect((await client.query("SELECT status FROM unfurl.agent_turn_runs WHERE id=$1",[run])).rows[0].status).toBe("succeeded");
    expect((await client.query("SELECT count(*)::int AS n FROM unfurl.agent_turn_events WHERE run_id=$1 AND type='run.completed'",[run])).rows[0].n).toBe(1);
    expect((await client.query("SELECT count(*)::int AS n FROM unfurl.run_steps WHERE job_id=$1 AND status='succeeded'",[job])).rows[0].n).toBe(2);
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
  },30000);
  it("rejects a duplicate live delivery, and crash recovery retains the paid-operation identity", async () => {
    const identities:string[]=[];let first=true;
    const h=handler(async ctx=>{await ctx.step({key:"external",input:null,digests,outputSchema:z.null(),resultSchema:z.null(),
      effect:async effect=>{identities.push(effect.budgetOperation("model").reservationId);if(first){first=false;throw new Error("simulated infrastructure interruption");}return null;},
      commit:async tx=>{await ctx.completeTurn(tx,{status:"succeeded"});return null;}});return{status:"succeeded"};});
    const registry=new RunHandlerRegistry([h]);const executor=new DurableRunExecutor(registry,transaction);
    await expect(executor.advance(job)).rejects.toThrow("simulated infrastructure interruption");
    expect(await transaction(tx=>claimJob(tx,job,registry))).toEqual({kind:"busy"});
    await client.query("UPDATE unfurl.execution_jobs SET lease_expires_at=now()-interval '1s' WHERE id=$1",[job]);
    expect(await executor.advance(job)).toEqual({status:"finished"});expect(identities).toHaveLength(2);expect(identities[0]).toBe(identities[1]);
  });
  it("fences a late result after cancellation without committing its domain effect", async () => {
    let committed=false;
    const h=handler(async ctx=>{await ctx.step({key:"late",input:null,digests,outputSchema:z.null(),resultSchema:z.null(),
      effect:async()=>{await client.query("UPDATE unfurl.agent_turn_runs SET status='cancelled' WHERE id=$1",[run]);
        await client.query("UPDATE unfurl.execution_jobs SET status='cancelled',lease_owner=NULL,lease_expires_at=NULL,fencing_token=fencing_token+1 WHERE id=$1",[job]);return null;},
      commit:async()=>{committed=true;return null;}});return{status:"succeeded"};});
    expect(await new DurableRunExecutor(new RunHandlerRegistry([h]),transaction).advance(job)).toEqual({status:"finished"});expect(committed).toBe(false);
    expect((await client.query("SELECT count(*)::int AS n FROM unfurl.run_steps WHERE job_id=$1 AND status='succeeded'",[job])).rows[0].n).toBe(0);
  });
});
