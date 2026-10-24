"use client";

import Link from "next/link";
import { Menu } from "lucide-react";
import { Drawer, IconButton, LinkButton } from "@/components/ui";
import { commonCopy } from "@/content/common";
import { routes } from "@/lib/routes";
import { Brand } from "./Brand";
import { Navigation } from "./Navigation";
import { useNavigationMenu } from "./useNavigationMenu";

export function PublicHeader() {
  const menu = useNavigationMenu();

  return (
    <>
      <a className="uf-shell-skip" href="#main-content">{commonCopy.accessibility.skipToContent}</a>
      <header className="uf-public-header">
        <div className="uf-public-header__inner">
          <Brand />
          <nav className="uf-public-header__links" aria-label={commonCopy.navigation.label}>
            <Link className="uf-public-header__link" href={routes.explore}>{commonCopy.navigation.explore}</Link>
            <Link className="uf-public-header__link" href={routes.library}>{commonCopy.navigation.library}</Link>
          </nav>
          <div className="uf-public-header__action">
            <LinkButton href={routes.create()} size="compact">{commonCopy.navigation.create}</LinkButton>
          </div>
          <div className="uf-public-header__menu">
            <IconButton
              label={commonCopy.navigation.openMenu}
              icon={<Menu size={24} strokeWidth={1.75} />}
              onClick={() => menu.setOpen(true)}
              aria-expanded={menu.open}
              aria-haspopup="dialog"
            />
          </div>
        </div>
      </header>
      <Drawer open={!menu.desktop && menu.open} onOpenChange={menu.setOpen} title={commonCopy.navigation.menuTitle}>
        <Navigation onNavigate={menu.close} />
      </Drawer>
    </>
  );
}
