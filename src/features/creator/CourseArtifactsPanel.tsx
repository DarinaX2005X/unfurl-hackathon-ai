"use client";

import { useEffect, useState } from "react";
import { Languages, Pencil } from "lucide-react";
import { Button, Dialog, LinkButton, Notice, Select, Textarea, TextField } from "@/components/ui";
import type { CatalogPort } from "@/application/catalog-port";
import { httpCatalog } from "@/application/http-catalog";
import type { CurriculumPort } from "@/application/curriculum-port";
import { httpCurriculum } from "@/application/http-curriculum";
import type { CourseArtifactRef, EditCourseMetadata } from "@/domain/chat";
import type { CurriculumApproval } from "@/domain/course";
import type { CurriculumAuthoringSnapshot } from "@/domain/curriculum-authoring";
import type { CourseDetailResult } from "@/domain/catalog";
import { accountScope } from "@/features/account/account-scope";
import { routes } from "@/lib/routes";
import { CurriculumPanel, type ApproveCurriculum } from "./CurriculumPanel";
import { CurriculumEditor } from "./CurriculumEditor";
import { createCurriculumEditBuffer, curriculumPatchForBuffer, rebaseCurriculumPatch, type CurriculumEditBuffer } from "./curriculum-editor";
import { editExistingCourseMetadata } from "./artifact-mutations";
import { languageLabel, languageOptions } from "./languages";
import { createGenerationStreamState, generationStreamReducer, type GenerationStreamState } from "./generation-stream";
import { cancelGenerationRun, getGenerationSnapshot, readGenerationEvents, retryGenerationRun } from "./generation-observer-client";
import { createStreamState, creatorStreamReducer, type CreatorStreamState } from "./stream";
import { cancelRun, getRunSnapshot, readRunEvents, retryRun } from "./run-observer-client";

interface Props {
  actorId?: string;
  artifacts: CourseArtifactRef[];
  selectedCourseId: string | null;
  onSelect: (courseId: string) => void;
  getCurrentArtifact: (courseId: string) => CourseArtifactRef | undefined;
  onArtifactChange: (artifact: CourseArtifactRef) => Promise<boolean>;
  onApproval: (courseId: string, approval: CurriculumApproval) => Promise<boolean>;
  onApprove?: ApproveCurriculum;
  onEditMetadata?: EditCourseMetadata;
  curriculumPort?: CurriculumPort;
  catalog?: CatalogPort;
  awaitingSnapshotCourseIds?: string[];
}

interface AuthoringEntry { status: "loading" | "ready" | "error"; snapshot: CurriculumAuthoringSnapshot | null }
interface EditEntry { buffer: CurriculumEditBuffer; key: string; pending: boolean; error: string | null; conflict: CurriculumAuthoringSnapshot | null }
interface ReadyEntry { status: "loading" | "ready" | "error"; result: CourseDetailResult | null }

function errorMessage(code?: string): string {
  if (code === "revision_conflict") return "The program changed in another session. Your edits are still here.";
  if (code === "service_unavailable") return "The service is temporarily unavailable. Your edits are still here; try again.";
  return "The change could not be confirmed. Your edits are still here.";
}

