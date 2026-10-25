/** In-memory work is tied to one verified actor. Browser drafts are never globally erased. */
export class AccountScope {
  private actor: string | null = null;
  private revision = 0;
  private requests = new Set<AbortController>();
  private cleanups = new Map<string, Set<() => void>>();

  get actorId(): string | null { return this.actor; }

  replaceActor(actorId: string | null) {
    if (this.actor !== actorId) {
      this.invalidate();
      this.actor = actorId;
    }
  }

  invalidate() {
    this.revision += 1;
    for (const request of this.requests) request.abort();
    this.requests.clear();
    if (this.actor !== null) {
      const callbacks = this.cleanups.get(this.actor);
      this.cleanups.delete(this.actor);
      for (const cleanup of callbacks ?? []) {
        try { cleanup(); } catch { /* One consumer cannot prevent the remaining cache cleanup. */ }
      }
    }
  }

  request(actorId: string | null) {
    const controller = new AbortController();
    const revision = this.revision;
    if (actorId !== this.actor) controller.abort();
    else this.requests.add(controller);
    return {
      signal: controller.signal,
      isCurrent: () => !controller.signal.aborted && revision === this.revision && actorId === this.actor,
      release: () => this.requests.delete(controller),
      abort: () => { controller.abort(); this.requests.delete(controller); },
    };
  }

  onClear(actorId: string, cleanup: () => void): () => void {
    if (actorId !== this.actor) { cleanup(); return () => {}; }
    const callbacks = this.cleanups.get(actorId) ?? new Set<() => void>();
    callbacks.add(cleanup);
    this.cleanups.set(actorId, callbacks);
    return () => {
      callbacks.delete(cleanup);
      if (callbacks.size === 0) this.cleanups.delete(actorId);
    };
  }
}

export const accountScope = new AccountScope();
