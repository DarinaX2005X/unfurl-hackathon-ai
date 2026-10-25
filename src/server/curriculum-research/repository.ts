import "server-only";
import type { CurriculumDraft } from "../../domain/course";
import { CurriculumDraftSchema } from "../../domain/course";
import type { DbTransaction } from "../db";
import { canonicalJson } from "../ai/json";
import { ServiceFault } from "../auth/errors";
import { PostgresResearchRepository } from "../research/repository";
import { CurriculumResearchEvidenceSchema, SourceClaimSchema, type CurriculumResearchEvidence, type SourceClaim } from "./contracts";
import type { CurriculumEvidenceFacts } from "./validation";

interface ClaimRow { id: string; owner_id: string; run_step_id: string | null; text: string; passage_ids: string[];
  outcome_ids: string[]; scope: unknown; support: string; unresolved_conflicts: unknown; created_at: Date | string }
const invalid = () => new ServiceFault(409, "revision_conflict", "curriculum.evidenceChanged");
function claimFromRow(row: ClaimRow): SourceClaim {
  return SourceClaimSchema.parse({ id: row.id, ownerId: row.owner_id, runStepId: row.run_step_id, text: row.text,
    passageIds: row.passage_ids, outcomeIds: row.outcome_ids, scope: row.scope, support: row.support,
    unresolvedConflicts: row.unresolved_conflicts, createdAt: new Date(row.created_at).toISOString() });
}

/** Source/claim reads are private. Callers must derive the authorization scope from saved records. */
export class PostgresCurriculumResearchRepository {
  constructor(private readonly sources = new PostgresResearchRepository()) {}

  async getClaim(tx: DbTransaction, ownerId: string, id: string): Promise<SourceClaim | null> {
    const row = (await tx.query<ClaimRow>("SELECT * FROM unfurl.source_claims WHERE id=$1 AND owner_id=$2", [id, ownerId])).rows[0];
    return row ? claimFromRow(row) : null;
  }

  async saveClaim(tx: DbTransaction, input: SourceClaim, authorizedSourceIds: ReadonlySet<string>): Promise<SourceClaim> {
    const claim = SourceClaimSchema.parse(input);
    if (!claim.runStepId) throw invalid();
    const authority = (await tx.query<{ owner_id: string }>(`SELECT COALESCE(turn.owner_id,build.owner_id) AS owner_id
      FROM unfurl.run_steps step JOIN unfurl.execution_jobs job ON job.id=step.job_id
      LEFT JOIN unfurl.agent_turn_runs turn ON turn.id=job.agent_turn_run_id
      LEFT JOIN unfurl.generation_runs build ON build.id=job.generation_run_id
      WHERE step.id=$1`, [claim.runStepId])).rows[0];
    if (authority?.owner_id !== claim.ownerId) throw invalid();
    for (const id of claim.passageIds) {
      const passage = await this.sources.getPassage(tx, id);
      if (!passage || !authorizedSourceIds.has(passage.sourceId)) throw invalid();
    }
    await tx.query(`INSERT INTO unfurl.source_claims
      (id,owner_id,run_step_id,text,passage_ids,outcome_ids,scope,support,unresolved_conflicts,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO NOTHING`,
    [claim.id, claim.ownerId, claim.runStepId, claim.text, claim.passageIds, claim.outcomeIds,
      JSON.stringify(claim.scope), claim.support, JSON.stringify(claim.unresolvedConflicts), claim.createdAt]);
    const stored = await this.getClaim(tx, claim.ownerId, claim.id);
    if (!stored || canonicalJson(stored) !== canonicalJson(claim)) throw invalid();
    return stored;
  }

  async saveEvidence(tx: DbTransaction, input: { draftId: string; revision: number; evidence: CurriculumResearchEvidence }): Promise<void> {
    const evidence = CurriculumResearchEvidenceSchema.parse(input.evidence);
    const document = canonicalJson(evidence, 2 * 1024 * 1024);
    await tx.query(`INSERT INTO unfurl.curriculum_revision_evidence(draft_id,revision,document)
      VALUES($1,$2,$3) ON CONFLICT(draft_id,revision) DO NOTHING`, [input.draftId, input.revision, document]);
    const stored = (await tx.query<{ document: unknown }>("SELECT document FROM unfurl.curriculum_revision_evidence WHERE draft_id=$1 AND revision=$2", [input.draftId, input.revision])).rows[0];
    if (!stored || canonicalJson(CurriculumResearchEvidenceSchema.parse(stored.document), 2 * 1024 * 1024) !== document) throw invalid();
  }

  async loadEvidence(tx: DbTransaction, input: { draft: CurriculumDraft; ownerId: string; allowPrevious?: boolean }): Promise<{ evidence: CurriculumResearchEvidence; facts: CurriculumEvidenceFacts }> {
    const { draft, ownerId } = input;
    const revision = (await tx.query<{ document: unknown }>(`SELECT revision.document FROM unfurl.curriculum_revisions revision
      JOIN unfurl.curriculum_drafts draft ON draft.id=revision.draft_id JOIN unfurl.courses course ON course.id=draft.course_id
      WHERE revision.draft_id=$1 AND revision.revision=$2 AND course.owner_id=$3`, [draft.id, draft.revision, ownerId])).rows[0];
    if (!revision || canonicalJson(CurriculumDraftSchema.parse(revision.document), 2 * 1024 * 1024) !== canonicalJson(draft, 2 * 1024 * 1024)) throw invalid();
    const row = (await tx.query<{ document: unknown }>(`SELECT evidence.document FROM unfurl.curriculum_revision_evidence evidence
      JOIN unfurl.curriculum_drafts draft ON draft.id=evidence.draft_id JOIN unfurl.courses course ON course.id=draft.course_id
      WHERE evidence.draft_id=$1 AND evidence.revision ${input.allowPrevious ? "<=" : "="} $2 AND course.owner_id=$3
      ORDER BY evidence.revision DESC LIMIT 1`, [draft.id, draft.revision, ownerId])).rows[0];
    if (!row) throw new ServiceFault(409, "revision_conflict", "curriculum.researchRequired", false, { currentRevision: draft.revision });
    const evidence = CurriculumResearchEvidenceSchema.parse(row.document);
    const claimIds = Array.from(new Set([...evidence.outcomeEvidence.flatMap((entry) => entry.claimIds), ...evidence.questionAnswers.flatMap((answer) => answer.claimIds)]));
    const claims = (await tx.query<ClaimRow>("SELECT * FROM unfurl.source_claims WHERE owner_id=$1 AND id=ANY($2::uuid[])", [ownerId, claimIds])).rows.map(claimFromRow);
    const passageIds = Array.from(new Set(claims.flatMap((claim) => claim.passageIds)));
    const passages = await this.sources.getPassages(tx, passageIds);
    // An immutable revision owned by this actor is itself a previously committed authorization binding.
    const authorizedSourceIds = new Set(draft.sourceIds);
    const sources = await this.sources.getSources(tx, draft.sourceIds);
    return { evidence, facts: { ownerId, authorizedSourceIds, claims, passages, sources } };
  }
}
