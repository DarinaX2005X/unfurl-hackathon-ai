import { z } from "zod";
import { IdSchema, IsoDateTimeSchema, SampleAttemptSchema, SampleEvaluationSchema, type SampleAttempt } from "@/domain";
import { CapacityResponseSchema, createInitialResponse, SAMPLE_HINT_ID, SAMPLE_TASK_ID, type CapacityResponse } from "./content";
import { evaluateSampleAttempt, type SampleReceipt } from "./evaluator";

export const SAMPLE_STORAGE_KEY = "unfurl.sample.model-capacity-v1.v1";
export const sampleReceiptsKey = (id: string) => `${SAMPLE_STORAGE_KEY}:receipts:${id}`;

export const SampleSessionSchema = z.object({
  schemaVersion: z.literal(1), id: IdSchema, taskId: z.literal(SAMPLE_TASK_ID), taskVersion: z.literal(1),
  response: CapacityResponseSchema, lastAttempt: SampleAttemptSchema.nullable(),
  evaluation: SampleEvaluationSchema.nullable(), hintIdsUsed: z.array(z.literal(SAMPLE_HINT_ID)).max(1),
  updatedAt: IsoDateTimeSchema,
}).strict().superRefine((session, context) => {
  if (session.lastAttempt && (session.lastAttempt.sampleSessionId !== session.id || session.lastAttempt.taskId !== session.taskId || session.lastAttempt.taskVersion !== session.taskVersion)) {
    context.addIssue({ code: "custom", path: ["lastAttempt"], message: "The attempt does not belong to this practice session" });
  }
  if (session.evaluation && session.evaluation.attemptId !== session.lastAttempt?.id) {
    context.addIssue({ code: "custom", path: ["evaluation"], message: "The evaluation must match the last attempt" });
  }
});

const ReceiptSchema = z.object({ attempt: SampleAttemptSchema, evaluation: SampleEvaluationSchema }).strict();
export type SampleSession = z.infer<typeof SampleSessionSchema>;
export interface SampleStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
export interface SampleSnapshot {
  session: SampleSession;
  started: boolean;
  resumed: boolean;
  storageMessage: string | null;
  error: string | null;
}

function newSession(): SampleSession {
  return { schemaVersion: 1, id: crypto.randomUUID(), taskId: SAMPLE_TASK_ID, taskVersion: 1,
    response: createInitialResponse(), lastAttempt: null, evaluation: null, hintIdsUsed: [], updatedAt: new Date().toISOString() };
}

/** Owns only the isolated practice namespace. Viewing the sample never creates storage. */
export class SampleController {
  private snapshot: SampleSnapshot = { session: newSession(), started: false, resumed: false, storageMessage: null, error: null };
  private readonly initialSnapshot = this.snapshot;
  private readonly listeners = new Set<() => void>();
  private receipts: SampleReceipt[] = [];
  private storage: SampleStorage | null = null;
  private attached = false;

  getSnapshot = (): SampleSnapshot => this.snapshot;
  getServerSnapshot = (): SampleSnapshot => this.initialSnapshot;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private publish(next: SampleSnapshot): void { this.snapshot = next; this.listeners.forEach((listener) => listener()); }

  attachStorage(storage: SampleStorage | null): void {
    if (this.attached) return;
    this.attached = true;
    this.storage = storage;
    if (!storage) { this.publish({ ...this.snapshot, storageMessage: "Practice will stay open here, but this browser cannot save it for your next visit." }); return; }
    try {
      const raw = storage.getItem(SAMPLE_STORAGE_KEY);
      if (!raw) return;
      const session = SampleSessionSchema.parse(JSON.parse(raw));
      const receiptRaw = storage.getItem(sampleReceiptsKey(session.id));
      const receipts = receiptRaw ? z.array(ReceiptSchema).parse(JSON.parse(receiptRaw)) : [];
      this.receipts = receipts.filter((receipt) => receipt.attempt.sampleSessionId === session.id && receipt.evaluation.attemptId === receipt.attempt.id);
      if (session.lastAttempt && session.evaluation && !this.receipts.some((receipt) => receipt.attempt.id === session.lastAttempt?.id)) {
        this.receipts.push({ attempt: session.lastAttempt, evaluation: session.evaluation });
      }
      this.publish({ session, started: true, resumed: true, storageMessage: null, error: null });
    } catch {
      this.publish({ ...this.snapshot, storageMessage: "Your saved practice could not be opened. You can start again here; your course drafts are unaffected." });
    }
  }

  private persist(session: SampleSession, saveReceipts = false): string | null {
    if (!this.storage) return "Your changes are kept while this page is open. This browser cannot save them for a later visit.";
    try {
      if (saveReceipts) this.storage.setItem(sampleReceiptsKey(session.id), JSON.stringify(this.receipts));
      this.storage.setItem(SAMPLE_STORAGE_KEY, JSON.stringify(SampleSessionSchema.parse(session)));
      return null;
    } catch { return "Your changes are kept while this page is open, but could not be saved. Keep this page open to continue."; }
  }

  edit(response: CapacityResponse): void {
    const valid = CapacityResponseSchema.parse(response);
    if (JSON.stringify(valid) === JSON.stringify(this.snapshot.session.response)) return;
    const session = { ...this.snapshot.session, response: valid, lastAttempt: null, evaluation: null, updatedAt: new Date().toISOString() };
    const storageMessage = this.persist(session);
    this.publish({ session, started: true, resumed: false, storageMessage, error: null });
  }

  useHint(): void {
    if (this.snapshot.session.hintIdsUsed.includes(SAMPLE_HINT_ID)) return;
    const session: SampleSession = { ...this.snapshot.session, hintIdsUsed: [SAMPLE_HINT_ID], lastAttempt: null, evaluation: null, updatedAt: new Date().toISOString() };
    const storageMessage = this.persist(session);
    this.publish({ session, started: true, resumed: false, storageMessage, error: null });
  }

  submit(): SampleReceipt | null {
    const current = this.snapshot.session;
    try {
      const attempt: SampleAttempt = current.lastAttempt ?? {
        id: crypto.randomUUID(), sampleSessionId: current.id, taskId: current.taskId, taskVersion: current.taskVersion,
        idempotencyKey: crypto.randomUUID(), response: current.response,
        assistance: current.hintIdsUsed.length ? "hinted" : "independent", hintIdsUsed: current.hintIdsUsed,
        submittedAt: new Date().toISOString(),
      };
      const receipt = evaluateSampleAttempt(attempt, this.receipts);
      if (!this.receipts.some((item) => item.attempt.idempotencyKey === attempt.idempotencyKey)) this.receipts.push(receipt);
      const session: SampleSession = { ...current, lastAttempt: receipt.attempt, evaluation: receipt.evaluation, updatedAt: new Date().toISOString() };
      const storageMessage = this.persist(session, true);
      this.publish({ session, started: true, resumed: false, storageMessage, error: null });
      return receipt;
    } catch {
      this.publish({ ...this.snapshot, error: "This answer could not be checked. Your settings are still here. Try checking it again." });
      return null;
    }
  }

  reset(): void {
    let storageMessage: string | null = null;
    try {
      this.storage?.removeItem(sampleReceiptsKey(this.snapshot.session.id));
      this.storage?.removeItem(SAMPLE_STORAGE_KEY);
    } catch { storageMessage = "Practice was reset here, but the old saved copy could not be removed from this browser."; }
    this.receipts = [];
    this.publish({ session: newSession(), started: false, resumed: false, storageMessage, error: null });
  }
}
