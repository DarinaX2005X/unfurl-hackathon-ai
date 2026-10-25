import type { ReactNode } from "react";
import styles from "./player.module.css";

function inline(text: string): ReactNode[] {
  const tokens = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\(https?:\/\/[^\s)]+\))/g);
  return tokens.map((token, index) => {
    if (token.startsWith("`") && token.endsWith("`")) return <code key={index}>{token.slice(1, -1)}</code>;
    if (token.startsWith("**") && token.endsWith("**")) return <strong key={index}>{token.slice(2, -2)}</strong>;
    const link = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(token);
    if (link) { try { const url = new URL(link[2]!); if (!url.username && !url.password) return <a key={index} href={url.href} target="_blank" rel="noopener noreferrer">{link[1]}</a>; } catch { /* Invalid links remain readable text. */ } }
    return token;
  });
}

/** Deliberately small Markdown subset: all content stays React text, never HTML. */
export function LessonText({ text }: { text: string }) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (!line.trim()) { index += 1; continue; }
    if (line.trimStart().startsWith("```")) {
      const code: string[] = []; index += 1;
      while (index < lines.length && !lines[index]!.trimStart().startsWith("```")) code.push(lines[index++]!);
      index += 1; blocks.push(<pre key={blocks.length}><code>{code.join("\n")}</code></pre>); continue;
    }
    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    if (heading) { blocks.push(<h3 key={blocks.length}>{inline(heading[1]!)}</h3>); index += 1; continue; }
    const list = /^\s*(?:[-*]|\d+\.)\s+/.test(line);
    if (list) {
      const ordered = /^\s*\d+\./.test(line); const items: ReactNode[] = [];
      while (index < lines.length && /^\s*(?:[-*]|\d+\.)\s+/.test(lines[index]!)) items.push(<li key={items.length}>{inline(lines[index++]!.replace(/^\s*(?:[-*]|\d+\.)\s+/, ""))}</li>);
      blocks.push(ordered ? <ol key={blocks.length}>{items}</ol> : <ul key={blocks.length}>{items}</ul>); continue;
    }
    const paragraph = [line]; index += 1;
    while (index < lines.length && lines[index]!.trim() && !/^(?:#{1,6}\s|```|\s*(?:[-*]|\d+\.)\s)/.test(lines[index]!)) paragraph.push(lines[index++]!);
    blocks.push(<p key={blocks.length}>{inline(paragraph.join("\n"))}</p>);
  }
  return <div className={styles.prose}>{blocks}</div>;
}
