import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { LessonText } from "@/features/learning/player/LessonText";
import { TaskGuide, taskGuides } from "@/features/learning/player/TaskGuide";
import { productionMechanics } from "@/features/learning/registry";
import { PythonArtifactRenderer, PythonRepairRenderer } from "@/features/learning/mechanics/python/renderers";
import { toggleFaultLine } from "@/features/learning/mechanics/python/fault-regions";
import { pythonArtifactDescriptor, pythonRepairDescriptor, type PythonArtifactConfig, type PythonRepairConfig } from "@/domain/mechanic-families/v3/python";
import type { TaskPublic } from "@/domain";
import type { ActivityController } from "@/features/learning/player/contracts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const config: PythonArtifactConfig = { kind: "artifact_construction", artifactType: "python_function", language: "python", runtimeProfile: "python_stdlib_v1", entrypoint: "solve",
  specification: "Return the input value.", inputShape: { type: "number", integer: true, minimum: 0, maximum: 10 }, outputShape: { type: "number", integer: true, minimum: 0, maximum: 10 },
  starterSource: "def solve(payload):\n    return payload", publicCases: [{ id: "public-one", input: 3 }] };
const task: TaskPublic<PythonArtifactConfig> = { id: id(1), taskVersion: 1, mechanicId: "artifact_construction", mechanicVersion: 3, instruction: "Build the Python function", contentLanguage: "en", config, outcomeIds: [id(2)], availableHints: 1, responseSchemaVersion: 3 };
function activity(caseId = "public-one"): ActivityController {
  return { pending: false, error: null, dispatch: vi.fn(), retryAction: vi.fn(), session: { id: id(3), enrollmentId: id(4), taskId: id(1), taskVersion: 1,
    revision: 2, inputRevision: 1, status: "active", remainingActions: 3, events: [{ id: id(5), seq: 1, at: "2026-10-25T00:00:00.000Z", action: { kind: "run" }, receipt: {
      id: id(6), clientActionId: id(7), input: { activitySessionId: id(3), inputRevision: 1, responseDigest: "a".repeat(64) }, sessionRevision: 2, status: "completed",
      observation: { kind: "python_execution", runtimeProfile: "python_stdlib_v1", cases: [{ caseId, input: 3, result: { status: "ok", value: 3, stdout: "<script>output()</script>" } }] },
    } }] } };
}

describe("production player content boundaries", () => {
  it("renders lesson Markdown as safe React text and permits only HTTP links without credentials", () => {
    const html = renderToStaticMarkup(createElement(LessonText, { text: "# Read this\n\n<script>alert(1)</script>\n\n[unsafe](javascript:alert) [credentials](https://user:pass@example.com) [source](https://example.com/article)\n\n```python\nprint('<tag>')\n```" }));
    expect(html).not.toContain("<script>"); expect(html).not.toContain('href="javascript:'); expect(html).not.toContain('href="https://user:pass');
    expect(html).toContain('href="https://example.com/article"'); expect(html).toContain("&lt;script&gt;"); expect(html).toContain("<pre><code>");
  });

  it("provides a guide for every registered family, including Python's real execution workflow", () => {
    const families = [...new Set(productionMechanics.map((mechanic) => mechanic.id))];
    expect(families).toHaveLength(29);
    for (const family of families) expect(taskGuides[family]?.action).toBeTruthy();
    const html = renderToStaticMarkup(createElement(TaskGuide, { task }));
    expect(html).toContain("solve(payload)"); expect(html).toContain("Run public cases"); expect(html).toContain("Skip guide");
  });

  it("shows only authored public cases and treats an unverified run as historical", () => {
    const props = { task, response: { ...pythonArtifactDescriptor.createInitialResponse(config), source: "def solve(payload):\n    return 7" }, onChange: vi.fn(), disabled: false, status: "editing" as const, evaluation: null, activity: activity() };
    const html = renderToStaticMarkup(createElement(PythonArtifactRenderer, props));
    expect(html).toContain("Results from an earlier answer"); expect(html).not.toContain("Results for your current code");
    expect(html).toContain("Returned value"); expect(html).toContain("Printed output"); expect(html).not.toContain("<script>");
    const invalid = renderToStaticMarkup(createElement(PythonArtifactRenderer, { ...props, activity: activity("hidden-case") }));
    expect(invalid).not.toContain("Returned value"); expect(invalid).not.toContain("Printed output");
  });

  it("renders a recoverable execution outage without presenting it as an incorrect answer", () => {
    const port = activity(); port.session!.events[0]!.receipt = { ...port.session!.events[0]!.receipt, status: "unavailable", observation: null };
    const html = renderToStaticMarkup(createElement(PythonArtifactRenderer, { task, response: pythonArtifactDescriptor.createInitialResponse(config), onChange: vi.fn(), disabled: false, status: "editing", evaluation: null, activity: port }));
    expect(html).toContain("Retry this run"); expect(html).not.toContain("incorrect");
  });

  it("preserves original line references while displaying the learner's repair", () => {
    const repairConfig: PythonRepairConfig = { ...config, kind: "diagnosis_repair", starterSource: "def solve(payload):\n    return 0" };
    const repairTask: TaskPublic<PythonRepairConfig> = { ...task, mechanicId: "diagnosis_repair", config: repairConfig };
    const html = renderToStaticMarkup(createElement(PythonRepairRenderer, { task: repairTask,
      response: { ...pythonRepairDescriptor.createInitialResponse(repairConfig), locations: [{ startLine: 2, endLine: 2 }], source: config.starterSource, explanation: "Return the input." }, onChange: vi.fn(), disabled: false, status: "editing", evaluation: null }));
    expect(html).toContain('aria-label="Fault at line 2"'); expect(html).toContain("return 0"); expect(html).toContain("return payload"); expect(html).toContain("checked");
  });

  it("groups adjacent fault lines and splits only the deselected line", () => {
    expect(toggleFaultLine([{ startLine: 2, endLine: 4 }], 5)).toEqual([{ startLine: 2, endLine: 5 }]);
    expect(toggleFaultLine([{ startLine: 2, endLine: 5 }], 3)).toEqual([{ startLine: 2, endLine: 2 }, { startLine: 4, endLine: 5 }]);
    expect(toggleFaultLine([{ startLine: 2, endLine: 2 }, { startLine: 4, endLine: 5 }], 3)).toEqual([{ startLine: 2, endLine: 5 }]);
  });
});
