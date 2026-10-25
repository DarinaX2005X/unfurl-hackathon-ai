import type { ComponentType } from "react";
import type { z } from "zod";
import type { Evaluation, JsonValue, TaskPublic } from "@/domain";
import type { ActionReceipt, ActivityAction, ActivitySessionPublic } from "@/domain/activity";
import type { ApiError } from "@/domain/errors";
import type { FamilyDescriptor } from "@/domain/mechanic-families/v2/shared";

/** The player saves the current input and coordinates authenticated actions. */
export interface ActivityController {
  session: ActivitySessionPublic | null;
  pending: boolean;
  error: ApiError | null;
  dispatch(action: ActivityAction): Promise<
    { ok: true; data: ActionReceipt } | { ok: false; error: ApiError }
  >;
}

export interface TaskRendererProps<C extends JsonValue, R extends JsonValue> {
  task: TaskPublic<C>;
  response: R;
  onChange: (next: R) => void;
  disabled: boolean;
  status: "editing" | "submitting" | "evaluated" | "error";
  evaluation: Evaluation | null;
  activity?: ActivityController;
}

export interface ProductionMechanic<C extends JsonValue, R extends JsonValue>
  extends RegisteredMechanic<C, R> {
  descriptor: FamilyDescriptor<C, R>;
}

export interface RegisteredMechanic<C extends JsonValue, R extends JsonValue> {
  configSchema: z.ZodType<C>;
  responseSchema: z.ZodType<R>;
  createInitialResponse: (config: C) => R;
  Renderer: ComponentType<TaskRendererProps<C, R>>;
  summarizeResponse: (response: R) => string;
}
