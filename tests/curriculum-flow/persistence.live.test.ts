import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { withSystemTransaction } from "../../src/server/db";
import { jsonDigest } from "../../src/server/ai/json";
import { PostgresResearchRepository } from "../../src/server/research/repository";
import { PostgresCurriculumResearchRepository } from "../../src/server/curriculum-research/repository";
import { enqueueAcceptedRun } from "../../src/server/runs/enqueue";
import { approveInTransaction, createResearchedCourse, readArtifact, requireDraft } from "../../src/server/curricula/repository";
import { createCurriculumService, patchCurriculumInTransaction, readAuthoringSnapshot } from "../../src/server/curricula/service";
import { loadApprovedBuild } from "../../src/server/curricula/build-binding";
import { commitResearchedRevision } from "../../src/server/curriculum-research/persistence";
import { curriculumDigest } from "../../src/domain/course";
import { researchFixture } from "./fixtures";

it.skipIf(process.env.RUN_LIVE_CURRICULUM !== "1")("persists researched courses, isolates approvals, invalidates stale builds and records language intent (rollback)", async () => {
  const fixture = await researchFixture();
  const ids = { conversation: randomUUID(), branch: randomUUID(), message: randomUUID(), turn: randomUUID(), step: randomUUID(),
    courseA: randomUUID(), courseB: randomUUID(), draftA: randomUUID(), draftB: randomUUID(), courseC: randomUUID(), draftC: randomUUID(), question: randomUUID() };
  const rollback = new Error("intentional_curriculum_rollback");
  await expect(withSystemTransaction("run_execution", async (tx) => {
    const ownerId = (await tx.query<{ id: string }>("SELECT id FROM unfurl.profiles ORDER BY created_at LIMIT 1")).rows[0]?.id;
    if (!ownerId) throw new Error("Existing QA identity required");
    await tx.query("INSERT INTO unfurl.conversations(id,owner_id,title,active_branch_id) VALUES($1,$2,'Curriculum rollback proof',$3)", [ids.conversation, ownerId, ids.branch]);
    await tx.query("INSERT INTO unfurl.conversation_branches(id,conversation_id) VALUES($1,$2)", [ids.branch, ids.conversation]);
    await tx.query(`INSERT INTO unfurl.messages(id,conversation_id,branch_id,role,status,parts,client_request_id)
      VALUES($1,$2,$3,'user','complete',$4,$5)`, [ids.message, ids.conversation, ids.branch, JSON.stringify([{ type: "text", text: "Rollback test only" }]), randomUUID()]);
    await tx.query(`INSERT INTO unfurl.agent_turn_runs(id,owner_id,conversation_id,branch_id,input_message_id,status)
      VALUES($1,$2,$3,$4,$5,'queued')`, [ids.turn, ownerId, ids.conversation, ids.branch, ids.message]);
    const job = await enqueueAcceptedRun(tx, { kind: "agent_turn", runId: ids.turn });
    await tx.query(`INSERT INTO unfurl.run_steps(id,job_id,step_key,input_digest,schema_digest,capability_digest,validation_policy_digest,status,lease_owner,lease_expires_at,fencing_token)
      VALUES($1,$2,'curriculum.proof',$3,$3,$3,$3,'running','proof',now()+interval '120s',1)`, [ids.step, job.jobId, "a".repeat(64)]);

    const sourceRepository = new PostgresResearchRepository();
    const researchRepository = new PostgresCurriculumResearchRepository();
    fixture.source.id = randomUUID();
    fixture.source.contentDigest = jsonDigest(fixture.source.blocks, 2 * 1024 * 1024);
    fixture.passage.id = randomUUID(); fixture.passage.sourceId = fixture.source.id;
    fixture.claim.id = randomUUID(); fixture.claim.ownerId = ownerId; fixture.claim.runStepId = ids.step; fixture.claim.passageIds = [fixture.passage.id];
    fixture.draft.conversationId = ids.conversation; fixture.draft.courseId = ids.courseA; fixture.draft.id = ids.draftA; fixture.draft.sourceIds = [fixture.source.id];
    fixture.evidence.outcomeEvidence.forEach((entry) => { entry.claimIds = [fixture.claim.id]; });
    fixture.evidence.contentDigest = await curriculumDigest(fixture.draft);
    fixture.facts.ownerId = ownerId; fixture.facts.authorizedSourceIds = new Set([fixture.source.id]);
    await sourceRepository.saveSource(tx, fixture.source);
    const passage = await sourceRepository.savePassage(tx, fixture.passage);
    expect(passage.id).toBe(fixture.passage.id);
    await researchRepository.saveClaim(tx, fixture.claim, new Set([fixture.source.id]));
    const createdA = await createResearchedCourse(tx, { ownerId, runId: ids.turn, branchId: ids.branch, courseId: ids.courseA,
      summary: "Rollback fixture", draft: fixture.draft, evidence: fixture.evidence, facts: fixture.facts });
    const draftB = { ...fixture.draft, id: ids.draftB, courseId: ids.courseB };
    const createdB = await createResearchedCourse(tx, { ownerId, runId: ids.turn, branchId: ids.branch, courseId: ids.courseB,
      summary: "Another rollback fixture", draft: draftB, evidence: { ...fixture.evidence, contentDigest: await curriculumDigest(draftB) }, facts: fixture.facts });
    expect((await tx.query<{ count: number }>("SELECT count(*)::int AS count FROM unfurl.conversation_artifacts WHERE conversation_id=$1", [ids.conversation])).rows[0]?.count).toBe(2);
    expect((await readAuthoringSnapshot(tx, ownerId, ids.draftA)).evidence.status).toBe("verified");
    const draftC = { ...fixture.draft, id: ids.draftC, courseId: ids.courseC,
      unresolvedQuestions: [{ id: ids.question, text: "What programming experience should this course assume?", blocking: true }] };
    await createResearchedCourse(tx, { ownerId, runId: ids.turn, branchId: ids.branch, courseId: ids.courseC,
      summary: "Question intent fixture", draft: draftC, evidence: { ...fixture.evidence, contentDigest: await curriculumDigest(draftC) }, facts: fixture.facts });
    await expect(requireDraft(tx, randomUUID(), ids.draftA)).rejects.toMatchObject({ status: 404 });

    const approvedA = await approveInTransaction(tx, { ownerId, draftId: ids.draftA, expectedRevision: 1, contentDigest: createdA.contentDigest });
    const repeatedA = await approveInTransaction(tx, { ownerId, draftId: ids.draftA, expectedRevision: 1, contentDigest: createdA.contentDigest });
    expect(repeatedA.run.id).toBe(approvedA.run.id);
    expect(repeatedA.artifact.revision).toBe(2);
    const approvedB = await approveInTransaction(tx, { ownerId, draftId: ids.draftB, expectedRevision: 1, contentDigest: createdB.contentDigest });
    const binding = await loadApprovedBuild(tx, { runId: approvedA.run.id, ownerId, lock: true });
    expect(binding.draft).toEqual(fixture.draft);
    expect(binding.version.lessonIds).toEqual([]);
    expect(binding.version.contentDigest).toBe(createdA.contentDigest);
    expect((await readAuthoringSnapshot(tx, ownerId, ids.draftA)).generationRun?.id).toBe(approvedA.run.id);
    expect((await tx.query<{ count: number }>("SELECT count(*)::int AS count FROM unfurl.execution_jobs WHERE generation_run_id=$1", [approvedA.run.id])).rows[0]?.count).toBe(1);

    const updated = await patchCurriculumInTransaction(tx, { ownerId, draftId: ids.draftA, request: {
      expectedRevision: 1, changes: [{ op: "set_details", title: "A revised rollback curriculum" }],
    }, now: new Date().toISOString() });
    expect(updated.draft.revision).toBe(2);
    expect(updated.artifact.revision).toBe(3);
    expect(updated.artifact.approval).toBeNull();
    expect((await readAuthoringSnapshot(tx, ownerId, ids.draftA)).generationRun).toBeNull();
    expect((await tx.query<{ status: string }>("SELECT status FROM unfurl.generation_runs WHERE id=$1", [approvedA.run.id])).rows[0]?.status).toBe("cancelled");
    expect((await tx.query<{ status: string }>("SELECT status FROM unfurl.generation_runs WHERE id=$1", [approvedB.run.id])).rows[0]?.status).toBe("queued");
    await expect(approveInTransaction(tx, { ownerId, draftId: ids.draftA, expectedRevision: 1, contentDigest: createdA.contentDigest })).rejects.toMatchObject({ status: 409 });
    await expect(loadApprovedBuild(tx, { runId: approvedA.run.id, ownerId })).rejects.toMatchObject({ status: 409 });
    expect((await tx.query<{ count: number }>("SELECT count(*)::int AS count FROM unfurl.generation_runs WHERE course_id=$1", [ids.courseA])).rows[0]?.count).toBe(1);

    const changedGoal = await patchCurriculumInTransaction(tx, { ownerId, draftId: ids.draftA, request: {
      expectedRevision: 2, changes: [{ op: "set_details", audience: "Someone without prior programming or mathematics experience." }],
    }, now: new Date().toISOString() });
    expect((await readAuthoringSnapshot(tx, ownerId, ids.draftA)).evidence.status).toBe("needs_research");
    await expect(approveInTransaction(tx, { ownerId, draftId: ids.draftA, expectedRevision: changedGoal.draft.revision, contentDigest: changedGoal.contentDigest })).rejects.toMatchObject({ status: 409 });

    const oldResearch = await researchRepository.loadEvidence(tx, { draft: draftB, ownerId });
    const changedResearch = structuredClone(oldResearch.evidence);
    changedResearch.rationale = "The source supports teaching generalization before capacity selection; this resolves a previously incomplete justification.";
    const refreshed = await commitResearchedRevision(tx, { ownerId, expectedRevision: 1, now: new Date().toISOString(), facts: oldResearch.facts,
      prepared: { draft: draftB, evidence: changedResearch, claims: [], passages: [], answers: { verifications: [], answers: [] }, summary: null } });
    expect(refreshed.draft.revision).toBe(2);
    expect(refreshed.contentDigest).toBe(createdB.contentDigest);
    expect(refreshed.artifact.readyVersionId).toBeNull();
    expect((await researchRepository.loadEvidence(tx, { draft: draftB, ownerId })).evidence.rationale).toBe(oldResearch.evidence.rationale);
    expect((await researchRepository.loadEvidence(tx, { draft: refreshed.draft, ownerId })).evidence.rationale).toBe(changedResearch.rationale);
    await expect(approveInTransaction(tx, { ownerId, draftId: ids.draftB, expectedRevision: 1, contentDigest: createdB.contentDigest })).rejects.toMatchObject({ status: 409 });
    expect((await tx.query<{ status: string }>("SELECT status FROM unfurl.generation_runs WHERE id=$1", [approvedB.run.id])).rows[0]?.status).toBe("cancelled");

    await tx.query("UPDATE unfurl.agent_turn_runs SET status='succeeded' WHERE id=$1", [ids.turn]);
    const actor = { id: ownerId, sessionId: randomUUID(), email: null };
    const service = createCurriculumService({ transaction: (work) => work(tx), admission: { assertAvailable: async () => undefined } });
    const languageKey = randomUUID();
    const artifact = await readArtifact(tx, ownerId, ids.courseB);
    const languageInput = { expectedRevision: artifact.revision, expectedDraftRevision: artifact.curriculum!.revision, contentLanguage: "ru" };
    const language = await service.language(actor, ids.courseB, languageInput, languageKey);
    const languageReplay = await service.language(actor, ids.courseB, languageInput, languageKey);
    expect(languageReplay.data.run.id).toBe(language.data.run.id);
    expect(languageReplay.replayed).toBe(true);
    expect(language.data.artifact.contentLanguage).toBe("en");
    expect(language.data.artifact.curriculum!.contentLanguage).toBe("en");
    expect((await readAuthoringSnapshot(tx, ownerId, ids.draftB)).languageRun?.id).toBe(language.data.run.id);
    expect((await tx.query<{ count: number }>("SELECT count(*)::int AS count FROM unfurl.course_language_revision_intents WHERE course_id=$1", [ids.courseB])).rows[0]?.count).toBe(1);
    await tx.query("UPDATE unfurl.agent_turn_runs SET status='cancelled' WHERE id=$1", [language.data.run.id]);
    const patchInput = { expectedRevision: 1, changes: [{ op: "answer_question" as const, id: ids.question, answer: "I use Python daily." },
      { op: "set_details" as const, title: "The exact title in the captured batch" }] };
    const patchKey = randomUUID();
    const pending = await service.patch(actor, ids.draftC, patchInput, patchKey);
    expect(pending.status).toBe(202);
    if (!("status" in pending.data)) throw new Error("Expected an asynchronous patch receipt");
    const replay = await service.patch(actor, ids.draftC, patchInput, patchKey);
    expect(replay.replayed).toBe(true);
    expect(replay.data).toEqual(pending.data);
    expect((await requireDraft(tx, ownerId, ids.draftC)).draft).toEqual(draftC);
    expect((await readAuthoringSnapshot(tx, ownerId, ids.draftC)).authoringRun?.id).toBe(pending.data.run.id);
    expect((await tx.query<{ changes: unknown }>("SELECT changes FROM unfurl.curriculum_patch_intents WHERE run_id=$1", [pending.data.run.id])).rows[0]?.changes).toEqual(patchInput.changes);
    await expect(approveInTransaction(tx, { ownerId, draftId: ids.draftC, expectedRevision: 1, contentDigest: await curriculumDigest(draftC) }))
      .rejects.toMatchObject({ status: 409, messageKey: "curriculum.reviewInProgress" });
    await tx.query("SET CONSTRAINTS ALL IMMEDIATE");
    throw rollback;
  })).rejects.toBe(rollback);
  const remains = await withSystemTransaction("run_execution", (tx) => tx.query("SELECT id FROM unfurl.courses WHERE id=ANY($1::uuid[])", [[ids.courseA, ids.courseB, ids.courseC]]));
  expect(remains.rowCount).toBe(0);
}, 90_000);
