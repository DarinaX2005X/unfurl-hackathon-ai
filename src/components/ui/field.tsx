"use client";

import { ChevronDown } from "lucide-react";
import { forwardRef, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { classes, describedBy } from "./utils";

interface FieldDescription {
  id: string;
  label: string;
  hint?: ReactNode;
  error?: ReactNode;
}

function FieldMessages({ id, hint, error }: Pick<FieldDescription, "id" | "hint" | "error">) {
  return <>
    {hint && <div id={`${id}-hint`} className="uf-field__hint">{hint}</div>}
    {error && <div id={`${id}-error`} className="uf-field__error" role="alert">{error}</div>}
  </>;
}

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "id">, FieldDescription {}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { id, label, hint, error, className, "aria-describedby": externalDescription, "aria-invalid": invalid, ...props }, ref,
) {
  return <div className={classes("uf-field", className)} data-invalid={Boolean(error) || undefined}>
    <label className="uf-field__label" htmlFor={id}>{label}</label>
    <input {...props} ref={ref} id={id} className="uf-field__input" aria-invalid={error ? true : invalid}
      aria-describedby={describedBy(externalDescription, Boolean(hint) && `${id}-hint`, Boolean(error) && `${id}-error`)} />
    <FieldMessages id={id} hint={hint} error={error} />
  </div>;
});

export interface TextareaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "id">, FieldDescription {}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { id, label, hint, error, className, rows = 4, "aria-describedby": externalDescription, "aria-invalid": invalid, ...props }, ref,
) {
  return <div className={classes("uf-field", className)} data-invalid={Boolean(error) || undefined}>
    <label className="uf-field__label" htmlFor={id}>{label}</label>
    <textarea {...props} ref={ref} id={id} rows={rows} className="uf-field__input uf-field__textarea" aria-invalid={error ? true : invalid}
      aria-describedby={describedBy(externalDescription, Boolean(hint) && `${id}-hint`, Boolean(error) && `${id}-error`)} />
    <FieldMessages id={id} hint={hint} error={error} />
  </div>;
});

export interface SelectOption { value: string; label: string; disabled?: boolean }
export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "id" | "children">, FieldDescription {
  options: SelectOption[];
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { id, label, hint, error, options, className, multiple = false, "aria-describedby": externalDescription, "aria-invalid": invalid, ...props }, ref,
) {
  return <div className={classes("uf-field", className)} data-invalid={Boolean(error) || undefined}>
    <label className="uf-field__label" htmlFor={id}>{label}</label>
    <div className="uf-field__select-wrap">
      <select {...props} ref={ref} id={id} multiple={multiple} className="uf-field__input uf-field__select" aria-invalid={error ? true : invalid}
        aria-describedby={describedBy(externalDescription, Boolean(hint) && `${id}-hint`, Boolean(error) && `${id}-error`)}>
        {options.map((option) => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}
      </select>
      {!multiple && <ChevronDown className="uf-field__chevron" size={18} strokeWidth={1.75} aria-hidden="true" />}
    </div>
    <FieldMessages id={id} hint={hint} error={error} />
  </div>;
});
