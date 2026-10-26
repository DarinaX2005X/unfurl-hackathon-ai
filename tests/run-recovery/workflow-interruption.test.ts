import {beforeEach,describe,expect,it,vi} from "vitest";
const mocks=vi.hoisted(()=>({advance:vi.fn()}));
vi.mock("workflow",async()=>({...(await import("@workflow/errors")),getStepMetadata:vi.fn(),getWorkflowMetadata:vi.fn()}));
vi.mock("../../src/server/runs/composition",()=>({getRuntime:()=>({executor:{advance:mocks.advance}})}));
import {advanceExecutionStep,safeExecutionInterruption} from "../../src/server/runs/workflow-steps";
import {dehydrateStepError,hydrateStepError} from "@workflow/core/serialization";
beforeEach(()=>{vi.clearAllMocks();});
describe("safe durable infrastructure diagnosis",()=>{
  it.each([["55P03","database_lock_timeout"],["57014","database_statement_timeout"],["42703","database_contract"],["53300","database_connection_limit"],["ECONNRESET","network_connection"]])("retains allowlisted %s without driver detail",(code,category)=>{
    expect(safeExecutionInterruption({code,message:"postgres://user:secret@host SQL SELECT prompt FROM secrets",query:"private SQL",parameters:["secret"]})).toEqual({category,code});
  });
  it("distinguishes pool exhaustion and preserves an allowlisted underlying cause",()=>{
    expect(safeExecutionInterruption(new Error("timeout exceeded when trying to connect"))).toEqual({category:"database_pool_timeout",code:"pool_connect_timeout"});
    expect(safeExecutionInterruption(new Error("Connection terminated due to connection timeout",{cause:{code:"ECONNREFUSED",message:"token secret"}}))).toEqual({category:"network_connection",code:"ECONNREFUSED"});
  });
  it("does not copy unknown codes, raw messages, hostile accessors or cyclic causes",()=>{
    const error:{code:string;message:string;cause?:unknown}={code:"secret-token",message:"private prompt"};error.cause=error;
    expect(safeExecutionInterruption(error)).toEqual({category:"unknown_infrastructure",code:"unclassified"});
    expect(safeExecutionInterruption({get code(){throw new Error("secret");}})).toEqual({category:"unknown_infrastructure",code:"unclassified"});
  });
  it("retains safe category in the SDK serialized error and keeps the original retry interval",async()=>{
    const original=Object.assign(new Error("secret connection string and private prompt"),{code:"55P03",query:"private SQL",parameters:["token"]});
    mocks.advance.mockRejectedValue(original);const started=Date.now();
    const error=await advanceExecutionStep("unchanged-job").catch(value=>value);
    expect(error.name).toBe("RetryableError");expect(error.message).toContain("database_lock_timeout:55P03");
    expect(error.cause).toEqual({category:"database_lock_timeout",code:"55P03"});expect(error.retryAfter.getTime()-started).toBeGreaterThanOrEqual(300000);
    const bytes=await dehydrateStepError(error,"run",undefined,undefined,undefined,false);
    const restored=await hydrateStepError(bytes,"run",undefined) as Error;
    expect(restored.message).toContain("database_lock_timeout:55P03");
    const serialized=Buffer.from(bytes).toString();for(const secret of ["secret connection","private prompt","private SQL","token"])expect(serialized).not.toContain(secret);
    expect(mocks.advance).toHaveBeenCalledExactlyOnceWith("unchanged-job");
  });
});
