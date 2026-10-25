import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { createInitialLearningRoute, createNormalProgramEntries } from '@/server/learning/initial-route';
import { program } from './fixtures';

describe("atomic enrollment route initializer", () => {
  it("validates a persisted generation program before readiness without a learner identity", () => {
    const input = program();
    const expected = createInitialLearningRoute(input).route.next;
    const { enrollmentId: _enrollment, ...candidate } = input;
    void _enrollment;
    candidate.version = { ...candidate.version, state: "validating", readyAt: null };
    expect(createNormalProgramEntries(candidate).next).toEqual(expected);
    candidate.lessons[0]!.blocks = [];
    expect(() => createNormalProgramEntries(candidate)).toThrow("normal lesson");
  });
  it("preserves version and authored task-block order, reading and all branches, excluding optional support", () => {
    const input = program();
    const before = structuredClone(input);
    input.lessons.reverse();
    const result = createInitialLearningRoute(input);
    expect(result.route.next.map(({ taskId }) => taskId)).toEqual([null, input.tasks[2]!.task.id, input.tasks[0]!.task.id]);
    expect(result.currentLessonId).toBe(input.version.lessonIds[0]);
    expect(result.currentTaskId).toBeNull();
    expect(result.route.targetOutcomeIds).toEqual(input.version.outcomes.map(({ id }) => id));
    expect(result.route.pendingOutcomeIds).toEqual(result.route.targetOutcomeIds);
    expect(result.route.coveredOutcomeIds).toEqual([]);
    expect(result.route.revision).toBe(1);
    expect(input.version).toEqual(before.version);
  });
  it("rejects missing, extra, duplicate and cross-version material rather than omitting it", () => {
    const input = program();
    for (const mutate of [
      (value: ReturnType<typeof program>) => { value.lessons.pop(); },
      (value: ReturnType<typeof program>) => { value.tasks.push(value.tasks[0]!); },
      (value: ReturnType<typeof program>) => { value.lessons[0]!.courseVersionId = crypto.randomUUID(); },
      (value: ReturnType<typeof program>) => { value.lessons[1]!.taskIds.pop(); },
      (value: ReturnType<typeof program>) => { value.tasks[0]!.assessment.outcomes[0]!.outcomeId = crypto.randomUUID(); },
      (value: ReturnType<typeof program>) => { value.version.state = "validating"; value.version.readyAt = null; },
    ]) {
      const invalid = structuredClone(input); mutate(invalid);
      expect(() => createInitialLearningRoute(invalid)).toThrow();
    }
  });
  it("rejects optional-only empty normal lessons and uncovered approved outcomes", () => {
    const input = program();
    input.lessons[0]!.blocks = [];
    expect(() => createInitialLearningRoute(input)).toThrow("normal lesson");
    const other = program();
    other.tasks.forEach(({ assessment }) => { assessment.role = "practice"; });
    expect(() => createInitialLearningRoute(other)).toThrow("required assessment");
  });
});
