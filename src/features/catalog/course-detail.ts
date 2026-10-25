import type { CatalogPort } from "@/application/catalog-port";
import type { CourseDetailResult } from "@/domain/catalog";

export type CourseDetailLoadResult = CourseDetailResult | { kind: "unavailable" } | { kind: "error" };
export type CourseDetailSource = { slug: string } | { shareToken: string };
export function courseDetailAuthorityKey(epoch: number, status: "loading" | "error" | "ready", actorId: string | null): string {
  return `${epoch}:${status === "ready" ? actorId ?? "anonymous" : status}`;
}
export async function loadCourseDetail(service: CatalogPort, source: CourseDetailSource, signal: AbortSignal): Promise<CourseDetailLoadResult> {
  signal.throwIfAborted();
  try {
    if ("slug" in source) {
      const result = await service.getBySlug(source.slug, signal);
      signal.throwIfAborted();
      if (result.ok) return result.data;
      return { kind: ["not_found", "forbidden", "unauthenticated"].includes(result.error.error.code) ? "unavailable" : "error" };
    }
    const result = await service.resolveShare(source.shareToken, signal);
    signal.throwIfAborted();
    if (result.ok) return { kind: "ready", detail: result.data };
    return { kind: ["not_found", "forbidden", "unauthenticated"].includes(result.error.error.code) ? "unavailable" : "error" };
  } catch {
    signal.throwIfAborted();
    return { kind: "error" };
  }
}

/** Owns one authority-scoped detail request so a disposed actor can never publish a late result. */
export class CourseDetailRequest {
  private request: AbortController | null = null;
  private revision = 0;
  constructor(private readonly service: CatalogPort, private readonly source: CourseDetailSource,
    private readonly publish: (result: CourseDetailLoadResult) => void) {}
  async start(): Promise<void> {
    this.request?.abort();
    const request = this.request = new AbortController();
    const revision = ++this.revision;
    try {
      const result = await loadCourseDetail(this.service, this.source, request.signal);
      if (!request.signal.aborted && revision === this.revision) this.publish(result);
    } catch {
      if (!request.signal.aborted && revision === this.revision) this.publish({ kind: "error" });
    }
  }
  dispose = () => { this.request?.abort(); this.revision += 1; };
}
