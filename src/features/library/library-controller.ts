import type { CatalogPort } from "@/application/catalog-port";
import { LibraryCourseItemSchema, type LibraryCourseItem, type LibraryQuery } from "@/domain/catalog";
import { accountScope, type AccountScope } from "@/features/account/account-scope";

export interface LibraryState {
  status: "idle" | "loading" | "ready" | "error";
  items: LibraryCourseItem[];
  nextCursor: string | null;
  refreshing: boolean;
  loadingMore: boolean;
  pageError: string | null;
}

export class LibraryController {
  private state: LibraryState = { status: "idle", items: [], nextCursor: null, refreshing: false, loadingMore: false, pageError: null };
  private listeners = new Set<() => void>();
  private request: ReturnType<AccountScope["request"]> | null = null;
  private revision = 0;
  private query: LibraryQuery = {};
  constructor(private readonly service: CatalogPort, private readonly actorId: string | null = null,
    private readonly scope: AccountScope = accountScope) {}
  getSnapshot = (): LibraryState => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<LibraryState>) { this.state = { ...this.state, ...patch }; this.listeners.forEach((listener) => listener()); }

  async search(query: LibraryQuery, preserve = false): Promise<void> {
    this.request?.abort();
    this.query = { ...query, limit: query.limit ?? 24 };
    delete this.query.cursor;
    const request = this.request = this.scope.request(this.actorId);
    const revision = ++this.revision;
    this.update({ status: preserve && this.state.items.length ? this.state.status : "loading", refreshing: true,
      ...(preserve ? {} : { items: [], nextCursor: null }), loadingMore: false, pageError: null });
    try {
      const result = await this.service.listLibrary(this.query, request.signal);
      if (!request.isCurrent() || revision !== this.revision) return;
      if (!result.ok) { this.update({ status: "error", refreshing: false }); return; }
      const records = LibraryCourseItemSchema.array().safeParse(result.data.items);
      if (!records.success) { this.update({ status: "error", refreshing: false }); return; }
      this.update({ status: "ready", items: records.data, nextCursor: result.data.nextCursor, refreshing: false });
    } catch { if (request.isCurrent() && revision === this.revision) this.update({ status: "error", refreshing: false }); }
    finally { request.release(); }
  }
  refresh = () => this.search(this.query, true);
  async loadMore(): Promise<void> {
    if (!this.state.nextCursor || this.state.loadingMore || this.state.status !== "ready") return;
    const cursor = this.state.nextCursor;
    const request = this.request = this.scope.request(this.actorId);
    const revision = this.revision;
    this.update({ loadingMore: true, pageError: null });
    try {
      const result = await this.service.listLibrary({ ...this.query, cursor }, request.signal);
      if (!request.isCurrent() || revision !== this.revision) return;
      if (!result.ok) { this.update({ loadingMore: false, pageError: "The next courses couldn’t be loaded. Your library above is still available." }); return; }
      const records = LibraryCourseItemSchema.array().safeParse(result.data.items);
      if (!records.success) { this.update({ loadingMore: false, pageError: "The next courses couldn’t be loaded. Your library above is still available." }); return; }
      const items = new Map(this.state.items.map((item) => [item.courseId, item]));
      records.data.forEach((item) => items.set(item.courseId, item));
      this.update({ items: [...items.values()], nextCursor: result.data.nextCursor, loadingMore: false });
    } catch { if (request.isCurrent() && revision === this.revision) this.update({ loadingMore: false, pageError: "The next courses couldn’t be loaded. Your library above is still available." }); }
    finally { request.release(); }
  }
  dispose = () => { this.request?.abort(); this.revision += 1; };
}
