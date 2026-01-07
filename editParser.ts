export type EditType = "addition" | "subtraction" | "annotation" | "replacement" | "star";
export type EditCategory = string;

export interface EditEntry {
  agent: string;
  anchor: string;
  line: number;
  type: EditType;
  category: EditCategory;
  original_text: string;
  output: string | null;
  annotation?: string | null; // Optional annotation merged from annotation edit on same line
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
  "annotation",
  "replacement",
  "star"
]);

function assert(condition: unknown, message: string, path?: string): asserts condition {
  if (!condition) {
    throw new ValidationError(message, path);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const WRITERSROOM_ANCHOR_PREFIX = "writersroom-edit-";

function normalizeAnchorCandidate(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : "";
}

function hashAnchorSeed(seed: string): string {
  let hash = 2166136261;

  for (let index = 0; index < seed.length; index++) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(36);
}

export function createEditAnchorId(
  entry: {
    line: number;
    type: EditType;
    category: EditCategory;
    original_text: string;
    output: string | null;
    anchor?: string | null;
  },
  index: number
): string {
  const existing =
    normalizeAnchorCandidate(entry.anchor) ||
    normalizeAnchorCandidate((entry as Record<string, unknown>).anchorId) ||
    normalizeAnchorCandidate((entry as Record<string, unknown>).anchor_id) ||
    normalizeAnchorCandidate((entry as Record<string, unknown>).id);

  if (existing) {
    return existing;
  }

  const seed = [
    entry.original_text ?? "",
    entry.output ?? "",
    entry.type ?? "",
    entry.category ?? "",
    Number.isFinite(entry.line) ? String(entry.line) : "",
    Number.isFinite(index) ? String(index) : ""
  ].join("|");

  const hash = hashAnchorSeed(seed);
  return `${WRITERSROOM_ANCHOR_PREFIX}${hash}`;
}

function parseEdit(entry: unknown, index: number): EditEntry {
  const path = `edits[${index}]`;
  assert(isRecord(entry), "Edit must be an object", path);

  const { agent, line, type, category, original_text, output } = entry;

  assert(typeof agent === "string" && agent.trim().length > 0, "agent must be a non-empty string", `${path}.agent`);
  const normalizedAgent = agent.trim();

  assert(typeof line === "number" && Number.isInteger(line), "line must be an integer", `${path}.line`);
  assert(line >= 1, "line must be at least 1", `${path}.line`);

  assert(typeof type === "string", "type must be a string", `${path}.type`);
  const allowedTypes = Array.from(EDIT_TYPES).join(", ");
  assert(EDIT_TYPES.has(type as EditType), `type must be one of: ${allowedTypes}`, `${path}.type`);

  assert(typeof category === "string" && category.trim().length > 0, "category must be a non-empty string", `${path}.category`);
  const normalizedCategory = category.trim();

  assert(typeof original_text === "string", "original_text must be a string", `${path}.original_text`);
  assert(original_text.length > 0, "original_text cannot be empty", `${path}.original_text`);

  assert(
    typeof output === "string" || output === null,
    "output must be a string or null",
    `${path}.output`
  );

  // Allow empty strings for subtraction edits (deletion) and replacement edits (replace with nothing)
  if (typeof output === "string" && output.length === 0) {
    const allowEmptyOutput = type === "subtraction" || type === "replacement";
    assert(
      allowEmptyOutput,
      `output cannot be empty string for ${type} edits (use null for subtraction, or provide replacement text)`,
      `${path}.output`
    );
  }

  const anchorCandidate =
    normalizeAnchorCandidate(entry.anchor) ||
    normalizeAnchorCandidate((entry as Record<string, unknown>).anchorId) ||
    normalizeAnchorCandidate((entry as Record<string, unknown>).anchor_id) ||
    normalizeAnchorCandidate((entry as Record<string, unknown>).id);

  return {
    agent: normalizedAgent,
    anchor: createEditAnchorId(
      {
        line,
        type: type as EditType,
        category: normalizedCategory as EditCategory,
        original_text,
        output: output === null ? null : (output as string),
        anchor: anchorCandidate
      },
      index
    ),
    line,
    type: type as EditType,
    category: normalizedCategory as EditCategory,
    original_text,
    output: output === null ? null : (output as string)
  };
}

/**
 * Combines annotations with other edits on the same line to reduce visual noise.
 * If an annotation and a replacement (or other substantive edit) target the same line,
 * merge the annotation text into the substantive edit.
 * If multiple substantive edits exist on the same line, prefer the first one and merge
 * the annotation into it, discarding the others (this shouldn't happen with proper prompts).
 */
function combineEditsOnSameLine(edits: EditEntry[]): EditEntry[] {
  // Group edits by line number
  const editsByLine = new Map<number, EditEntry[]>();
  
  for (const edit of edits) {
    const existing = editsByLine.get(edit.line) || [];
    existing.push(edit);
    editsByLine.set(edit.line, existing);
  }

  const combined: EditEntry[] = [];

  for (const [line, lineEdits] of editsByLine) {
    // If only one edit on this line, keep it as-is
    if (lineEdits.length === 1) {
      combined.push(lineEdits[0]);
      continue;
    }

    // Find annotation and substantive edits (replacement, addition, subtraction, star)
    const annotations = lineEdits.filter(e => e.type === "annotation");
    const substantiveEdits = lineEdits.filter(e => e.type !== "annotation");

    // If no annotations, keep all edits (though ideally there should be only one substantive edit per line)
    if (annotations.length === 0) {
      // If multiple substantive edits on same line, only keep the first one (model error)
      combined.push(substantiveEdits[0]);
      continue;
    }

    // If we have both annotations and substantive edits, merge them
    if (substantiveEdits.length > 0) {
      // Combine annotation text
      const annotationText = annotations
        .map(a => a.output || "")
        .filter(text => text.length > 0)
        .join(" ");

      // Merge annotations into the first substantive edit
      // (If there are multiple substantive edits, only keep the first - this is a model error)
      combined.push({
        ...substantiveEdits[0],
        annotation: annotationText || null
      });
    } else {
      // Only annotations on this line, combine them all
      if (annotations.length === 1) {
        combined.push(annotations[0]);
      } else {
        // Combine multiple annotations into one
        const combinedAnnotationText = annotations
          .map(a => a.output || "")
          .filter(text => text.length > 0)
          .join(" ");
        
        combined.push({
          ...annotations[0],
          output: combinedAnnotationText || null
        });
      }
    }
  }

  return combined;
}

function cloneEdit(edit: EditEntry): EditEntry {
  return {
    agent: edit.agent,
    anchor: edit.anchor,
    line: edit.line,
    type: edit.type,
    category: edit.category,
    original_text: edit.original_text,
    output: edit.output,
    annotation: edit.annotation ?? null
  };
}

function createEditSignature(edit: EditEntry): string {
  const outputValue = edit.output ?? "__NULL__";
  return [
    edit.agent.trim().toLowerCase(),
    edit.category.trim().toLowerCase(),
    edit.type,
    edit.line,
    edit.original_text,
    outputValue
  ].join("|");
}

export function mergeEditPayloads(existing: EditPayload | null, incoming: EditPayload): EditPayload {
  const baseSummary = incoming.summary?.trim().length ? incoming.summary : existing?.summary ?? "";

  if (!existing) {
    const incomingClones = incoming.edits.map((edit) => cloneEdit(edit));
    const normalized = incomingClones.map((edit, index) => ({
      ...edit,
      anchor: createEditAnchorId(
        {
          line: edit.line,
          type: edit.type,
          category: edit.category,
          original_text: edit.original_text,
          output: edit.output,
          anchor: edit.anchor
        },
        index
      )
    }));

    return {
      summary: baseSummary,
      edits: normalized
    };
  }

  const existingClones = existing.edits.map((edit) => cloneEdit(edit));
  const signatures = new Set(existingClones.map((edit) => createEditSignature(edit)));

  const appended: EditEntry[] = [];
  for (const edit of incoming.edits) {
    const clone = cloneEdit(edit);
    const signature = createEditSignature(clone);
    if (signatures.has(signature)) {
      continue;
    }
    signatures.add(signature);
    appended.push(clone);
  }

  const mergedEdits = [...existingClones, ...appended].map((edit, index) => ({
    ...edit,
    anchor: createEditAnchorId(
      {
        line: edit.line,
        type: edit.type,
        category: edit.category,
        original_text: edit.original_text,
        output: edit.output,
        anchor: edit.anchor
      },
      index
    )
  }));

  return {
    summary: baseSummary,
    edits: mergedEdits
  };
}

export function parseEditPayload(raw: unknown): EditPayload {
  assert(isRecord(raw), "Payload must be an object");

  const { summary, edits } = raw;

  assert(typeof summary === "string", "summary must be a string", "summary");
  assert(summary.trim().length > 0, "summary cannot be empty", "summary");

  assert(Array.isArray(edits), "edits must be an array", "edits");

  const parsedEdits = edits.map((entry, index) => parseEdit(entry, index));
  
  // Combine annotations with other edits on the same line
  const combinedEdits = combineEditsOnSameLine(parsedEdits);

  return {
    summary: summary.trim(),
    edits: combinedEdits
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
