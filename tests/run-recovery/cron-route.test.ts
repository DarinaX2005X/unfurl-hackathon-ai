import {afterEach,expect,it,vi} from "vitest";
import {NextRequest} from "next/server";
const dispatch=vi.hoisted(()=>vi.fn());
vi.mock("../../src/server/runs/dispatcher",()=>({dispatchExecutionOutbox:dispatch,inspectRecoveryProof:vi.fn(),startRecoveryProof:vi.fn()}));
import {GET,POST} from "../../src/app/api/internal/dispatch/route";
afterEach(()=>{vi.unstubAllEnvs();vi.clearAllMocks();});
it("accepts only the dedicated cron bearer for GET and the separate admin bearer for POST",async()=>{
  vi.stubEnv("CRON_SECRET","c".repeat(32));vi.stubEnv("INTERNAL_DISPATCH_SECRET","i".repeat(32));dispatch.mockResolvedValue({scanned:0});
  const req=(secret:string,method="GET")=>new NextRequest("https://example.test/api/internal/dispatch",{method,headers:{authorization:`Bearer ${secret}`},...(method==="POST"?{body:JSON.stringify({action:"dispatch"})}:{})});
  expect((await GET(req("i".repeat(32)))).status).toBe(401);expect((await GET(req("é".repeat(32)))).status).toBe(401);
  expect((await GET(req("c".repeat(32)))).status).toBe(200);
  expect((await POST(req("c".repeat(32),"POST"))).status).toBe(401);
  expect((await POST(req("i".repeat(32),"POST"))).status).toBe(200);expect(dispatch).toHaveBeenCalledTimes(2);
});
