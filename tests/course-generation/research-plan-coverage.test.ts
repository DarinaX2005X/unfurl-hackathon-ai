import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { assertResearchPlanCoverage } from "@/server/course-generation/research-stages";
import { ModuleResearchPlanSchema } from "@/server/course-generation/planning";
import { KnowledgeCoverageReviewSchema } from "@/server/course-validation/knowledge";
import { id, digest } from "./fixtures";

const moduleId = id(101), outcomes = [id(100), id(200)];
const plan = () => ModuleResearchPlanSchema.parse({ moduleId, queries: [
  { key: "numpy-profile-view-copy", query: "NumPy profile copies and views", domainHints: [], outcomeIds: [outcomes[0]], knowledgeGap: "Profiling performance" },
  { key: "numpy-contiguity-memory-performance", query: "NumPy layout performance", domainHints: [], outcomeIds: [outcomes[0]], knowledgeGap: "Memory usage" },
] });
const review = (outcomeId: string, status: "passed" | "failed" | "uncertain") => KnowledgeCoverageReviewSchema.parse({ outcomeId,
  knowledgeDigest: digest, checks: ["approved_scope", "criteria", "source_support"].map(category => ({ category, status,
    explanation: "Saved review finding", correction: status === "passed" ? null : "Research the documented gap",
    evidence: [{ path: ["knowledge"], value: "synthetic evidence" }] })), invalidCriteria: [], unsupportedClaimIds: [], publicCommentary: null });

it("accepts the observed targeted repair while preserving the saved plan bytes", () => {
  const saved = plan(), before = JSON.stringify(saved);
  expect(() => assertResearchPlanCoverage(saved, moduleId, outcomes, [review(outcomes[0]!, "failed"), review(outcomes[1]!, "passed")])).not.toThrow();
  expect(JSON.stringify(saved)).toBe(before);
});

it("still requires all approved outcomes for initial research", () => {
  const saved = plan();
  expect(() => assertResearchPlanCoverage(saved, moduleId, outcomes)).toThrow("provider.invalid_output");
  saved.queries[1]!.outcomeIds.push(outcomes[1]!);
  expect(() => assertResearchPlanCoverage(saved, moduleId, outcomes)).not.toThrow();
});

it.each(["failed", "uncertain"] as const)("does not skip a second %s outcome", status => {
  const saved = plan(), reviews = [review(outcomes[0]!, "failed"), review(outcomes[1]!, status)];
  expect(() => assertResearchPlanCoverage(saved, moduleId, outcomes, reviews)).toThrow("provider.invalid_output");
  saved.queries[1]!.outcomeIds.push(outcomes[1]!);
  expect(() => assertResearchPlanCoverage(saved, moduleId, outcomes, reviews)).not.toThrow();
});

it.each(["foreign outcome", "foreign module", "duplicate query", "missing review", "duplicate review", "foreign review"])("rejects %s during targeted repair", reason => {
  const saved = plan(), reviews = [review(outcomes[0]!, "failed"), review(outcomes[1]!, "passed")];
  if (reason === "foreign outcome") saved.queries[0]!.outcomeIds.push(id(999));
  if (reason === "foreign module") saved.moduleId = id(999);
  if (reason === "duplicate query") saved.queries[1]!.key = saved.queries[0]!.key;
  if (reason === "missing review") reviews.pop();
  if (reason === "duplicate review") reviews[1] = reviews[0]!;
  if (reason === "foreign review") reviews[1] = review(id(999), "passed");
  expect(() => assertResearchPlanCoverage(saved, moduleId, outcomes, reviews)).toThrow("provider.invalid_output");
});
