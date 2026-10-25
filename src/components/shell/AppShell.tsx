"use client";

import type { ReactNode } from "react";
import { Menu } from "lucide-react";
import { Drawer, IconButton } from "@/components/ui";
import { commonCopy } from "@/content/common";
import { Brand } from "./Brand";
import { Navigation, type ShellDestination } from "./Navigation";
import { useNavigationMenu } from "./useNavigationMenu";
import { AccountControl } from "./AccountControl";

export interface AppShellProps {
  active: ShellDestination;
  children: ReactNode;
  sidebarContent?: ReactNode;
  contextPanel?: ReactNode;
}

export function AppShell({ active, children, sidebarContent, contextPanel }: AppShellProps) {
  const menu = useNavigationMenu();
  const hasContext = contextPanel !== undefined && contextPanel !== null && contextPanel !== false;

  const navigation = (
    <>
      <Navigation active={active} onNavigate={menu.close} />
      {sidebarContent != null && <div className="uf-shell__history">{sidebarContent}</div>}
      <AccountControl active={active === "account"} onNavigate={menu.close} />
    </>
  );

  return (
    <div className="uf-shell">
      <a className="uf-shell-skip" href="#main-content">{commonCopy.accessibility.skipToContent}</a>
      <header className="uf-shell__mobile-header">
        <Brand />
        <IconButton
          label={commonCopy.navigation.openMenu}
          icon={<Menu size={24} strokeWidth={1.75} />}
          onClick={() => menu.setOpen(true)}
          aria-expanded={menu.open}
          aria-haspopup="dialog"
        />
      </header>
      <div className="uf-shell__layout">
        {menu.desktop ? (
          <aside className="uf-shell__sidebar">
            <Brand />
            {navigation}
          </aside>
        ) : (
          <Drawer open={menu.open} onOpenChange={menu.setOpen} title={commonCopy.navigation.menuTitle}>
            <div className="uf-shell__drawer-content">{navigation}</div>
          </Drawer>
        )}
        <div className={`uf-shell__workspace${hasContext ? " uf-shell__workspace--context" : ""}`}>
          <main className="uf-shell__main" id="main-content" tabIndex={-1}>{children}</main>
          {hasContext && (
            <aside className="uf-shell__context" aria-label={commonCopy.accessibility.courseContext}>
              {contextPanel}
            </aside>
          )}
        </div>
      </div>
    </div>
  );
}
