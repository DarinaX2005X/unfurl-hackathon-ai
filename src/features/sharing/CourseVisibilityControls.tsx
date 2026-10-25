import { Globe2, Link2, LockKeyhole } from "lucide-react";
import type { Visibility } from "@/domain/common";
import type { CourseVisibilityState } from "@/domain/progression";
import { Button, Notice } from "@/components/ui";

const names: Record<Visibility, string> = { private: "Private", unlisted: "Unlisted", public: "Public" };

export function visibilityHasChanges(state: CourseVisibilityState, choice: Visibility, selectedVersionId: string | null): boolean {
  const publishedVersionId = choice === "public" ? selectedVersionId : null;
  return state.visibility !== choice || state.publishedVersionId !== publishedVersionId;
}

export function CourseVisibilityControls({ state, choice, selectedVersionId, displayedVersionId, displayedVersionNumber,
  pending, locked, blocked, error, onChoice, onSelectVersion, onSave }: {
  state: CourseVisibilityState; choice: Visibility; selectedVersionId: string | null;
  displayedVersionId: string; displayedVersionNumber: number; pending: boolean; locked: boolean; blocked: boolean; error: string | null;
  onChoice: (visibility: Visibility) => void; onSelectVersion: () => void; onSave: () => void;
}) {
  const eligible = state.progress.publication.eligible;
  const versionChosen = choice !== "public" || selectedVersionId === displayedVersionId;
  const changed = visibilityHasChanges(state, choice, selectedVersionId);
  const controlsLocked = pending || locked || blocked;
  return <section className="uf-visibility" aria-labelledby="course-visibility-heading">
    <div className="uf-visibility__heading"><div><h3 id="course-visibility-heading">Course visibility</h3>
      <p>Saved as <strong>{names[state.visibility]}</strong> · Revision {state.revision}</p></div>
      {changed && <span className="uf-visibility__unsaved">Unsaved choice</span>}
    </div>
    {error && <Notice tone="error">{error}</Notice>}
    <fieldset className="uf-visibility__choices" disabled={controlsLocked}><legend>Who can open this course?</legend>
      <label><input type="radio" name={`visibility-${state.courseId}`} checked={choice === "private"} onChange={() => onChoice("private")} />
        <span className="uf-visibility__icon"><LockKeyhole size={19} aria-hidden="true" /></span><span><strong>Private</strong><small>Only you can open the course. Saving this revokes active access links; existing enrollments keep their course.</small></span></label>
      <label><input type="radio" name={`visibility-${state.courseId}`} checked={choice === "unlisted"} onChange={() => onChoice("unlisted")} />
        <span className="uf-visibility__icon"><Link2 size={19} aria-hidden="true" /></span><span><strong>Unlisted</strong><small>People need an active link. Choosing Unlisted does not create one.</small></span></label>
      <label aria-disabled={!eligible || undefined}><input type="radio" name={`visibility-${state.courseId}`} checked={choice === "public"}
        disabled={!eligible} onChange={() => onChoice("public")} />
        <span className="uf-visibility__icon"><Globe2 size={19} aria-hidden="true" /></span><span><strong>Public</strong><small>Anyone can find and open the ready version you select.</small></span></label>
    </fieldset>
    <p className={`uf-visibility__gate${eligible ? " uf-visibility__gate--ready" : ""}`}>{eligible
      ? `Your Level ${state.progress.level} account can publish a ready course.`
      : `Public sharing unlocks at Level ${state.progress.publication.requiredLevel}. Your current level is ${state.progress.level}.`}</p>
    {choice === "public" && <fieldset className="uf-visibility__version" disabled={controlsLocked || !eligible}><legend>Version to publish</legend>
      <label><input type="radio" name={`published-version-${state.courseId}`} checked={selectedVersionId === displayedVersionId} onChange={onSelectVersion} />
        <span><strong>Version {displayedVersionNumber}</strong><small>The ready version displayed on this page</small></span></label>
      {state.publishedVersionId && state.publishedVersionId !== displayedVersionId && selectedVersionId !== displayedVersionId
        && <p>Another version is currently public. Select the displayed version to replace it.</p>}
    </fieldset>}
    <div className="uf-visibility__save"><Button pending={pending} disabled={blocked || !changed || !versionChosen || (choice === "public" && !eligible)} onClick={onSave}>
      {locked ? "Retry saved change" : "Save visibility"}</Button>
      <p>Nothing changes until you save.</p>
    </div>
  </section>;
}
