import {randomUUID} from "node:crypto";
import {describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {appendChatEvent} from "../../src/server/runs/events";
import type {ChatEventPayload,ExecutionTarget} from "../../src/server/runs/ports";

function harness(){
  const target:Extract<ExecutionTarget,{kind:"agent_turn"}>={kind:"agent_turn",runId:randomUUID(),ownerId:randomUUID(),conversationId:randomUUID(),branchId:randomUUID(),inputMessageId:randomUUID()};
  const query=vi.fn(async(sql:string)=>sql.startsWith("UPDATE")?{rows:[{last_seq:7,updated_at:new Date("2026-10-25T12:00:00Z") }]}:{rows:[]});
  return{target,query,tx:{query} as never};
}
describe("persisted action progress fields",()=>{
  it("preserves semantic labels, commentary position and safe facts in the stored event",async()=>{
    const h=harness(),payload:ChatEventPayload={type:"action.started",invocationId:randomUUID(),action:"search",labelKey:"generation.search",afterMessageId:randomUUID(),details:{query:"Primary source research"}};
    const event=await appendChatEvent(h.tx,h.target,payload);
    expect(event).toMatchObject(payload);
    const insert=h.query.mock.calls.find(([sql])=>sql.startsWith("INSERT")) as unknown as [string,unknown[]];
    expect(JSON.parse(String(insert[1][5]))).toEqual(event);
  });
  it("retains course-specific labels and source detail counts",async()=>{
    const h=harness(),payload:ChatEventPayload={type:"action.started",invocationId:randomUUID(),action:"build_outline",labelKey:"generation.reviseCurriculum",details:{sourceCount:2,changeCount:1}};
    expect(await appendChatEvent(h.tx,h.target,payload)).toMatchObject(payload);
  });
  it("falls back for unknown labels and does not persist arbitrary params",async()=>{
    const h=harness(),payload:ChatEventPayload={type:"action.started",invocationId:randomUUID(),action:"read_source",labelKey:"untrusted.model.label",params:{private:"not public"}};
    const event=await appendChatEvent(h.tx,h.target,payload);
    expect(event).toMatchObject({labelKey:"generation.action.read_source"});expect(event).not.toHaveProperty("params");
  });
  it("rejects private detail fields instead of storing them",async()=>{
    const h=harness(),payload={type:"action.started",invocationId:randomUUID(),action:"search",labelKey:"generation.search",details:{query:"Research",operationId:randomUUID()}} as unknown as ChatEventPayload;
    await expect(appendChatEvent(h.tx,h.target,payload)).rejects.toThrow();
    expect(h.query.mock.calls.some(([sql])=>sql.startsWith("INSERT"))).toBe(false);
  });
});
