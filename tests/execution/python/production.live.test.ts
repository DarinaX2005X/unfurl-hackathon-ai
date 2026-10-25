import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { createClient } from "@supabase/supabase-js";
import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { jsonDigest } from "@/server/ai/json";
import { createTransactionRunner } from "@/server/db/transaction";
import { PostgresPythonExecutionPersistence } from "@/server/db/python-execution";
import { createPythonExecutionPort } from "@/server/execution/python";
import { VercelOidcPythonCapabilityGate } from "@/server/execution/python/capability";
import { buildPythonExecutionRequest, pythonSourceDigest } from "@/server/execution/python/contracts";
import { executeLearningPython, publicPythonObservation } from "@/server/learning/python";
import { stableExecutionId } from "@/server/runs/identity";
import { prepareTaskCandidate } from "@/server/mechanics/materialization";
import { PythonArtifactConfigSchema, parsePythonPublicObservation } from "@/domain/mechanic-families/v3/python";
import { COURSE_GENERATION_SCHEMA_DIGEST, COURSE_VALIDATION_POLICY_DIGEST } from "@/server/course-generation/checkpoints";
import { getCapabilityCatalogDigest } from "@/server/mechanics/catalog";
import { replayStoredPythonCase } from "@/server/course-validation/python-cases";
import { CaseEvaluationResultSchema } from "@/server/course-validation/case-evaluation";
import type { ApprovedBuildBinding } from "@/server/curricula/build-binding";
import type { DbTransaction } from "@/server/db";

const qaEmail = "private-python-runtime-proof@unfurl.invalid";
const source = "def solve(payload):\n    return payload * 2\n";
const config = PythonArtifactConfigSchema.parse({
  kind: "artifact_construction", artifactType: "python_function", language: "python",
  runtimeProfile: "python_stdlib_v1", entrypoint: "solve", specification: "Return twice the supplied integer.",
  inputShape: { type: "number", integer: true, minimum: -10, maximum: 10 },
  outputShape: { type: "number", integer: true, minimum: -20, maximum: 20 },
  starterSource: "def solve(payload):\n    return 0\n", publicCases: [{ id: "public_two", input: 2 }],
});

function sslConfig() {
  const url = new URL(process.env.DIRECT_DATABASE_URL ?? "");
  for (const name of ["sslmode", "sslrootcert", "sslcert", "sslkey"]) url.searchParams.delete(name);
  return { connectionString: url.toString(), connectionTimeoutMillis: 10_000,
    ssl: { rejectUnauthorized: true, ...(process.env.DATABASE_SSL_CA
      ? { ca: process.env.DATABASE_SSL_CA.replace(/\\n/g, "\n") } : {}) } };
}

