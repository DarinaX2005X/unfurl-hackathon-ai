"use client";

import { useState } from "react";
import { Pencil } from "lucide-react";
import { Button, Dialog, Notice, Select, Textarea, TextField } from "@/components/ui";
import type { CourseArtifactRef, EditCourseMetadata } from "@/domain/chat";
import type { CurriculumApproval } from "@/domain/course";
import { CurriculumPanel, type ApproveCurriculum } from "./CurriculumPanel";
import { editExistingCourseMetadata } from "./artifact-mutations";
import { languageLabel, languageOptions } from "./languages";

interface Props {
  artifacts: CourseArtifactRef[];
  selectedCourseId: string | null;
  onSelect: (courseId: string) => void;
  getCurrentArtifact: (courseId: string) => CourseArtifactRef | undefined;
  onArtifactChange: (artifact: CourseArtifactRef) => Promise<boolean>;
  onApproval: (courseId: string, approval: CurriculumApproval) => Promise<boolean>;
  onApprove?: ApproveCurriculum;
  onEditMetadata?: EditCourseMetadata;
  awaitingSnapshotCourseIds?: string[];
}

export function CourseArtifactsPanel({ artifacts, selectedCourseId, onSelect, getCurrentArtifact, onArtifactChange, onApproval, onApprove, onEditMetadata, awaitingSnapshotCourseIds = [] }: Props) {
  const selected = artifacts.find((artifact) => artifact.courseId === selectedCourseId) ?? artifacts[0];
  const [editing, setEditing] = useState<CourseArtifactRef | null>(null);
  const [values, setValues] = useState({ title: "", summary: "", contentLanguage: "en" });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!selected) return null;

  async function saveMetadata() {
    if (!editing || !onEditMetadata || pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await editExistingCourseMetadata(editing, values, getCurrentArtifact, onEditMetadata);
      if (!await onArtifactChange(result)) throw new Error("The chat could not retain these details");
      setEditing(null);
    } catch { setError("The update couldn’t be confirmed. Your changes are still here. Reopen the current course details before trying again."); }
    finally { setPending(false); }
  }

  const approve: ApproveCurriculum | undefined = onApprove ? async (input) => {
    const receipt = await onApprove(input);
    if (!await onApproval(input.courseId, receipt)) throw new Error("This program changed before approval was confirmed");
    return receipt;
  } : undefined;
  const curriculum = selected.curriculum;

  return <section className="creator-artifacts" aria-label="Courses in this chat">
    <div className="creator-artifacts__selection"><Select id="chat-course" label="Courses in this chat" value={selected.courseId} options={artifacts.map((artifact) => ({ value: artifact.courseId, label: artifact.title }))} onChange={(event) => onSelect(event.target.value)} /></div>
    <header className="creator-artifacts__heading"><h2>{selected.title}</h2><p>{selected.summary}</p><div className="creator-artifacts__metadata"><span>{languageLabel(selected.contentLanguage)}</span>{onEditMetadata && <Button variant="quiet" size="compact" onClick={() => { setEditing(selected); setValues({ title: selected.title, summary: selected.summary, contentLanguage: selected.contentLanguage }); setError(null); }}><Pencil size={16} aria-hidden="true" />Edit details</Button>}</div></header>
    {curriculum ? <CurriculumPanel key={selected.courseId} draft={curriculum} currentRevision={curriculum.revision}
      awaitingApproval={selected.approvalRequestedRevision === curriculum.revision && !awaitingSnapshotCourseIds.includes(selected.courseId)} approval={selected.approval} showTitle={false}
      {...(approve ? { onApprove: approve } : {})} /> : <p className="creator-artifacts__no-program">This course doesn’t have a program to review yet.</p>}
    <Dialog open={editing !== null} onOpenChange={(open) => { if (!open && !pending) setEditing(null); }} title="Edit course details" footer={<><Button variant="quiet" onClick={() => setEditing(null)} disabled={pending}>Cancel</Button><Button pending={pending} disabled={!values.title.trim() || !values.summary.trim()} onClick={() => void saveMetadata()}>Save changes</Button></>}>
      <div className="creator-metadata-form"><TextField id="course-title" label="Title" value={values.title} maxLength={120} onChange={(event) => setValues({ ...values, title: event.target.value })} /><Textarea id="course-summary" label="Description" value={values.summary} maxLength={4000} onChange={(event) => setValues({ ...values, summary: event.target.value })} /><Select id="course-content-language" label="Course language" value={values.contentLanguage} options={languageOptions(values.contentLanguage)} onChange={(event) => setValues({ ...values, contentLanguage: event.target.value })} />{error && <Notice tone="error">{error}</Notice>}</div>
    </Dialog>
  </section>;
}