export function CourseArtifactsPanel({ actorId, artifacts, selectedCourseId, onSelect, getCurrentArtifact, onArtifactChange, onApproval, onApprove, onEditMetadata, curriculumPort = httpCurriculum, catalog = httpCatalog, awaitingSnapshotCourseIds = [] }: Props) {
  const selected = artifacts.find((artifact) => artifact.courseId === selectedCourseId) ?? artifacts[0];
  const [authoring, setAuthoring] = useState<Record<string, AuthoringEntry>>({});
  const [programCourseId, setProgramCourseId] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, EditEntry>>({});
  const [metadataCourseId, setMetadataCourseId] = useState<string | null>(null);
  const [metadata, setMetadata] = useState({ title: "", summary: "" });
  const [metadataKey, setMetadataKey] = useState(() => crypto.randomUUID());
  const [metadataPending, setMetadataPending] = useState(false);
  const [metadataError, setMetadataError] = useState<string | null>(null);
  const [languageCourseId, setLanguageCourseId] = useState<string | null>(null);
  const [language, setLanguage] = useState("en");
  const [languageKey, setLanguageKey] = useState(() => crypto.randomUUID());
  const [languagePending, setLanguagePending] = useState(false);
  const [languageError, setLanguageError] = useState<string | null>(null);
  const [ready, setReady] = useState<Record<string, ReadyEntry>>({});
  const [startPending, setStartPending] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [generationStreams, setGenerationStreams] = useState<Record<string, GenerationStreamState>>({});
  const [generationError, setGenerationError] = useState<Record<string, boolean>>({});
  const [cancelPending, setCancelPending] = useState(false);
  const [retryPending, setRetryPending] = useState(false);
  const [retryError, setRetryError] = useState<Record<string, boolean>>({});
  const [retryKeys, setRetryKeys] = useState<Record<string, string>>({});
  const [authoringStreams, setAuthoringStreams] = useState<Record<string, CreatorStreamState>>({});
  const [authoringConnectionError, setAuthoringConnectionError] = useState<Record<string, boolean>>({});
  const [authoringCommandError, setAuthoringCommandError] = useState<Record<string, boolean>>({});
  const [authoringCommandPending, setAuthoringCommandPending] = useState(false);
  const [authoringRetryKeys, setAuthoringRetryKeys] = useState<Record<string, string>>({});
  const [approvalKeys, setApprovalKeys] = useState<Record<string, string>>({});

  async function fetchAuthoring(courseId: string, draftId: string, force = false): Promise<CurriculumAuthoringSnapshot | null> {
    if (!actorId) return null;
    if (!force && authoring[courseId]?.status === "loading") return null;
    setAuthoring((current) => ({ ...current, [courseId]: { status: "loading", snapshot: current[courseId]?.snapshot ?? null } }));
    const request = accountScope.request(actorId);
    try {
      const result = await curriculumPort.getCurriculum(draftId, request.signal);
      if (!request.isCurrent()) return null;
      if (!result.ok || result.data.artifact.courseId !== courseId) {
        setAuthoring((current) => ({ ...current, [courseId]: { status: "error", snapshot: current[courseId]?.snapshot ?? null } }));
        return null;
      }
      setAuthoring((current) => ({ ...current, [courseId]: { status: "ready", snapshot: result.data } }));
      await onArtifactChange(result.data.artifact);
      return result.data;
    } catch {
      if (request.isCurrent()) setAuthoring((current) => ({ ...current, [courseId]: { status: "error", snapshot: current[courseId]?.snapshot ?? null } }));
      return null;
    } finally { request.release(); }
  }

  const selectedDraftId = selected?.curriculum?.id;
  const selectedDraftRevision = selected?.curriculum?.revision;
  useEffect(() => {
    if (!actorId || !selected || !selectedDraftId) return;
    const snapshot = authoring[selected.courseId]?.snapshot;
    if (snapshot?.draft.id === selectedDraftId && snapshot.draft.revision === selectedDraftRevision) return;
    const courseId = selected.courseId;
    const request = accountScope.request(actorId);
    void curriculumPort.getCurriculum(selectedDraftId, request.signal).then(async (result) => {
      if (!request.isCurrent()) return;
      if (!result.ok || result.data.artifact.courseId !== courseId) {
        setAuthoring((current) => ({ ...current, [courseId]: { status: "error", snapshot: current[courseId]?.snapshot ?? null } }));
        return;
      }
      setAuthoring((current) => ({ ...current, [courseId]: { status: "ready", snapshot: result.data } }));
      await onArtifactChange(result.data.artifact);
    }).catch(() => { if (request.isCurrent()) setAuthoring((current) => ({ ...current, [courseId]: { status: "error", snapshot: current[courseId]?.snapshot ?? null } })); }).finally(request.release);
    return request.abort;
    // The selected draft identity/revision is the fetch boundary; authoring updates are deliberately excluded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actorId, selected?.courseId, selectedDraftId, selectedDraftRevision, curriculumPort]);

  const readyVersionId = selected?.readyVersionId;
  async function fetchReady(courseId: string, versionId: string) {
    if (!actorId) return;
    setReady((current) => ({ ...current, [courseId]: { status: "loading", result: current[courseId]?.result ?? null } }));
    const request = accountScope.request(actorId);
    try {
      const result = await catalog.getCourse(courseId, versionId, request.signal);
      if (!request.isCurrent()) return;
      setReady((current) => ({ ...current, [courseId]: result.ok ? { status: "ready", result: result.data } : { status: "error", result: null } }));
    } catch { if (request.isCurrent()) setReady((current) => ({ ...current, [courseId]: { status: "error", result: null } })); }
    finally { request.release(); }
  }
  useEffect(() => {
    if (!actorId || !selected || !readyVersionId || ready[selected.courseId]?.status === "loading" || ready[selected.courseId]?.result?.kind === "ready") return;
    const courseId = selected.courseId;
    const request = accountScope.request(actorId);
    void catalog.getCourse(courseId, readyVersionId, request.signal).then((result) => {
      if (!request.isCurrent()) return;
      setReady((current) => ({ ...current, [courseId]: result.ok ? { status: "ready", result: result.data } : { status: "error", result: null } }));
    }).catch(() => { if (request.isCurrent()) setReady((current) => ({ ...current, [courseId]: { status: "error", result: null } })); }).finally(request.release);
    return request.abort;
  }, [actorId, catalog, readyVersionId, selected?.courseId]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedSnapshot = selected ? authoring[selected.courseId]?.snapshot : null;
  const observableRun = selectedSnapshot && selected?.curriculum
    && selectedSnapshot.draft.id === selected.curriculum.id && selectedSnapshot.draft.revision === selected.curriculum.revision
    ? selectedSnapshot.generationRun : null;
  useEffect(() => {
    if (!actorId || !selected || !selected.curriculum || !observableRun || !selected.approval) return;
    const courseId = selected.courseId;
    const draftId = selected.curriculum.id;
    const draftRevision = selected.curriculum.revision;
    const approvalId = selected.approval.id;
    const runId = observableRun.id;
    const request = accountScope.request(actorId);
    void (async () => {
      const retryPause = () => new Promise<void>((resolve) => setTimeout(resolve, 1000));
      const loadSnapshot = async () => {
        while (request.isCurrent()) {
          try {
            const value = await getGenerationSnapshot(runId, request.signal);
            setGenerationError((current) => ({ ...current, [courseId]: false }));
            return value;
          } catch (error) {
            if (!request.isCurrent() || (error instanceof Error && error.name === "AbortError")) throw error;
            setGenerationError((current) => ({ ...current, [courseId]: true }));
            await retryPause();
          }
        }
        throw new DOMException("Aborted", "AbortError");
      };
      let stream = createGenerationStreamState(await loadSnapshot());
      if (stream.run.ownerId !== actorId || stream.run.courseId !== courseId || stream.run.approvalId !== approvalId
        || stream.approvedDraftRevision !== draftRevision) throw new Error("generation_scope_invalid");
      setGenerationStreams((current) => ({ ...current, [courseId]: stream }));
      setGenerationError((current) => ({ ...current, [courseId]: false }));
      while (request.isCurrent() && ["queued", "running"].includes(stream.run.status)) {
        let snapshotRequired = false;
        try {
          await readGenerationEvents(runId, stream.lastAppliedSeq, request.signal, {
            onEvent(event) {
              const next = generationStreamReducer(stream, { type: "event", event });
              if (next === stream && event.seq > stream.lastAppliedSeq) snapshotRequired = true;
              else stream = next;
              setGenerationStreams((current) => ({ ...current, [courseId]: stream }));
            },
            onSnapshotRequired() { snapshotRequired = true; },
          });
          setGenerationError((current) => ({ ...current, [courseId]: false }));
        } catch (error) {
          if (!request.isCurrent() || (error instanceof Error && error.name === "AbortError")) throw error;
          setGenerationError((current) => ({ ...current, [courseId]: true }));
          await retryPause();
          continue;
        }
        if (!request.isCurrent() || !["queued", "running"].includes(stream.run.status)) break;
        if (snapshotRequired || stream.needsSnapshot || stream.replayAfterSeq !== null) {
          const repair = await loadSnapshot();
          stream = generationStreamReducer(stream, { type: "snapshot", snapshot: repair });
          setGenerationStreams((current) => ({ ...current, [courseId]: stream }));
        }
      }
      if (request.isCurrent() && stream.run.status === "succeeded") {
        const result = await curriculumPort.getCurriculum(draftId, request.signal);
        if (request.isCurrent() && result.ok && result.data.artifact.courseId === courseId) {
          setAuthoring((current) => ({ ...current, [courseId]: { status: "ready", snapshot: result.data } }));
          await onArtifactChange(result.data.artifact);
        }
      }
    })().catch((error) => {
      if (request.isCurrent() && !(error instanceof Error && error.name === "AbortError")) setGenerationError((current) => ({ ...current, [courseId]: true }));
    }).finally(request.release);
    return request.abort;
    // The run identity defines one observer lifetime; state updates are reducer-owned.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actorId, observableRun?.id, selected?.courseId, selected?.curriculum?.id, selected?.curriculum?.revision, selected?.approval?.id]);

  const observableAuthoringRun = selectedSnapshot && selected?.curriculum
    && selectedSnapshot.draft.id === selected.curriculum.id && selectedSnapshot.draft.revision === selected.curriculum.revision
    ? selectedSnapshot.authoringRun : null;
  useEffect(() => {
    if (!actorId || !selected || !selected.curriculum || !observableAuthoringRun) return;
    const courseId = selected.courseId;
    const draftId = selected.curriculum.id;
    const conversationId = selected.curriculum.conversationId;
    const runId = observableAuthoringRun.id;
    const request = accountScope.request(actorId);
    void (async () => {
      const retryPause = () => new Promise<void>((resolve) => setTimeout(resolve, 1000));
      const loadSnapshot = async () => {
        while (request.isCurrent()) {
          try {
            const value = await getRunSnapshot(runId, request.signal);
            setAuthoringConnectionError((current) => ({ ...current, [courseId]: false }));
            return value;
          } catch (error) {
            if (!request.isCurrent() || (error instanceof Error && error.name === "AbortError")) throw error;
            setAuthoringConnectionError((current) => ({ ...current, [courseId]: true }));
            await retryPause();
          }
        }
        throw new DOMException("Aborted", "AbortError");
      };
      const initial = await loadSnapshot();
      if (initial.run.ownerId !== actorId || initial.run.conversationId !== conversationId) throw new Error("authoring_scope_invalid");
      let stream = creatorStreamReducer(createStreamState({ ...initial.run, lastSeq: 0 }), { type: "snapshot", snapshot: initial });
      setAuthoringStreams((current) => ({ ...current, [courseId]: stream }));
      while (request.isCurrent() && ["queued", "running"].includes(stream.run.status)) {
        let snapshotRequired = false;
        try {
          await readRunEvents(runId, stream.lastAppliedSeq, request.signal, {
            onEvent(event) {
              const next = creatorStreamReducer(stream, { type: "event", event });
              if (next === stream && event.seq > stream.lastAppliedSeq) snapshotRequired = true;
              else stream = next;
              setAuthoringStreams((current) => ({ ...current, [courseId]: stream }));
            },
            onSnapshotRequired() { snapshotRequired = true; },
          });
          setAuthoringConnectionError((current) => ({ ...current, [courseId]: false }));
        } catch (error) {
          if (!request.isCurrent() || (error instanceof Error && error.name === "AbortError")) throw error;
          setAuthoringConnectionError((current) => ({ ...current, [courseId]: true }));
          await retryPause(); continue;
        }
        if (!request.isCurrent() || !["queued", "running"].includes(stream.run.status)) break;
        if (snapshotRequired || stream.needsSnapshot || stream.replayAfterSeq !== null) {
          stream = creatorStreamReducer(stream, { type: "snapshot", snapshot: await loadSnapshot() });
          setAuthoringStreams((current) => ({ ...current, [courseId]: stream }));
        }
      }
      if (!request.isCurrent()) return;
      const result = await curriculumPort.getCurriculum(draftId, request.signal);
      if (!request.isCurrent() || !result.ok || result.data.artifact.courseId !== courseId) return;
      setAuthoring((current) => ({ ...current, [courseId]: { status: "ready", snapshot: result.data } }));
      await onArtifactChange(result.data.artifact);
      if (stream.run.status === "succeeded") {
        setEdits((current) => { const next = { ...current }; delete next[courseId]; return next; });
        setProgramCourseId((current) => current === courseId ? null : current);
      } else if (stream.run.status === "failed") {
        setEdits((current) => {
          const edit = current[courseId];
          if (!edit) return current;
          const conflict = result.data.draft.revision !== edit.buffer.base.revision ? result.data : edit.conflict;
          return { ...current, [courseId]: { ...edit, pending: false, key: conflict ? crypto.randomUUID() : edit.key, conflict,
            error: conflict ? errorMessage("revision_conflict") : "The answer check stopped before applying your changes. Your edits are still here." } };
        });
      }
    })().catch((error) => {
      if (request.isCurrent() && !(error instanceof Error && error.name === "AbortError")) setAuthoringConnectionError((current) => ({ ...current, [courseId]: true }));
    }).finally(request.release);
    return request.abort;
    // The immutable authoring intent owns this observer lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actorId, observableAuthoringRun?.id, observableAuthoringRun?.status, selected?.courseId, selected?.curriculum?.id, selected?.curriculum?.conversationId]);

  if (!selected) return null;
  const selectedAuthoring = authoring[selected.courseId];
  const snapshotCandidate = selectedAuthoring?.snapshot;
  const snapshot = snapshotCandidate && selected.curriculum && snapshotCandidate.draft.id === selected.curriculum.id
    && snapshotCandidate.draft.revision === selected.curriculum.revision ? snapshotCandidate : null;
  const curriculum = snapshot?.draft ?? selected.curriculum;
  const programEdit = programCourseId ? edits[programCourseId] : undefined;
  const metadataArtifact = metadataCourseId ? artifacts.find((item) => item.courseId === metadataCourseId) : undefined;
  const languageArtifact = languageCourseId ? artifacts.find((item) => item.courseId === languageCourseId) : undefined;
  const readyEntry = ready[selected.courseId];
  const readyDetail = readyEntry?.result?.kind === "ready" ? readyEntry.result.detail : null;
  const generation = generationStreams[selected.courseId]?.run.id === snapshot?.generationRun?.id ? generationStreams[selected.courseId] : undefined;
  const selectedAuthoringStream = authoringStreams[selected.courseId]?.run.id === snapshot?.authoringRun?.id ? authoringStreams[selected.courseId] : undefined;
  const selectedAuthoringRun = selectedAuthoringStream?.run ?? snapshot?.authoringRun ?? null;
  const editingSnapshot = programCourseId ? authoring[programCourseId]?.snapshot : null;
  const editingAuthoringStream = programCourseId && authoringStreams[programCourseId]?.run.id === editingSnapshot?.authoringRun?.id ? authoringStreams[programCourseId] : undefined;
  const editingAuthoringRun = editingAuthoringStream?.run ?? editingSnapshot?.authoringRun ?? null;
  const editingAuthoringActive = Boolean(editingAuthoringRun && !["succeeded", "failed", "cancelled"].includes(editingAuthoringRun.status));

  function openProgram() {
    if (!curriculum) return;
    const courseId = selected!.courseId;
    setEdits((current) => ({ ...current, [courseId]: current[courseId] ?? { buffer: createCurriculumEditBuffer(curriculum), key: crypto.randomUUID(), pending: false, error: null, conflict: null } }));
    setProgramCourseId(courseId);
  }

  function changeProgram(buffer: CurriculumEditBuffer) {
    if (!programCourseId) return;
    setEdits((current) => ({ ...current, [programCourseId]: { ...current[programCourseId]!, buffer, key: crypto.randomUUID(), error: null } }));
  }

  async function saveProgram() {
    if (!actorId || !programCourseId || !programEdit || programEdit.pending) return;
    let patch;
    try { patch = programEdit.conflict ? rebaseCurriculumPatch(programEdit.buffer, programEdit.conflict.draft) : curriculumPatchForBuffer(programEdit.buffer); }
    catch { setEdits((current) => ({ ...current, [programCourseId]: { ...current[programCourseId]!, error: "Resolve the highlighted program issues before saving." } })); return; }
    const courseId = programCourseId;
    const draftId = programEdit.buffer.base.id;
    setEdits((current) => ({ ...current, [courseId]: { ...current[courseId]!, pending: true, error: null } }));
    const request = accountScope.request(actorId);
    try {
      const result = await curriculumPort.patchCurriculum(draftId, patch, { idempotencyKey: programEdit.key, signal: request.signal });
      if (!request.isCurrent()) return;
      if (!result.ok) {
        if (result.error.error.code === "revision_conflict") {
          const latest = await fetchAuthoring(courseId, draftId, true);
          setEdits((current) => ({ ...current, [courseId]: { ...current[courseId]!, pending: false, key: crypto.randomUUID(), error: errorMessage("revision_conflict"), conflict: latest } }));
        } else setEdits((current) => ({ ...current, [courseId]: { ...current[courseId]!, pending: false, error: errorMessage(result.error.error.code) } }));
        return;
      }
      if ("status" in result.data) {
        const pendingResult = result.data;
        if (pendingResult.run.ownerId !== actorId || pendingResult.run.conversationId !== programEdit.buffer.base.conversationId
          || pendingResult.artifact.courseId !== courseId) throw new Error("authoring_scope_invalid");
        if (!await onArtifactChange(pendingResult.artifact)) throw new Error("artifact changed");
        setAuthoring((current) => current[courseId]?.snapshot ? { ...current, [courseId]: { status: "ready", snapshot: {
          ...current[courseId]!.snapshot!, artifact: pendingResult.artifact, authoringRun: pendingResult.run,
        } } } : current);
        setEdits((current) => ({ ...current, [courseId]: { ...current[courseId]!, pending: false, error: null } }));
        return;
      }
      if (!await onArtifactChange(result.data.artifact)) throw new Error("artifact changed");
      setProgramCourseId(null);
      setEdits((current) => { const next = { ...current }; delete next[courseId]; return next; });
      await fetchAuthoring(courseId, draftId, true);
    } catch {
      if (request.isCurrent()) setEdits((current) => ({ ...current, [courseId]: { ...current[courseId]!, pending: false, error: errorMessage() } }));
    } finally { request.release(); }
  }

  async function saveMetadata() {
    if (!metadataArtifact || metadataPending) return;
    setMetadataPending(true); setMetadataError(null);
    try {
      let artifact: CourseArtifactRef;
      if (actorId) {
        const request = accountScope.request(actorId);
        try {
          const result = await curriculumPort.editCourseMetadata(metadataArtifact.courseId, { expectedRevision: metadataArtifact.revision, title: metadata.title, summary: metadata.summary }, { idempotencyKey: metadataKey, signal: request.signal });
          if (!request.isCurrent() || !result.ok) { setMetadataError(result.ok ? errorMessage() : errorMessage(result.error.error.code)); return; }
          artifact = result.data;
        } finally { request.release(); }
      } else if (onEditMetadata) artifact = await editExistingCourseMetadata(metadataArtifact, { ...metadata, contentLanguage: metadataArtifact.contentLanguage }, getCurrentArtifact, onEditMetadata);
      else return;
      if (!await onArtifactChange(artifact)) throw new Error("artifact changed");
      setMetadataCourseId(null);
    } catch { setMetadataError(errorMessage()); }
    finally { setMetadataPending(false); }
  }

  async function requestLanguage() {
    if (!actorId || !languageArtifact?.curriculum || languagePending) return;
    setLanguagePending(true); setLanguageError(null);
    const request = accountScope.request(actorId);
    try {
      const result = await curriculumPort.requestCourseLanguage(languageArtifact.courseId, { expectedRevision: languageArtifact.revision, expectedDraftRevision: languageArtifact.curriculum.revision, contentLanguage: language }, { idempotencyKey: languageKey, signal: request.signal });
      if (!request.isCurrent() || !result.ok) { setLanguageError(result.ok ? errorMessage() : errorMessage(result.error.error.code)); return; }
      if (!await onArtifactChange(result.data.artifact)) throw new Error("artifact changed");
      setAuthoring((current) => current[languageArtifact.courseId]?.snapshot ? { ...current, [languageArtifact.courseId]: { status: "ready", snapshot: { ...current[languageArtifact.courseId]!.snapshot!, artifact: result.data.artifact, languageRun: result.data.run } } } : current);
      setLanguageCourseId(null);
    } catch { setLanguageError(errorMessage()); }
    finally { request.release(); setLanguagePending(false); }
  }

  const approve: ApproveCurriculum | undefined = onApprove ?? (actorId ? async (input) => {
    const keyId = `${input.draftId}:${input.revision}:${input.contentDigest}`;
    const key = approvalKeys[keyId] ?? crypto.randomUUID();
    if (!approvalKeys[keyId]) setApprovalKeys((current) => ({ ...current, [keyId]: key }));
    const request = accountScope.request(actorId);
    try {
      const result = await curriculumPort.approveCurriculum(input.draftId, { expectedRevision: input.revision, contentDigest: input.contentDigest }, { idempotencyKey: key, signal: request.signal });
      if (!request.isCurrent() || !result.ok) throw new Error(result.ok ? "stale account" : result.error.error.code);
      if (!await onArtifactChange(result.data.artifact)) throw new Error("artifact changed");
      setAuthoring((current) => current[input.courseId]?.snapshot ? { ...current, [input.courseId]: { status: "ready", snapshot: { ...current[input.courseId]!.snapshot!, artifact: result.data.artifact, generationRun: result.data.run } } } : current);
      setApprovalKeys((current) => { const next = { ...current }; delete next[keyId]; return next; });
      return result.data.approval;
    } finally { request.release(); }
  } : undefined);
  const approveAndRetain: ApproveCurriculum | undefined = approve ? async (input) => {
    const receipt = await approve(input);
    if (onApprove && !await onApproval(input.courseId, receipt)) throw new Error("This program changed before approval was confirmed");
    return receipt;
  } : undefined;

  async function startCourse() {
    if (!actorId || !readyDetail || startPending) return;
    setStartPending(true); setStartError(null);
    const request = accountScope.request(actorId);
    try {
      const result = await catalog.createEnrollment(readyDetail.course.id, { courseVersionId: readyDetail.version.id }, crypto.randomUUID(), request.signal);
      if (!request.isCurrent() || !result.ok) { setStartError("The course is ready, but starting it failed. Try again."); return; }
      window.location.assign(result.data.redirectTo);
    } catch { if (request.isCurrent()) setStartError("The course is ready, but starting it failed. Try again."); }
    finally { if (request.isCurrent()) setStartPending(false); request.release(); }
  }

  async function cancelBuild() {
    const run = generation?.run ?? snapshot?.generationRun;
    const courseId = run?.courseId;
    if (!actorId || !run || !courseId || cancelPending) return;
    setCancelPending(true);
    const request = accountScope.request(actorId);
    try {
      const cancelled = await cancelGenerationRun(run.id, request.signal);
      if (!request.isCurrent() || cancelled.run.ownerId !== actorId || cancelled.run.courseId !== courseId) return;
      setGenerationStreams((current) => ({ ...current, [courseId]: createGenerationStreamState(cancelled) }));
      setGenerationError((current) => ({ ...current, [courseId]: false }));
    } catch { if (request.isCurrent()) setGenerationError((current) => ({ ...current, [courseId]: true })); }
    finally { if (request.isCurrent()) setCancelPending(false); request.release(); }
  }

  async function retryBuild() {
    const run = generation?.run ?? snapshot?.generationRun;
    const courseId = run?.courseId;
    if (!actorId || !run || !courseId || !["failed", "cancelled"].includes(run.status) || retryPending) return;
    const key = retryKeys[run.id] ?? crypto.randomUUID();
    if (!retryKeys[run.id]) setRetryKeys((current) => ({ ...current, [run.id]: key }));
    setRetryPending(true);
    setRetryError((current) => ({ ...current, [courseId]: false }));
    const request = accountScope.request(actorId);
    try {
      const retried = await retryGenerationRun(run.id, key, request.signal);
      if (!request.isCurrent() || retried.run.ownerId !== actorId || retried.run.courseId !== courseId
        || retried.run.approvalId !== run.approvalId || retried.approvedDraftRevision !== run.sourceDraftRevision) throw new Error("generation_retry_scope");
      setGenerationStreams((current) => ({ ...current, [courseId]: createGenerationStreamState(retried) }));
      setAuthoring((current) => current[courseId]?.snapshot ? { ...current, [courseId]: { status: "ready", snapshot: { ...current[courseId]!.snapshot!, generationRun: retried.run } } } : current);
      setRetryKeys((current) => { const next = { ...current }; delete next[run.id]; return next; });
    } catch { if (request.isCurrent()) setRetryError((current) => ({ ...current, [courseId]: true })); }
    finally { if (request.isCurrent()) setRetryPending(false); request.release(); }
  }

  async function cancelAuthoring() {
    const run = selectedAuthoringRun;
    if (!actorId || !run || authoringCommandPending || !["queued", "running"].includes(run.status)) return;
    const courseId = selected!.courseId;
    setAuthoringCommandPending(true);
    setAuthoringCommandError((current) => ({ ...current, [courseId]: false }));
    const request = accountScope.request(actorId);
    try {
      const cancelled = await cancelRun(run.id, request.signal);
      if (!request.isCurrent() || cancelled.run.ownerId !== actorId || cancelled.run.conversationId !== run.conversationId) throw new Error("authoring_cancel_scope");
      const stream = creatorStreamReducer(createStreamState({ ...cancelled.run, lastSeq: 0 }), { type: "snapshot", snapshot: cancelled });
      setAuthoringStreams((current) => ({ ...current, [courseId]: stream }));
      setAuthoring((current) => current[courseId]?.snapshot ? { ...current, [courseId]: { status: "ready", snapshot: { ...current[courseId]!.snapshot!, authoringRun: cancelled.run } } } : current);
    } catch { if (request.isCurrent()) setAuthoringCommandError((current) => ({ ...current, [courseId]: true })); }
    finally { if (request.isCurrent()) setAuthoringCommandPending(false); request.release(); }
  }

  async function retryAuthoring() {
    const run = selectedAuthoringRun;
    if (!actorId || !run || authoringCommandPending || !["failed", "cancelled"].includes(run.status)) return;
    const courseId = selected!.courseId;
    const key = authoringRetryKeys[run.id] ?? crypto.randomUUID();
    if (!authoringRetryKeys[run.id]) setAuthoringRetryKeys((current) => ({ ...current, [run.id]: key }));
    setAuthoringCommandPending(true);
    setAuthoringCommandError((current) => ({ ...current, [courseId]: false }));
    setEdits((current) => current[courseId] ? { ...current, [courseId]: { ...current[courseId]!, error: null } } : current);
    const request = accountScope.request(actorId);
    try {
      const retried = await retryRun(run.id, key, request.signal);
      if (!request.isCurrent() || retried.run.ownerId !== actorId || retried.run.conversationId !== run.conversationId) throw new Error("authoring_retry_scope");
      const stream = creatorStreamReducer(createStreamState({ ...retried.run, lastSeq: 0 }), { type: "snapshot", snapshot: retried });
      setAuthoringStreams((current) => ({ ...current, [courseId]: stream }));
      setAuthoring((current) => current[courseId]?.snapshot ? { ...current, [courseId]: { status: "ready", snapshot: { ...current[courseId]!.snapshot!, authoringRun: retried.run } } } : current);
      setAuthoringRetryKeys((current) => { const next = { ...current }; delete next[run.id]; return next; });
    } catch { if (request.isCurrent()) setAuthoringCommandError((current) => ({ ...current, [courseId]: true })); }
    finally { if (request.isCurrent()) setAuthoringCommandPending(false); request.release(); }
  }

  return <section className="creator-artifacts" aria-label="Courses in this chat">
    <div className="creator-artifacts__selection"><Select id="chat-course" label="Courses in this chat" value={selected.courseId} options={artifacts.map((artifact) => ({ value: artifact.courseId, label: artifact.title }))} onChange={(event) => onSelect(event.target.value)} /></div>
    <header className="creator-artifacts__heading"><h2>{selected.title}</h2><p>{selected.summary}</p><div className="creator-artifacts__metadata"><span>{languageLabel(selected.contentLanguage)}</span><div>{(actorId || onEditMetadata) && <Button variant="quiet" size="compact" onClick={() => { setMetadataCourseId(selected.courseId); setMetadata({ title: selected.title, summary: selected.summary }); setMetadataKey(crypto.randomUUID()); setMetadataError(null); }}><Pencil size={16} aria-hidden="true" />Edit details</Button>}{actorId && curriculum && <Button variant="quiet" size="compact" onClick={() => { setLanguageCourseId(selected.courseId); setLanguage(selected.contentLanguage); setLanguageKey(crypto.randomUUID()); setLanguageError(null); }}><Languages size={16} aria-hidden="true" />Change language</Button>}</div></div></header>
    {selectedAuthoring?.status === "error" && <Notice tone="warning" action={<Button variant="quiet" size="compact" onClick={() => curriculum && void fetchAuthoring(selected.courseId, curriculum.id, true)}>Try again</Button>}>Live research and build status could not be loaded. The saved program is still shown.</Notice>}
    {curriculum ? <CurriculumPanel key={selected.courseId} draft={curriculum} currentRevision={curriculum.revision}
      awaitingApproval={selected.approvalRequestedRevision === curriculum.revision && !awaitingSnapshotCourseIds.includes(selected.courseId)} approval={snapshot?.artifact.approval ?? selected.approval} showTitle={false}
      {...(snapshot ? { evidence: snapshot.evidence, generationRun: generation?.run ?? snapshot.generationRun, languageRun: snapshot.languageRun } : {})}
      {...(generation ? { generation } : {})}
      generationConnectionError={Boolean(generationError[selected.courseId])} cancelPending={cancelPending}
      {...((generation?.pending ?? ["queued", "running"].includes(snapshot?.generationRun?.status ?? "")) ? { onCancelBuild: cancelBuild } : {})}
      retryPending={retryPending} retryError={Boolean(retryError[selected.courseId])}
      {...(["failed", "cancelled"].includes((generation?.run ?? snapshot?.generationRun)?.status ?? "") ? { onRetryBuild: retryBuild } : {})}
      authoringRun={selectedAuthoringRun} authoringConnectionError={Boolean(authoringConnectionError[selected.courseId])}
      authoringCommandPending={authoringCommandPending} authoringCommandError={Boolean(authoringCommandError[selected.courseId])}
      {...(selectedAuthoringRun && ["queued", "running"].includes(selectedAuthoringRun.status) ? { onCancelAuthoring: cancelAuthoring } : {})}
      {...(selectedAuthoringRun && ["failed", "cancelled"].includes(selectedAuthoringRun.status) && selectedAuthoringRun.error?.code !== "revision_conflict" ? { onRetryAuthoring: retryAuthoring } : {})}
      {...(actorId ? { onEdit: openProgram } : {})}
      {...(approveAndRetain ? { onApprove: approveAndRetain } : {})} /> : <p className="creator-artifacts__no-program">This course doesn’t have a program to review yet.</p>}
    {selected.readyVersionId && <section className="creator-ready"><h3>Your course is ready</h3>{readyDetail ? <><p>Open the course to review it, or start learning now.</p><div><LinkButton href={routes.course(readyDetail.course.slug)} variant="secondary">View course</LinkButton><Button pending={startPending} onClick={() => void startCourse()}>Start course</Button></div></> : readyEntry?.status === "error" ? <><p>The course is ready, but its link could not be loaded.</p><Button variant="quiet" size="compact" onClick={() => void fetchReady(selected.courseId, selected.readyVersionId!)}>Try again</Button></> : <p>Loading the course link…</p>}{startError && <Notice tone="error">{startError}</Notice>}</section>}

    <Dialog open={metadataCourseId !== null} onOpenChange={(open) => { if (!open && !metadataPending) setMetadataCourseId(null); }} title="Edit course details" footer={<><Button variant="quiet" onClick={() => setMetadataCourseId(null)} disabled={metadataPending}>Cancel</Button><Button pending={metadataPending} disabled={!metadata.title.trim() || !metadata.summary.trim()} onClick={() => void saveMetadata()}>Save changes</Button></>}>
      <div className="creator-metadata-form"><TextField id="course-title" label="Title" value={metadata.title} maxLength={120} disabled={metadataPending} onChange={(event) => { setMetadata({ ...metadata, title: event.target.value }); setMetadataKey(crypto.randomUUID()); }} /><Textarea id="course-summary" label="Description" value={metadata.summary} maxLength={4000} disabled={metadataPending} onChange={(event) => { setMetadata({ ...metadata, summary: event.target.value }); setMetadataKey(crypto.randomUUID()); }} />{metadataError && <Notice tone="error">{metadataError}</Notice>}</div>
    </Dialog>
    <Dialog open={languageCourseId !== null} onOpenChange={(open) => { if (!open && !languagePending) setLanguageCourseId(null); }} title="Create another language version" description="Your current course stays available while the new version is prepared." footer={<><Button variant="quiet" onClick={() => setLanguageCourseId(null)} disabled={languagePending}>Cancel</Button><Button pending={languagePending} disabled={!languageArtifact?.curriculum || language === languageArtifact?.contentLanguage} onClick={() => void requestLanguage()}>Create version</Button></>}>
      <div className="creator-metadata-form"><Select id="course-content-language" label="New course language" value={language} options={languageOptions(languageArtifact?.contentLanguage ?? language)} disabled={languagePending} onChange={(event) => { setLanguage(event.target.value); setLanguageKey(crypto.randomUUID()); }} />{languageError && <Notice tone="error">{languageError}</Notice>}</div>
    </Dialog>
    <Dialog open={programCourseId !== null} onOpenChange={(open) => { if (!open && !programEdit?.pending) setProgramCourseId(null); }} title="Edit course program" description="Changes are checked against the latest saved version before they are applied." footer={programEdit && <>{programEdit.conflict && <Button variant="secondary" disabled={programEdit.pending || authoringCommandPending} onClick={() => setEdits((current) => ({ ...current, [programCourseId!]: { ...current[programCourseId!]!, buffer: createCurriculumEditBuffer(programEdit.conflict!.draft), conflict: null, error: null, key: crypto.randomUUID() } }))}>Reload current</Button>}<Button variant="quiet" disabled={programEdit.pending || authoringCommandPending} onClick={() => setProgramCourseId(null)}>Close</Button><Button pending={programEdit.pending || authoringCommandPending} disabled={editingAuthoringActive} onClick={() => void (editingAuthoringRun && ["failed", "cancelled"].includes(editingAuthoringRun.status) && !programEdit.conflict ? retryAuthoring() : saveProgram())}>{editingAuthoringActive ? "Checking answers…" : editingAuthoringRun && ["failed", "cancelled"].includes(editingAuthoringRun.status) && !programEdit.conflict ? "Retry check" : programEdit.conflict ? "Apply my changes" : "Save program"}</Button></>}>
      {programEdit && <><CurriculumEditor buffer={programEdit.buffer} disabled={programEdit.pending || editingAuthoringActive} onChange={changeProgram} />{editingAuthoringActive && <Notice tone="info">Your exact edits are saved while the answers are checked. You can close this dialog and come back without interrupting the check.</Notice>}{programEdit.conflict && <Notice tone="warning" title="A newer version is available">Reload it, or apply your edits to the newer version. Nothing has been discarded.</Notice>}{programEdit.error && <Notice tone="error">{programEdit.error}</Notice>}</>}
    </Dialog>
  </section>;
}
