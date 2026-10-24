"use client";

import { X } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { IconButton } from "./button";

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
}

let scrollLockCount = 0;
let previousOverflow = "";
function lockScroll() {
  if (scrollLockCount === 0) { previousOverflow = document.body.style.overflow; document.body.style.overflow = "hidden"; }
  scrollLockCount += 1;
  return () => {
    scrollLockCount = Math.max(0, scrollLockCount - 1);
    if (scrollLockCount === 0) document.body.style.overflow = previousOverflow;
  };
}

function DialogSurface({ open, onOpenChange, title, description, children, footer, drawer }: DialogProps & { drawer: boolean }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const id = useId();

  useEffect(() => {
    const element = dialogRef.current;
    if (!open || !element) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!element.open) element.showModal();
    const unlock = lockScroll();
    return () => {
      if (element.open) element.close();
      unlock();
      if (previousFocus?.isConnected && !previousFocus.closest("dialog:not([open])")) previousFocus.focus({ preventScroll: true });
    };
  }, [open]);

  return <dialog ref={dialogRef} className={drawer ? "uf-dialog uf-dialog--drawer" : "uf-dialog"}
    aria-labelledby={`${id}-title`} aria-describedby={description ? `${id}-description` : undefined}
    onCancel={(event) => { event.preventDefault(); onOpenChange(false); }}
    onClose={() => { if (open) onOpenChange(false); }}
    onClick={(event) => {
      if (event.target !== event.currentTarget) return;
      const rect = event.currentTarget.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onOpenChange(false);
    }}>
    <header className="uf-dialog__header">
      <div className="uf-dialog__heading"><h2 id={`${id}-title`}>{title}</h2>{description && <p id={`${id}-description`}>{description}</p>}</div>
      <IconButton label={`Close ${title}`} icon={<X size={20} strokeWidth={1.75} />} className="uf-dialog__close" onClick={() => onOpenChange(false)} />
    </header>
    <div className="uf-dialog__body">{children}</div>
    {footer && <footer className="uf-dialog__footer">{footer}</footer>}
  </dialog>;
}

/** Native modal semantics retain child state even while the closed dialog is hidden. */
export function Dialog(props: DialogProps) { return <DialogSurface {...props} drawer={false} />; }
export function Drawer(props: DialogProps) { return <DialogSurface {...props} drawer />; }
