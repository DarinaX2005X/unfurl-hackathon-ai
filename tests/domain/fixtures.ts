import type { CurriculumDraft } from "../../src/domain/course";

export const ids = {
  draft: "10000000-0000-4000-8000-000000000001",
  course: "10000000-0000-4000-8000-000000000002",
  conversation: "10000000-0000-4000-8000-000000000003",
  outcomeA: "10000000-0000-4000-8000-000000000004",
  outcomeB: "10000000-0000-4000-8000-000000000005",
  moduleA: "10000000-0000-4000-8000-000000000006",
  moduleB: "10000000-0000-4000-8000-000000000007",
  source: "10000000-0000-4000-8000-000000000008",
  approval: "10000000-0000-4000-8000-000000000009",
  actor: "10000000-0000-4000-8000-00000000000a",
  question: "10000000-0000-4000-8000-00000000000b",
  task: "10000000-0000-4000-8000-00000000000c",
  attempt: "10000000-0000-4000-8000-00000000000d",
  request: "10000000-0000-4000-8000-00000000000e",
  sample: "10000000-0000-4000-8000-00000000000f",
  evaluation: "10000000-0000-4000-8000-000000000010",
  missing: "10000000-0000-4000-8000-000000000011",
} as const;

export const timestamp = "2026-10-24T12:00:00.000Z";

export function curriculum(): CurriculumDraft {
  return {
    id: ids.draft,
    courseId: ids.course,
    conversationId: ids.conversation,
    revision: 1,
    title: "From model fitting to reliable AI systems",
    contentLanguage: "en",
    goal: "Build and assess a small model using evidence from held-out data.",
    audience: "A programmer beginning to study machine learning.",
    assumedKnowledge: ["Basic algebra", "Reading a simple chart"],
    outcomes: [
      {
        id: ids.outcomeA,
        title: "Distinguish fit from generalization",
        demonstration: "Compare training and validation error and explain their different roles.",
        prerequisiteOutcomeIds: [],
        requirement: "core",
      },
      {
        id: ids.outcomeB,
        title: "Select a suitable model capacity",
        demonstration: "Adjust model capacity and justify a choice with validation evidence.",
        prerequisiteOutcomeIds: [ids.outcomeA],
        requirement: "core",
      },
    ],
    modules: [
      {
        id: ids.moduleA,
        title: "What fitting tells us",
        summary: "Read training and validation error for a concrete model.",
        outcomeIds: [ids.outcomeA],
        prerequisiteModuleIds: [],
        estimatedStudyMinutes: 30,
      },
      {
        id: ids.moduleB,
        title: "Choose a useful level of complexity",
        summary: "Change capacity and regularization, then compare the evidence.",
        outcomeIds: [ids.outcomeB],
        prerequisiteModuleIds: [ids.moduleA],
        estimatedStudyMinutes: 45,
      },
    ],
    unresolvedQuestions: [],
    sourceIds: [ids.source],
    updatedAt: timestamp,
  };
}
