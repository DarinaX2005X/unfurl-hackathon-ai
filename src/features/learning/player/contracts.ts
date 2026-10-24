import type { ComponentType } from "react";
import type { z } from "zod";
import type { Evaluation, JsonValue, TaskPublic } from "@/domain";

export interface TaskRendererProps<C extends JsonValue, R extends JsonValue> {
  task: TaskPublic<C>;
  response: R;
  onChange: (next: R) => void;
  disabled: boolean;
  status: "editing" | "submitting" | "evaluated" | "error";
  evaluation: Evaluation | null;
}

export interface RegisteredMechanic<C extends JsonValue, R extends JsonValue> {
  configSchema: z.ZodType<C>;
  responseSchema: z.ZodType<R>;
  createInitialResponse: (config: C) => R;
  Renderer: ComponentType<TaskRendererProps<C, R>>;
  summarizeResponse: (response: R) => string;
}
