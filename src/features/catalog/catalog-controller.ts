import type { ApplicationPort, CourseQuery } from "@/application/ports";
import type { CourseSummary } from "@/domain";

export interface CatalogState {
  status: "idle" | "loading" | "ready" | "error";
  items: CourseSummary[];
  nextCursor: string | null;
  loadingMore: boolean;
  error: string | null;
  pageError: string | null;
}

/** Keeps request identity and pagination together so late responses cannot replace a newer search. */
export class CatalogController {
  private state: CatalogState = { status: "idle", items: [], nextCursor: null, loadingMore: false, error: null, pageError: null };
  private listeners = new Set<() => void>();
  private request: AbortController | null = null;
  private query: CourseQuery = {};
  private revision = 0;
  constructor(private readonly service: ApplicationPort) {}
  getSnapshot = (): CatalogState => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<CatalogState>) { this.state = { ...this.state, ...patch }; this.listeners.forEach((listener) => listener()); }
  async search(query: CourseQuery): Promise<void> {
    this.request?.abort();
    this.query = { ...query, limit: query.limit ?? 12 };
    delete this.query.cursor;
    const revision = ++this.revision;
    const request = this.request = new AbortController();
    this.update({ status: "loading", items: [], nextCursor: null, loadingMore: false, error: null, pageError: null });
    try {
      const result = await this.service.listPublic(this.query, request.signal);
      if (request.signal.aborted || revision !== this.revision) return;
      if (!result.ok) { this.update({ status: "error", error: "Courses could not be loaded. Your search is still here. Please try again." }); return; }
      this.update({ status: "ready", items: result.data.items, nextCursor: result.data.nextCursor });
    } catch {
      if (!request.signal.aborted && revision === this.revision) this.update({ status: "error", error: "Courses could not be loaded. Your search is still here. Please try again." });
    }
  }
  async loadMore(): Promise<void> {
    if (this.state.loadingMore || !this.state.nextCursor || this.state.status !== "ready") return;
    const cursor = this.state.nextCursor;
    const revision = this.revision;
    const request = this.request = new AbortController();
    this.update({ loadingMore: true, pageError: null });
    try {
      const result = await this.service.listPublic({ ...this.query, cursor }, request.signal);
      if (request.signal.aborted || revision !== this.revision) return;
      if (!result.ok) { this.update({ loadingMore: false, pageError: "The next courses could not be loaded. The courses above are still available." }); return; }
      const items = new Map(this.state.items.map((item) => [item.id, item]));
      result.data.items.forEach((item) => items.set(item.id, item));
      this.update({ items: [...items.values()], nextCursor: result.data.nextCursor, loadingMore: false });
    } catch {
      if (!request.signal.aborted && revision === this.revision) this.update({ loadingMore: false, pageError: "The next courses could not be loaded. The courses above are still available." });
    }
  }
  retry = () => this.state.pageError ? this.loadMore() : this.search(this.query);
  dispose = () => { this.request?.abort(); this.revision += 1; };
}
