import { IdSchema, type ContentLanguage } from "@/domain/common";
import { StorageError, type DraftStore, type LocalDraft } from "@/domain/drafts";
import type { RequestBuffer } from "./request-buffer";

export const REQUEST_LIMIT = 20_000;
export const quickActions = [
  { id: "starting-point", label: "Add my starting point", text: "My starting point: " },
  { id: "outcome", label: "Define the outcome", text: "I want to be able to " },
  { id: "time", label: "Set a time commitment", text: "I can spend this much time each week: " },
] as const;

export function appendQuickAction(text: string, addition: string): string {
  const separator = text.length === 0 || text.endsWith("\n") ? "" : "\n\n";
  return `${text}${separator}${addition}`.slice(0, REQUEST_LIMIT);
}

export function draftTitle(text: string): string {
  const firstLine = text.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "Course request";
  const title = firstLine.replace(/\s+/g, " ");
  return title.length > 90 ? `${title.slice(0, 87).trimEnd()}…` : title;
}

export type DraftLoadStatus = "loading" | "ready" | "invalid" | "missing" | "error";
export type DraftSaveStatus = "unsaved" | "saving" | "saved" | "error";
export interface DraftEditorState {
  loadStatus: DraftLoadStatus;
  saveStatus: DraftSaveStatus;
  text: string;
  contentLanguage: ContentLanguage;
  savedDraft: LocalDraft | null;
  error: StorageError | null;
}

/** One editor owns one requested record. A failed lookup never selects another draft. */
export class DraftEditor {
  private state: DraftEditorState;
  private listeners = new Set<() => void>();
  private version = 0;
  private savedVersion = -1;
  private writing: Promise<LocalDraft | null> | null = null;
  private candidateId: string | null = null;
  private opening: Promise<void> | null = null;

  constructor(
    private readonly store: DraftStore,
    private readonly requestedId: string | null,
    private readonly createId: () => string = () => crypto.randomUUID(),
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly buffer?: RequestBuffer,
  ) {
    this.state = { loadStatus: requestedId === null ? "ready" : "loading", saveStatus: "unsaved", text: "", contentLanguage: "en", savedDraft: null, error: null };
  }

  getSnapshot = (): DraftEditorState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private publish(change: Partial<DraftEditorState>): void {
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) listener();
  }

  open(): Promise<void> {
    if (this.opening) return this.opening;
    if (this.requestedId === null) {
      const recovered = this.buffer?.read("new");
      if (recovered && !this.state.savedDraft && this.version === 0) this.publish({ text: recovered.text, contentLanguage: recovered.contentLanguage });
      return Promise.resolve();
    }
    if (!IdSchema.safeParse(this.requestedId).success) {
      this.publish({ loadStatus: "invalid" });
      return Promise.resolve();
    }
    this.publish({ loadStatus: "loading", error: null });
    this.opening = this.store.get(this.requestedId).then((draft) => {
      if (!draft) { this.publish({ loadStatus: "missing" }); return; }
      if (draft.id !== this.requestedId) throw new StorageError("corrupt_record", "The stored draft does not match this link", { draftId: this.requestedId! });
      this.candidateId = draft.id;
      this.savedVersion = this.version;
      this.publish({ loadStatus: "ready", saveStatus: "saved", text: draft.text, contentLanguage: draft.contentLanguage, savedDraft: draft });
      const recovered = this.buffer?.read(draft.id);
      if (recovered?.baseUpdatedAt === draft.updatedAt) this.edit({ text: recovered.text, contentLanguage: recovered.contentLanguage });
    }).catch((error: unknown) => {
      this.publish({ loadStatus: "error", error: asStorageError(error) });
    }).finally(() => { this.opening = null; });
    return this.opening;
  }

  edit(change: { text?: string; contentLanguage?: ContentLanguage }): void {
    if (this.state.loadStatus !== "ready") return;
    const text = (change.text ?? this.state.text).slice(0, REQUEST_LIMIT);
    const contentLanguage = change.contentLanguage ?? this.state.contentLanguage;
    if (text === this.state.text && contentLanguage === this.state.contentLanguage) return;
    this.version += 1;
    this.publish({ text, contentLanguage, saveStatus: this.writing ? "saving" : "unsaved", error: null });
    this.buffer?.write(this.state.savedDraft?.id ?? this.requestedId ?? "new", { text, contentLanguage, baseUpdatedAt: this.state.savedDraft?.updatedAt ?? null });
  }

  save(): Promise<LocalDraft | null> {
    if (this.writing) return this.writing;
    if (this.state.loadStatus !== "ready") return Promise.resolve(null);
    if (this.savedVersion === this.version && this.state.savedDraft) return Promise.resolve(this.state.savedDraft);
    this.candidateId ??= this.createId();
    this.publish({ saveStatus: "saving", error: null });
    this.writing = this.writeLatest().finally(() => { this.writing = null; });
    return this.writing;
  }

  private async writeLatest(): Promise<LocalDraft | null> {
    try {
      while (this.savedVersion !== this.version) {
        const savingVersion = this.version;
        const draft: LocalDraft = {
          id: this.candidateId!, kind: "course_request", schemaVersion: 1,
          title: this.state.savedDraft?.title ?? draftTitle(this.state.text),
          text: this.state.text, contentLanguage: this.state.contentLanguage,
          intendedConversationId: this.state.savedDraft?.intendedConversationId ?? null,
          updatedAt: this.now(),
        };
        await this.store.put(draft);
        this.savedVersion = savingVersion;
        if (this.savedVersion === this.version) {
          this.buffer?.clear(draft.id);
          if (this.requestedId === null) this.buffer?.clear("new");
        }
        this.publish({ savedDraft: draft, saveStatus: this.savedVersion === this.version ? "saved" : "saving" });
      }
      return this.state.savedDraft;
    } catch (error: unknown) {
      this.publish({ saveStatus: "error", error: asStorageError(error) });
      return null;
    }
  }
}

function asStorageError(error: unknown): StorageError {
  return error instanceof StorageError ? error : new StorageError("unavailable", "Draft storage is unavailable", { cause: error });
}

export function storageMessage(error: StorageError | null, operation: "open" | "save" = "save"): string {
  switch (error?.code) {
    case "quota_exceeded": return "This device is out of space for drafts. Free some browser storage, then try saving again. Your text is still here.";
    case "corrupt_record": return "This draft could not be read. It has been kept on this device. You can return to your library or start a new request.";
    case "version_unsupported": return "This draft was saved in a newer format. It has been kept on this device. Try opening it in an updated browser session.";
    default: return operation === "open"
      ? "Your browser could not open this draft. Allow site storage, then try again."
      : "Your browser could not save this draft. Your text is still here. Allow site storage, then try again.";
  }
}
