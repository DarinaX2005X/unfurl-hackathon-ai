export type GuideStep = "observe" | "adjust" | "compare";
export interface GuideSnapshot { step: GuideStep | null; adjusted: boolean }
export interface GuideStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
export const GUIDE_STORAGE_KEY = "unfurl.sample.model-capacity-v1.guide";

/** Orientation is UI state. It never edits an answer, consumes a hint or resets practice. */
export class PracticeGuide {
  private snapshot: GuideSnapshot = { step: "observe", adjusted: false };
  private readonly initialSnapshot = this.snapshot;
  private readonly listeners = new Set<() => void>();
  private storage: GuideStorage | null = null;
  private attached = false;

  getSnapshot = (): GuideSnapshot => this.snapshot;
  getServerSnapshot = (): GuideSnapshot => this.initialSnapshot;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private publish(next: GuideSnapshot): void { this.snapshot = next; this.listeners.forEach((listener) => listener()); }

  attachStorage(storage: GuideStorage | null): void {
    if (this.attached) return;
    this.attached = true;
    this.storage = storage;
    try { if (storage?.getItem(GUIDE_STORAGE_KEY) === "dismissed") this.publish({ step: null, adjusted: false }); }
    catch { /* Orientation is available even when browser preferences cannot be read. */ }
  }

  next(): void {
    if (this.snapshot.step === "observe") this.publish({ step: "adjust", adjusted: false });
    else if (this.snapshot.step === "adjust" && this.snapshot.adjusted) this.publish({ ...this.snapshot, step: "compare" });
    else if (this.snapshot.step === "compare") this.dismiss();
  }

  recordAdjustment(): void {
    if (this.snapshot.step === "adjust" && !this.snapshot.adjusted) this.publish({ ...this.snapshot, adjusted: true });
  }

  dismiss(): void {
    try { this.storage?.setItem(GUIDE_STORAGE_KEY, "dismissed"); }
    catch { /* Failing to remember a dismissed guide must not block the activity. */ }
    this.publish({ ...this.snapshot, step: null });
  }

  replay(): void { this.publish({ step: "observe", adjusted: false }); }
}
