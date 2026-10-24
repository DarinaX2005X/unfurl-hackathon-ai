import type { ReactNode } from "react";
import { PublicHeader } from "@/components/shell";
import { SiteFooter } from "./SiteFooter";

export function InfoLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <PublicHeader />
      <main id="main-content" className="uf-info" tabIndex={-1}>{children}</main>
      <SiteFooter />
    </>
  );
}
