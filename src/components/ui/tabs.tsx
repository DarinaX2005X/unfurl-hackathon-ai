"use client";

import { useId, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { classes } from "./utils";

export interface TabItem { id: string; label: string; panel: ReactNode; disabled?: boolean }
export interface TabsProps { value: string; onValueChange: (value: string) => void; items: TabItem[]; label?: string; className?: string }

export function nextTabId(items: ReadonlyArray<Pick<TabItem, "id" | "disabled">>, current: string, key: string): string | undefined {
  const enabled = items.filter((item) => !item.disabled);
  if (!enabled.length) return undefined;
  if (key === "Home") return enabled[0]?.id;
  if (key === "End") return enabled.at(-1)?.id;
  if (key !== "ArrowLeft" && key !== "ArrowRight") return undefined;
  const position = enabled.findIndex((item) => item.id === current);
  const direction = key === "ArrowRight" ? 1 : -1;
  return enabled[(Math.max(position, 0) + direction + enabled.length) % enabled.length]?.id;
}

export function Tabs({ value, onValueChange, items, label = "Sections", className }: TabsProps) {
  const groupId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const plateRef = useRef<HTMLSpanElement>(null);
  const buttonRefs = useRef(new Map<string, HTMLButtonElement>());
  const activeId = items.find((item) => item.id === value && !item.disabled)?.id ?? items.find((item) => !item.disabled)?.id;

  useLayoutEffect(() => {
    const list = listRef.current;
    const plate = plateRef.current;
    if (!list || !plate) return;
    const update = () => {
      const selected = activeId ? buttonRefs.current.get(activeId) : null;
      if (!selected || selected.offsetWidth === 0) { plate.hidden = true; return; }
      plate.style.width = `${selected.offsetWidth}px`;
      plate.style.height = `${selected.offsetHeight}px`;
      plate.style.transform = `translate(${selected.offsetLeft}px, ${selected.offsetTop}px)`;
      plate.hidden = false;
      list.dataset.indicatorReady = "true";
    };
    update();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
    observer?.observe(list);
    for (const button of buttonRefs.current.values()) observer?.observe(button);
    return () => observer?.disconnect();
  }, [activeId, items]);

  function handleKey(event: KeyboardEvent<HTMLButtonElement>, id: string) {
    const next = nextTabId(items, id, event.key);
    if (!next) return;
    event.preventDefault();
    onValueChange(next);
    buttonRefs.current.get(next)?.focus({ preventScroll: true });
  }

  return <div className={classes("uf-tabs", className)}>
    <div ref={listRef} className="uf-tabs__list" role="tablist" aria-label={label}>
      <span ref={plateRef} className="uf-tabs__indicator" aria-hidden="true" hidden />
      {items.map((item, index) => <button key={item.id} ref={(node) => { if (node) buttonRefs.current.set(item.id, node); else buttonRefs.current.delete(item.id); }}
        id={`${groupId}-tab-${index}`} aria-controls={`${groupId}-panel-${index}`} className="uf-tabs__tab" role="tab" type="button"
        aria-selected={item.id === activeId} tabIndex={item.id === activeId ? 0 : -1} disabled={item.disabled}
        onClick={() => onValueChange(item.id)} onKeyDown={(event) => handleKey(event, item.id)}>{item.label}</button>)}
    </div>
    {items.map((item, index) => <div key={item.id} id={`${groupId}-panel-${index}`} aria-labelledby={`${groupId}-tab-${index}`}
      role="tabpanel" className="uf-tabs__panel" tabIndex={0} hidden={item.id !== activeId}>{item.panel}</div>)}
  </div>;
}
