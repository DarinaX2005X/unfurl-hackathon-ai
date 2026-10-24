import Link from "next/link";
import { BookOpen, Compass } from "lucide-react";
import { LinkButton } from "@/components/ui";
import { commonCopy } from "@/content/common";
import { routes } from "@/lib/routes";

export type ShellDestination = "explore" | "library" | "create" | "learn";

interface NavigationProps {
  active?: ShellDestination;
  onNavigate?: () => void;
}

const destinations = [
  { id: "explore", label: commonCopy.navigation.explore, href: routes.explore, Icon: Compass },
  { id: "library", label: commonCopy.navigation.library, href: routes.library, Icon: BookOpen },
] as const;

export function Navigation({ active, onNavigate }: NavigationProps) {
  return (
    <nav className="uf-shell-nav" aria-label={commonCopy.navigation.label}>
      <LinkButton
        href={routes.create()}
        className="uf-shell-nav__create"
        aria-current={active === "create" ? "page" : undefined}
        {...(onNavigate ? { onClick: onNavigate } : {})}
      >
        {commonCopy.navigation.create}
      </LinkButton>
      <ul className="uf-shell-nav__list">
        {destinations.map(({ id, label, href, Icon }) => (
          <li key={id}>
            <Link
              className="uf-shell-nav__link"
              href={href}
              aria-current={active === id ? "page" : undefined}
              {...(onNavigate ? { onClick: onNavigate } : {})}
            >
              <Icon aria-hidden="true" focusable="false" size={22} strokeWidth={1.75} />
              <span>{label}</span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
