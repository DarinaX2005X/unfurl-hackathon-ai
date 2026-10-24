import { CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react";
import { useId, type ReactNode } from "react";
import { classes } from "./utils";

export interface NoticeProps { tone: "info" | "success" | "warning" | "error"; title?: string; children: ReactNode; action?: ReactNode; className?: string }
const noticeIcons = { info: Info, success: CircleCheck, warning: TriangleAlert, error: CircleAlert };

export function Notice({ tone, title, children, action, className }: NoticeProps) {
  const Icon = noticeIcons[tone];
  return <div className={classes("uf-notice", className)} data-tone={tone} role={tone === "error" ? "alert" : "status"}>
    <Icon className="uf-notice__icon" size={22} strokeWidth={1.75} aria-hidden="true" />
    <div className="uf-notice__content">{title && <p className="uf-notice__title">{title}</p>}<div>{children}</div>{action && <div className="uf-notice__action">{action}</div>}</div>
  </div>;
}

export interface EmptyStateProps { title: string; children: ReactNode; action?: ReactNode; className?: string }
export function EmptyState({ title, children, action, className }: EmptyStateProps) {
  return <section className={classes("uf-empty", className)}>
    <h2>{title}</h2><div className="uf-empty__description">{children}</div>{action && <div className="uf-empty__action">{action}</div>}
  </section>;
}

export interface ProgressProps { value: number; max: number; label: string; className?: string }
export function progressPercentage(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0 || value < 0 || value > max) {
    throw new RangeError("Progress needs a finite measured value between zero and a positive maximum");
  }
  return Math.round(value / max * 100);
}

export function Progress({ value, max, label, className }: ProgressProps) {
  const id = useId();
  const percentage = progressPercentage(value, max);
  return <div className={classes("uf-progress", className)}>
    <div className="uf-progress__heading"><label htmlFor={id}>{label}</label><span aria-hidden="true">{percentage}%</span></div>
    <progress id={id} className="uf-progress__bar" max={max} value={value}>{percentage}%</progress>
  </div>;
}
