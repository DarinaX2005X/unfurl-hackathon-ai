import { LibraryItemSchema, type ApplicationPort, type LibraryItem, type CourseQuery } from "@/application/ports";
import type { LibraryView } from "@/features/catalog/query";

export interface LibraryState {
  status: "idle" | "loading" | "ready" | "unavailable" | "error";
  items: LibraryItem[];
  refreshing: boolean;
}

/** The library accepts course records only. Conversation storage is outside this boundary. */
export class LibraryController {
  private state: LibraryState = { status: "idle", items: [], refreshing: false };
  private listeners = new Set<() => void>();
  private request: AbortController | null = null;
  private revision = 0;
  constructor(private readonly service: ApplicationPort) {}
  getSnapshot = (): LibraryState => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<LibraryState>) { this.state = { ...this.state, ...patch }; this.listeners.forEach((listener) => listener()); }
  async refresh(): Promise<void> {
    this.request?.abort();
    const request = this.request = new AbortController();
    const revision = ++this.revision;
    this.update({ status: this.state.items.length ? this.state.status : "loading", refreshing: true });
    try {
      const capabilities = await this.service.capabilities();
      if (request.signal.aborted || revision !== this.revision) return;
      if (!capabilities.cloudPersistence) { this.update({ status: "unavailable", items: [], refreshing: false }); return; }
      const result = await this.service.listLibrary(request.signal);
      if (request.signal.aborted || revision !== this.revision) return;
      if (!result.ok) { this.update({ status: "error", refreshing: false }); return; }
      const records = LibraryItemSchema.array().safeParse(result.data.items);
      if (!records.success) { this.update({ status: "error", refreshing: false }); return; }
      this.update({ status: "ready", items: records.data, refreshing: false });
    } catch {
      if (!request.signal.aborted && revision === this.revision) this.update({ status: "error", refreshing: false });
    }
  }
  dispose = () => { this.request?.abort(); this.revision += 1; };
}

export function selectLibraryItems(items: LibraryItem[], query: CourseQuery, view: LibraryView): LibraryItem[] {
  const q = query.q?.trim().toLocaleLowerCase("en") ?? "";
  return items.filter((item) => {
    if (view === "courses" && item.kind !== "owned") return false;
    if (view === "in_progress" && (item.kind !== "enrolled" || item.lastStudiedAt === null)) return false;
    const course = item.course;
    return (!q || `${course.title} ${course.summary}`.toLocaleLowerCase("en").includes(q)) &&
      (!query.contentLanguage || course.contentLanguage.toLowerCase() === query.contentLanguage.toLowerCase());
  });
}
