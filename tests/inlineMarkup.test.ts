import { describe, expect, it } from "vitest";
import { transformInlineEditMarkupToMarkdown } from "../inlineMarkup";

describe("transformInlineEditMarkupToMarkdown", () => {
  it("converts +insertions+ and ~~deletions~~ into Writers Room highlight spans", () => {
    const input = 'Jamie stared at a ~~blank~~ +greige+ screen. [FLOW: clarified tone]';
    const output = transformInlineEditMarkupToMarkdown(input, { highlightStarLines: false });

    expect(output).toContain('data-wr-type="subtraction"');
    expect(output).toContain("<del>blank</del>");
    expect(output).toContain('data-wr-type="addition"');
    expect(output).toContain(">greige<");
    expect(output).toContain('data-wr-type="annotation"');
    expect(output).toContain("[FLOW: clarified tone]");

    expect(output).not.toContain("~~blank~~");
    expect(output).not.toContain("+greige+");
  });

  it("escapes HTML inside markers", () => {
    const input = "+<b>hi</b>+ and ~~<i>bye</i>~~";
    const output = transformInlineEditMarkupToMarkdown(input, { highlightStarLines: false });

    expect(output).toContain("&lt;b&gt;hi&lt;/b&gt;");
    expect(output).toContain("&lt;i&gt;bye&lt;/i&gt;");
    expect(output).not.toContain("<b>hi</b>");
    expect(output).not.toContain("<i>bye</i>");
  });

  it("does not transform inside fenced code blocks", () => {
    const input = [
      "```markdown",
      "Jamie ~~blank~~ +greige+ [FLOW: note]",
      "```"
    ].join("\n");
    const output = transformInlineEditMarkupToMarkdown(input);
    expect(output).toBe(input);
  });

  it("does not transform inside inline code spans", () => {
    const input = "Use `~~blank~~ +greige+ [FLOW: note]` literally.";
    const output = transformInlineEditMarkupToMarkdown(input, { highlightStarLines: false });
    expect(output).toContain("`~~blank~~ +greige+ [FLOW: note]`");
    expect(output).not.toContain('data-wr-type="addition"');
    expect(output).not.toContain('data-wr-type="subtraction"');
  });

  it("wraps top-level ✅ lines as star blocks when enabled", () => {
    const input = ["✅ What’s Working", "Regular line"].join("\n");
    const output = transformInlineEditMarkupToMarkdown(input, { highlightStarLines: true });
    const lines = output.split("\n");
    expect(lines[0]).toContain('data-wr-type="star"');
    expect(lines[0]).toContain("✅ What’s Working");
  });
});

