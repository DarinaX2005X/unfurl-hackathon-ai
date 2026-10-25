"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { httpAccount } from "@/application/http-account";
import { AppShell } from "@/components/shell/AppShell";
import { Button, LinkButton, Notice, Select, TextField } from "@/components/ui";
import { UpdateProfileInputSchema, type AccountSession, type Profile, type UpdateProfileInput } from "@/domain/account";
import { routes } from "@/lib/routes";
import { languageOptions } from "@/features/creator/languages";
import { accountErrorMessage, accountServerFields, type AccountFieldErrors } from "./account-form";
import { accountScope } from "./account-scope";
import { acceptProfile, refreshAccount, useAccountSession } from "./account-session";
import { SignOutButton } from "./SignOutButton";
import "./account.css";

type ProfileField = "displayName" | "defaultContentLanguage";

function ProfileEditor({ session }: { session: AccountSession }) {
  const [base, setBase] = useState<Profile>(session.profile);
  const [name, setName] = useState(session.profile.displayName ?? "");
  const [language, setLanguage] = useState(session.profile.defaultContentLanguage ?? "");
  const [dirty, setDirty] = useState<Set<ProfileField>>(new Set());
  const [fields, setFields] = useState<AccountFieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [pending, setPending] = useState<"save" | "reload" | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const requestRef = useRef<ReturnType<typeof accountScope.request> | null>(null);
  useEffect(() => () => { requestRef.current?.abort(); requestRef.current = null; }, []);

  function edit(field: ProfileField, value: string) {
    if (field === "displayName") setName(value); else setLanguage(value);
    const original = field === "displayName" ? base.displayName ?? "" : base.defaultContentLanguage ?? "";
    setDirty((current) => { const next = new Set(current); if (value === original) next.delete(field); else next.add(field); return next; });
    setFields((current) => { const next = { ...current }; delete next[field]; return next; });
    setSaved(null);
    if (!conflict) setError(null);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (requestRef.current || dirty.size === 0 || conflict) return;
    const input: UpdateProfileInput = { expectedRevision: base.revision,
      ...(dirty.has("displayName") ? { displayName: name } : {}),
      ...(dirty.has("defaultContentLanguage") ? { defaultContentLanguage: language || null } : {}),
    };
    const parsed = UpdateProfileInputSchema.safeParse(input);
    if (!parsed.success) {
      const invalid: AccountFieldErrors = {};
      for (const issue of parsed.error.issues) {
        if (issue.path[0] === "displayName") invalid.displayName = "Use between 1 and 80 characters for your name.";
        if (issue.path[0] === "defaultContentLanguage") invalid.defaultContentLanguage = "Choose a language from the list.";
      }
      setFields(invalid);
      const field = formRef.current?.elements.namedItem(Object.keys(invalid)[0] ?? "");
      if (field instanceof HTMLElement) field.focus();
      return;
    }
    const request = accountScope.request(session.identity.id);
    requestRef.current = request;
    setPending("save"); setError(null); setSaved(null);
    try {
      const result = await httpAccount.updateProfile(parsed.data, request.signal);
      if (!request.isCurrent()) return;
      if (result.ok) {
        acceptProfile(result.data); setBase(result.data);
        setName(result.data.displayName ?? ""); setLanguage(result.data.defaultContentLanguage ?? "");
        setDirty(new Set()); setFields({}); setSaved("Profile saved");
      } else {
        setFields(accountServerFields(result.error)); setError(accountErrorMessage(result.error));
        setConflict(result.error.error.code === "revision_conflict");
        if (result.error.error.code === "unauthenticated") void refreshAccount();
      }
    } catch { if (!request.signal.aborted) setError("We could not save your profile. Your edits are still here. Please try again."); }
    finally { request.release(); if (requestRef.current === request) { requestRef.current = null; setPending(null); } }
  }

  async function reload() {
    if (requestRef.current) return;
    const request = accountScope.request(session.identity.id);
    requestRef.current = request;
    setPending("reload");
    try {
      const result = await httpAccount.getSession(request.signal);
      if (!request.isCurrent()) return;
      if (result.ok && result.data.session?.identity.id === session.identity.id) {
        const profile = result.data.session.profile;
        setBase(profile); acceptProfile(profile);
        if (!dirty.has("displayName")) setName(profile.displayName ?? "");
        if (!dirty.has("defaultContentLanguage")) setLanguage(profile.defaultContentLanguage ?? "");
        setConflict(false); setError(null); setSaved("Latest profile loaded. Your edits are still here, ready to save.");
      } else if (result.ok) { void refreshAccount(); }
      else setError(accountErrorMessage(result.error));
    } catch { if (!request.signal.aborted) setError("We could not load your profile. Your edits are still here. Please try again."); }
    finally { request.release(); if (requestRef.current === request) { requestRef.current = null; setPending(null); } }
  }

  return <form className="uf-account-form" ref={formRef} onSubmit={save} noValidate aria-busy={pending !== null}>
    <TextField id="profile-name" name="displayName" label="Display name" autoComplete="nickname" value={name} maxLength={80} readOnly={pending !== null}
      onChange={(event) => edit("displayName", event.target.value)}
      onBlur={() => { if (dirty.has("displayName") && !name.trim()) setFields((current) => ({ ...current, displayName: "Use between 1 and 80 characters for your name." })); }}
      {...(fields.displayName ? { error: fields.displayName } : {})} />
    <Select id="profile-language" name="defaultContentLanguage" label="Preferred course language" value={language} disabled={pending !== null}
      options={[{ value: "", label: "Follow my request" }, ...languageOptions(language || "en")]}
      hint="Optional. You can always ask for a different language when creating a course."
      onChange={(event) => edit("defaultContentLanguage", event.target.value)} {...(fields.defaultContentLanguage ? { error: fields.defaultContentLanguage } : {})} />
    {error && <Notice tone="error" {...(conflict ? { action: <Button variant="secondary" size="compact" pending={pending === "reload"} onClick={() => void reload()}>Load latest profile</Button> } : {})}>{error}</Notice>}
    {saved && <p className="uf-account-saved" role="status">{saved}</p>}
    <div><Button type="submit" pending={pending === "save"} disabled={dirty.size === 0 || conflict || pending === "reload"}>{pending === "save" ? "Saving profile" : "Save changes"}</Button></div>
  </form>;
}

