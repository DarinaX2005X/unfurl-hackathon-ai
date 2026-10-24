import { LocalDraftSchema, StorageError, type DraftStore, type LocalDraft } from "@/lib/drafts";

export interface DraftState { status: "idle" | "loading" | "ready" | "error"; drafts: LocalDraft[]; error: string | null; pending: string | null; actionError: string | null }
export function storageMessage(error: unknown): string {
  if (error instanceof StorageError) {
    if (error.code === "corrupt_record") return "A draft could not be read. Your stored drafts have been kept. Try again, or reopen this library in the browser where you saved them.";
    if (error.code === "version_unsupported") return "A draft was saved in a different version of Unfurl. Your stored drafts have been kept. Try refreshing this page.";
    if (error.code === "quota_exceeded") return "This device has no room to save the change. Free some browser storage and try again. Your existing draft has been kept.";
  }
  return "Your drafts could not be accessed on this device. Check that browser storage is allowed, then try again.";
}
export class DraftController {
  private state: DraftState = { status: "idle", drafts: [], error: null, pending: null, actionError: null };
  private listeners = new Set<() => void>();
  private revision = 0;
  constructor(private readonly store: DraftStore) {}
  getSnapshot = (): DraftState => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<DraftState>) { this.state = { ...this.state, ...patch }; this.listeners.forEach((listener) => listener()); }
  async refresh(): Promise<void> {
    const revision = ++this.revision;
    this.update({ status: "loading", error: null });
    try { const drafts = await this.store.list(); if (revision === this.revision) this.update({ status: "ready", drafts }); }
    catch (error) { if (revision === this.revision) this.update({ status: "error", error: storageMessage(error) }); }
  }
  clearActionError() { this.update({ actionError: null }); }
  async rename(id: string, title: string): Promise<boolean> {
    if (this.state.pending) return false;
    this.update({ pending: id, actionError: null });
    try {
      const current = await this.store.get(id);
      if (!current) { this.update({ actionError: "This draft is no longer on this device. Close this dialog and refresh your drafts." }); return false; }
      const updated = LocalDraftSchema.parse({ ...current, title: title.trim(), updatedAt: new Date().toISOString() });
      await this.store.put(updated);
      this.revision += 1;
      this.update({ status: "ready", error: null, drafts: this.state.drafts.map((draft) => draft.id === id ? updated : draft).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) });
      return true;
    } catch (error) { this.update({ actionError: storageMessage(error) }); return false; }
    finally { this.update({ pending: null }); }
  }
  async remove(id: string): Promise<boolean> {
    if (this.state.pending) return false;
    this.update({ pending: id, actionError: null });
    try { await this.store.remove(id); this.revision += 1; this.update({ status: "ready", error: null, drafts: this.state.drafts.filter((draft) => draft.id !== id) }); return true; }
    catch (error) { this.update({ actionError: storageMessage(error) }); return false; }
    finally { this.update({ pending: null }); }
  }
  async create(title: string): Promise<string | null> {
    if (this.state.pending) return null;
    this.update({ pending: "new", actionError: null });
    try {
      const draft = LocalDraftSchema.parse({ id: crypto.randomUUID(), kind: "course_request", title: title.trim(), text: "", contentLanguage: "en", updatedAt: new Date().toISOString(), schemaVersion: 1, intendedConversationId: null });
      await this.store.put(draft);
      this.revision += 1;
      this.update({ status: "ready", error: null, drafts: [draft, ...this.state.drafts] });
      return draft.id;
    } catch (error) { this.update({ actionError: storageMessage(error) }); return null; }
    finally { this.update({ pending: null }); }
  }
  dispose = () => { this.revision += 1; };
}
