// @vitest-environment happy-dom
import { act, type PropsWithChildren } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CourseDetailPublic } from "../../src/domain/course";
import { CourseDetailPage } from "../../src/features/catalog/CourseDetailPage";
import { curriculum, ids } from "../domain/fixtures";
import { catalogService, course } from "./fixtures";

vi.mock("../../src/components/shell", () => ({ AppShell: ({ children }: PropsWithChildren) => <main>{children}</main> }));
vi.mock("../../src/features/account/account-session", () => ({
  useAccountEpoch: () => 0,
  useAccountSession: () => ({ status: "ready", session: null }),
}));

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });

function previewCourse(): CourseDetailPublic {
  const plan = curriculum();
  const first = plan.modules[0]!;
  return {
    ...course({ publisher: "Unfurl", moduleCount: 1, lessonCount: 1, estimatedStudyMinutes: 30 }),
    assumedKnowledge: plan.assumedKnowledge, outcomes: [plan.outcomes[0]!], modules: [first],
    release: {
      kind: "preview", availableModuleIds: [first.id], plannedModules: plan.modules,
      notice: "The first section is available. The remaining section has not been generated yet.",
      lessons: [{ id: ids.draft, moduleId: first.id, title: "Inspect real validation evidence", tasks: [
        { id: ids.task, instruction: "Compare the two error curves and explain your choice.", mechanicId: "self_explanation" },
      ] }],
    },
  };
}

async function show(value: CourseDetailPublic) {
  const services = catalogService({ getBySlug: vi.fn().mockResolvedValue({ ok: true, data: {
    kind: "ready", detail: { course: value, version: { id: ids.approval, number: 1 }, access: "public", enrollmentId: null },
  } }) });
  await act(async () => { root.render(<CourseDetailPage slug={value.slug} services={services} />); });
}

describe("official course preview", () => {
  it("offers only the available version and describes its real lessons and tasks", async () => {
    const value = previewCourse();
    await show(value);
    expect(container.textContent).toContain("Published by Unfurl");
    expect(container.textContent).toContain("Available content1 section, 1 lesson");
    expect(container.textContent).toContain("Available study time30 min");
    expect(container.textContent).toContain(value.release!.notice);
    expect(container.textContent).toContain("Inspect real validation evidence");
    expect(container.textContent).toContain("Compare the two error curves and explain your choice.");
    const start = [...container.querySelectorAll("a")].find((link) => link.textContent === "Start this course");
    expect(start?.getAttribute("href")).toBe(`/start/${ids.course}?version=${ids.approval}`);
    expect(container.querySelector(".uf-course-detail__program > ol > li > details")?.hasAttribute("open")).toBe(true);
    expect(container.querySelector(".uf-course-detail__activity")?.hasAttribute("open")).toBe(false);
  });

  it("keeps the unavailable outline readable without adding lesson or enrollment destinations", async () => {
    await show(previewCourse());
    const planned = container.querySelector(".uf-course-detail__planned")!;
    expect(planned.textContent).toContain("1 section not yet available");
    expect(planned.textContent).toContain(curriculum().modules[1]!.title);
    expect(planned.textContent).toContain(curriculum().modules[1]!.summary);
    expect(planned.textContent).not.toContain(curriculum().modules[0]!.title);
    expect(planned.querySelector("details")?.hasAttribute("open")).toBe(false);
    expect(planned.querySelector("li")?.getAttribute("value")).toBe("2");
    expect(planned.querySelectorAll("a, button, input")).toHaveLength(0);
  });

  it("does not label an ordinary full course as an official preview", async () => {
    const plan = curriculum();
    await show({ ...course(), assumedKnowledge: plan.assumedKnowledge, outcomes: plan.outcomes, modules: plan.modules });
    expect(container.textContent).toContain("The course at a glance");
    expect(container.textContent).toContain("Course content2 modules, 5 lessons");
    expect(container.textContent).not.toContain("Published by Unfurl");
    expect(container.querySelector(".uf-course-detail__planned")).toBeNull();
    expect(container.querySelector(".uf-course-detail__release-note")).toBeNull();
  });
});
