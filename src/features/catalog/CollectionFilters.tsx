"use client";
import { useState, type FormEvent } from "react";
import { Search } from "lucide-react";
import { Button, Select, TextField } from "@/components/ui";
import { languageName } from "./query";

export function CollectionFilters({ q, contentLanguage, onChange, noun = "courses" }: { q: string; contentLanguage: string; onChange: (q: string, language: string) => void; noun?: string }) {
  const [text, setText] = useState(q);
  const [previousQuery, setPreviousQuery] = useState(q);
  if (previousQuery !== q) { setPreviousQuery(q); setText(q); }
  const languages = ["en", "es", "fr", "de", "ja", "ko", "zh", "ar", "pt", "ru", "kk"];
  if (contentLanguage && !languages.includes(contentLanguage)) languages.push(contentLanguage);
  function submit(event: FormEvent) { event.preventDefault(); onChange(text.trim(), contentLanguage); }
  return <form className="uf-collection-filters" role="search" aria-label={`Search ${noun}`} onSubmit={submit}>
    <div className="uf-collection-filters__query"><TextField id={`search-${noun}`} type="search" label={`Search ${noun}`} placeholder="Find a subject or learning goal" maxLength={200} value={text} onChange={(event) => setText(event.target.value)} /><Button type="submit" variant="secondary"><Search size={20} aria-hidden="true" />Search</Button></div>
    <Select id={`${noun}-language`} label="Course language" value={contentLanguage} options={[{ value: "", label: "All languages" }, ...languages.map((code) => ({ value: code, label: languageName(code) }))]} onChange={(event) => onChange(text.trim(), event.target.value)} />
    {(q || contentLanguage) && <Button className="uf-collection-filters__reset" variant="quiet" onClick={() => { setText(""); onChange("", ""); }}>Reset filters</Button>}
  </form>;
}
