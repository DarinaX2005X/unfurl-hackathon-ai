import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Button, IconButton, LinkButton } from "../../src/components/ui/button";
import { TextField, Textarea, Select } from "../../src/components/ui/field";
import { Dialog } from "../../src/components/ui/dialog";
import { Progress, progressPercentage } from "../../src/components/ui/feedback";
import { Tabs, nextTabId } from "../../src/components/ui/tabs";

describe("shared control semantics", () => {
  it("keeps the action label and disables repeat submission while pending", () => {
    const html = renderToStaticMarkup(<Button type="submit" pending>Save draft</Button>);
    expect(html).toContain('type="submit"');
    expect(html).toContain('disabled=""');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain(">Save draft</span>");
  });

  it("uses actual native disablement for aria-disabled buttons", () => {
    const html = renderToStaticMarkup(<Button aria-disabled="true">Publish</Button>);
    expect(html).toContain('disabled=""');
    expect(html).not.toContain('aria-busy="true"');
  });

  it("gives icon-only actions a stable accessible name", () => {
    const html = renderToStaticMarkup(<IconButton label="Open course menu" icon={<svg />} />);
    expect(html).toContain('aria-label="Open course menu"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('type="button"');
  });

  it("keeps a disabled destination out of sequential keyboard navigation", () => {
    const html = renderToStaticMarkup(<LinkButton href="/library" aria-disabled>Open library</LinkButton>);
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain('aria-disabled="true"');
  });

  it("connects field errors and hints without dropping an external description", () => {
    const html = renderToStaticMarkup(<TextField id="goal" label="Learning goal" hint="Describe a concrete outcome" error="Add your goal" aria-describedby="privacy-context" />);
    expect(html).toContain('for="goal"');
    expect(html).toContain('aria-describedby="privacy-context goal-hint goal-error"');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('id="goal-error"');
  });

  it("renders the supplied textarea draft and disabled select alternatives", () => {
    const textarea = renderToStaticMarkup(<Textarea id="draft" label="Course request" defaultValue="Understand model evaluation" />);
    const select = renderToStaticMarkup(<Select id="depth" label="Course depth" options={[{ value: "deep", label: "Deep" }, { value: "brief", label: "Brief", disabled: true }]} />);
    expect(textarea).toContain("Understand model evaluation</textarea>");
    expect(select).toContain('<option value="brief" disabled="">Brief</option>');
  });

  it("retains panel content in the DOM with exactly one selected tab", () => {
    const html = renderToStaticMarkup(<Tabs value="plan" onValueChange={() => {}} items={[
      { id: "chat", label: "Conversation", panel: <input defaultValue="Unsent request" /> },
      { id: "plan", label: "Program", panel: <p>Curriculum content</p> },
    ]} />);
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(html).toContain('value="Unsent request"');
    expect(html).toContain('hidden=""');
    expect(html).toContain("Curriculum content");
  });

  it("retains closed-dialog form content while leaving it natively hidden", () => {
    const html = renderToStaticMarkup(<Dialog open={false} onOpenChange={() => {}} title="Rename draft"><input defaultValue="Existing title" /></Dialog>);
    expect(html).toContain("<dialog");
    expect(html).not.toContain(' open=""');
    expect(html).toContain('value="Existing title"');
    expect(html).toContain('aria-labelledby=');
  });
});

describe("tab keyboard destinations", () => {
  const items = [{ id: "first" }, { id: "unavailable", disabled: true }, { id: "last" }];
  it("wraps and skips disabled choices", () => {
    expect(nextTabId(items, "first", "ArrowRight")).toBe("last");
    expect(nextTabId(items, "first", "ArrowLeft")).toBe("last");
    expect(nextTabId(items, "last", "ArrowRight")).toBe("first");
  });
  it("supports Home/End without hijacking other keys", () => {
    expect(nextTabId(items, "last", "Home")).toBe("first");
    expect(nextTabId(items, "first", "End")).toBe("last");
    expect(nextTabId(items, "first", "Tab")).toBeUndefined();
    expect(nextTabId([{ id: "off", disabled: true }], "off", "ArrowRight")).toBeUndefined();
  });
});

describe("measured progress", () => {
  it("shows only a percentage derived from its measured numerator and denominator", () => {
    expect(progressPercentage(3, 8)).toBe(38);
    const html = renderToStaticMarkup(<Progress value={3} max={8} label="Lessons completed" />);
    expect(html).toContain('max="8" value="3"');
    expect(html).toContain("38%");
    expect(html).toContain("Lessons completed");
  });
  it.each([[1, 0], [-1, 10], [11, 10], [Number.NaN, 10], [1, Number.POSITIVE_INFINITY]])("rejects invalid measurements %s/%s", (value, max) => {
    expect(() => progressPercentage(value, max)).toThrow(RangeError);
  });
});
