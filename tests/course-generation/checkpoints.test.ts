import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { z } from "zod";
import { AuthoredTaskSchema, ProposedTaskCasesSchema, prepareTaskCasesCheckpoint } from "@/server/course-generation/checkpoints";
import { ContentReviewSchema } from "@/server/course-validation/content-review";
import { ModuleKnowledgeSchema } from "@/server/course-generation/contracts";
import { id } from "./fixtures";

describe("durable authoring contracts", () => {
  it("uses stable case identities across replay without granting readiness", () => {
    const input = { candidateStepId: id(700), candidateDigest: "a".repeat(64), operationId: id(701),
      proposal: { cases: [ { key: "valid", category: "valid", response: { value: 1 } }, { key: "alternative", category: "alternative", response: { value: 1, approach: "different" } }, { key: "invalid", category: "invalid", response: { value: 2 } } ], alternativeSpaceProof: null } };
    expect(prepareTaskCasesCheckpoint(input)).toEqual(prepareTaskCasesCheckpoint(input));
    expect(new Set(prepareTaskCasesCheckpoint(input).cases.map((item) => item.caseId)).size).toBe(3);
    expect(JSON.stringify(prepareTaskCasesCheckpoint(input))).not.toContain("verdict");
  });
  it("rejects a case plan without an alternate answer or replayable proof", () => {
    expect(() => ProposedTaskCasesSchema.parse({ cases: [{ key: "valid", category: "valid", response: {} }, { key: "invalid", category: "invalid", response: {} }], alternativeSpaceProof: null })).toThrow();
  });
  it.each([AuthoredTaskSchema, ProposedTaskCasesSchema, ContentReviewSchema, ModuleKnowledgeSchema])("has an actual representable provider JSON schema", (schema) => {
    const json = z.toJSONSchema(schema);
    expect(json.type).toBe("object");
    expect(json.additionalProperties).toBe(false);
  });
});
