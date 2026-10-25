import Link from "next/link";
import { useId, type ReactNode } from "react";
import { Brand } from "@/components/shell/Brand";
import { routes } from "@/lib/routes";
import "./account.css";

function OpenBook() {
  const id = useId().replaceAll(":", "");
  return <svg className="uf-auth-book" viewBox="0 0 480 340" aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id={`${id}-paper`} x1="0" x2="1"><stop stopColor="#e1ddcf" /><stop offset=".16" stopColor="#fffefa" /><stop offset=".82" stopColor="#fffefa" /><stop offset="1" stopColor="#e6e1d5" /></linearGradient>
      <linearGradient id={`${id}-cover`} x1="0" y1="0" x2=".8" y2="1"><stop stopColor="#d17b5e" /><stop offset="1" stopColor="#a23f2c" /></linearGradient>
      <linearGradient id={`${id}-gutter`}><stop stopColor="#8b7660" stopOpacity="0" /><stop offset=".5" stopColor="#8b7660" stopOpacity=".22" /><stop offset="1" stopColor="#8b7660" stopOpacity="0" /></linearGradient>
    </defs>
    <ellipse cx="243" cy="282" rx="179" ry="18" fill="#25272b" opacity=".055" />
    <ellipse cx="243" cy="277" rx="137" ry="9" fill="#25272b" opacity=".07" />
    <path d="m66 146 160 15 162-48 34 148q1 10-11 13l-157 32q-11 3-24-1L74 270q-9-2-10-12Z" fill="#80392b" />
    <path d="m66 134 165 19 153-55 35 151q2 10-10 13l-155 33q-11 2-25-1L72 259q-10-2-10-12Z" fill={`url(#${id}-cover)`} />
    <path d="m81 142 145 18 145-48 31 133-159 36L79 247Z" fill="#d2cbbb" />
    <path d="m82 138 143 19 146-48 30 130-159 36L80 241Z" fill="#e8e1d3" />
    <path d="m82 232 158 35 157-35M83 226l157 34 155-35" fill="none" stroke="#bcb3a1" strokeWidth="1.2" />
    <path d="M82 115q89-31 154 27 54-66 135-57l28 143q-81-13-155 32-61-51-164-35Z" fill={`url(#${id}-paper)`} />
    <path d="M82 115q89-31 154 27l8 118q-62-51-164-35Z" fill="#fffefa" opacity=".42" />
    <path d="M221 131q17 5 31-5l10 123-18 11-16-13Z" fill={`url(#${id}-gutter)`} />
    <path d="m236 142 8 118" fill="none" stroke="#b8ab95" strokeWidth="1.3" />
    <path d="M87 116q84-26 148 28M241 142q55-62 127-55" fill="none" stroke="#fffefa" strokeWidth="3" />
    <path d="m314 91 17-2 28 155-10-4-9 8Z" fill="#ba432d" />
    <path d="m316 93 5 0 27 145" fill="none" stroke="#de9a7d" strokeWidth="1.2" />
    <path d="M120 153q45-6 80 14M119 167q45-4 81 15M119 181q41-1 64 10" fill="none" stroke="#d9d4c9" strokeWidth="3" strokeLinecap="round" />
    <path d="M267 169q16-19 35-27M268 183q18-20 37-26" fill="none" stroke="#d9d4c9" strokeWidth="3" strokeLinecap="round" />
  </svg>;
}

export function AuthLayout({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return <div className="uf-auth">
    <a className="uf-shell-skip" href="#main-content">Skip to content</a>
    <header className="uf-auth__header">
      <Brand />
      <Link className="uf-text-link" href={routes.explore}>Explore courses</Link>
    </header>
    <main className="uf-auth__main" id="main-content" tabIndex={-1}>
      <section className="uf-auth__form-region" aria-labelledby="account-title">
        <div className="uf-auth__heading"><h1 id="account-title">{title}</h1>{description && <p>{description}</p>}</div>
        {children}
      </section>
      <aside className="uf-auth__identity" aria-label="Unfurl">
        <p>Learn what you’ve<br />always wanted to</p>
        <OpenBook />
      </aside>
    </main>
    <footer className="uf-auth__footer">
      <Link className="uf-text-link" href={routes.home}>Back to home</Link>
      <div><Link className="uf-text-link" href={routes.help}>Help</Link><Link className="uf-text-link" href={routes.privacy}>Privacy</Link></div>
    </footer>
  </div>;
}
