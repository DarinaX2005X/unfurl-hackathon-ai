"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ChevronDown } from "lucide-react";
import { Button } from "./button";

export interface MenuItem { id: string; label: string; onSelect: () => void; disabled?: boolean; danger?: boolean }
export interface MenuProps { label: string; items: MenuItem[] }

export function Menu({ label, items }: MenuProps) {
  return <DropdownMenu.Root>
    <DropdownMenu.Trigger asChild>
      <Button variant="quiet" size="compact" className="uf-menu__trigger">{label}<ChevronDown size={16} strokeWidth={1.75} aria-hidden="true" /></Button>
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content className="uf-menu__content" align="end" sideOffset={8} collisionPadding={12}>
        {items.map((item) => <DropdownMenu.Item key={item.id} className="uf-menu__item" data-danger={item.danger || undefined}
          disabled={Boolean(item.disabled)} onSelect={item.onSelect}>{item.label}</DropdownMenu.Item>)}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>;
}