export function AccountPage() {
  const account = useAccountSession();
  return <AppShell active="account">
    <div className="uf-account-page">
      <h1>Your account</h1>
      {account.status === "loading" ? <p className="uf-account-secondary" role="status">Loading your account</p>
        : account.status === "error" ? <Notice tone="error" action={<Button variant="secondary" onClick={() => void refreshAccount()}>Try again</Button>}>We could not load your account. Please try again.</Notice>
          : !account.session ? <div className="uf-account-stack"><p>Sign in to manage your profile and account access.</p><div><LinkButton href={routes.login(routes.account)}>Sign in</LinkButton></div></div>
            : <>
              <section className="uf-account-page__section" aria-labelledby="profile-heading">
                <div className="uf-account-page__section-title"><h2 id="profile-heading">Profile</h2><dl className="uf-account-email"><dt>Email</dt><dd>{account.session.identity.email ?? "No email address"}</dd></dl></div>
                <ProfileEditor key={account.session.identity.id} session={account.session} />
              </section>
              <section className="uf-account-page__section uf-account-page__access" aria-labelledby="access-heading">
                <h2 id="access-heading">Password and access</h2>
                <div className="uf-account-stack"><div><Link className="uf-text-link" href={routes.resetPassword(routes.account)}>Change your password</Link></div>
                  <p className="uf-account-secondary">You can change it while this account is signed in.</p>
                  <SignOutButton actorId={account.session.identity.id} />
                </div>
              </section>
            </>}
    </div>
  </AppShell>;
}
