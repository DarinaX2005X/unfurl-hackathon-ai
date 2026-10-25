"use client";

import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { Button, Notice, Select, Textarea, TextField } from "@/components/ui";
import { validateCurriculum, type CurriculumDraft } from "@/domain/course";
import type { CurriculumEditBuffer } from "./curriculum-editor";

interface Props {
  buffer: CurriculumEditBuffer;
  disabled?: boolean;
  onChange: (buffer: CurriculumEditBuffer) => void;
}

function lines(value: string): string[] {
  return value.split("\n").map((item) => item.trim()).filter(Boolean);
}

export function CurriculumEditor({ buffer, disabled = false, onChange }: Props) {
  const draft = buffer.working;
  const issues = validateCurriculum(draft);
  const setDraft = (next: CurriculumDraft) => onChange({ ...buffer, working: next });
  const setQuestion = (id: string, answer: string) => onChange({ ...buffer, answers: { ...buffer.answers, [id]: answer } });
  const updateOutcome = (index: number, changes: Partial<CurriculumDraft["outcomes"][number]>) => {
    const outcomes = draft.outcomes.map((item, position) => position === index ? { ...item, ...changes } : item);
    setDraft({ ...draft, outcomes });
  };
  const updateModule = (index: number, changes: Partial<CurriculumDraft["modules"][number]>) => {
    const modules = draft.modules.map((item, position) => position === index ? { ...item, ...changes } : item);
    setDraft({ ...draft, modules });
  };
  const addOutcome = () => {
    const outcome = { id: crypto.randomUUID(), title: "New outcome", demonstration: "Describe how the learner will demonstrate this outcome.", prerequisiteOutcomeIds: [], requirement: "core" as const };
    const modules = draft.modules.map((item, index) => index === draft.modules.length - 1 ? { ...item, outcomeIds: [...item.outcomeIds, outcome.id] } : item);
    setDraft({ ...draft, outcomes: [...draft.outcomes, outcome], modules });
  };
  const removeOutcome = (id: string) => setDraft({
    ...draft,
    outcomes: draft.outcomes.filter((item) => item.id !== id),
    modules: draft.modules.map((item) => ({ ...item, outcomeIds: item.outcomeIds.filter((outcomeId) => outcomeId !== id) })),
  });
  const addModule = () => {
    const previous = draft.modules.at(-1);
    setDraft({ ...draft, modules: [...draft.modules, {
      id: crypto.randomUUID(), title: "New section", summary: "Describe what the learner will study and practise in this section.",
      outcomeIds: [draft.outcomes[0]!.id], prerequisiteModuleIds: previous ? [previous.id] : [], estimatedStudyMinutes: 30,
    }] });
  };
  const removeModule = (id: string) => setDraft({
    ...draft,
    modules: draft.modules.filter((item) => item.id !== id).map((item) => ({ ...item, prerequisiteModuleIds: item.prerequisiteModuleIds.filter((moduleId) => moduleId !== id) })),
  });
  const moveModule = (index: number, offset: -1 | 1) => {
    const destination = index + offset;
    if (destination < 0 || destination >= draft.modules.length) return;
    const modules = [...draft.modules];
    [modules[index], modules[destination]] = [modules[destination]!, modules[index]!];
    setDraft({ ...draft, modules });
  };

  return <div className="creator-program-editor">
    <section className="creator-program-editor__section">
      <h3>Purpose and audience</h3>
      <TextField id="program-title" label="Program title" value={draft.title} maxLength={120} disabled={disabled}
        onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
      <Textarea id="program-goal" label="Learning goal" value={draft.goal} maxLength={4000} disabled={disabled}
        onChange={(event) => setDraft({ ...draft, goal: event.target.value })} />
      <Textarea id="program-audience" label="Who this is for" value={draft.audience} maxLength={4000} disabled={disabled}
        onChange={(event) => setDraft({ ...draft, audience: event.target.value })} />
      <Textarea id="program-knowledge" label="Before you begin" hint="One item per line" value={draft.assumedKnowledge.join("\n")} maxLength={4000} disabled={disabled}
        onChange={(event) => setDraft({ ...draft, assumedKnowledge: lines(event.target.value) })} />
    </section>

    <section className="creator-program-editor__section">
      <div className="creator-program-editor__section-heading"><div><h3>Learning outcomes</h3><p>Keep each outcome concrete and demonstrable.</p></div><Button type="button" variant="secondary" size="compact" disabled={disabled} onClick={addOutcome}><Plus size={16} aria-hidden="true" />Add outcome</Button></div>
      <div className="creator-program-editor__cards">{draft.outcomes.map((outcome, index) => <fieldset className="creator-program-editor__card" key={outcome.id} disabled={disabled}>
        <legend>Outcome {index + 1}</legend>
        <TextField id={`outcome-${outcome.id}-title`} label="Outcome" value={outcome.title} maxLength={120} onChange={(event) => updateOutcome(index, { title: event.target.value })} />
        <Textarea id={`outcome-${outcome.id}-demonstration`} label="How the learner will demonstrate it" value={outcome.demonstration} maxLength={4000} onChange={(event) => updateOutcome(index, { demonstration: event.target.value })} />
        <Select id={`outcome-${outcome.id}-requirement`} label="Requirement" value={outcome.requirement} options={[{ value: "core", label: "Core" }, { value: "specialization", label: "Specialization" }]} onChange={(event) => updateOutcome(index, { requirement: event.target.value as "core" | "specialization" })} />
        {draft.outcomes.length > 1 && <div className="creator-program-editor__checks"><span>Prerequisite outcomes</span>{draft.outcomes.filter((item) => item.id !== outcome.id).map((candidate) => <label key={candidate.id}><input type="checkbox" checked={outcome.prerequisiteOutcomeIds.includes(candidate.id)} onChange={(event) => updateOutcome(index, { prerequisiteOutcomeIds: event.target.checked ? [...outcome.prerequisiteOutcomeIds, candidate.id] : outcome.prerequisiteOutcomeIds.filter((id) => id !== candidate.id) })} />{candidate.title}</label>)}</div>}
        <Button type="button" variant="quiet" size="compact" disabled={draft.outcomes.length === 1} onClick={() => removeOutcome(outcome.id)}><Trash2 size={16} aria-hidden="true" />Remove outcome</Button>
      </fieldset>)}</div>
    </section>

    <section className="creator-program-editor__section">
      <div className="creator-program-editor__section-heading"><div><h3>Learning sequence</h3><p>Order sections and connect each one to its outcomes.</p></div><Button type="button" variant="secondary" size="compact" disabled={disabled} onClick={addModule}><Plus size={16} aria-hidden="true" />Add section</Button></div>
      <div className="creator-program-editor__cards">{draft.modules.map((module, index) => <fieldset className="creator-program-editor__card" key={module.id} disabled={disabled}>
        <legend>Section {index + 1}</legend>
        <div className="creator-program-editor__order"><Button type="button" variant="quiet" size="compact" disabled={index === 0} onClick={() => moveModule(index, -1)}><ArrowUp size={16} aria-hidden="true" />Earlier</Button><Button type="button" variant="quiet" size="compact" disabled={index === draft.modules.length - 1} onClick={() => moveModule(index, 1)}><ArrowDown size={16} aria-hidden="true" />Later</Button></div>
        <TextField id={`module-${module.id}-title`} label="Section title" value={module.title} maxLength={120} onChange={(event) => updateModule(index, { title: event.target.value })} />
        <Textarea id={`module-${module.id}-summary`} label="What this section covers" value={module.summary} maxLength={4000} onChange={(event) => updateModule(index, { summary: event.target.value })} />
        <TextField id={`module-${module.id}-minutes`} type="number" min={1} step={1} label="Estimated study time (minutes)" value={String(module.estimatedStudyMinutes)} onChange={(event) => updateModule(index, { estimatedStudyMinutes: Number(event.target.value) })} />
        <div className="creator-program-editor__checks"><span>Outcomes covered</span>{draft.outcomes.map((outcome) => <label key={outcome.id}><input type="checkbox" checked={module.outcomeIds.includes(outcome.id)} onChange={(event) => updateModule(index, { outcomeIds: event.target.checked ? [...module.outcomeIds, outcome.id] : module.outcomeIds.filter((id) => id !== outcome.id) })} />{outcome.title}</label>)}</div>
        {index > 0 && <div className="creator-program-editor__checks"><span>Prerequisite sections</span>{draft.modules.slice(0, index).map((candidate) => <label key={candidate.id}><input type="checkbox" checked={module.prerequisiteModuleIds.includes(candidate.id)} onChange={(event) => updateModule(index, { prerequisiteModuleIds: event.target.checked ? [...module.prerequisiteModuleIds, candidate.id] : module.prerequisiteModuleIds.filter((id) => id !== candidate.id) })} />{candidate.title}</label>)}</div>}
        <Button type="button" variant="quiet" size="compact" disabled={draft.modules.length === 1} onClick={() => removeModule(module.id)}><Trash2 size={16} aria-hidden="true" />Remove section</Button>
      </fieldset>)}</div>
    </section>

    {draft.unresolvedQuestions.length > 0 && <section className="creator-program-editor__section"><h3>Questions to resolve</h3><p>Answers are reviewed before they become part of the program.</p>{draft.unresolvedQuestions.map((question) => <Textarea key={question.id} id={`question-${question.id}`} label={question.text} hint={question.blocking ? "Required before approval" : undefined} value={buffer.answers[question.id] ?? ""} maxLength={4000} disabled={disabled} onChange={(event) => setQuestion(question.id, event.target.value)} />)}</section>}
    {issues.length > 0 && <Notice tone="warning" title="This program needs a little more work"><ul>{issues.slice(0, 4).map((issue, index) => <li key={`${issue.code}-${index}`}>{issue.message}</li>)}</ul></Notice>}
  </div>;
}