it.skipIf(process.env.RUN_LIVE_PYTHON !== "approved-two-free-sandboxes-v1")(
  "proves two production Python sandbox paths and zero-create same-identity replay",
  async () => {
    const setup = new pg.Client({ ...sslConfig(), application_name: "unfurl-private-python-proof-setup" });
    await setup.connect();
    let owner = (await setup.query<{ id: string }>("SELECT id FROM auth.users WHERE email=$1", [qaEmail])).rows[0]?.id;
    if (!owner) {
      const admin = createClient(process.env.SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", {
        auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
      });
      const created = await admin.auth.admin.createUser({ email: qaEmail,
        password: `${randomUUID()}Aa1!`, email_confirm: true,
        user_metadata: { purpose: "private_python_runtime_proof", retainedQaIdentity: true } });
      if (created.error || !created.data.user) throw created.error ?? new Error("QA identity was not created");
      owner = created.data.user.id;
    }
    const key = (name: string) => stableExecutionId(owner!, `private-python-runtime-proof-v1:${name}`);
    const ids = {
      conversation: key("conversation"), branch: key("branch"), message: key("message"), course: key("course"),
      draft: key("draft"), approval: key("approval"), generation: key("generation"), version: key("version"),
      outcome: key("outcome"), module: key("module"), task: key("task"), enrollment: key("enrollment"),
      activity: key("activity"), action: key("action"), actionClient: key("action-client"),
      learningJob: key("learning-job"), authoringJob: key("authoring-job"), candidateStep: key("candidate-step"),
      casePlanStep: key("case-plan-step"), authoringStep: key("authoring-step"),
      authoringValidation: key("authoring-validation"), authoringCase: key("authoring-case"),
      authoringLogical: key("authoring-logical"), authoringExecution: key("authoring-execution"),
      authoringIdempotency: key("authoring-idempotency"), testSet: key("test-set"), evidenceGroup: key("evidence-group"),
    };
    const response = { kind: "artifact_construction", action: "build_artifact", artifactType: "python_function", source } as const;
    const responseDigest = jsonDigest(response);
    const candidate = prepareTaskCandidate({ task: {
      id: ids.task, taskVersion: 1, mechanicId: "artifact_construction", mechanicVersion: 3,
      outcomeIds: [ids.outcome], instruction: "Implement solve(payload) so it returns twice the integer input.",
      contentLanguage: "en", config, availableHints: 1, responseSchemaVersion: 3,
    }, privateTask: {
      taskId: ids.task, taskVersion: 1,
      evaluationSpec: { kind: "execution", executorId: "python_stdlib_v1", dialect: "python3.14",
        testSetId: ids.testSet, resourceLimits: { timeoutMs: 3000, memoryMb: 256 } },
      sourceClaimIds: [], hints: ["Multiply the input by two."], workedExample: null,
      evaluatorData: { testSetId: ids.testSet,
        hiddenCases: [{ id: "hidden_three", input: 3, expected: 6, dimensionId: "behavior" }],
        comparator: { kind: "json_exact" }, requiredDimensions: ["behavior"] },
      assessment: { evidenceGroupId: ids.evidenceGroup, role: "required", outcomes: [{ outcomeId: ids.outcome,
        dimensions: [{ dimensionId: "doubling", evaluationDimensionIds: ["behavior"] }] }] },
    } }, { approvalDigest: "a".repeat(64) });
    const approvalDigest = candidate.approvalDigest;
    const executionCases = [{ id: "public_two", input: 2 }, { id: "hidden_three", input: 3 }];
    const caseBindings = [{ id: "public_two", role: "public", inputDigest: jsonDigest(2), expectedDigest: null },
      { id: "hidden_three", role: "hidden", inputDigest: jsonDigest(3), expectedDigest: jsonDigest(6) }];
    const digests = { schema: COURSE_GENERATION_SCHEMA_DIGEST, capability: getCapabilityCatalogDigest(),
      validationPolicy: COURSE_VALIDATION_POLICY_DIGEST, approval: approvalDigest };
    const authoredResponseCase = { caseId: ids.authoringCase, key: "valid_double", category: "valid", response };
    const candidateCheckpoint = { kind: "course.task.candidate", moduleId: ids.module, knowledgeStepId: key("knowledge-step"),
      candidate, authored: {}, authoringOperationId: key("authoring-operation") };
    const casesCheckpoint = { kind: "course.task.cases", candidateStepId: ids.candidateStep,
      candidateDigest: candidate.candidateDigest, operationId: key("cases-operation"),
      cases: [authoredResponseCase], alternativeSpaceProof: null };
    const learningLeaseOwner = randomUUID(), authoringLeaseOwner = randomUUID(), stepLeaseOwner = randomUUID();
    let learningFence = "1", authoringFence = "1", stepFence = "1";
    const globalBefore = Number((await setup.query<{ reserved_count: string }>(`SELECT reserved_count::text
      FROM unfurl.python_execution_global_daily_quotas WHERE quota_day=(now() at time zone 'UTC')::date`)).rows[0]?.reserved_count ?? 0);
    const existingExecutions = Number((await setup.query<{ count: string }>(`SELECT count(*)::text AS count
      FROM unfurl.code_execution_runs WHERE (job_id=$1 AND activity_action_id=$2) OR id=$3`,
    [ids.learningJob, ids.action, ids.authoringExecution])).rows[0]?.count ?? 0);
    await setup.query("BEGIN");
    try {
      await setup.query("SET CONSTRAINTS ALL DEFERRED");
      await setup.query("INSERT INTO unfurl.conversations(id,owner_id,title,active_branch_id) VALUES($1,$2,'PRIVATE QA — Python runtime proof',$3) ON CONFLICT(id) DO NOTHING", [ids.conversation, owner, ids.branch]);
      await setup.query("INSERT INTO unfurl.conversation_branches(id,conversation_id) VALUES($1,$2) ON CONFLICT(id) DO NOTHING", [ids.branch, ids.conversation]);
      await setup.query(`INSERT INTO unfurl.messages(id,conversation_id,branch_id,role,status,parts,client_request_id)
        VALUES($1,$2,$3,'user','complete','[]',$4) ON CONFLICT(id) DO NOTHING`, [ids.message, ids.conversation, ids.branch, key("message-request")]);
      await setup.query(`INSERT INTO unfurl.courses(id,owner_id,slug,title,summary,content_language,visibility,cover)
        VALUES($1,$2,'private-python-runtime-proof','PRIVATE QA — Python runtime proof','Retained private QA authority graph; never published.','en','private',$3)
        ON CONFLICT(id) DO NOTHING`, [ids.course, owner, { motifId: "private-qa", alt: "Private QA runtime proof" }]);
      await setup.query(`INSERT INTO unfurl.curriculum_drafts(id,course_id,conversation_id,revision,document)
        VALUES($1,$2,$3,1,'{}') ON CONFLICT(id) DO NOTHING`, [ids.draft, ids.course, ids.conversation]);
      await setup.query(`INSERT INTO unfurl.curriculum_revisions(draft_id,revision,content_digest,document)
        VALUES($1,1,$2,'{}') ON CONFLICT(draft_id,revision) DO NOTHING`, [ids.draft, approvalDigest]);
      await setup.query(`INSERT INTO unfurl.curriculum_approvals(id,draft_id,draft_revision,content_digest,approved_by)
        VALUES($1,$2,1,$3,$4) ON CONFLICT(id) DO NOTHING`, [ids.approval, ids.draft, approvalDigest, owner]);
      await setup.query(`INSERT INTO unfurl.generation_runs
        (id,owner_id,course_id,conversation_id,branch_id,input_message_id,source_draft_revision,approval_id,phase,status)
        VALUES($1,$2,$3,$4,$5,$6,1,$7,'validating','running') ON CONFLICT(id) DO NOTHING`,
      [ids.generation, owner, ids.course, ids.conversation, ids.branch, ids.message, ids.approval]);
      const outcomes = [{ id: ids.outcome, title: "Double an integer", demonstration: "Implement and validate a doubling function.", prerequisiteOutcomeIds: [], requirement: "core" }];
      const modules = [{ id: ids.module, title: "Private QA module", summary: "Runtime proof only.", outcomeIds: [ids.outcome], prerequisiteModuleIds: [], estimatedStudyMinutes: 5 }];
      await setup.query(`INSERT INTO unfurl.course_versions
        (id,course_id,number,approval_id,source_run_id,content_digest,state,title,summary,content_language,assumed_knowledge,outcomes,modules,cover)
        VALUES($1,$2,1,$3,$4,$5,'building','PRIVATE QA — Python runtime proof','Non-ready private runtime evidence.','en','[]',$6,$7,$8)
        ON CONFLICT(id) DO NOTHING`, [ids.version, ids.course, ids.approval, ids.generation, approvalDigest,
        JSON.stringify(outcomes), JSON.stringify(modules), { motifId: "private-qa", alt: "Private QA runtime proof" }]);
      await setup.query(`INSERT INTO unfurl.tasks_public
        (id,task_version,course_version_id,mechanic_id,mechanic_version,outcome_ids,instruction,content_language,config,available_hints,response_schema_version)
        VALUES($1,1,$2,'artifact_construction',3,$3,$4,'en',$5,1,3) ON CONFLICT(id,task_version) DO NOTHING`,
      [ids.task, ids.version, [ids.outcome], candidate.task.instruction, JSON.stringify(config)]);
      await setup.query(`INSERT INTO unfurl.enrollments(id,learner_id,course_id,course_version_id)
        VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING`, [ids.enrollment, owner, ids.course, ids.version]);
      await setup.query(`INSERT INTO unfurl.activity_sessions
        (id,enrollment_id,task_id,task_version,hidden_state,action_budget,actions_used,status,revision,input_revision)
        VALUES($1,$2,$3,1,'{}',1,0,'active',1,1) ON CONFLICT(id) DO NOTHING`, [ids.activity, ids.enrollment, ids.task]);
      await setup.query(`INSERT INTO unfurl.activity_inputs(activity_session_id,input_revision,response_digest,response)
        VALUES($1,1,$2,$3) ON CONFLICT(activity_session_id,input_revision) DO NOTHING`, [ids.activity, responseDigest, JSON.stringify(response)]);
      await setup.query(`INSERT INTO unfurl.activity_actions
        (id,activity_session_id,client_action_id,request_digest,action,input_revision,response_digest,session_revision,status)
        VALUES($1,$2,$3,$4,$5,1,$6,1,'pending') ON CONFLICT(id) DO NOTHING`,
      [ids.action, ids.activity, ids.actionClient, jsonDigest({ kind: "run" }), JSON.stringify({ kind: "run" }), responseDigest]);
      const learning = (await setup.query<{ fencing_token: string }>(`INSERT INTO unfurl.execution_jobs
        (id,activity_action_id,status,attempt_count,lease_owner,lease_expires_at,fencing_token)
        VALUES($1,$2,'running',1,$3,now()+interval '10 minutes',1)
        ON CONFLICT(id) DO UPDATE SET status='running',attempt_count=execution_jobs.attempt_count+1,lease_owner=$3,
          lease_expires_at=now()+interval '10 minutes',fencing_token=execution_jobs.fencing_token+1,updated_at=now()
        RETURNING fencing_token::text`, [ids.learningJob, ids.action, learningLeaseOwner])).rows[0]!;
      learningFence = learning.fencing_token;
      const authoring = (await setup.query<{ fencing_token: string }>(`INSERT INTO unfurl.execution_jobs
        (id,generation_run_id,status,attempt_count,lease_owner,lease_expires_at,fencing_token)
        VALUES($1,$2,'running',1,$3,now()+interval '10 minutes',1)
        ON CONFLICT(id) DO UPDATE SET status='running',attempt_count=execution_jobs.attempt_count+1,lease_owner=$3,
          lease_expires_at=now()+interval '10 minutes',fencing_token=execution_jobs.fencing_token+1,updated_at=now()
        RETURNING fencing_token::text`, [ids.authoringJob, ids.generation, authoringLeaseOwner])).rows[0]!;
      authoringFence = authoring.fencing_token;
      const stepSql = `INSERT INTO unfurl.run_steps
        (id,job_id,step_key,input_digest,approval_digest,schema_digest,capability_digest,validation_policy_digest,
          status,attempt_count,lease_owner,lease_expires_at,fencing_token,result_reference)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$11,$12,$13) ON CONFLICT(id) DO NOTHING`;
      await setup.query(stepSql, [ids.candidateStep, ids.authoringJob, "private-qa/candidate", jsonDigest(candidateCheckpoint),
        approvalDigest, digests.schema, digests.capability, digests.validationPolicy, "succeeded", null, null, 1, JSON.stringify(candidateCheckpoint)]);
      await setup.query(stepSql, [ids.casePlanStep, ids.authoringJob, "private-qa/cases", jsonDigest(casesCheckpoint),
        approvalDigest, digests.schema, digests.capability, digests.validationPolicy, "succeeded", null, null, 1, JSON.stringify(casesCheckpoint)]);
      const executionStep = (await setup.query<{ fencing_token: string }>(`INSERT INTO unfurl.run_steps
        (id,job_id,step_key,input_digest,approval_digest,schema_digest,capability_digest,validation_policy_digest,
          status,attempt_count,lease_owner,lease_expires_at,fencing_token)
        VALUES($1,$2,'private-qa/python-execute',$3,$4,$5,$6,$7,'running',1,$8,now()+interval '10 minutes',1)
        ON CONFLICT(id) DO UPDATE SET status='running',attempt_count=run_steps.attempt_count+1,lease_owner=$8,
          lease_expires_at=now()+interval '10 minutes',fencing_token=run_steps.fencing_token+1,updated_at=now()
        RETURNING fencing_token::text`, [ids.authoringStep, ids.authoringJob, jsonDigest({ candidate, test: authoredResponseCase }),
        approvalDigest, digests.schema, digests.capability, digests.validationPolicy, stepLeaseOwner])).rows[0]!;
      stepFence = executionStep.fencing_token;
      await setup.query(`INSERT INTO unfurl.python_authoring_validations
        (id,job_id,run_step_id,candidate_step_id,case_plan_step_id,validation_case_id,owner_id,generation_run_id,
          course_id,course_version_id,approval_id,approval_digest,candidate_digest,capability_catalog_digest,source,
          source_digest,cases_digest,case_key,case_category,case_bindings,execution_cases,candidate_step_schema_digest,
          candidate_step_capability_digest,candidate_step_validation_policy_digest,case_plan_schema_digest,
          case_plan_capability_digest,case_plan_validation_policy_digest,execution_schema_digest,
          execution_capability_digest,execution_validation_policy_digest,job_lease_owner,job_fencing_token,
          job_retry_epoch,step_lease_owner,step_fencing_token)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'valid',$19,$20,
          $21,$22,$23,$21,$22,$23,$21,$22,$23,$24,$25,0,$26,$27) ON CONFLICT(id) DO NOTHING`, [
        ids.authoringValidation, ids.authoringJob, ids.authoringStep, ids.candidateStep, ids.casePlanStep,
        ids.authoringCase, owner, ids.generation, ids.course, ids.version, ids.approval, approvalDigest,
        candidate.candidateDigest, candidate.capabilityCatalogDigest, source, pythonSourceDigest(source),
        jsonDigest(executionCases), authoredResponseCase.key, JSON.stringify(caseBindings), JSON.stringify(executionCases),
        digests.schema, digests.capability, digests.validationPolicy, authoringLeaseOwner, authoringFence,
        stepLeaseOwner, stepFence,
      ]);
      await setup.query("SET CONSTRAINTS ALL IMMEDIATE");
      await setup.query("COMMIT");
    } catch (error) {
      await setup.query("ROLLBACK");
      throw error;
    }

    const project = JSON.parse(await readFile(new URL("../../../.vercel/project.json", import.meta.url), "utf8")) as { projectId: string };
    const capability = await new VercelOidcPythonCapabilityGate(project.projectId).inspect(AbortSignal.timeout(10_000));
    if (capability.status !== "available") throw new Error(`Python capability unavailable: ${capability.reason}`);
    expect(capability.evidence).toMatchObject({ projectId: project.projectId, plan: "hobby", runtimeProfile: "python_stdlib_v1" });

    const pool = new pg.Pool({ ...sslConfig(), max: 2, application_name: "unfurl-private-python-proof-runtime" });
    const runner = createTransactionRunner(pool);
    const persistence = new PostgresPythonExecutionPersistence(work => runner.withSystemTransaction("run_execution", work));
    const python = createPythonExecutionPort({ persistence, projectId: project.projectId });
    try {
      const learningInput = {
        claim: { jobId: ids.learningJob, leaseOwner: learningLeaseOwner, fencingToken: learningFence, retryEpoch: 0,
          target: { kind: "activity_action" as const, activityActionId: ids.action } },
        effect: { stepId: key("learning-effect"), deadlineAt: Date.now() + 90_000, signal: new AbortController().signal,
          stepFence: { jobId: ids.learningJob, jobLeaseOwner: learningLeaseOwner, jobFencingToken: learningFence,
            retryEpoch: 0, stepId: key("learning-effect"), stepLeaseOwner: key("unused-step-owner"), stepFencingToken: "1" },
          budgetOperation() { throw new Error("Python execution has no AI budget operation"); } },
        enrollment: { id: ids.enrollment, learnerId: owner, courseId: ids.course, courseVersionId: ids.version,
          status: "active" as const, routeRevision: 1, currentLessonId: null, currentTaskId: null,
          createdAt: new Date().toISOString(), lastStudiedAt: null },
        task: candidate.task,
        input: { activitySessionId: ids.activity, inputRevision: 1, responseDigest },
        program: { source, cases: [{ id: "public_two", input: 2 }] },
        target: { kind: "activity_action" as const, activityActionId: ids.action },
      };
      const learning = await executeLearningPython(python, learningInput);
      expect(learning).toMatchObject({ status: "completed", purpose: "public_run",
        cases: [{ id: "public_two", result: { status: "ok", value: 4 } }], audit: { cleanup: "deleted" } });
      const publicObservation = publicPythonObservation(candidate.task, learningInput.program, learning);
      expect(publicObservation).toEqual({ kind: "python_execution", runtimeProfile: "python_stdlib_v1",
        cases: [{ caseId: "public_two", input: 2, result: { status: "ok", value: 4, stdout: "" } }] });
      expect(JSON.stringify(publicObservation)).not.toContain("hidden_three");
      const learningRow = (await setup.query(`SELECT id,status,provider_sandbox_id,provider_command_ids,capability_evidence,result
        FROM unfurl.code_execution_runs WHERE job_id=$1 AND activity_action_id=$2`, [ids.learningJob, ids.action])).rows[0];
      expect(learningRow).toMatchObject({ status: "completed", capability_evidence: { source: "vercel_oidc_signed_claim_v1", plan: "hobby" } });
      const learningReplayFence = (await setup.query<{ lease_owner: string; fencing_token: string }>(`UPDATE unfurl.execution_jobs
        SET lease_owner=$2,lease_expires_at=now()+interval '10 minutes',fencing_token=fencing_token+1,updated_at=now()
        WHERE id=$1 RETURNING lease_owner,fencing_token::text`, [ids.learningJob, randomUUID()])).rows[0]!;
      const learningReplay = await executeLearningPython(python, { ...learningInput,
        claim: { ...learningInput.claim, leaseOwner: learningReplayFence.lease_owner, fencingToken: learningReplayFence.fencing_token },
        effect: { ...learningInput.effect, deadlineAt: Date.now() + 90_000 },
      });
      expect(learningReplay).toEqual(learning);
      const learningAfter = (await setup.query(`SELECT count(*)::int AS count,provider_sandbox_id,provider_command_ids
        FROM unfurl.code_execution_runs WHERE job_id=$1 AND activity_action_id=$2
        GROUP BY provider_sandbox_id,provider_command_ids`, [ids.learningJob, ids.action])).rows[0];
      expect(learningAfter).toEqual({ count: 1, provider_sandbox_id: learningRow.provider_sandbox_id,
        provider_command_ids: learningRow.provider_command_ids });

      const authoringDraft = (jobOwner: string, jobToken: string, currentStepOwner: string, currentStepToken: string) => ({
        executionId: ids.authoringExecution, logicalExecutionId: ids.authoringLogical, executionAttempt: 1,
        retryOfExecutionId: null, idempotencyKey: ids.authoringIdempotency,
        job: { jobId: ids.authoringJob, leaseOwner: jobOwner, fencingToken: jobToken, retryEpoch: 0 },
        authority: { kind: "authoring" as const, ownerId: owner!, generationRunId: ids.generation,
          courseId: ids.course, courseVersionId: ids.version, approvalId: ids.approval,
          approvalDigest, candidateDigest: candidate.candidateDigest },
        input: { kind: "authoring" as const, authoringValidationId: ids.authoringValidation,
          candidateDigest: candidate.candidateDigest },
        purpose: "authoring_validation" as const,
        target: { kind: "authoring_validation" as const, authoringValidationId: ids.authoringValidation, runStepId: ids.authoringStep },
        step: { stepId: ids.authoringStep, leaseOwner: currentStepOwner, fencingToken: currentStepToken },
        source, cases: executionCases, deadlineAt: new Date(Date.now() + 90_000).toISOString(),
      });
      const authoringRequest = buildPythonExecutionRequest(authoringDraft(authoringLeaseOwner, authoringFence, stepLeaseOwner, stepFence));
      const authoring = await python.execute(authoringRequest, new AbortController().signal);
      expect(authoring).toMatchObject({ status: "completed", purpose: "authoring_validation",
        cases: [{ id: "public_two", result: { status: "ok", value: 4 } },
          { id: "hidden_three", result: { status: "ok", value: 6 } }], audit: { cleanup: "deleted" } });
      if (authoring.status !== "completed") throw new Error(`Authoring execution unavailable: ${authoring.reason}`);
      const authoringPublic = parsePythonPublicObservation(config, { kind: "python_execution", runtimeProfile: "python_stdlib_v1",
        cases: [{ caseId: "public_two", input: 2, result: authoring.cases[0]!.result }] });
      expect(authoringPublic.cases).toEqual([{ caseId: "public_two", input: 2,
        result: { status: "ok", value: 4, stdout: "" } }]);
      expect(JSON.stringify(authoringPublic)).not.toContain("hidden_three");
      const authoringRow = (await setup.query(`SELECT id,status,provider_sandbox_id,provider_command_ids,capability_evidence,result
        FROM unfurl.code_execution_runs WHERE id=$1`, [ids.authoringExecution])).rows[0];
      expect(authoringRow).toMatchObject({ status: "completed", capability_evidence: { source: "vercel_oidc_signed_claim_v1", plan: "hobby" } });
      const newJobOwner = randomUUID(), newStepOwner = randomUUID();
      const authoringReplayJob = (await setup.query<{ fencing_token: string }>(`UPDATE unfurl.execution_jobs
        SET lease_owner=$2,lease_expires_at=now()+interval '10 minutes',fencing_token=fencing_token+1,updated_at=now()
        WHERE id=$1 RETURNING fencing_token::text`, [ids.authoringJob, newJobOwner])).rows[0]!;
      const authoringReplayStep = (await setup.query<{ fencing_token: string }>(`UPDATE unfurl.run_steps
        SET lease_owner=$2,lease_expires_at=now()+interval '10 minutes',fencing_token=fencing_token+1,updated_at=now()
        WHERE id=$1 RETURNING fencing_token::text`, [ids.authoringStep, newStepOwner])).rows[0]!;
      const replayRequest = buildPythonExecutionRequest(authoringDraft(newJobOwner, authoringReplayJob.fencing_token,
        newStepOwner, authoringReplayStep.fencing_token));
      expect(replayRequest.requestDigest).toBe(authoringRequest.requestDigest);
      const authoringReplay = await python.execute(replayRequest, new AbortController().signal);
      expect(authoringReplay).toEqual(authoring);
      const authoringAfter = (await setup.query(`SELECT count(*)::int AS count,provider_sandbox_id,provider_command_ids
        FROM unfurl.code_execution_runs WHERE id=$1 GROUP BY provider_sandbox_id,provider_command_ids`, [ids.authoringExecution])).rows[0];
      expect(authoringAfter).toEqual({ count: 1, provider_sandbox_id: authoringRow.provider_sandbox_id,
        provider_command_ids: authoringRow.provider_command_ids });
      const executionCheckpoint = { kind: "course.python_execution" as const,
        candidateDigest: candidate.candidateDigest, caseId: ids.authoringCase,
        authoringValidationId: ids.authoringValidation, executionId: ids.authoringExecution, result: authoring };
      await setup.query(`UPDATE unfurl.run_steps SET status='succeeded',result_reference=$2,
        lease_owner=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1`, [ids.authoringStep, JSON.stringify(executionCheckpoint)]);
      const caseResult = CaseEvaluationResultSchema.parse({ kind: "course.response_case",
        candidateDigest: candidate.candidateDigest, caseId: ids.authoringCase, category: "valid", response,
        decision: { status: "evaluated", outcome: "correct", dimensions: [{ id: "behavior", status: "met",
          explanation: "The implementation satisfies the required behavior." }],
        feedback: { explanation: "The implementation meets every assessed criterion.", nextAction: "continue" } },
        rejectedAsInvalid: false, modelCallId: null, rubricRequest: null, rubricJudgement: null,
        activityEvidenceRef: ids.authoringExecution });
      const replayDecision = await replayStoredPythonCase(setup as unknown as DbTransaction, {
        run: { id: ids.generation, retryOfRunId: null }, course: { id: ids.course, ownerId: owner },
        version: { id: ids.version }, approval: { id: ids.approval, draftRevision: 1, contentDigest: approvalDigest },
      } as unknown as ApprovedBuildBinding, candidate, caseResult,
      { id: key("grade-step"), inputDigest: "b".repeat(64), result: caseResult });
      expect(replayDecision).toEqual(caseResult.decision);
      const globalAfter = Number((await setup.query<{ reserved_count: string }>(`SELECT reserved_count::text
        FROM unfurl.python_execution_global_daily_quotas WHERE quota_day=(now() at time zone 'UTC')::date`)).rows[0]?.reserved_count ?? 0);
      expect(globalAfter - globalBefore).toBe(2 - existingExecutions);
      expect((await setup.query<{ count: number }>(`SELECT count(*)::int AS count FROM unfurl.code_execution_runs
        WHERE status IN ('reserved','creating','running','collecting','ambiguous','cleanup_pending')`)).rows[0]?.count).toBe(0);
      console.log(JSON.stringify({ pythonProductionProof: "passed", freshSandboxCreates: 2 - existingExecutions,
        replaySandboxCreates: 0, retainedPrivateQa: { actorId: owner, courseId: ids.course, courseVersionId: ids.version,
          learningExecutionId: learningRow.id, authoringExecutionId: ids.authoringExecution },
        sandboxes: [{ id: learningRow.provider_sandbox_id, cleanup: learning.audit.cleanup },
          { id: authoringRow.provider_sandbox_id, cleanup: authoring.audit.cleanup }],
        capability: { source: capability.evidence.source, plan: capability.evidence.plan,
          projectId: capability.evidence.projectId, environment: capability.evidence.environment },
        publicProjectionCaseIds: authoringPublic.cases.map(({ caseId }) => caseId),
        hiddenCaseCount: authoring.cases.length - authoringPublic.cases.length,
        immutableBridgeReplay: "verified" }));
    } finally {
      await pool.end();
      await setup.end();
    }
  },
  300_000,
);
