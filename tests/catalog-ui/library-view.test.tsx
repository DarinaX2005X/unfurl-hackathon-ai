import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { LibraryItem } from "../../src/application/ports";
import { LibraryCollection } from "../../src/features/library/LibraryCollection";
import type { LibraryState } from "../../src/features/library/library-controller";
import { course } from "./fixtures";
import { timestamp } from "../domain/fixtures";

const enrollmentId = "00000000-0000-4000-8000-000000000097";

function render(state: LibraryState, q = "") { return renderToStaticMarkup(<LibraryCollection state={state} query={{ q }} view="all" onRetry={() => {}} onReset={() => {}} />); }
describe("library state presentation", () => {
  it("distinguishes unavailable, failed, genuinely empty and no-match states", () => {
    const unavailable = render({ status: "unavailable", items: [], refreshing: false });
    const error = render({ status: "error", items: [], refreshing: false });
    const empty = render({ status: "ready", items: [], refreshing: false });
    const noMatch = render({ status: "ready", items: [{ kind: "owned", course: course() }], refreshing: false }, "astronomy");
    expect(unavailable).toContain("Your library is unavailable");
    expect(unavailable).not.toContain("No courses in your library yet");
    expect(error).toContain("Your courses couldn’t be loaded");
    expect(empty).toContain("No courses in your library yet");
    expect(noMatch).toContain("No courses match your search");
    expect(noMatch).toContain("Reset filters");
    for (const html of [unavailable, error, empty, noMatch]) expect(html).not.toMatch(/New draft|Rename draft|Delete draft|On this device|course_request/);
  });
  it("renders actual enrollments before owned courses with real continuation links and no fake progress", () => {
    const items: LibraryItem[] = [{ kind: "owned", course: course({ title: "Created course" }) }, { kind: "enrolled", course: course({ title: "Already learning" }), enrollmentId, lastStudiedAt: timestamp }];
    const html = render({ status: "ready", items, refreshing: false });
    expect(html.indexOf("Continue learning")).toBeLessThan(html.indexOf("Created by you"));
    expect(html).toContain(`/learn/${enrollmentId}`);
    expect(html).toContain("Continue course");
    expect(html).not.toContain("<progress");
    expect(html).not.toContain("% complete");
  });
  it("keeps already-loaded course actions available alongside a failed refresh", () => {
    const html = render({ status: "error", items: [{ kind: "owned", course: course() }], refreshing: false });
    expect(html).toContain("Your library could not be refreshed");
    expect(html).toContain("View course");
    expect(html).toContain("/courses/model-evaluation");
  });
  it("keeps a no-match result clear when refreshing the retained collection fails", () => {
    const html = render({ status: "error", items: [{ kind: "owned", course: course() }], refreshing: false }, "astronomy");
    expect(html).toContain("Your library could not be refreshed");
    expect(html).toContain("No courses match your search");
    expect(html).toContain("Reset filters");
    expect(html).not.toContain("View course");
  });
});
