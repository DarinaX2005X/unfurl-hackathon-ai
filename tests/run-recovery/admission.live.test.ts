import {expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {getRuntimeAdmission,getRuntimeCapabilityProjection,getRuntime} from "../../src/server/runs/composition";

/** Read-only final integration boundary: actual evidence, current rates, budget and composed handlers. */
it.skipIf(process.env.RUN_LIVE_RUNTIME_ADMISSION!=="1")("admits normal authoring only from fresh actual runtime evidence",async()=>{
  const runtime=getRuntime();
  for(const kind of ["agent_turn","generation","evaluation","activity_action"] as const)expect(runtime.registry.has(kind)).toBe(true);
  await expect(getRuntimeAdmission().assertAvailable("agent_turn")).resolves.toBeUndefined();
  await expect(getRuntimeAdmission().assertAvailable("generation")).resolves.toBeUndefined();
  expect(await getRuntimeCapabilityProjection()).toEqual({generation:true});
},30000);
