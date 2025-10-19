import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

import {
  mergeEditPayloads,
  parseEditPayload,
  parseEditPayloadFromString,
  ValidationError
} from "../editParser";

const fixturesDir = join(__dirname);

describe("parseEditPayload", () => {
  it("parses a valid payload from object", () => {
    const filePath = join(fixturesDir, "three-little-pigs-edits.json");
    const payload = JSON.parse(readFileSync(filePath, "utf8"));

    const result = parseEditPayload(payload);

    expect(result.summary).toContain("pacing is strong");
    expect(result.edits).toHaveLength(3);
    expect(result.edits[0]).toMatchObject({
      agent: "editor",
      line: 2,
      type: "addition",
      category: "flow"
    });
    expect(result.edits[0].anchor).toMatch(/^writersroom-edit-/);
  });

  it("rejects payloads without required summary", () => {
    const payload = { edits: [] };

    expect(() => parseEditPayload(payload)).toThrowError(ValidationError);
  });

  it("rejects payloads where edit line is invalid", () => {
    const payload = {
      summary: "ok",
      edits: [
        {
          agent: "editor",
          line: 0,
          type: "addition",
          category: "flow",
          original_text: "text",
          output: "out"
        }
      ]
    };

    expect(() => parseEditPayload(payload)).toThrowError(/line must be at least 1/);
  });

  it("rejects payloads with invalid type", () => {
    const payload = {
      summary: "ok",
      edits: [
        {
          agent: "editor",
          line: 1,
          type: "rewrite",
          category: "flow",
          original_text: "text",
          output: "out"
        }
      ]
    };

    expect(() => parseEditPayload(payload)).toThrowError(/type must be one of/);
  });

  it("accepts replacement edits", () => {
    const payload = {
      summary: "ok",
      edits: [
        {
          agent: "editor",
          line: 3,
          type: "replacement",
          category: "flow",
          original_text: "A dull sentence.",
          output: "A sharper, livelier sentence."
        }
      ]
    };

    const result = parseEditPayload(payload);
    expect(result.edits[0].type).toBe("replacement");
    expect(result.edits[0].output).toBe("A sharper, livelier sentence.");
  });

  it("accepts star edits", () => {
    const payload = {
      summary: "ok",
      edits: [
        {
          agent: "editor",
          line: 5,
          type: "star",
          category: "punch",
          original_text: "The final line hit like a bell.",
          output: "[STAR: resonant closing image worth preserving.]"
        }
      ]
    };

    const result = parseEditPayload(payload);
    expect(result.edits[0].type).toBe("star");
    expect(result.edits[0].output).toContain("STAR");
  });

  it("supports custom agent identifiers", () => {
    const payload = {
      summary: "ok",
      edits: [
        {
          agent: "flow",
          line: 2,
          type: "addition",
          category: "flow",
          original_text: "Original line",
          output: "Revised line"
        }
      ]
    };

    const result = parseEditPayload(payload);
    expect(result.edits[0].agent).toBe("flow");
    expect(result.edits[0].category).toBe("flow");
  });

  it("rejects payloads with invalid output value", () => {
    const payload = {
      summary: "ok",
      edits: [
        {
          agent: "editor",
          line: 1,
          type: "addition",
          category: "flow",
          original_text: "text",
          output: 42
        }
      ]
    };

    expect(() => parseEditPayload(payload)).toThrowError(/output must be a string or null/);
  });

  it("preserves anchors provided in the payload", () => {
    const payload = {
      summary: "ok",
      edits: [
        {
          agent: "editor",
          line: 4,
          type: "addition",
          category: "flow",
          original_text: "Original text",
          output: "Added text",
          anchor: "writersroom-edit-custom-anchor"
        }
      ]
    };

    const result = parseEditPayload(payload);
    expect(result.edits[0].anchor).toBe("writersroom-edit-custom-anchor");
  });

  it("generates deterministic anchors for identical edits", () => {
    const payload = {
      summary: "ok",
      edits: [
        {
          agent: "editor",
          line: 7,
          type: "addition",
          category: "flow",
          original_text: "Original text",
          output: "Added text"
        }
      ]
    };

    const firstParse = parseEditPayload(payload);
    const secondParse = parseEditPayload(payload);
    expect(firstParse.edits[0].anchor).toBe(secondParse.edits[0].anchor);
  });

  it("accepts empty string output for subtraction edits", () => {
    const payload = {
      summary: "ok",
      edits: [
        {
          agent: "editor",
          line: 3,
          type: "subtraction",
          category: "flow",
          original_text: "This sentence can go.",
          output: ""
        }
      ]
    };

    const result = parseEditPayload(payload);
    expect(result.edits[0].type).toBe("subtraction");
    expect(result.edits[0].output).toBe("");
  });

  it("accepts empty string output for replacement edits", () => {
    const payload = {
      summary: "ok",
      edits: [
        {
          agent: "editor",
          line: 4,
          type: "replacement",
          category: "flow",
          original_text: "Delete this.",
          output: ""
        }
      ]
    };

    const result = parseEditPayload(payload);
    expect(result.edits[0].type).toBe("replacement");
    expect(result.edits[0].output).toBe("");
  });

  it("rejects empty string output for addition edits", () => {
    const payload = {
      summary: "ok",
      edits: [
        {
          agent: "editor",
          line: 2,
          type: "addition",
          category: "flow",
          original_text: "Text",
          output: ""
        }
      ]
    };

    expect(() => parseEditPayload(payload)).toThrowError(/output cannot be empty string for addition edits/);
  });

  it("rejects empty string output for annotation edits", () => {
    const payload = {
      summary: "ok",
      edits: [
        {
          agent: "editor",
          line: 5,
          type: "annotation",
          category: "punch",
          original_text: "Text",
          output: ""
        }
      ]
    };

    expect(() => parseEditPayload(payload)).toThrowError(/output cannot be empty string for annotation edits/);
  });

  it("rejects empty string output for star edits", () => {
    const payload = {
      summary: "ok",
      edits: [
        {
          agent: "editor",
          line: 6,
          type: "star",
          category: "punch",
          original_text: "Great line!",
          output: ""
        }
      ]
    };

    expect(() => parseEditPayload(payload)).toThrowError(/output cannot be empty string for star edits/);
  });

  it("groups annotations with replacements on the same line", () => {
    const payload = {
      summary: "ok",
      edits: [
        {
          agent: "editor",
          line: 5,
          type: "replacement",
          category: "flow",
          original_text: "The old text.",
          output: "The new text."
        },
        {
          agent: "editor",
          line: 5,
          type: "annotation",
          category: "rhythm",
          original_text: "The old text.",
          output: "This improves the pacing."
        }
      ]
    };

    const result = parseEditPayload(payload);
    
    // Should have only 1 edit after grouping
    expect(result.edits).toHaveLength(1);
    expect(result.edits[0].type).toBe("replacement");
    expect(result.edits[0].output).toBe("The new text.");
    expect(result.edits[0].annotation).toBe("This improves the pacing.");
  });

  it("groups multiple annotations into one replacement", () => {
    const payload = {
      summary: "ok",
      edits: [
        {
          agent: "editor",
          line: 3,
          type: "replacement",
          category: "flow",
          original_text: "Text.",
          output: "Better text."
        },
        {
          agent: "editor",
          line: 3,
          type: "annotation",
          category: "rhythm",
          original_text: "Text.",
          output: "First note."
        },
        {
          agent: "editor",
          line: 3,
          type: "annotation",
          category: "sensory",
          original_text: "Text.",
          output: "Second note."
        }
      ]
    };

    const result = parseEditPayload(payload);
    
    expect(result.edits).toHaveLength(1);
    expect(result.edits[0].annotation).toBe("First note. Second note.");
  });

  it("keeps only annotation if no substantive edit on line", () => {
    const payload = {
      summary: "ok",
      edits: [
        {
          agent: "editor",
          line: 2,
          type: "annotation",
          category: "punch",
          original_text: "Text.",
          output: "Just a comment."
        }
      ]
    };

    const result = parseEditPayload(payload);
    
    expect(result.edits).toHaveLength(1);
    expect(result.edits[0].type).toBe("annotation");
    expect(result.edits[0].annotation).toBeUndefined();
  });

  it("discards duplicate substantive edits on same line", () => {
    const payload = {
      summary: "ok",
      edits: [
        {
          agent: "editor",
          line: 4,
          type: "replacement",
          category: "flow",
          original_text: "Text.",
          output: "First replacement."
        },
        {
          agent: "editor",
          line: 4,
          type: "addition",
          category: "sensory",
          original_text: "Text.",
          output: "Second addition."
        }
      ]
    };

    const result = parseEditPayload(payload);
    
    // Should only keep the first substantive edit
    expect(result.edits).toHaveLength(1);
    expect(result.edits[0].type).toBe("replacement");
    expect(result.edits[0].output).toBe("First replacement.");
  });
});

