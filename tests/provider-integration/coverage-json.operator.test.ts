import {readFile,writeFile,mkdir} from "node:fs/promises";
import {resolve} from "node:path";
import {it,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {z} from "zod";
import {jsonDigest} from "../../src/server/ai/json";
import {prepareSavedCoverageJsonProbe,executeSavedCoverageJsonProbe} from "../../src/server/ai/saved-coverage-json-probe";

const selectedBinding=()=>({jobId:z.uuid().parse(process.env.COVERAGE_SCHEMA_JOB_ID),stepId:z.uuid().parse(process.env.COVERAGE_SCHEMA_STEP_ID)});
const proofPath=resolve(".cache/coverage-json-probe-preparation.json");
const sources=["src/server/ai/model-policy.ts","src/server/ai/wire-schema.ts","src/server/ai/openrouter.ts","src/server/ai/error-receipt.ts",
  "src/server/ai/saved-coverage-request.ts","src/server/ai/saved-coverage-json-probe.ts","src/server/ai/active-policy.ts","src/server/ai/capabilities.ts",
  "src/server/ai/provider-proof-portability.ts","src/server/ai/json.ts","src/server/ai/accounting.ts","src/server/ai/rate-card.ts",
  "src/server/budget/postgres.ts","src/server/budget/calculations.ts","src/server/budget/money.ts","src/server/course-validation/knowledge.ts","src/server/course-generation/repository.ts",
  "src/server/course-generation/checkpoints.ts","src/server/research/repository.ts","src/server/curriculum-research/repository.ts",
  "src/domain/course.ts","tests/provider-integration/coverage-json.operator.test.ts"];
async function sourceDigest(){return jsonDigest(await Promise.all(sources.map(async path=>({path,text:await readFile(resolve(path),"utf8")}))),2*1024*1024);}

it.skipIf(process.env.COVERAGE_JSON_OPERATOR!=="prepare-readonly")("prepares exactly one actual coverage request without provider traffic or database writes",async()=>{
  const prepared=await prepareSavedCoverageJsonProbe(selectedBinding());
  await mkdir(resolve(".cache"),{recursive:true});
  const report={...prepared.report,preparedAt:new Date().toISOString(),sourceDigest:await sourceDigest()};
  await writeFile(proofPath,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
},30000);

it.skipIf(process.env.COVERAGE_JSON_OPERATOR!=="execute-approved-one-probe")("executes only the explicitly approved fixed coverage operation and records its actual settled proof",async()=>{
  if(process.env.RUN_PAID_COVERAGE_JSON_PROBE!=="approved-one-coverage-json-probe-v4")throw new Error("Explicit one-attempt coverage probe authorization is required");
  const binding=selectedBinding(),proof=z.object({jobId:z.literal(binding.jobId),stepId:z.literal(binding.stepId),candidateRequestDigest:z.string().regex(/^[a-f0-9]{64}$/),
    modelPolicy:z.literal("gemini-flash-google-schema-v4"),responseFormat:z.literal("json_object"),wireSchema:z.literal("gemini-recursive-json-mode-v4"),
    maxPaidCalls:z.literal(1),maxExposureMicroUsd:z.literal("847872"),preparedAt:z.iso.datetime(),sourceDigest:z.string().regex(/^[a-f0-9]{64}$/)}).parse(JSON.parse(await readFile(proofPath,"utf8")));
  if(Date.now()-Date.parse(proof.preparedAt)>1800000||Date.parse(proof.preparedAt)>Date.now()+1000||proof.sourceDigest!==await sourceDigest())throw new Error("Fresh unchanged coverage preparation is required");
  const result=await executeSavedCoverageJsonProbe(binding,proof.candidateRequestDigest);
  await writeFile(resolve(".cache/coverage-json-probe-result.json"),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
},1840000);
