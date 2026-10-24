"use client";

import Link from "next/link";
import { forwardRef, type AnchorHTMLAttributes, type ButtonHTMLAttributes, type MouseEvent, type ReactNode } from "react";
import { classes, isAriaDisabled } from "./utils";

export type ButtonVariant = "primary" | "secondary" | "quiet" | "danger";
export type ButtonSize = "default" | "compact";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  pending?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "default", pending = false, disabled = false, type = "button", className, children, onClick, "aria-disabled": ariaDisabled, ...props }, ref,
) {
  const unavailable = disabled || pending || isAriaDisabled(ariaDisabled);
  return (
    <button {...props} ref={ref} type={type} disabled={unavailable} aria-disabled={unavailable || undefined} aria-busy={pending || undefined}
      className={classes("uf-button", `uf-button--${variant}`, `uf-button--${size}`, className)} data-pending={pending || undefined}
      onClick={(event) => { if (!unavailable) onClick?.(event); }}>
      <span className="uf-button__surface" aria-hidden="true" />
      <span className="uf-button__content">{children}</span>
      {pending && <span className="uf-button__pending" aria-hidden="true" />}
    </button>
  );
});

export interface LinkButtonProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  href: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export const LinkButton = forwardRef<HTMLAnchorElement, LinkButtonProps>(function LinkButton(
  { href, variant = "primary", size = "default", className, children, onClick, onMouseEnter, onTouchStart, tabIndex, "aria-disabled": ariaDisabled, ...props }, ref,
) {
  const unavailable = isAriaDisabled(ariaDisabled);
  function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    if (unavailable) { event.preventDefault(); event.stopPropagation(); return; }
    onClick?.(event);
  }
  return (
    <Link {...props} {...(onMouseEnter ? { onMouseEnter } : {})} {...(onTouchStart ? { onTouchStart } : {})}
      ref={ref} href={href} aria-disabled={unavailable || undefined} tabIndex={unavailable ? -1 : tabIndex}
      onClick={handleClick} className={classes("uf-button", `uf-button--${variant}`, `uf-button--${size}`, className)}>
      <span className="uf-button__surface" aria-hidden="true" />
      <span className="uf-button__content">{children}</span>
    </Link>
  );
});

export interface IconButtonProps extends Omit<ButtonProps, "children" | "aria-label"> {
  label: string;
  icon: ReactNode;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, variant = "quiet", className, ...props }, ref,
) {
  return <Button {...props} ref={ref} variant={variant} aria-label={label} className={classes("uf-icon-button", className)}>
    <span className="uf-icon-button__glyph" aria-hidden="true">{icon}</span>
  </Button>;
});
