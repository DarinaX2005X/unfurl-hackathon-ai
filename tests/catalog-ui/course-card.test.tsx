import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CourseCard } from "../../src/features/catalog/CourseCard";
import { course } from "./fixtures";

describe("public course card content", () => {
  it("renders the complete long title, supplied summary, and actual module, lesson and study values", () => {
    const title = "Understanding how model capacity changes training fit, validation evidence, and the limits of claims about future results";
    const item = course({ title, moduleCount: 7, lessonCount: 23, estimatedStudyMinutes: 125, contentLanguage: "ja" });
    const html = renderToStaticMarkup(<CourseCard course={item} />);
    expect(html).toContain(`<h3>${title}</h3>`);
    expect(html).toContain(`<p>${item.summary}</p>`);
    expect(html).toContain("<dt>Modules</dt><dd>7</dd>");
    expect(html).toContain("<dt>Lessons</dt><dd>23</dd>");
    expect(html).toContain("<dt>Study time</dt><dd>2 hr 5 min</dd>");
    expect(html).toContain("Japanese</span>");
  });

  it("links to the real course slug, uses supplied artwork text, and exposes no guessed ownership or enrollment action", () => {
    const item = course({ slug: "evidence-and-model-capacity", cover: { motifId: "model-capacity", alt: "A model curve with measured observations" } });
    const html = renderToStaticMarkup(<CourseCard course={item} />);
    expect(html).toContain('href="/courses/evidence-and-model-capacity"');
    expect(html).toContain('role="img" aria-label="A model curve with measured observations"');
    expect(html).toContain("View course</span>");
    expect(html.match(/<a\s/g)).toHaveLength(1);
    expect(html).not.toMatch(/<button\b|Enroll|Start learning|Author|Rating|Publish|Edit course|Share course/);
  });

  it("preserves literal course text by escaping markup supplied through public data", () => {
    const html = renderToStaticMarkup(<CourseCard course={course({ title: "Models < systems & evidence", summary: "Read <script>alert(1)</script> as a quoted example." })} />);
    expect(html).toContain("Models &lt; systems &amp; evidence");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
  });
});
