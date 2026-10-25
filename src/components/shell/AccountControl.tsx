"use client";

import Link from "next/link";
import { CircleHelp, UserRound } from "lucide-react";
import { Button, LinkButton } from "@/components/ui";
import { useAccountSession } from "@/features/account/account-session";
import { SignOutButton } from "@/features/account/SignOutButton";
import { routes } from "@/lib/routes";
import "@/features/account/account.css";

export function AccountControl({ placement = "sidebar", active = false, onNavigate }: { placement?: "header" | "sidebar"; active?: boolean; onNavigate?: () => void }) {
  const account = useAccountSession();
  const signedIn = account.status === "ready" && account.session !== null;
  if (placement === "header") {
    if (account.status === "loading") return <Button variant="quiet" size="compact" disabled>Account</Button>;
    return <LinkButton variant="quiet" size="compact" href={signedIn ? routes.account : routes.login()}>{signedIn ? "Account" : "Sign in"}</LinkButton>;
  }
  return <div className="uf-account-control">
    {account.status === "loading" ? <Button variant="quiet" size="compact" pending disabled>Loading account</Button> : <Link className="uf-shell-nav__link" href={signedIn ? routes.account : routes.login()} aria-current={active ? "page" : undefined}
      {...(onNavigate ? { onClick: onNavigate } : {})}>
      <UserRound size={22} strokeWidth={1.75} aria-hidden="true" /><span>{signedIn ? "Account" : "Sign in"}</span>
    </Link>}
    <Link className="uf-shell-nav__link" href={routes.help} {...(onNavigate ? { onClick: onNavigate } : {})}>
      <CircleHelp size={22} strokeWidth={1.75} aria-hidden="true" /><span>Help</span>
    </Link>
    {account.status === "ready" && account.session && <SignOutButton actorId={account.session.identity.id} compact />}
  </div>;
}
