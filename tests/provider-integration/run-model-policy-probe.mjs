import {spawnSync} from "node:child_process";
import {probeSourceDigest} from "./probe-files.mjs";
const mode=process.argv[2],operationId=process.argv[3],jobId=process.argv[3],stepId=process.argv[4];
const modes={"--prepare":"prepare-readonly","--retire-approved-ended-probe":"retire-approved-ended-probe","--execute-approved-one-probe":"execute-approved-one-probe"};
if(!Object.hasOwn(modes,mode))throw new Error("Select --prepare <job UUID> <step UUID>, --retire-approved-ended-probe <operation UUID>, or --execute-approved-one-probe <job UUID> <step UUID>");
if(mode==="--retire-approved-ended-probe"&&!/^[a-f0-9-]{36}$/.test(operationId??""))throw new Error("Exact standalone operation UUID required");
if(mode!=="--retire-approved-ended-probe"&&![jobId,stepId].every(value=>/^[a-f0-9-]{36}$/.test(value??"")))throw new Error("Exact current job and decision step UUIDs required");
const digest=await probeSourceDigest(process.cwd());
const run=spawnSync(process.execPath,["--env-file=.env","--env-file=.env.local","node_modules/vitest/vitest.mjs","run","tests/provider-integration/model-policy.live.test.ts"],{
  cwd:process.cwd(),env:{...process.env,MODEL_POLICY_MAINTENANCE:modes[mode],MODEL_POLICY_SOURCE_DIGEST:digest,ENDED_PROBE_OPERATION_ID:operationId??"",MODEL_POLICY_JOB_ID:jobId??"",MODEL_POLICY_STEP_ID:stepId??"",
    RUN_PAID_PROVIDER_PROBE:"",RUN_PAID_DIAGNOSTIC:"",RUN_PAID_SEARCH:""},stdio:"inherit",windowsHide:true});
process.exit(run.status??1);
