import Link from "next/link";
import { Brand } from "@/components/shell";
import { commonCopy } from "@/content/common";
import { routes } from "@/lib/routes";
import "./info.css";

export function SiteFooter() {
  return (
    <footer className="uf-site-footer">
      <div className="uf-site-footer__inner">
        <div className="uf-site-footer__identity">
          <Brand />
          <p>{commonCopy.brand.tagline}</p>
        </div>
        <nav className="uf-site-footer__group" aria-label="Product">
          <h2>Product</h2>
          <ul>
            <li><Link href={routes.create()}>{commonCopy.navigation.create}</Link></li>
            <li><Link href={routes.try}>Try an activity</Link></li>
            <li><Link href={routes.explore}>Explore courses</Link></li>
            <li><Link href={routes.library}>{commonCopy.navigation.library}</Link></li>
          </ul>
        </nav>
        <nav className="uf-site-footer__group" aria-label="About and help">
          <h2>About and help</h2>
          <ul>
            <li><Link href={routes.about}>About Unfurl</Link></li>
            <li><Link href={routes.help}>Help</Link></li>
            <li><Link href={routes.privacy}>Privacy</Link></li>
          </ul>
        </nav>
      </div>
    </footer>
  );
}
