import {beforeEach,describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
const mocks=vi.hoisted(()=>({query:vi.fn(),start:vi.fn(),getRun:vi.fn(),observe:vi.fn(),refresh:vi.fn(),certify:vi.fn(),inside:false}));
vi.mock("../../src/server/db",()=>({withSystemTransaction:async(_kind:unknown,work:(tx:unknown)=>Promise<unknown>)=>{
  mocks.inside=true;try{return await work({query:mocks.query});}finally{mocks.inside=false;}
}}));
vi.mock("workflow/api",()=>({start:mocks.start,getRun:mocks.getRun}));
vi.mock("../../src/server/runs/composition",()=>({getRuntime:()=>({budget:{budgetId:"budget"},gate:{world:"local",observe:mocks.observe,refresh:mocks.refresh}})}));
vi.mock("../../src/server/runs/compatibility",()=>({certifyRuntimeCompatibility:mocks.certify}));
vi.mock("../../src/server/runs/workflow",()=>({executeJobWorkflow:()=>{},executionRecoveryWorkflow:()=>{}}));
import {WorkflowRunNotFoundError} from "workflow/internal/errors";
import {cancelWorkflowDelivery,dispatchExecutionOutbox,dispatchOwnedExecution,ensureDispatchReady} from "../../src/server/runs/dispatcher";

const actor={id:"00000000-0000-4000-8000-000000000001"};
function rows(operation="start"){
  mocks.query.mockImplementation(async(sql:string)=>{
    if(sql.includes("SELECT o.id,o.job_id"))return{rows:[{id:"outbox",job_id:"job",operation,fencing_token:"1",workflow_run_id:"workflow",status:operation==="cancel"?"cancelled":"queued"}]};
    if(sql.includes("RETURNING fencing_token"))return{rows:[{fencing_token:"2"}]};
    return{rows:[],rowCount:1};
  });
}
beforeEach(()=>{vi.clearAllMocks();mocks.inside=false;rows();mocks.refresh.mockResolvedValue(new Set());mocks.observe.mockResolvedValue(undefined);mocks.certify.mockResolvedValue(undefined);mocks.start.mockImplementation(async()=>{
  expect(mocks.inside).toBe(false);return{runId:"new-workflow"};
});});
describe("request-driven durable delivery",()=>{
  it("starts the accepted owned run outside its transaction and acknowledges the lease fence",async()=>{
    const result=await dispatchOwnedExecution(actor,actor.id);
    expect(result).toMatchObject({dispatched:1,failed:0});
    expect(mocks.start).toHaveBeenCalledTimes(1);
    const selection=mocks.query.mock.calls.find(([sql])=>sql.includes("SELECT o.id,o.job_id"))!;
    expect(selection[1]).toEqual([actor.id,actor.id]);expect(selection[0]).toContain("a.learner_id=$1");
    expect(mocks.query.mock.calls.some(([sql])=>sql.includes("WHERE id=$1 AND lease_owner=$2 AND fencing_token=$3 RETURNING id"))).toBe(true);
    const recovery=mocks.query.mock.calls.find(([sql])=>sql.includes("SELECT j.id,j.workflow_run_id"))!;
    expect(recovery[0]).toContain("accepted.operation IN ('start','resume')");
  });
  it("preserves acceptance when storage or SDK delivery is unavailable",async()=>{
    mocks.query.mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(dispatchOwnedExecution(actor)).resolves.toBeNull();
    rows();mocks.start.mockRejectedValueOnce(new Error("SDK unavailable"));
    await expect(dispatchOwnedExecution(actor)).resolves.toMatchObject({failed:1});
    expect(mocks.query.mock.calls.some(([sql])=>sql.includes("safe_error='"))).toBe(true);
  });
  it("refreshes idle dispatch readiness before admission without a paid probe",async()=>{
    await ensureDispatchReady();expect(mocks.certify).toHaveBeenCalledTimes(1);expect(mocks.observe).toHaveBeenCalledWith(expect.objectContaining({capability:"dispatcher",passed:true}));
    mocks.refresh.mockResolvedValueOnce(new Set(["dispatcher"]));mocks.query.mockClear();await ensureDispatchReady();expect(mocks.query).not.toHaveBeenCalled();
  });
  it("acknowledges a fenced cancellation whose SDK run no longer exists",async()=>{
    rows("cancel");mocks.getRun.mockImplementation(()=>({get status(){return Promise.reject(new WorkflowRunNotFoundError("workflow"));}}));
    await expect(dispatchExecutionOutbox({maintenance:false})).resolves.toMatchObject({dispatched:1,failed:0});
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it("does not retry terminal SDK cancellation, but retains network failures",async()=>{
    const cancel=vi.fn();mocks.getRun.mockReturnValue({status:Promise.resolve("completed"),cancel});
    await cancelWorkflowDelivery("workflow");expect(cancel).not.toHaveBeenCalled();
    mocks.getRun.mockImplementation(()=>({get status(){return Promise.reject(new Error("network"));}}));
    await expect(cancelWorkflowDelivery("workflow")).rejects.toThrow("network");
  });
});
