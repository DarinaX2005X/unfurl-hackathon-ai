import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CourseVisibilityState } from "../../src/domain/progression";
import { CourseVisibilityControls } from "../../src/features/sharing/CourseVisibilityControls";
import { ids } from "../domain/fixtures";

function visibilityState(overrides: Partial<CourseVisibilityState> = {}): CourseVisibilityState {
  return {
    courseId: ids.course, visibility: "private", revision: 4, currentReadyVersionId: ids.draft, publishedVersionId: null,
    progress: { xpTotal: 0, level: 2, xpToNextLevel: 40,
      publication: { eligible: false, requiredLevel: 3, reasons: ["level_required"] } },
    ...overrides,
  };
}
function render(state: CourseVisibilityState, options: { choice?: "private" | "unlisted" | "public"; selected?: string | null; locked?: boolean } = {}) {
  return renderToStaticMarkup(<CourseVisibilityControls state={state} choice={options.choice ?? state.visibility}
    selectedVersionId={options.selected ?? null} displayedVersionId={ids.draft} displayedVersionNumber={3}
    pending={false} locked={options.locked ?? false} blocked={false} error={null}
    onChoice={() => {}} onSelectVersion={() => {}} onSave={() => {}} />);
}

describe("owner visibility controls", () => {
  it("shows saved state and revision, explains every access mode, and gates public from server progress", () => {
    const html = render(visibilityState());
    expect(html).toContain("Saved as <strong>Private</strong> · Revision 4");
    expect(html).toContain("Saving this revokes active access links; existing enrollments keep their course.");
    expect(html).toContain("Choosing Unlisted does not create one.");
    expect(html).toContain("Public sharing unlocks at Level 3. Your current level is 2.");
    expect(html).toContain("<label aria-disabled=\"true\"><input type=\"radio\" disabled=\"\"");
    expect(html).toContain("<strong>Public</strong>");
    expect(html).not.toContain("XP");
  });

  it("requires an explicit displayed-version choice before an eligible public save", () => {
    const eligible = visibilityState({ progress: { xpTotal: 600, level: 3, xpToNextLevel: 200,
      publication: { eligible: true, requiredLevel: 3, reasons: [] } } });
    const unselected = render(eligible, { choice: "public" });
    const selected = render(eligible, { choice: "public", selected: ids.draft });
    expect(unselected).toContain("Version to publish");
    expect(unselected).toContain("Version 3");
    expect(unselected).toMatch(/Save visibility<\/span>.*disabled|disabled=""[^>]*>.*Save visibility/s);
    expect(selected).toContain("The ready version displayed on this page");
    expect(selected).toContain("Unsaved choice");
  });

  it("locks choices but exposes the same mutation as a retry after an unknown response", () => {
    const eligible = visibilityState({ progress: { xpTotal: 600, level: 3, xpToNextLevel: 200,
      publication: { eligible: true, requiredLevel: 3, reasons: [] } } });
    const html = render(eligible, { choice: "public", selected: ids.draft, locked: true });
    expect(html).toContain("Retry saved change");
    expect(html).toContain("<fieldset class=\"uf-visibility__choices\" disabled=\"\"");
  });
});
