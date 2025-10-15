export type EditType = "addition" | "subtraction" | "annotation";
export type EditCategory = "flow" | "rhythm" | "sensory" | "punch";

export interface EditEntry {
  agent: "editor";
  line: number;
  type: EditType;
  category: EditCategory;
  original_text: string;
  output: string | null;
}

export interface EditPayload {
  summary: string;
  edits: EditEntry[];
}

export class ValidationError extends Error {
  readonly path?: string;

  constructor(message: string, path?: string) {
    const suffix = path ? ` at ${path}` : "";
    super(`${message}${suffix}`);
    this.name = "ValidationError";
    this.path = path;
  }
}

const EDIT_TYPES: ReadonlySet<EditType> = new Set([
  "addition",
  "subtraction",
  "annotation"
]);

const EDIT_CATEGORIES: ReadonlySet<EditCategory> = new Set([
  "flow",
  "rhythm",
  "sensory",
  "punch"
]);

function assert(condition: unknown, message: string, path?: string): asserts condition {
  if (!condition) {
    throw new ValidationError(message, path);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEdit(entry: unknown, index: number): EditEntry {
  const path = `edits[${index}]`;
  assert(isRecord(entry), "Edit must be an object", path);

  const { agent, line, type, category, original_text, output } = entry;

  assert(typeof agent === "string", "agent must be a string", `${path}.agent`);
  assert(agent === "editor", "agent must be set to \"editor\"", `${path}.agent`);

  assert(typeof line === "number" && Number.isInteger(line), "line must be an integer", `${path}.line`);
  assert(line >= 1, "line must be at least 1", `${path}.line`);

  assert(typeof type === "string", "type must be a string", `${path}.type`);
  assert(EDIT_TYPES.has(type as EditType), "type must be addition, subtraction, or annotation", `${path}.type`);

  assert(typeof category === "string", "category must be a string", `${path}.category`);
  assert(EDIT_CATEGORIES.has(category as EditCategory), "category must be flow, rhythm, sensory, or punch", `${path}.category`);

  assert(typeof original_text === "string", "original_text must be a string", `${path}.original_text`);
  assert(original_text.length > 0, "original_text cannot be empty", `${path}.original_text`);

  assert(
    typeof output === "string" || output === null,
    "output must be a string or null",
    `${path}.output`
  );

  if (typeof output === "string") {
    assert(output.length > 0, "output cannot be empty string", `${path}.output`);
  }

  return {
    agent: "editor",
    line,
    type: type as EditType,
    category: category as EditCategory,
    original_text,
    output: output === null ? null : (output as string)
  };
}

export function parseEditPayload(raw: unknown): EditPayload {
  assert(isRecord(raw), "Payload must be an object");

  const { summary, edits } = raw;

  assert(typeof summary === "string", "summary must be a string", "summary");
  assert(summary.trim().length > 0, "summary cannot be empty", "summary");

  assert(Array.isArray(edits), "edits must be an array", "edits");

  const parsedEdits = edits.map((entry, index) => parseEdit(entry, index));

  return {
    summary: summary.trim(),
    edits: parsedEdits
  };
}

export function parseEditPayloadFromString(json: string): EditPayload {
  try {
    const parsed = JSON.parse(json) as unknown;
    return parseEditPayload(parsed);
  } catch (error) {
    if (error instanceof ValidationError) {
      throw error;
    }

    throw new ValidationError("Invalid JSON provided");
  }
}
