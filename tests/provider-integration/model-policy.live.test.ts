import {readFile,writeFile,mkdir} from "node:fs/promises";
import {resolve} from "node:path";
import {it,vi} from "vitest";
import {z} from "zod";
vi.mock("server-only",()=>({}));
import {prepareSavedDecisionProbe,executeSavedDecisionProbe,retireEndedStandaloneProbe} from "../../src/server/ai/saved-decision-probe";

const selectedBinding=()=>({jobId:z.uuid().parse(process.env.MODEL_POLICY_JOB_ID),stepId:z.uuid().parse(process.env.MODEL_POLICY_STEP_ID)});
const proofPath=resolve(".cache/model-policy-probe-preparation.json");
it.skipIf(process.env.MODEL_POLICY_MAINTENANCE!=="prepare-readonly")("reconstructs the original paid request exactly and prepares one real-schema candidate probe without inference",async()=>{
  const prepared=await prepareSavedDecisionProbe(selectedBinding());
  await mkdir(resolve(".cache"),{recursive:true});
  await writeFile(proofPath,JSON.stringify({...prepared.report,preparedAt:new Date().toISOString(),sourceDigest:process.env.MODEL_POLICY_SOURCE_DIGEST},null,2));
  console.log(JSON.stringify({prepared:true,inferenceCalls:0,...prepared.report}));
},30000);

it.skipIf(process.env.MODEL_POLICY_MAINTENANCE!=="retire-approved-ended-probe")("retires only the explicitly named ended standalone probe slot with unchanged ledger totals",async()=>{
  console.log(JSON.stringify(await retireEndedStandaloneProbe(z.uuid().parse(process.env.ENDED_PROBE_OPERATION_ID))));
},30000);

it.skipIf(process.env.MODEL_POLICY_MAINTENANCE!=="execute-approved-one-probe")("executes one bounded real-context schema probe, saves accounting and activates its proved structured route without executing the selected tool",async()=>{
  const binding=selectedBinding();
  const proof=z.object({jobId:z.literal(binding.jobId),stepId:z.literal(binding.stepId),candidateRequestDigest:z.string().regex(/^[a-f0-9]{64}$/),
    maxPaidCalls:z.literal(1),maxExposureMicroUsd:z.literal("909312"),preparedAt:z.iso.datetime(),sourceDigest:z.string().min(64)}).parse(JSON.parse(await readFile(proofPath,"utf8")));
  if(Date.now()-Date.parse(proof.preparedAt)>1800000||proof.sourceDigest!==process.env.MODEL_POLICY_SOURCE_DIGEST)throw new Error("Fresh unchanged preparation required");
  const result=await executeSavedDecisionProbe(binding,proof.candidateRequestDigest);
  await writeFile(resolve(".cache/model-policy-probe-result.json"),JSON.stringify(result,null,2));
  console.log(JSON.stringify({...result,decision:undefined,decisionFile:resolve(".cache/model-policy-probe-result.json")}));
},1840000);
