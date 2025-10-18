import { describe, expect, it } from "vitest";
// @ts-ignore Vitest processes TypeScript modules directly in test builds
import {
  buildWritersRoomCss,
  setEditorHighlightsEffect,
  writersRoomEditorHighlightsField,
  getCodeMirrorModules
} from "../main.ts";

const { state: cmState, view: cmView } = getCodeMirrorModules();
const { EditorState } = cmState;
const { Decoration } = cmView;
type CMDecorationInstance = ReturnType<typeof Decoration.mark>;

describe("Writers Room editor highlights", () => {
  it("exposes CSS that targets CodeMirror editor highlights", () => {
    const css = buildWritersRoomCss();
    // Mark decorations use .writersroom-highlight directly (not scoped to .cm-editor)
    expect(css).toMatch(/\.writersroom-highlight\s*\{/);
    expect(css).toMatch(/\.writersroom-highlight-active/);
    // Check for type-specific styles
    expect(css).toMatch(/\[data-wr-type="addition"\]/);
  expect(css).toMatch(/\[data-wr-type="replacement"\]/);
  expect(css).toMatch(/\[data-wr-type="star"\]/);
    expect(css).toMatch(/\[data-wr-type="subtraction"\]/);
    expect(css).toMatch(/\[data-wr-type="annotation"\]/);
  });

  it("adds mark decorations with writersroom metadata", () => {
    let state = EditorState.create({
      doc: "Example line of text",
      extensions: [writersRoomEditorHighlightsField]
    });

    const effect = setEditorHighlightsEffect.of([
      {
        from: 0,
        to: 7,
        className: "writersroom-highlight writersroom-type-addition",
        attributes: {
          "data-writersroom-anchor": "writersroom-line-1-edit-0",
          "data-wr-source": "example.md",
          "data-wr-index": "0",
          "data-wr-line": "1",
          "data-wr-type": "addition",
          "data-wr-category": "flow",
          "data-wr-anchor": "writersroom-line-1-edit-0",
          "data-wr-match": "Example",
          "data-wr-original": "Example"
        }
      }
    ]);

    const transaction = state.update({ effects: effect });
    state = transaction.state;

    const decorations = state.field(writersRoomEditorHighlightsField);
    let found = false;
    decorations.between(0, state.doc.length, (from, to, value) => {
      if (from === 0 && to === 7) {
        found = true;
  const decoration = value as CMDecorationInstance;
        expect(decoration.spec.class).toContain("writersroom-highlight");
        expect(decoration.spec.attributes?.["data-wr-match"]).toBe("Example");
        expect(decoration.spec.attributes?.["data-writersroom-anchor"]).toBe(
          "writersroom-line-1-edit-0"
        );
      }
    });

    expect(found).toBe(true);
  });
});
