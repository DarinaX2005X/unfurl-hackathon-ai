import Markdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

function safeUrl(url: string): string | undefined {
  const value = defaultUrlTransform(url);
  if (!value || /[\u0000-\u0020\u007f\\]/.test(value)) return;
  try {
    const parsed = new URL(value, "https://unfurl.invalid");
    if (!["http:", "https:", "mailto:"].includes(parsed.protocol) || parsed.username || parsed.password) return;
    return value;
  } catch { return; }
}

const components: Components = {
  h1: "h3",
  h2: "h3",
  a: ({ children, href, title }) => href
    ? <a href={href} title={title} {...(/^https?:\/\//i.test(href) ? { target: "_blank", rel: "noopener noreferrer" } : {})}>{children}</a>
    : <span>{children}</span>,
  // Assistant messages cannot cause remote image requests or execute raw HTML.
  img: ({ alt }) => alt ? <span>{alt}</span> : null,
  pre: ({ children }) => <pre tabIndex={0} role="region" aria-label="Code block">{children}</pre>,
  table: ({ children }) => <div className="creator-markdown__table" tabIndex={0} role="region" aria-label="Table"><table>{children}</table></div>,
};

/** CommonMark + GFM, rendered as React elements without raw-HTML plugins. */
export function AssistantMarkdown({ text }: { text: string }) {
  return <div className="creator-markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={safeUrl} components={components}>{text}</Markdown></div>;
}
