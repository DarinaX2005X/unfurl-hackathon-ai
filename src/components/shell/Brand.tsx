import Link from "next/link";
import { commonCopy } from "@/content/common";
import { routes } from "@/lib/routes";

export interface BrandProps {
  compact?: boolean;
  href?: string;
}

export function Brand({ compact = false, href = routes.home }: BrandProps) {
  return (
    <Link className="uf-brand" href={href} aria-label={commonCopy.brand.homeLabel}>
      <svg className="uf-brand__mark" viewBox="6 1 80 80" aria-hidden="true" focusable="false">
        <path d="M14 14h16v29c0 10 6 17 16 17s16-7 16-17V29l16 7v7c0 19-13 32-32 32S14 62 14 43Z" />
        <path d="M44 7 78 22v16L44 23Z" />
      </svg>
      {!compact && <span className="uf-brand__wordmark">{commonCopy.brand.name}</span>}
    </Link>
  );
}
