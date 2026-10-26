import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AssistantMarkdown } from "../../src/features/creator/AssistantMarkdown";

const render = (text: string) => renderToStaticMarkup(<AssistantMarkdown text={text} />);

describe("assistant Markdown", () => {
  it("formats the reported curriculum response with real headings and emphasis", () => {
    const html = render("I have created the curriculum for **Artificial Intelligence and Machine Learning Systems: Foundations to Production**.\n\n### Curriculum Structure\n\nFive progressive phases.\n\n#### 1. Algorithmic AI Foundations & Search\n\n- **Search methods**\n  - Compare *breadth-first* and depth-first search.\n  - Use `visited` to avoid repeated states.");
    expect(html).toContain("<strong>Artificial Intelligence and Machine Learning Systems: Foundations to Production</strong>");
    expect(html).toContain("<h3>Curriculum Structure</h3>");
    expect(html).toContain("<h4>1. Algorithmic AI Foundations &amp; Search</h4>");
    expect(html.match(/<ul>/g)).toHaveLength(2);
    expect(html).toContain("<em>breadth-first</em>");
    expect(html).toContain("<code>visited</code>");
    expect(html).not.toContain("###");
  });

  it("supports ordered lists, quotes, GFM tables and source links", () => {
    const html = render("3. Measure the baseline.\n4. Compare held-out results.\n\n> Keep the test set independent.\n\n| Method | Purpose |\n| --- | --- |\n| Validation | Select a model |\n\n[Source](https://example.org/book?q=learning#evaluation) and [Library](/library).");
    expect(html).toContain('<ol start="3">');
    expect(html).toContain("<blockquote>");
    expect(html).toContain('<div class="creator-markdown__table" tabindex="0" role="region" aria-label="Table"><table>');
    expect(html).toContain("<th>Method</th>");
    expect(html).toContain('href="https://example.org/book?q=learning#evaluation" target="_blank" rel="noopener noreferrer"');
    expect(html).toContain('<a href="/library">Library</a>');
  });

  it("keeps fenced code literal and handles an unfinished streaming fence", () => {
    const html = render("```html\n<img src=x onerror=alert(1)>\n**literal code**");
    expect(html).toContain('<pre tabindex="0" role="region" aria-label="Code block"><code class="language-html">');
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("**literal code**");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<strong>");
  });

  it.each([
    "javascript:alert(1)", "jav&#x61;script:alert(1)", "vbscript:msgbox(1)", "data:text/html;base64,PHNjcmlwdD4=",
    "https://user:password@example.org/secret", "//user:password@example.org/secret", "file:///etc/passwd",
  ])("renders unsafe or credential-bearing links as text: %s", (url) => {
    const html = render(`[Readable label](${url})`);
    expect(html).toContain("Readable label");
    expect(html).not.toContain("href=");
  });

  it("ignores raw HTML and never requests Markdown images", () => {
    const html = render('<script>alert("private")</script>\n\n<img src="https://tracking.invalid/pixel" onerror="alert(1)">\n\n![Source diagram](https://tracking.invalid/image.png)\n\n**Safe text**');
    expect(html).not.toMatch(/<script|<img|<iframe|onerror=|tracking\.invalid|rel="preload"/);
    expect(html).toContain("Source diagram");
    expect(html).toContain("<strong>Safe text</strong>");
  });
});
