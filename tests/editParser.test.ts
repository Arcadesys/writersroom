import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

import {
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

    expect(() => parseEditPayload(payload)).toThrowError(/type must be addition/);
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