describe("parseEditPayloadFromString", () => {
  it("parses a valid JSON string", () => {
    const filePath = join(fixturesDir, "three-little-pigs-edits.json");
    const raw = readFileSync(filePath, "utf8");

    const result = parseEditPayloadFromString(raw);

    expect(result.edits[1].category).toBe("sensory");
  });

  it("throws validation error on malformed JSON", () => {
    expect(() => parseEditPayloadFromString("{ not json"))
      .toThrowError(/Invalid JSON provided/);
  });
});

describe("mergeEditPayloads", () => {
  it("appends new edits while keeping existing ones", () => {
    const existing = parseEditPayload({
      summary: "Existing overview",
      edits: [
        {
          agent: "flow",
          line: 1,
          type: "replacement",
          category: "flow",
          original_text: "Old line.",
          output: "Improved line."
        }
      ]
    });

    const incoming = parseEditPayload({
      summary: "Fresh summary",
      edits: [
        {
          agent: "lens",
          line: 2,
          type: "addition",
          category: "lens",
          original_text: "Scene beats",
          output: "Add a splash of rain on the windowsill."
        }
      ]
    });

    const merged = mergeEditPayloads(existing, incoming);

    expect(merged.summary).toBe("Fresh summary");
    expect(merged.edits).toHaveLength(2);
    expect(new Set(merged.edits.map((edit) => edit.anchor)).size).toBe(2);
    expect(merged.edits[0].agent).toBe("flow");
    expect(merged.edits[1].agent).toBe("lens");
  });

  it("deduplicates identical edits from new payload", () => {
    const existing = parseEditPayload({
      summary: "Existing",
      edits: [
        {
          agent: "punch",
          line: 3,
          type: "addition",
          category: "punch",
          original_text: "Cliffhanger",
          output: "Let thunder roll through the doorway."
        }
      ]
    });

    const duplicate = parseEditPayload({
      summary: "Duplicate run",
      edits: [
        {
          agent: "punch",
          line: 3,
          type: "addition",
          category: "punch",
          original_text: "Cliffhanger",
          output: "Let thunder roll through the doorway."
        }
      ]
    });

    const merged = mergeEditPayloads(existing, duplicate);

    expect(merged.edits).toHaveLength(1);
    expect(merged.summary).toBe("Duplicate run");
  });
});
