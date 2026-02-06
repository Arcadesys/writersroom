export type InlineMarkupHighlightType = "addition" | "subtraction" | "annotation" | "star";

export interface InlineMarkupTransformOptions {
  /**
   * Wrap top-level praise lines (e.g. "✅ ...") as "star" blocks.
   * Defaults to true.
   */
  highlightStarLines?: boolean;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function span(type: InlineMarkupHighlightType, innerHtml: string, extraClasses: string[] = []): string {
  const classes = ["writersroom-highlight", ...extraClasses].join(" ");
  return `<span class="${classes}" data-wr-type="${type}">${innerHtml}</span>`;
}

function findNextUnescaped(haystack: string, needle: string, fromIndex: number): number {
  let index = haystack.indexOf(needle, fromIndex);
  while (index !== -1) {
    // A single backslash escapes the marker; double backslash means literal backslash.
    const before = index - 1;
    if (before < 0 || haystack[before] !== "\\") {
      return index;
    }
    index = haystack.indexOf(needle, index + needle.length);
  }
  return -1;
}

function transformInlineSegment(segment: string): string {
  let out = "";
  let i = 0;

  while (i < segment.length) {
    const ch = segment[i];

    // Respect explicit escaping for our delimiters.
    if (ch === "\\" && i + 1 < segment.length) {
      const next = segment[i + 1];
      if (next === "+" || next === "~" || next === "[" || next === "]" || next === "\\") {
        out += escapeHtml(next);
        i += 2;
        continue;
      }
      out += escapeHtml(ch);
      i += 1;
      continue;
    }

    // ~~deletion~~
    if (segment.startsWith("~~", i)) {
      const end = findNextUnescaped(segment, "~~", i + 2);
      if (end !== -1) {
        const inner = segment.slice(i + 2, end);
        const del = `<del>${escapeHtml(inner)}</del>`;
        out += span("subtraction", del);
        i = end + 2;
        continue;
      }
    }

    // +insertion+
    if (ch === "+") {
      const end = findNextUnescaped(segment, "+", i + 1);
      const newlineIndex = segment.indexOf("\n", i + 1);
      const endInSameLine = end !== -1 && (newlineIndex === -1 || end < newlineIndex);
      if (endInSameLine) {
        const inner = segment.slice(i + 1, end);
        if (inner.length > 0) {
          out += span("addition", escapeHtml(inner));
          i = end + 1;
          continue;
        }
      }
    }

    // [AGENT: comment]
    if (ch === "[") {
      const end = findNextUnescaped(segment, "]", i + 1);
      const newlineIndex = segment.indexOf("\n", i + 1);
      const endInSameLine = end !== -1 && (newlineIndex === -1 || end < newlineIndex);
      if (endInSameLine) {
        const inner = segment.slice(i + 1, end);
        const match = inner.match(/^\s*([A-Za-z][A-Za-z0-9 _-]{0,30})\s*:\s*(.+?)\s*$/s);
        if (match) {
          const tag = match[1].trim();
          const type: InlineMarkupHighlightType =
            tag.toLowerCase() === "star" || tag.toLowerCase() === "praise" ? "star" : "annotation";
          out += span(type, escapeHtml(`[${tag}: ${match[2].trim()}]`), ["writersroom-inline-note"]);
          i = end + 1;
          continue;
        }
      }
    }

    out += escapeHtml(ch);
    i += 1;
  }

  return out;
}

function transformInlineMarkupLine(line: string, options: InlineMarkupTransformOptions): string {
  // Preserve inline code spans: copy them verbatim and only transform outside.
  let out = "";
  let i = 0;

  while (i < line.length) {
    if (line[i] !== "`") {
      // Fast-forward to next backtick or end
      const nextTick = line.indexOf("`", i);
      const chunk = nextTick === -1 ? line.slice(i) : line.slice(i, nextTick);
      out += transformInlineSegment(chunk);
      i = nextTick === -1 ? line.length : nextTick;
      continue;
    }

    // Code span: count backticks and find matching run
    let tickCount = 0;
    while (i + tickCount < line.length && line[i + tickCount] === "`") {
      tickCount++;
    }
    const ticks = "`".repeat(tickCount);
    const start = i;
    const end = line.indexOf(ticks, i + tickCount);
    if (end === -1) {
      // Unclosed; treat rest as normal text
      out += transformInlineSegment(line.slice(i));
      break;
    }

    const literal = line.slice(start, end + tickCount);
    out += escapeHtml(literal);
    i = end + tickCount;
  }

  if (options.highlightStarLines) {
    const trimmed = line.trimStart();
    const startsWithMarkdownControl = /^(\s*[-*+]\s+|\s*>|\s*#)/.test(line);
    if (!startsWithMarkdownControl && (/^✅\s+/.test(trimmed) || /^⭐\s+/.test(trimmed) || /^🌟\s+/.test(trimmed))) {
      return span("star", out, ["writersroom-highlight-block"]);
    }
  }

  return out;
}

/**
 * Converts "Two Flat Cats" inline markup into markdown that renders with Writers Room highlights.
 * - `~~deleted~~` => subtraction highlight (with strikethrough)
 * - `+inserted+` => addition highlight
 * - `[AGENT: note]` => annotation highlight (or star when tag is STAR/PRAISE)
 *
 * The output is still markdown, but uses inline HTML spans for styling.
 * Fenced code blocks are left untouched.
 */
export function transformInlineEditMarkupToMarkdown(
  source: string,
  options: InlineMarkupTransformOptions = {}
): string {
  const resolved: InlineMarkupTransformOptions = {
    highlightStarLines: options.highlightStarLines ?? true
  };

  const lines = source.split("\n");
  let inFence = false;
  let fenceMarker: string | null = null;
  const outLines: string[] = [];

  for (const line of lines) {
    const fenceMatch = line.match(/^\s*(```+|~~~+)\s*/);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (fenceMarker === marker) {
        inFence = false;
        fenceMarker = null;
      }
      outLines.push(line);
      continue;
    }

    if (inFence) {
      outLines.push(line);
      continue;
    }

    outLines.push(transformInlineMarkupLine(line, resolved));
  }

  return outLines.join("\n");
}

