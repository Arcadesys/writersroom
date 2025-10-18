import {
  App,
  MarkdownPostProcessorContext,
  Editor,
  ItemView,
  MarkdownView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TextComponent,
  TAbstractFile,
  TFile,
  Vault,
  WorkspaceLeaf
} from "obsidian";
import { existsSync, readdirSync } from "fs";
import { createRequire } from "module";
import { join } from "path";

type CMEditorView = import("@codemirror/view").EditorView;
type CMViewUpdate = import("@codemirror/view").ViewUpdate;
type CMPluginValue = import("@codemirror/view").PluginValue;
type CMDecoration = import("@codemirror/view").Decoration;
type CMDecorationSet = import("@codemirror/view").DecorationSet;
type CMTransaction = import("@codemirror/state").Transaction;
type CMStateField<T> = import("@codemirror/state").StateField<T>;
type ElectronProcess = NodeJS.Process & { resourcesPath?: string };

type CMStateModule = typeof import("@codemirror/state");
type CMViewModule = typeof import("@codemirror/view");

declare const __dirname: string;
declare const __filename: string;
declare const require: NodeRequire | undefined;

const globalRequire = (globalThis as { require?: NodeRequire }).require;
const windowRequire =
  typeof window !== "undefined"
    ? ((window as unknown as { require?: NodeRequire }).require ?? null)
    : null;

const fallbackRequire = createRequire(typeof __filename === "string" && __filename.length > 0 ? __filename : `${process.cwd()}/index.js`);

const nodeRequire: NodeRequire =
  (typeof require === "function" ? require : undefined) ??
  globalRequire ??
  windowRequire ??
  fallbackRequire;

function tryResolveFromBase<T>(moduleId: string, base: string): T | null {
  try {
    const resolved = nodeRequire.resolve(moduleId, { paths: [base] });
    if (resolved) {
      return nodeRequire(resolved) as T;
    }
  } catch {
    // ignore and allow caller to continue searching
  }
  return null;
}

function tryRequireDirect<T>(moduleId: string): T | null {
  try {
    return nodeRequire(moduleId) as T;
  } catch {
    // ignore and fall back to resource scanning
  }

  if (typeof window !== "undefined") {
    const winRequire = (window as unknown as { require?: NodeRequire }).require;
    if (typeof winRequire === "function") {
      try {
        return winRequire(moduleId) as T;
      } catch {
        // ignore and continue
      }
    }
  }

  return null;
}

function tryResolveFromPnpm<T>(moduleId: string, pnpmBase: string): T | null {
  if (!existsSync(pnpmBase)) {
    return null;
  }

  let entries: string[] = [];
  try {
    entries = readdirSync(pnpmBase);
  } catch {
    return null;
  }

  const normalized = moduleId.startsWith("@")
    ? moduleId.slice(1).replace("/", "+")
    : moduleId.replace("/", "+");

  for (const entry of entries) {
    if (!entry.includes(normalized + "@")) {
      continue;
    }

    const candidateNodeModules = join(pnpmBase, entry, "node_modules");
    const resolved = tryResolveFromBase<T>(moduleId, candidateNodeModules);
    if (resolved) {
      return resolved;
    }
  }

  return null;
}

function loadFromAppResources<T>(moduleId: string): T | null {
  if (typeof process === "undefined") {
    return null;
  }

  const direct = tryRequireDirect<T>(moduleId);
  if (direct) {
    return direct;
  }

  const resourcesPath = (process as ElectronProcess).resourcesPath;
  if (typeof resourcesPath !== "string" || resourcesPath.length === 0) {
    return null;
  }

  const baseCandidates = [
    join(resourcesPath, "app.asar", "node_modules"),
    join(resourcesPath, "app.asar.unpacked", "node_modules"),
    join(resourcesPath, "app", "node_modules")
  ];

  for (const base of baseCandidates) {
    const resolved = tryResolveFromBase<T>(moduleId, base);
    if (resolved) {
      return resolved;
    }

    const pnpmResolved = tryResolveFromPnpm<T>(moduleId, join(base, ".pnpm"));
    if (pnpmResolved) {
      return pnpmResolved;
    }
  }

  return null;
}

let cachedStateModule: CMStateModule | null | undefined;
let cachedViewModule: CMViewModule | null | undefined;

function getCodeMirrorStateModule(): CMStateModule | null {
  if (cachedStateModule !== undefined) {
    return cachedStateModule;
  }

  cachedStateModule = loadFromAppResources<CMStateModule>("@codemirror/state");
  return cachedStateModule;
}

function getCodeMirrorViewModule(): CMViewModule | null {
  if (cachedViewModule !== undefined) {
    return cachedViewModule;
  }

  cachedViewModule = loadFromAppResources<CMViewModule>("@codemirror/view");
  return cachedViewModule;
}

function resolveCodeMirrorModules(): { state: CMStateModule; view: CMViewModule } | null {
  const state = getCodeMirrorStateModule();
  const view = getCodeMirrorViewModule();

  if (state && view) {
    return { state, view };
  }

  return null;
}

export function getCodeMirrorModules(): { state: CMStateModule; view: CMViewModule } {
  const modules = resolveCodeMirrorModules();
  if (!modules) {
    throw new Error("CodeMirror modules are unavailable in this environment.");
  }
  return modules;
}

const {
  state: { StateEffect, StateField, RangeSetBuilder },
  view: { EditorView, ViewPlugin, Decoration }
} = getCodeMirrorModules();

import {
  EditEntry,
  EditPayload,
  ValidationError,
  createEditAnchorId,
  parseEditPayload,
  parseEditPayloadFromString
} from "./editParser";

const WR_VIEW_TYPE = "writersroom-sidebar";

// Audicon system for accessibility - provides audio feedback for actions
type AudiconType = 
  | "selection"      // When an edit is selected
  | "apply"          // When an edit is applied
  | "resolve"        // When an edit is resolved/dismissed
  | "request-start"  // When requesting new edits
  | "request-complete" // When edits are received
  | "request-error"  // When request fails
  | "navigate-next"  // Navigation between edits
  | "navigate-prev";

class AudiconPlayer {
  private audioContext: AudioContext | null = null;
  private enabled: boolean = true;

  constructor() {
    if (typeof window !== "undefined" && typeof AudioContext !== "undefined") {
      try {
        this.audioContext = new AudioContext();
      } catch (error) {
        console.warn("[WritersRoom] Audio context unavailable for audicons:", error);
        this.enabled = false;
      }
    } else {
      this.enabled = false;
    }
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  play(type: AudiconType): void {
    if (!this.enabled || !this.audioContext) {
      return;
    }

    try {
      const ctx = this.audioContext;
      const now = ctx.currentTime;

      // Create gain node for volume control
      const gainNode = ctx.createGain();
      gainNode.connect(ctx.destination);
      gainNode.gain.setValueAtTime(0.15, now); // Low volume to not be intrusive

      // Create oscillator
      const osc = ctx.createOscillator();
      osc.connect(gainNode);

      // Define different sounds for different actions
      switch (type) {
        case "selection":
          // Soft ascending tone
          osc.frequency.setValueAtTime(440, now);
          osc.frequency.exponentialRampToValueAtTime(660, now + 0.08);
          gainNode.gain.exponentialRampToValueAtTime(0.01, now + 0.08);
          osc.start(now);
          osc.stop(now + 0.08);
          break;

        case "apply":
          // Confident double-beep
          osc.frequency.setValueAtTime(523.25, now);
          gainNode.gain.setValueAtTime(0.15, now);
          gainNode.gain.exponentialRampToValueAtTime(0.01, now + 0.06);
          osc.start(now);
          osc.stop(now + 0.06);
          
          // Second beep
          const osc2 = ctx.createOscillator();
          const gain2 = ctx.createGain();
          osc2.connect(gain2);
          gain2.connect(ctx.destination);
          osc2.frequency.setValueAtTime(659.25, now + 0.08);
          gain2.gain.setValueAtTime(0.15, now + 0.08);
          gain2.gain.exponentialRampToValueAtTime(0.01, now + 0.14);
          osc2.start(now + 0.08);
          osc2.stop(now + 0.14);
          break;

        case "resolve":
          // Descending tone (dismissal)
          osc.frequency.setValueAtTime(660, now);
          osc.frequency.exponentialRampToValueAtTime(440, now + 0.08);
          gainNode.gain.exponentialRampToValueAtTime(0.01, now + 0.08);
          osc.start(now);
          osc.stop(now + 0.08);
          break;

        case "request-start":
          // Ascending sweep
          osc.frequency.setValueAtTime(330, now);
          osc.frequency.exponentialRampToValueAtTime(880, now + 0.15);
          gainNode.gain.exponentialRampToValueAtTime(0.01, now + 0.15);
          osc.start(now);
          osc.stop(now + 0.15);
          break;

        case "request-complete":
          // Success chime (3 ascending notes)
          osc.frequency.setValueAtTime(523.25, now);
          gainNode.gain.setValueAtTime(0.12, now);
          gainNode.gain.exponentialRampToValueAtTime(0.01, now + 0.06);
          osc.start(now);
          osc.stop(now + 0.06);

          const osc3 = ctx.createOscillator();
          const gain3 = ctx.createGain();
          osc3.connect(gain3);
          gain3.connect(ctx.destination);
          osc3.frequency.setValueAtTime(659.25, now + 0.08);
          gain3.gain.setValueAtTime(0.12, now + 0.08);
          gain3.gain.exponentialRampToValueAtTime(0.01, now + 0.14);
          osc3.start(now + 0.08);
          osc3.stop(now + 0.14);

          const osc4 = ctx.createOscillator();
          const gain4 = ctx.createGain();
          osc4.connect(gain4);
          gain4.connect(ctx.destination);
          osc4.frequency.setValueAtTime(783.99, now + 0.16);
          gain4.gain.setValueAtTime(0.12, now + 0.16);
          gain4.gain.exponentialRampToValueAtTime(0.01, now + 0.24);
          osc4.start(now + 0.16);
          osc4.stop(now + 0.24);
          break;

        case "request-error":
          // Low error tone
          osc.frequency.setValueAtTime(200, now);
          osc.type = "sawtooth";
          gainNode.gain.setValueAtTime(0.1, now);
          gainNode.gain.exponentialRampToValueAtTime(0.01, now + 0.2);
          osc.start(now);
          osc.stop(now + 0.2);
          break;

        case "navigate-next":
          // Quick high blip
          osc.frequency.setValueAtTime(880, now);
          gainNode.gain.setValueAtTime(0.1, now);
          gainNode.gain.exponentialRampToValueAtTime(0.01, now + 0.04);
          osc.start(now);
          osc.stop(now + 0.04);
          break;

        case "navigate-prev":
          // Quick low blip
          osc.frequency.setValueAtTime(660, now);
          gainNode.gain.setValueAtTime(0.1, now);
          gainNode.gain.exponentialRampToValueAtTime(0.01, now + 0.04);
          osc.start(now);
          osc.stop(now + 0.04);
          break;
      }
    } catch (error) {
      // Silently fail - audicons are nice-to-have
      console.debug("[WritersRoom] Audicon playback failed:", error);
    }
  }

  dispose(): void {
    if (this.audioContext) {
      try {
        void this.audioContext.close();
      } catch (error) {
        // Ignore cleanup errors
      }
      this.audioContext = null;
    }
  }
}

// Settings interface and defaults (moved here for facet)
type ColorScheme = "default" | "high-contrast" | "colorblind-friendly" | "muted" | "warm" | "cool";

interface WritersRoomSettings {
  apiKey: string;
  colorScheme: ColorScheme;
  audibleFeedback: boolean; // Enable/disable audicons
}

const DEFAULT_SETTINGS: WritersRoomSettings = {
  apiKey: "",
  colorScheme: "default",
  audibleFeedback: true
};

interface ColorPalette {
  addition: { bg: string; border: string };
  replacement: { bg: string; border: string };
  subtraction: { bg: string; border: string };
  annotation: { bg: string; border: string };
  star: { bg: string; border: string };
  hover: string;
  active: { bg: string; border: string };
}

const COLOR_SCHEMES: Record<ColorScheme, ColorPalette> = {
  "default": {
    addition: { bg: "rgba(76, 175, 80, 0.15)", border: "rgba(76, 175, 80, 0.3)" },
    replacement: { bg: "rgba(255, 152, 0, 0.15)", border: "rgba(255, 152, 0, 0.3)" },
    subtraction: { bg: "rgba(244, 67, 54, 0.12)", border: "rgba(244, 67, 54, 0.3)" },
    annotation: { bg: "rgba(63, 81, 181, 0.12)", border: "rgba(63, 81, 181, 0.3)" },
    star: { bg: "rgba(255, 215, 0, 0.18)", border: "rgba(255, 215, 0, 0.5)" },
    hover: "rgba(255, 193, 7, 0.25)",
    active: { bg: "rgba(255, 193, 7, 0.3)", border: "rgba(255, 193, 7, 0.8)" }
  },
  "high-contrast": {
    addition: { bg: "rgba(0, 200, 0, 0.25)", border: "rgba(0, 200, 0, 0.6)" },
    replacement: { bg: "rgba(255, 140, 0, 0.25)", border: "rgba(255, 140, 0, 0.6)" },
    subtraction: { bg: "rgba(255, 0, 0, 0.25)", border: "rgba(255, 0, 0, 0.6)" },
    annotation: { bg: "rgba(0, 100, 255, 0.25)", border: "rgba(0, 100, 255, 0.6)" },
    star: { bg: "rgba(255, 215, 0, 0.3)", border: "rgba(255, 200, 0, 0.7)" },
    hover: "rgba(255, 180, 0, 0.4)",
    active: { bg: "rgba(255, 200, 0, 0.4)", border: "rgba(255, 180, 0, 1)" }
  },
  "colorblind-friendly": {
    // Using colors that work for most types of color blindness (protanopia, deuteranopia, tritanopia)
    addition: { bg: "rgba(0, 114, 178, 0.2)", border: "rgba(0, 114, 178, 0.5)" }, // Blue
    replacement: { bg: "rgba(230, 159, 0, 0.2)", border: "rgba(230, 159, 0, 0.5)" }, // Orange
    subtraction: { bg: "rgba(213, 94, 0, 0.2)", border: "rgba(213, 94, 0, 0.5)" }, // Vermillion
    annotation: { bg: "rgba(86, 180, 233, 0.2)", border: "rgba(86, 180, 233, 0.5)" }, // Sky blue
    star: { bg: "rgba(240, 228, 66, 0.25)", border: "rgba(240, 228, 66, 0.6)" }, // Yellow
    hover: "rgba(204, 121, 167, 0.3)", // Reddish purple
    active: { bg: "rgba(204, 121, 167, 0.35)", border: "rgba(204, 121, 167, 0.8)" }
  },
  "muted": {
    // Softer, less saturated colors for reduced eye strain
    addition: { bg: "rgba(140, 200, 140, 0.12)", border: "rgba(140, 200, 140, 0.25)" },
    replacement: { bg: "rgba(220, 180, 120, 0.12)", border: "rgba(220, 180, 120, 0.25)" },
    subtraction: { bg: "rgba(200, 140, 140, 0.12)", border: "rgba(200, 140, 140, 0.25)" },
    annotation: { bg: "rgba(140, 160, 200, 0.12)", border: "rgba(140, 160, 200, 0.25)" },
    star: { bg: "rgba(230, 220, 140, 0.15)", border: "rgba(230, 220, 140, 0.35)" },
    hover: "rgba(200, 180, 140, 0.2)",
    active: { bg: "rgba(200, 180, 140, 0.25)", border: "rgba(200, 180, 140, 0.6)" }
  },
  "warm": {
    // Warmer tones - reds, oranges, yellows
    addition: { bg: "rgba(255, 193, 7, 0.15)", border: "rgba(255, 193, 7, 0.4)" },
    replacement: { bg: "rgba(255, 152, 0, 0.18)", border: "rgba(255, 152, 0, 0.4)" },
    subtraction: { bg: "rgba(244, 67, 54, 0.15)", border: "rgba(244, 67, 54, 0.4)" },
    annotation: { bg: "rgba(233, 138, 21, 0.15)", border: "rgba(233, 138, 21, 0.4)" },
    star: { bg: "rgba(255, 235, 59, 0.2)", border: "rgba(255, 235, 59, 0.5)" },
    hover: "rgba(255, 160, 0, 0.3)",
    active: { bg: "rgba(255, 160, 0, 0.35)", border: "rgba(255, 140, 0, 0.7)" }
  },
  "cool": {
    // Cooler tones - blues, greens, purples
    addition: { bg: "rgba(66, 165, 245, 0.15)", border: "rgba(66, 165, 245, 0.4)" },
    replacement: { bg: "rgba(156, 39, 176, 0.15)", border: "rgba(156, 39, 176, 0.4)" },
    subtraction: { bg: "rgba(103, 58, 183, 0.15)", border: "rgba(103, 58, 183, 0.4)" },
    annotation: { bg: "rgba(0, 150, 136, 0.15)", border: "rgba(0, 150, 136, 0.4)" },
    star: { bg: "rgba(0, 188, 212, 0.18)", border: "rgba(0, 188, 212, 0.5)" },
    hover: "rgba(100, 150, 200, 0.25)",
    active: { bg: "rgba(100, 150, 200, 0.3)", border: "rgba(80, 130, 200, 0.7)" }
  }
};

interface EditorHighlightSpec {
  from: number;
  to: number;
  className: string;
  attributes: Record<string, string>;
}

export const setEditorHighlightsEffect = StateEffect.define<EditorHighlightSpec[]>();

export const writersRoomEditorHighlightsField: CMStateField<CMDecorationSet> = StateField.define<CMDecorationSet>({
  create() {
    console.info("[WritersRoom] StateField.create() called");
    return Decoration.none;
  },
  update(value: CMDecorationSet, transaction: CMTransaction) {
    console.info("[WritersRoom] StateField.update() called, effects:", transaction.effects.length);
    let decorations = value.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(setEditorHighlightsEffect)) {
        console.info("[WritersRoom] StateField.update() received setEditorHighlightsEffect with specs:", effect.value.length);
        decorations = buildEditorHighlightDecorations(transaction.state.doc, effect.value);
      }
    }
    return decorations;
  },
  provide(field: CMStateField<CMDecorationSet>) {
    return EditorView.decorations.from(field);
  }
});

// ViewPlugin for viewport-optimized rendering and click handling
class WritersRoomViewPlugin implements CMPluginValue {
  decorations: CMDecorationSet;
  private view: CMEditorView;

  constructor(view: CMEditorView) {
    this.view = view;
    this.decorations = this.buildDecorations(view);
  }

  update(update: CMViewUpdate) {
    // Rebuild decorations when:
    // 1. Viewport changes (scrolling)
    // 2. Document changes
    // 3. Selection changes (for active highlight)
    // 4. New highlights dispatched via effect
    const hasNewHighlights = update.transactions.some((tr) =>
      tr.effects.some((effect) => effect.is(setEditorHighlightsEffect))
    );

    if (update.viewportChanged || update.docChanged || update.selectionSet || hasNewHighlights) {
      this.decorations = this.buildDecorations(update.view);
    }
  }

  buildDecorations(view: CMEditorView): CMDecorationSet {
  const builder = new RangeSetBuilder<CMDecoration>();
  const highlights: CMDecorationSet = view.state.field(writersRoomEditorHighlightsField);

    // Only render decorations within visible viewport for performance
    for (const range of view.visibleRanges) {
      const { from, to } = range;
      highlights.between(from, to, (decorFrom: number, decorTo: number, decoration: CMDecoration) => {
        builder.add(decorFrom, decorTo, decoration);
      });
    }

    return builder.finish();
  }

  destroy() {
    // Cleanup if needed
  }
}

// Create the ViewPlugin with decorations spec and event handlers
const writersRoomViewPlugin = ViewPlugin.fromClass(WritersRoomViewPlugin, {
  decorations: (plugin) => plugin.decorations,
  eventHandlers: {
    // Handle mousedown events to capture clicks on highlighted lines
    // We use mousedown instead of click to catch the event before cursor placement
    mousedown: (event: MouseEvent, view: CMEditorView) => {
      const target = event.target as HTMLElement | null;
      if (!target) {
        return false;
      }

      // Find the closest line element with writersroom highlight attributes
      const lineElement = target.closest<HTMLElement>(".cm-line[data-writersroom-anchor]");
      if (!lineElement) {
        return false; // Not a highlighted line, allow default behavior
      }

      const anchorId = lineElement.getAttribute("data-writersroom-anchor");
      const sourcePath = lineElement.dataset.wrSource;

      if (!anchorId || !sourcePath) {
        return false;
      }

      // Allow the default cursor placement to happen
      // Then asynchronously sync the selection to the sidebar
      // Use setTimeout to let CodeMirror process the click first
      setTimeout(() => {
        // Get the plugin instance from the global window object
        // This is set during plugin initialization
        const plugin = (window as unknown as { writersRoomPlugin?: WritersRoomPlugin }).writersRoomPlugin;
        if (plugin) {
          void plugin.handleAnchorClick(sourcePath, anchorId);
        }
      }, 0);

      // Return false to allow default cursor placement behavior
      return false;
    }
  }
});

// Export the complete extension for registration
export const writersRoomEditorExtension = [
  writersRoomEditorHighlightsField,
  writersRoomViewPlugin
];

function buildEditorHighlightDecorations(
  doc: unknown,
  specs: EditorHighlightSpec[]
): CMDecorationSet {
  console.info("[WritersRoom] buildEditorHighlightDecorations called with", specs.length, "specs");
  
  if (!specs.length) {
    return Decoration.none;
  }

  const builder = new RangeSetBuilder<CMDecoration>();
  const sorted = [...specs].sort((a, b) => a.from - b.from);
  
  // Group specs by line to avoid duplicate line decorations
  const lineDecorations = new Map<number, EditorHighlightSpec>();

  for (const spec of sorted) {
    if (!(Number.isFinite(spec.from) && Number.isFinite(spec.to))) {
      console.warn("[WritersRoom] Skipping invalid decoration range", spec);
      continue;
    }
    
    // Store only the first decoration for each unique line position
    // This prevents multiple decorations on the same line
    if (!lineDecorations.has(spec.from)) {
      lineDecorations.set(spec.from, spec);
    }
  }

  // Create line decorations for entire lines as visual units
  for (const spec of lineDecorations.values()) {
    // Use Decoration.line() to highlight the entire line as a block
    // This creates a unified visual element that doesn't interfere with cursor placement
    const decoration = Decoration.line({
      class: spec.className,
      attributes: spec.attributes
    });
    
    console.info("[WritersRoom] Creating line decoration at", spec.from, "with class", spec.className);
    
    // Line decorations only need the line start position
    builder.add(spec.from, spec.from, decoration);
  }

  const result = builder.finish();
  console.info("[WritersRoom] Built decoration set with size:", result.size);
  return result;
}

interface HighlightOptions {
  id: string;
  classes: string[];
  dataAttrs: Record<string, string>;
  title?: string;
}

interface DecoratedEdit {
  edit: EditEntry;
  index: number;
  anchorId: string;
}

interface PersistedEditEntry {
  payload: EditPayload;
  editsPath: string | null;
  updatedAt: number;
  hash: string;
}

interface WritersRoomDataFile {
  settings: WritersRoomSettings;
  edits?: Record<string, StoredEditRecord>;
}

type StoredEditRecord = {
  payload: unknown;
  editsPath?: string | null;
  updatedAt?: number;
  hash?: string;
};

type SidebarProgressTone = "info" | "active" | "success" | "error";

interface SidebarProgressEntry {
  message: string;
  tone: SidebarProgressTone;
}

interface SidebarState {
  sourcePath: string | null;
  payload: EditPayload | null;
  selectedAnchorId?: string | null;
  progressLog?: SidebarProgressEntry[];
}

interface SidebarAction {
  label: string;
  title?: string;
  onClick: () => void | Promise<void>;
  disabled?: boolean;
}

type SelectionOrigin = "highlight" | "sidebar" | "external";

interface HighlightActivationOptions {
  scroll?: boolean;
  attempts?: number;
  editIndex?: number | null;
  origin?: SelectionOrigin;
}

export default class WritersRoomPlugin extends Plugin {
  settings: WritersRoomSettings = DEFAULT_SETTINGS;
  private persistedEdits = new Map<string, PersistedEditEntry>();
  private editCache = new Map<string, EditPayload | null>();
  private editCachePromises = new Map<string, Promise<EditPayload | null>>();
  private styleEl: HTMLStyleElement | null = null;
  private sidebarView: WritersRoomSidebarView | null = null;
  private activeSourcePath: string | null = null;
  private activeAnchorId: string | null = null;
  private activePayload: EditPayload | null = null;
  private activeEditIndex: number | null = null;
  private highlightRetryHandle: number | null = null;
  private editorHighlightState = new WeakMap<CMEditorView, string>();
  private requestInProgress = false;
  private staleEditSources = new Set<string>();
  private pendingAnchorResolutions = new Set<string>();
  private requestProgressSource: string | null = null;
  private requestProgressEntries: SidebarProgressEntry[] = [];
  private requestProgressTimer: number | null = null;
  private requestProgressMessageIndex = -1;
  private requestProgressActiveLabel: string | null = null;
  audiconPlayer: AudiconPlayer | null = null; // Public for settings access

  private log(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    ...details: unknown[]
  ): void {
    const prefix = `[WritersRoom] ${message}`;
    switch (level) {
      case "debug":
        console.debug(prefix, ...details);
        break;
      case "info":
        console.info(prefix, ...details);
        break;
      case "warn":
        console.warn(prefix, ...details);
        break;
      default:
        console.error(prefix, ...details);
    }
  }

  private clearEditCache(): void {
    this.editCache.clear();
    this.editCachePromises.clear();
  }

  private logInfo(message: string, ...details: unknown[]): void {
    this.log("info", message, ...details);
  }

  private logWarn(message: string, ...details: unknown[]): void {
    this.log("warn", message, ...details);
  }

  private logError(message: string, ...details: unknown[]): void {
    this.log("error", message, ...details);
  }

  private computePayloadHash(payload: EditPayload): string {
    try {
      return JSON.stringify(payload);
    } catch (error) {
      this.logWarn("Failed to compute hash for edit payload; using fallback.", error);
      return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
  }

  private readEnvVar(name: string): string {
    const candidates: Array<string | undefined> = [];

    if (typeof process !== "undefined" && process?.env) {
      candidates.push(process.env[name]);
    }

    if (typeof window !== "undefined") {
      const windowProcess = (window as unknown as {
        process?: { env?: Record<string, string | undefined> };
      }).process;
      if (windowProcess?.env) {
        candidates.push(windowProcess.env[name]);
      }
    }

    for (const value of candidates) {
      if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed) {
          return trimmed;
        }
      }
    }

    return "";
  }

  getResolvedApiKey(): string {
    const fromEnv = this.readEnvVar("WRITERSROOM_API_KEY");
    if (fromEnv) {
      return fromEnv;
    }

    return this.settings.apiKey.trim();
  }

  hasResolvedApiKey(): boolean {
    return this.getResolvedApiKey().length > 0;
  }

  isUsingEnvironmentApiKey(): boolean {
    return this.readEnvVar("WRITERSROOM_API_KEY").length > 0;
  }

  private resolveStoredData(raw: unknown): {
    settings: WritersRoomSettings;
    edits: Record<string, StoredEditRecord>;
  } {
    if (!raw || typeof raw !== "object") {
      return { settings: { ...DEFAULT_SETTINGS }, edits: {} };
    }

    const record = raw as Record<string, unknown>;

    if ("settings" in record && record.settings && typeof record.settings === "object") {
      const settingsRaw = record.settings as Record<string, unknown>;
      const settings: WritersRoomSettings = {
        ...DEFAULT_SETTINGS,
        apiKey: typeof settingsRaw.apiKey === "string" ? settingsRaw.apiKey : DEFAULT_SETTINGS.apiKey,
        colorScheme: 
          typeof settingsRaw.colorScheme === "string" && 
          ["default", "high-contrast", "colorblind-friendly", "muted", "warm", "cool"].includes(settingsRaw.colorScheme)
            ? (settingsRaw.colorScheme as ColorScheme)
            : DEFAULT_SETTINGS.colorScheme
      };

      const editsRaw = record.edits;
      const edits =
        editsRaw && typeof editsRaw === "object" && !Array.isArray(editsRaw)
          ? (editsRaw as Record<string, StoredEditRecord>)
          : {};

      return { settings, edits };
    }

    if ("apiKey" in record && typeof record.apiKey === "string") {
      return {
        settings: { ...DEFAULT_SETTINGS, apiKey: record.apiKey },
        edits: {}
      };
    }

    return { settings: { ...DEFAULT_SETTINGS }, edits: {} };
  }

  private normalizePersistedEntry(
    sourcePath: string,
    record: StoredEditRecord
  ): PersistedEditEntry | null {
    if (!record || typeof record !== "object") {
      return null;
    }

    try {
      const payload = parseEditPayload(record.payload);
      const hash = typeof record.hash === "string" && record.hash.length > 0
        ? record.hash
        : this.computePayloadHash(payload);
      const editsPathCandidate =
        typeof record.editsPath === "string" && record.editsPath.length > 0
          ? record.editsPath
          : this.getEditsPathForSource(sourcePath);
      const updatedAt =
        typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt)
          ? record.updatedAt
          : Date.now();

      return {
        payload,
        editsPath: editsPathCandidate ?? null,
        updatedAt,
        hash
      };
    } catch (error) {
      this.logWarn("Skipping persisted Writers Room edits due to invalid payload.", {
        sourcePath,
        error
      });
      return null;
    }
  }

  private serializePersistedEdits():
    | Record<string, StoredEditRecord>
    | undefined {
    if (this.persistedEdits.size === 0) {
      return undefined;
    }

    const output: Record<string, StoredEditRecord> = {};
    for (const [sourcePath, entry] of this.persistedEdits) {
      output[sourcePath] = {
        payload: entry.payload,
        editsPath: entry.editsPath,
        updatedAt: entry.updatedAt,
        hash: entry.hash
      };
    }

    return output;
  }

  private async persistState(): Promise<void> {
    const data: WritersRoomDataFile = {
      settings: this.settings,
      edits: this.serializePersistedEdits()
    };
    await this.saveData(data);
  }

  private persistStateSafely(): void {
    void this.persistState().catch((error) => {
      this.logError("Failed to persist Writers Room state.", error);
    });
  }

  private async persistEditsForSource(
    sourcePath: string,
    payload: EditPayload,
    options?: { editsPath?: string | null; persist?: boolean }
  ): Promise<void> {
    const editsPath =
      options?.editsPath ?? this.getEditsPathForSource(sourcePath) ?? null;
    const hash = this.computePayloadHash(payload);
    const existing = this.persistedEdits.get(sourcePath);
    const hasChanged =
      !existing ||
      existing.hash !== hash ||
      existing.editsPath !== editsPath;

    const entry: PersistedEditEntry = {
      payload,
      editsPath,
      updatedAt: Date.now(),
      hash
    };

    this.persistedEdits.set(sourcePath, entry);
    this.editCache.set(sourcePath, payload);
    if (this.activeSourcePath === sourcePath) {
      this.activePayload = payload;
      this.refreshEditorHighlights();
    }

    if (options?.persist === false) {
      return;
    }

    if (hasChanged) {
      await this.persistState();
    }
  }

  private removePersistedEdit(
    sourcePath: string,
    options?: { cacheValue?: EditPayload | null; suppressRefresh?: boolean }
  ): void {
    const removed = this.persistedEdits.delete(sourcePath);

    if (options && "cacheValue" in options) {
      this.editCache.set(sourcePath, options.cacheValue ?? null);
    } else {
      this.editCache.delete(sourcePath);
    }

    this.editCachePromises.delete(sourcePath);

    if (removed) {
      this.persistStateSafely();
    }

    if (this.activeSourcePath === sourcePath) {
      this.activePayload = options?.cacheValue ?? null;
      this.activeEditIndex = null;
      this.activeAnchorId = null;
      if (!options?.suppressRefresh) {
        this.refreshEditorHighlights();
      }
    }
  }

  private markEditsAsStale(sourcePath: string): void {
    if (this.staleEditSources.has(sourcePath)) {
      return;
    }

    this.staleEditSources.add(sourcePath);
    this.logWarn("Detected stale Writers Room edits; clearing cached data.", {
      sourcePath
    });

    const existing = this.persistedEdits.get(sourcePath);
    const editsPath = existing?.editsPath ?? this.getEditsPathForSource(sourcePath);

    this.removePersistedEdit(sourcePath, {
      cacheValue: null,
      suppressRefresh: true
    });

    if (editsPath) {
      void this.deleteFileIfExists(editsPath);
    }

    const finalize = () => {
      this.staleEditSources.delete(sourcePath);
      if (this.activeSourcePath === sourcePath) {
        this.activePayload = null;
        this.activeAnchorId = null;
        this.activeEditIndex = null;
      }
      void this.refreshSidebarForActiveFile();
      this.refreshEditorHighlights();
      new Notice(
        "Writers Room edits were cleared because the note changed substantially. Request new edits to refresh suggestions."
      );
    };

    if (typeof window !== "undefined" && typeof window.setTimeout === "function") {
      window.setTimeout(finalize, 0);
    } else {
      finalize();
    }
  }

  private findSourcePathByEditsPath(editsPath: string): string | null {
    for (const [sourcePath, entry] of this.persistedEdits) {
      if (entry.editsPath === editsPath) {
        return sourcePath;
      }
    }
    return null;
  }

  private isEditsJsonPath(path: string): boolean {
    return path.toLowerCase().startsWith("edits/") && path.toLowerCase().endsWith(".json");
  }

  async onload() {
    await this.loadSettings();

    // Initialize audicon player for accessibility
    this.audiconPlayer = new AudiconPlayer();
    this.audiconPlayer.setEnabled(this.settings.audibleFeedback);

    // Store plugin instance globally for access from CodeMirror event handlers
    (window as unknown as { writersRoomPlugin?: WritersRoomPlugin }).writersRoomPlugin = this;

    this.activeSourcePath = this.app.workspace.getActiveFile()?.path ?? null;
    if (this.activeSourcePath) {
      const persisted = this.persistedEdits.get(this.activeSourcePath);
      this.activePayload = persisted?.payload ?? null;
    }

    this.registerView(WR_VIEW_TYPE, (leaf) => new WritersRoomSidebarView(leaf, this));

    this.injectStyles();
    
    // Register editor extensions for CodeMirror
    // Include settings facet for reactive updates
    const editorExtensions = [...writersRoomEditorExtension];
    
    (this as unknown as { registerEditorExtension: (extension: unknown) => void })
      .registerEditorExtension(editorExtensions);
    this.logInfo("Registered editor highlight extension with settings facet");
    
    // Delay to ensure editors pick up the extension
    setTimeout(() => {
      this.logInfo("Triggering initial highlight refresh");
      this.refreshEditorHighlights();
    }, 100);
    
    this.registerHighlighting();
    this.registerVaultListeners();
    this.registerWorkspaceListeners();

    // Add ribbon icon to sidebar
    this.addRibbonIcon("book-open", "Open Writers Room", async () => {
      await this.openSidebarForActiveFile();
    });

    // Register click handler for preview mode highlights
    // Editor mode highlights are handled by CodeMirror event handlers
    (this as unknown as {
      registerDomEvent: (
        el: Document | HTMLElement,
        type: string,
        callback: (event: Event) => void
      ) => void;
    }).registerDomEvent(document, "click", (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }

      const anchor = target.closest<HTMLElement>("[data-writersroom-anchor]");
      if (!anchor) {
        return;
      }

      // Skip if this is an editor decoration - those are handled by CodeMirror
      if (anchor.dataset.wrBound === "editor") {
        return;
      }

      const source = anchor.dataset.wrSource;
      const anchorId =
        anchor.dataset.wrAnchor ??
        anchor.getAttribute("data-writersroom-anchor");

      if (!source || !anchorId) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      void this.handleAnchorClick(source, anchorId);
    });

    this.addSettingTab(new WritersRoomSettingTab(this.app, this));

    this.addCommand({
      id: "writers-room-test-command",
      name: "Test Writers Room setup",
      callback: () => {
        new Notice("Writers Room plugin initialized.");
      }
    });

    this.addCommand({
      id: "writers-room-open-sidebar",
      name: "Open Writers Room sidebar",
      callback: async () => {
        await this.openSidebarForActiveFile();
      }
    });

    this.addCommand({
      id: "writers-room-request-ai-edits",
      name: "Ask the Writers for edits",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) {
          return false;
        }
        if (!checking) {
          void this.requestAiEditsForActiveFile("external");
        }
        return true;
      }
    });

    const workspaceWithLayout = this.app.workspace as unknown as {
      onLayoutReady?: (callback: () => void) => void;
    };
    workspaceWithLayout.onLayoutReady?.(() => {
      this.refreshEditorHighlights();
    });

    this.refreshEditorHighlights();
  }

  private getVault(): Vault {
    return (this.app as App & { vault: Vault }).vault;
  }

  private async ensureFolder(folderPath: string): Promise<void> {
    const vault = this.getVault();
    const adapter = vault.adapter;
    const exists = await adapter.exists(folderPath);
    if (!exists) {
      try {
        await vault.createFolder(folderPath);
      } catch (error) {
        const alreadyExists =
          error instanceof Error && /exists/i.test(error.message);
        if (!alreadyExists) {
          throw error;
        }
      }
    }
  }

  private isTFile(file: TAbstractFile | null): file is TFile {
    return file instanceof TFile;
  }

  private async writeFile(vaultPath: string, contents: string): Promise<void> {
    const vault = this.getVault();
    const existing = vault.getAbstractFileByPath(vaultPath);

    if (this.isTFile(existing)) {
      await vault.modify(existing, contents);
      return;
    }

    if (existing) {
      throw new Error(`${vaultPath} exists and is not a file.`);
    }

    await vault.create(vaultPath, contents);
  }

  private async deleteFileIfExists(vaultPath: string): Promise<void> {
    const vault = this.getVault();
    const adapter = vault.adapter as typeof vault.adapter & {
      remove?: (path: string) => Promise<void>;
    };

    try {
      const exists = await adapter.exists(vaultPath);
      if (!exists) {
        return;
      }

      if (typeof adapter.remove === "function") {
        await adapter.remove(vaultPath);
        return;
      }

      const abstract = vault.getAbstractFileByPath(vaultPath);
      const deletable = (vault as unknown as {
        delete?: (file: TAbstractFile) => Promise<void>;
      }).delete;

      if (abstract && typeof deletable === "function") {
        await deletable.call(vault, abstract);
      }
    } catch (error) {
      this.logWarn("Failed to remove outdated Writers Room edits file.", {
        vaultPath,
        error
      });
    }
  }

  onunload(): void {
    // Clean up global plugin reference
    const win = window as unknown as { writersRoomPlugin?: WritersRoomPlugin };
    if (win.writersRoomPlugin === this) {
      delete win.writersRoomPlugin;
    }
    
    // Dispose of audicon player
    if (this.audiconPlayer) {
      this.audiconPlayer.dispose();
      this.audiconPlayer = null;
    }
    
    if (this.styleEl?.parentElement) {
      this.styleEl.parentElement.removeChild(this.styleEl);
    }
    this.styleEl = null;
    this.clearHighlightRetry();
    this.clearEditorHighlights();
    this.clearEditCache();
    this.cancelRequestProgressTimer();
    this.requestProgressEntries = [];
    this.requestProgressSource = null;
    this.requestProgressActiveLabel = null;
    this.requestProgressMessageIndex = -1;
  }

  private registerHighlighting(): void {
    this.registerMarkdownPostProcessor(async (element, context) => {
      try {
        await this.highlightSection(element, context);
      } catch (error) {
        console.error("[WritersRoom] Failed to apply highlight:", error);
      }
    });
  }

  private registerVaultListeners(): void {
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile) {
          void this.onVaultModify(file);
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (file instanceof TFile) {
          this.onVaultDelete(file);
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (file instanceof TFile) {
          this.onVaultRename(file, oldPath);
        }
      })
    );
  }

  private registerWorkspaceListeners(): void {
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        this.activeSourcePath = file?.path ?? null;
        if (!this.activeSourcePath) {
          this.activeAnchorId = null;
          this.activePayload = null;
          this.activeEditIndex = null;
        } else {
          const persisted = this.persistedEdits.get(this.activeSourcePath);
          this.activePayload = persisted?.payload ?? null;
          this.activeEditIndex = null;
        }
        void this.refreshSidebarForActiveFile();
        this.refreshEditorHighlights();
      })
    );
  }

  private async highlightSection(
    element: HTMLElement,
    context: MarkdownPostProcessorContext
  ): Promise<void> {
    const sectionInfo = context.getSectionInfo(element);
    if (!sectionInfo) {
      return;
    }

    const payload = await this.getEditPayloadForSource(context.sourcePath);
    if (!payload || payload.edits.length === 0) {
      return;
    }

    const decoratedEdits: DecoratedEdit[] = payload.edits.map((edit, index) => ({
      edit,
      index,
      anchorId: this.getAnchorForEdit(edit, index)
    }));

    for (const item of decoratedEdits) {
      const targetLine = item.edit.line - 1;
      if (
        targetLine < sectionInfo.lineStart ||
        targetLine > sectionInfo.lineEnd
      ) {
        continue;
      }

      if (!item.edit.original_text) {
        continue;
      }

      if (element.querySelector(`#${item.anchorId}`)) {
        continue;
      }

      const options: HighlightOptions = {
        id: item.anchorId,
        classes: this.getHighlightClasses(item.edit),
        dataAttrs: {
          wrLine: String(item.edit.line),
          wrType: item.edit.type,
          wrCategory: item.edit.category,
          wrIndex: String(item.index),
          wrSource: context.sourcePath,
          wrAnchor: item.anchorId
        },
        title: `Edit ${item.edit.type} (${item.edit.category})`
      };

      const targets = [item.edit.original_text];
      const trimmed = item.edit.original_text.trim();
      const targetValues = new Set<string>();
      const addTargets = (value: string | null | undefined) => {
        if (typeof value !== "string") {
          return;
        }
        const variants = [value, value.trim()];
        for (const variant of variants) {
          if (!variant) {
            continue;
          }
          targetValues.add(variant);
          const collapsed = variant.replace(/\s+/g, " ");
          if (collapsed && collapsed !== variant) {
            targetValues.add(collapsed);
          }
        }
      };

      addTargets(item.edit.original_text);
      addTargets(typeof item.edit.output === "string" ? item.edit.output : null);

      let anchorEl: HTMLElement | null = null;
      for (const needle of targetValues) {
        anchorEl = this.wrapMatchInElement(element, needle, options);
        if (anchorEl) {
          break;
        }
      }

      if (!anchorEl) {
        anchorEl = this.wrapBlockInElement(element, options);
      }

      if (anchorEl) {
        const highlightText = anchorEl.textContent ?? "";
        anchorEl.dataset.wrSource = context.sourcePath;
        anchorEl.dataset.wrIndex = String(item.index);
        anchorEl.dataset.wrLine = String(item.edit.line);
        anchorEl.dataset.wrType = item.edit.type;
        anchorEl.dataset.wrCategory = item.edit.category;
        anchorEl.dataset.wrAnchor = item.anchorId;
        anchorEl.dataset.wrMatch = highlightText;
        anchorEl.dataset.wrOriginal = item.edit.original_text;
        if (typeof item.edit.output === "string") {
          anchorEl.dataset.wrOutput = item.edit.output;
        }
        anchorEl.setAttribute("role", "button");
        anchorEl.setAttribute(
          "aria-label",
          `Edit on line ${item.edit.line}: ${item.edit.type}`
        );

        if (this.activeAnchorId === item.anchorId) {
          anchorEl.classList.add("writersroom-highlight-active");
        }

        if (anchorEl.dataset.wrBound !== "true") {
          anchorEl.dataset.wrBound = "true";
          anchorEl.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            void this.handleAnchorClick(context.sourcePath, item.anchorId);
          });
        }
      } else {
        this.logWarn("Unable to highlight text for edit.", {
          line: item.edit.line,
          type: item.edit.type,
          sourcePath: context.sourcePath,
          candidates: Array.from(targetValues).slice(0, 4)
        });
        this.resolveMissingAnchors(context.sourcePath, [item.anchorId]);
      }
    }
  }

  private wrapMatchInElement(
    element: HTMLElement,
    needle: string,
    options: HighlightOptions
  ): HTMLElement | null {
    if (!needle) {
      return null;
    }

    if (options.id) {
      const existing = element.querySelector(`#${options.id}`);
      if (existing instanceof HTMLElement) {
        return existing;
      }
    }

    const doc = element.ownerDocument ?? document;
    const walker = doc.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const textNodes: Array<{ node: Text; start: number; length: number }> = [];
    let aggregate = "";
    let offset = 0;

    let current: Node | null = walker.nextNode();
    while (current) {
      const textNode = current as Text;
      const value = textNode.nodeValue ?? "";
      if (value.length > 0) {
        textNodes.push({ node: textNode, start: offset, length: value.length });
        aggregate += value;
        offset += value.length;
      }
      current = walker.nextNode();
    }

    if (!aggregate) {
      return null;
    }

    const matchIndex = aggregate.indexOf(needle);
    if (matchIndex === -1) {
      return null;
    }

    const matchEnd = matchIndex + needle.length;
    let startNode: Text | null = null;
    let startOffset = 0;
    let endNode: Text | null = null;
    let endOffset = 0;

    for (const entry of textNodes) {
      const nodeStart = entry.start;
      const nodeEnd = nodeStart + entry.length;

      if (!startNode && matchIndex >= nodeStart && matchIndex < nodeEnd) {
        startNode = entry.node;
        startOffset = matchIndex - nodeStart;
      }

      if (!endNode && matchEnd > nodeStart && matchEnd <= nodeEnd) {
        endNode = entry.node;
        endOffset = matchEnd - nodeStart;
        break;
      }
    }

    if (!startNode || !endNode) {
      return null;
    }

    const range = doc.createRange();
    try {
      range.setStart(startNode, startOffset);
      range.setEnd(endNode, endOffset);
    } catch {
      range.detach?.();
      return null;
    }

    const wrapper = doc.createElement("span");
    wrapper.id = options.id;
    wrapper.tabIndex = -1;
    wrapper.setAttribute("data-writersroom-anchor", options.id);

    if (options.title) {
      wrapper.setAttribute("title", options.title);
    }

    for (const cls of options.classes) {
      wrapper.classList.add(cls);
    }

    for (const [key, value] of Object.entries(options.dataAttrs)) {
      wrapper.dataset[key] = value;
    }

    try {
      range.surroundContents(wrapper);
    } catch (error) {
      this.logWarn("Failed to surround text for highlight.", {
        needle,
        error
      });
      range.detach?.();
      return null;
    }

  range.detach?.();
  return wrapper;
  }

  refreshEditorHighlights(): void {
    this.applyEditorHighlightsToViews();
  }

  private applyEditorHighlightsToViews(): void {
    const targetPath = this.activeSourcePath;
    const payload = this.activePayload;
    const activeAnchorId = this.activeAnchorId;
    const workspace = this.app.workspace;
    const leaves =
      typeof workspace.getLeavesOfType === "function"
        ? workspace.getLeavesOfType("markdown")
        : [];

    for (const leaf of leaves) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) {
        continue;
      }

      const editorView = this.getEditorViewFromMarkdownView(view);
      if (!editorView) {
        continue;
      }

      const viewPath = view.file?.path ?? null;
      if (
        !targetPath ||
        !payload ||
        payload.edits.length === 0 ||
        viewPath !== targetPath
      ) {
        this.dispatchEditorHighlights(editorView, []);
        continue;
      }

      const specs = this.buildEditorHighlightSpecs(
        editorView,
        payload,
        targetPath,
        activeAnchorId ?? null
      );
      
      // Debug logging
      if (specs.length > 0) {
        this.logInfo(`Applying ${specs.length} editor highlights`, { 
          viewPath, 
          specs: specs.slice(0, 2) 
        });
      }
      
      this.dispatchEditorHighlights(editorView, specs);
    }
  }

  private getEditorViewFromMarkdownView(view: MarkdownView): CMEditorView | null {
    const editorAny = view.editor as unknown as { cm?: CMEditorView };
    const result = editorAny?.cm ?? null;
    this.logInfo("Getting editor view", { 
      hasView: !!result, 
      path: view.file?.path 
    });
    return result;
  }

  private buildEditorHighlightSpecs(
    editorView: CMEditorView,
    payload: EditPayload,
    sourcePath: string,
    activeAnchorId: string | null
  ): EditorHighlightSpec[] {
    const specs: EditorHighlightSpec[] = [];
    const doc = editorView.state?.doc ?? null;
    if (!doc) {
      return specs;
    }

    const docText = typeof doc.toString === "function" ? doc.toString() : "";
    const totalLines = doc.lines;
    const missingAnchors: string[] = [];

    payload.edits.forEach((edit, index) => {
      const anchorId = this.getAnchorForEdit(edit, index);
      const classList = [...this.getHighlightClasses(edit)];
      if (activeAnchorId === anchorId) {
        classList.push("writersroom-highlight-active");
      }

      let from: number | null = null;
      let to: number | null = null;
      let matchText: string | null = null;
      let resolvedLineNumber = edit.line;

      if (docText) {
        const range = this.findEditRangeInText(docText, edit);
        if (range && Number.isFinite(range.start) && Number.isFinite(range.end) && range.start < range.end) {
          from = range.start;
          to = range.end;
          matchText = docText.slice(range.start, range.end);
          try {
            const lineInfo = doc.lineAt(range.start);
            resolvedLineNumber = lineInfo.number;
          } catch {
            // ignore line resolution errors and keep original line number
          }
        }
      }

      if (from === null || to === null) {
        const lineNumber = Math.max(1, edit.line);
        if (lineNumber > totalLines) {
          this.logWarn(
            `Edit references line ${lineNumber} but document only has ${totalLines} lines. Skipping.`
          );
          missingAnchors.push(anchorId);
          return;
        }

        try {
          const docLine = doc.line(lineNumber);
          if (docLine && docLine.from < docLine.to && docLine.text.trim().length > 0) {
            from = docLine.from;
            to = docLine.to;
            matchText = docLine.text;
            resolvedLineNumber = docLine.number;
          } else {
            this.logInfo(
              `Skipping line ${lineNumber} - empty or no content to highlight`
            );
            missingAnchors.push(anchorId);
            return;
          }
        } catch (error) {
          this.logWarn(`Failed to get line ${lineNumber} for highlight`, error);
          missingAnchors.push(anchorId);
          return;
        }
      }

      if (from === null || to === null) {
        missingAnchors.push(anchorId);
        return;
      }

      if (
        Number.isFinite(resolvedLineNumber) &&
        resolvedLineNumber > 0 &&
        resolvedLineNumber !== edit.line
      ) {
        (edit as { line: number }).line = resolvedLineNumber;
      }

      const attributes: Record<string, string> = {
        "data-writersroom-anchor": anchorId,
        "data-wr-source": sourcePath,
        "data-wr-index": String(index),
        "data-wr-line": String(resolvedLineNumber),
        "data-wr-type": edit.type,
        "data-wr-category": edit.category,
        "data-wr-anchor": anchorId,
        "data-wr-original": edit.original_text,
        tabindex: "-1",
        role: "button",
        "aria-label": `Edit on line ${edit.line}: ${edit.type}`,
        title: `Edit ${edit.type} (${edit.category})`,
        "data-wr-bound": "editor"
      };

      if (typeof edit.output === "string") {
        attributes["data-wr-output"] = edit.output;
      }

      if (typeof matchText === "string" && matchText.length > 0) {
        attributes["data-wr-match"] = matchText;
      }

      specs.push({
        from,
        to,
        className: classList.join(" "),
        attributes
      });
    });

    // Debug logging and stale data detection
    const validSpecsRatio = specs.length / payload.edits.length;
    
    if (specs.length > 0 && validSpecsRatio >= 0.5) {
      // Most edits are valid
      this.logInfo(
        `Built ${specs.length}/${payload.edits.length} highlight specs for ${sourcePath}`,
        { totalLines }
      );
    } else if (payload.edits.length > 0 && validSpecsRatio < 0.5) {
      // Less than 50% of edits are valid - likely stale data
      this.logWarn(
        `Built ${specs.length}/${payload.edits.length} highlight specs for ${sourcePath}. Document appears to have changed significantly. Clearing stale edits.`,
        { totalLines, validSpecsRatio }
      );

      this.markEditsAsStale(sourcePath);
      return [];
    }

    if (missingAnchors.length > 0) {
      this.resolveMissingAnchors(sourcePath, missingAnchors);
    }

    return specs;
  }

  private getEditorHighlightCandidates(edit: EditEntry): string[] {
    const values = new Set<string>();
    const addCandidate = (value: string | null | undefined) => {
      if (typeof value !== "string") {
        return;
      }
      if (!value.length) {
        return;
      }

      const variants = [value, value.trim()];
      for (const variant of variants) {
        if (!variant) {
          continue;
        }
        values.add(variant);
        const collapsed = variant.replace(/\s+/g, " ");
        if (collapsed && collapsed !== variant) {
          values.add(collapsed);
        }
      }
    };

    addCandidate(edit.original_text);
    if (typeof edit.output === "string") {
      addCandidate(edit.output);
    }

    return Array.from(values).sort((a, b) => b.length - a.length);
  }

  private computeLineOffsets(text: string): number[] {
    const offsets: number[] = [0];
    for (let index = 0; index < text.length; index++) {
      if (text.charCodeAt(index) === 10) {
        offsets.push(index + 1);
      }
    }
    return offsets;
  }

  private offsetToLineIndex(offset: number, lineOffsets: number[]): number {
    if (lineOffsets.length === 0) {
      return 0;
    }

    let low = 0;
    let high = lineOffsets.length - 1;
    let result = 0;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const midOffset = lineOffsets[mid];
      if (midOffset <= offset) {
        result = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    return result;
  }

  private findEditRangeInText(
    text: string,
    edit: EditEntry
  ): { start: number; end: number } | null {
    const variants = this.getEditorHighlightCandidates(edit);
    if (!variants.length) {
      return null;
    }

    const lineOffsets = this.computeLineOffsets(text);
    const safeLineIndex = Math.min(
      Math.max(edit.line - 1, 0),
      Math.max(lineOffsets.length - 1, 0)
    );
    const searchStart = lineOffsets[safeLineIndex] ?? 0;

    const isWithinLineRange = (offset: number): boolean => {
      const lineIndex = this.offsetToLineIndex(offset, lineOffsets);
      return Math.abs(lineIndex - safeLineIndex) <= 3;
    };

    for (const candidate of variants) {
      if (!candidate) {
        continue;
      }
      const localIndex = text.indexOf(candidate, searchStart);
      if (localIndex !== -1 && isWithinLineRange(localIndex)) {
        return { start: localIndex, end: localIndex + candidate.length };
      }
    }

    for (const candidate of variants) {
      if (!candidate) {
        continue;
      }
      const globalIndex = text.indexOf(candidate);
      if (globalIndex !== -1) {
        return { start: globalIndex, end: globalIndex + candidate.length };
      }
    }

    return null;
  }

  private resolveEditorHighlightRange(
    doc: {
      line: (line: number) => { from: number; to: number; text: string; number: number };
      lineAt: (pos: number) => { from: number; to: number; text: string; number: number };
      lines?: number;
      length?: number;
    },
    docText: string,
    edit: EditEntry,
    candidates: string[]
  ): { from: number; to: number; match: string } | null {
    if (!candidates.length) {
      return null;
    }

    const totalLines =
      typeof doc.lines === "number" && Number.isFinite(doc.lines)
        ? Math.max(1, doc.lines)
        : 1;

    const safeLine = Math.min(
      totalLines,
      Math.max(1, Math.trunc(edit.line ?? 1))
    );

    let lineInfo: { from: number; to: number; text: string; number: number };
    try {
      lineInfo = doc.line(safeLine);
    } catch {
      return null;
    }

    for (const candidate of candidates) {
      if (!candidate) {
        continue;
      }
      const localIndex = lineInfo.text.indexOf(candidate);
      if (localIndex !== -1) {
        return {
          from: lineInfo.from + localIndex,
          to: lineInfo.from + localIndex + candidate.length,
          match: candidate
        };
      }
    }

    if (docText) {
      const searchStart = lineInfo.from;
      for (const candidate of candidates) {
        if (!candidate) {
          continue;
        }
        let globalIndex = docText.indexOf(candidate, searchStart);
        if (globalIndex === -1) {
          globalIndex = docText.indexOf(candidate);
        }
        if (globalIndex === -1) {
          continue;
        }

        let matchLine: { from: number; to: number; number: number };
        try {
          matchLine = doc.lineAt(globalIndex);
        } catch {
          continue;
        }

        if (Math.abs(matchLine.number - lineInfo.number) > 3) {
          continue;
        }

        return {
          from: globalIndex,
          to: globalIndex + candidate.length,
          match: candidate
        };
      }
    }

    if (lineInfo.from < lineInfo.to) {
      return {
        from: lineInfo.from,
        to: lineInfo.to,
        match: lineInfo.text
      };
    }

    return null;
  }

  private resolveMissingAnchors(sourcePath: string, anchorIds: string[]): void {
    const unique = Array.from(new Set(anchorIds)).filter((anchorId) => {
      if (this.pendingAnchorResolutions.has(anchorId)) {
        return false;
      }
      this.pendingAnchorResolutions.add(anchorId);
      return true;
    });

    if (!unique.length) {
      return;
    }

    const process = async (): Promise<void> => {
      let removed = 0;
      try {
        for (const anchorId of unique) {
          try {
            await this.resolveSidebarEdit(sourcePath, anchorId);
            removed += 1;
          } catch (error) {
            this.logError("Failed to auto-resolve missing Writers Room anchor.", error, {
              sourcePath,
              anchorId
            });
          }
        }

        if (removed > 0) {
          const message =
            removed === 1
              ? "Removed an edit whose text no longer exists in the note."
              : `Removed ${removed} edits whose text no longer exists in the note.`;
          new Notice(message, 4000);
        }
      } finally {
        unique.forEach((anchorId) => this.pendingAnchorResolutions.delete(anchorId));
      }
    };

    void process();
  }

  private dispatchEditorHighlights(
    editorView: CMEditorView,
    specs: EditorHighlightSpec[]
  ): void {
    // Check if the editor has our field
    let hasField = false;
    try {
      const field = editorView.state.field(writersRoomEditorHighlightsField, false);
      hasField = field !== undefined;
    } catch {
      hasField = false;
    }

    if (!hasField) {
      this.logWarn(
        "Editor does not have WritersRoom highlight field. Please close and reopen this file to enable edit mode highlights."
      );
      return;
    }

    const signature = JSON.stringify(
      specs.map((spec) => [
        spec.from,
        spec.to,
        spec.className,
        spec.attributes["data-writersroom-anchor"],
        spec.attributes["data-wr-match"]
      ])
    );

    const previous = this.editorHighlightState.get(editorView);
    if (previous === signature) {
      this.logInfo("Skipping duplicate highlight dispatch");
      return;
    }

    this.editorHighlightState.set(editorView, signature);
    
    this.logInfo(`Dispatching ${specs.length} highlights to editor`, {
      specs: specs.map(s => ({ 
        from: s.from, 
        to: s.to, 
        className: s.className,
        anchor: s.attributes["data-writersroom-anchor"]
      }))
    });
    
    try {
      editorView.dispatch({
        effects: setEditorHighlightsEffect.of(specs)
      });
      this.logInfo("Dispatch successful");
    } catch (error) {
      this.logWarn("Failed to dispatch editor highlight update.", error);
    }
  }

  private clearEditorHighlights(): void {
    const workspace = this.app?.workspace;
    if (!workspace || typeof workspace.getLeavesOfType !== "function") {
      return;
    }

    const leaves = workspace.getLeavesOfType("markdown");
    for (const leaf of leaves) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) {
        continue;
      }
      const editorView = this.getEditorViewFromMarkdownView(view);
      if (!editorView) {
        continue;
      }
      this.editorHighlightState.delete(editorView);
      try {
        editorView.dispatch({
          effects: setEditorHighlightsEffect.of([])
        });
      } catch (error) {
        this.logWarn("Failed to clear editor highlights.", error);
      }
    }
  }

  private wrapBlockInElement(
    element: HTMLElement,
    options: HighlightOptions
  ): HTMLElement | null {
    if (!element.firstChild) {
      return null;
    }

    if (options.id) {
      const existing = element.querySelector(`#${options.id}`);
      if (existing instanceof HTMLElement) {
        return existing;
      }
    }

    const doc = element.ownerDocument ?? document;
    const range = doc.createRange();
    range.selectNodeContents(element);

    const wrapper = doc.createElement("span");
    wrapper.id = options.id;
    wrapper.tabIndex = -1;
    wrapper.setAttribute("data-writersroom-anchor", options.id);
    wrapper.classList.add("writersroom-highlight-block");

    if (options.title) {
      wrapper.setAttribute("title", options.title);
    }

    for (const cls of options.classes) {
      wrapper.classList.add(cls);
    }

    for (const [key, value] of Object.entries(options.dataAttrs)) {
      wrapper.dataset[key] = value;
    }

    try {
      range.surroundContents(wrapper);
    } catch (error) {
      this.logWarn("Failed to apply block-level highlight wrapper.", error);
      range.detach?.();
      return null;
    }

    range.detach?.();
    return wrapper;
  }

  async handleAnchorClick(
    sourcePath: string,
    anchorId: string
  ): Promise<void> {
    await this.selectEdit(sourcePath, anchorId, "highlight");
  }

  async handleSidebarSelection(
    sourcePath: string,
    anchorId: string
  ): Promise<void> {
    await this.selectEdit(sourcePath, anchorId, "sidebar");
  }

  async jumpToAnchor(sourcePath: string, anchorId: string): Promise<void> {
    await this.selectEdit(sourcePath, anchorId, "sidebar");
  }

  async resolveSidebarEdit(sourcePath: string, anchorId: string): Promise<void> {
    if (!sourcePath) {
      return;
    }

    const payload =
      this.activeSourcePath === sourcePath && this.activePayload
        ? this.activePayload
        : await this.getEditPayloadForSource(sourcePath);

    if (!payload) {
      this.logWarn("Resolve requested but no payload was available.", {
        sourcePath
      });
      return;
    }

    const match = this.findEditByAnchor(payload, anchorId);
    if (!match) {
      this.logWarn("Resolve requested for edit outside payload bounds.", {
        anchorId,
        total: payload.edits.length
      });
      return;
    }

    const updatedEdits = payload.edits.slice();
    updatedEdits.splice(match.index, 1);

    const updatedPayload: EditPayload = {
      ...payload,
      edits: updatedEdits
    };

    const persisted = this.persistedEdits.get(sourcePath);
    const editsPath = persisted?.editsPath ?? null;

    try {
      if (editsPath) {
        const folder = editsPath.includes("/")
          ? editsPath.slice(0, editsPath.lastIndexOf("/"))
          : null;
        if (folder) {
          await this.ensureFolder(folder);
        }

        await this.writeFile(
          editsPath,
          JSON.stringify(updatedPayload, null, 2) + "\n"
        );
      }

      await this.persistEditsForSource(sourcePath, updatedPayload, {
        editsPath
      });
    } catch (error) {
      this.logError("Failed to resolve Writers Room edit.", error, {
        sourcePath,
        anchorId
      });
      new Notice("Failed to resolve edit. Check the console for details.");
      return;
    }

    if (this.activeSourcePath === sourcePath) {
      if (this.activeAnchorId === anchorId) {
        this.activeAnchorId = null;
        this.activeEditIndex = null;
      } else if (this.activeAnchorId) {
        const activeMatch = this.findEditByAnchor(updatedPayload, this.activeAnchorId);
        if (activeMatch) {
          this.activeEditIndex = activeMatch.index;
        } else {
          this.activeAnchorId = null;
          this.activeEditIndex = null;
        }
      }

      this.activePayload = updatedPayload;
      this.setActiveHighlight(this.activeAnchorId, {
        scroll: false,
        editIndex: this.activeEditIndex
      });
    }

    // Play resolve audicon for accessibility
    this.audiconPlayer?.play("resolve");

    await this.refreshSidebarForActiveFile();
  }

  async applySidebarEdit(sourcePath: string, anchorId: string): Promise<void> {
    if (!sourcePath) {
      return;
    }

    let payload =
      this.activeSourcePath === sourcePath && this.activePayload
        ? this.activePayload
        : await this.getEditPayloadForSource(sourcePath);

    if (!payload) {
      new Notice("No Writers Room edits available to apply for this note.");
      return;
    }

    const match = this.findEditByAnchor(payload, anchorId);
    if (!match) {
      this.logWarn("Apply requested for edit outside payload bounds.", {
        anchorId,
        total: payload.edits.length
      });
      return;
    }

    const { edit } = match;

    const supportedTypes: Array<EditEntry["type"]> = [
      "addition",
      "replacement",
      "subtraction"
    ];

    if (!supportedTypes.includes(edit.type)) {
      new Notice("Only additions, replacements, or subtractions can be applied automatically.");
      return;
    }

    if ((edit.type === "addition" || edit.type === "replacement") && typeof edit.output !== "string") {
      new Notice("This edit does not include replacement text and cannot be applied automatically.");
      return;
    }

    const vault = this.getVault();
    const abstractFile = vault.getAbstractFileByPath(sourcePath);
    if (!this.isTFile(abstractFile)) {
      new Notice("Unable to locate the target note for this edit.");
      return;
    }

    const leaves = this.app.workspace.getLeavesOfType("markdown");
    let targetView: MarkdownView | null = null;
    for (const leaf of leaves) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file?.path === sourcePath) {
        targetView = view;
        break;
      }
    }

    let editor: Editor | null = null;
    let docText: string;
    if (targetView) {
      editor = targetView.editor;
      docText = editor.getValue();
    } else {
      docText = await vault.read(abstractFile);
    }

    const range = this.findEditRangeInText(docText, edit);
    if (!range) {
      this.logWarn("Failed to locate edit text within document during apply.", {
        edit,
        sourcePath
      });
      new Notice("Could not locate the original text for this edit. Please apply manually.");
      return;
    }

    const newline = docText.includes("\r\n") ? "\r\n" : "\n";
    let replacement = "";
    let startOffset = range.start;
    let endOffset = range.end;

    if (edit.type === "replacement") {
      replacement = edit.output as string;
    } else if (edit.type === "subtraction") {
      replacement = "";
    } else {
      const lineStart = docText.lastIndexOf("\n", range.end - 1);
      const nextNewline = docText.indexOf("\n", range.end);
      const lineText = docText.slice(
        lineStart + 1,
        nextNewline === -1 ? docText.length : nextNewline
      );
      const indentMatch = lineText.match(/^\s*/);
      const indent = indentMatch?.[0] ?? "";
      const insertion = `${newline}${indent}${edit.output as string}`;
      startOffset = range.end;
      endOffset = range.end;
      replacement = insertion;
    }

    try {
      if (editor) {
        const startPos = editor.offsetToPos(startOffset);
        const endPos = editor.offsetToPos(endOffset);
        editor.replaceRange(replacement, startPos, endPos);
      } else {
        const before = docText.slice(0, startOffset);
        const after = docText.slice(endOffset);
        const updated = before + replacement + after;
        await this.writeFile(sourcePath, updated);
      }
    } catch (error) {
      this.logError("Failed to apply edit to document.", error);
      new Notice("Failed to apply the edit. Check the console for details.");
      return;
    }

    // Reload payload reference if we used cached value to avoid stale state.
    if (this.activeSourcePath === sourcePath) {
      payload = this.activePayload ?? payload;
    }

    // Play apply audicon for accessibility
    this.audiconPlayer?.play("apply");

    await this.resolveSidebarEdit(sourcePath, anchorId);
    new Notice(`Applied ${edit.type} on line ${edit.line}.`);
  }

  private async selectEdit(
    sourcePath: string,
    anchorId: string,
    origin: SelectionOrigin
  ): Promise<void> {
    if (!sourcePath) {
      return;
    }

    const activeFile = this.app.workspace.getActiveFile();
    if (
      origin === "sidebar" &&
      activeFile?.path !== sourcePath &&
      typeof this.app.workspace.openLinkText === "function"
    ) {
      await this.app.workspace.openLinkText(sourcePath, "", false);
    }

    const payload = await this.getEditPayloadForSource(sourcePath);
    if (!payload) {
      if (origin !== "highlight") {
        new Notice("No Writers Room edits found for this note.");
      }
      return;
    }

    this.activeSourcePath = sourcePath;
    this.activeAnchorId = anchorId;
    this.activePayload = payload;

    const match = this.findEditByAnchor(payload, anchorId);
    const editIndex = match ? match.index : null;
    this.activeEditIndex = editIndex;

    // Play selection audicon for accessibility
    this.audiconPlayer?.play("selection");

    const view = await this.ensureSidebar({
      sourcePath,
      payload,
      selectedAnchorId: anchorId
    });

    view.updateSelection(anchorId);

    const shouldScroll = origin !== "highlight";
    this.setActiveHighlight(anchorId, {
      scroll: shouldScroll,
      attempts: 0,
      editIndex,
      origin  // Pass origin to know how to position cursor
    });
  }

  private async ensureSidebar(
    state: SidebarState
  ): Promise<WritersRoomSidebarView> {
    const view = await this.ensureSidebarView();
    view.setState({
      ...state,
      progressLog:
        state.progressLog ?? this.getProgressEntriesForSource(state.sourcePath ?? this.activeSourcePath)
    });
    return view;
  }

  private async ensureSidebarView(): Promise<WritersRoomSidebarView> {
    const existing = this.app.workspace.getLeavesOfType(WR_VIEW_TYPE);
    let leaf: WorkspaceLeaf | null = existing[0] ?? null;

    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getRightLeaf(true);
      if (!leaf) {
        throw new Error("Unable to create Writers Room sidebar leaf.");
      }
      await leaf.setViewState({ type: WR_VIEW_TYPE, active: true });
    }

    await this.app.workspace.revealLeaf(leaf);

    const view = leaf.view;
    if (!(view instanceof WritersRoomSidebarView)) {
      throw new Error("Sidebar leaf does not host a Writers Room view.");
    }

    return view;
  }

  private findAnchorInRoot(root: Document | Element, anchorId: string): HTMLElement | null {
    const selectors = [
      `[data-writersroom-anchor="${anchorId}"]`,
      `[data-wr-anchor="${anchorId}"]`,
      `#${anchorId}`
    ];

    for (const selector of selectors) {
      const element = root.querySelector(selector);
      if (element instanceof HTMLElement) {
        return element;
      }
    }

    return null;
  }

  private resolveAnchorElement(anchorId: string): HTMLElement | null {
    if (!anchorId || typeof document === "undefined") {
      return null;
    }

    const element = this.findAnchorInRoot(document, anchorId);
    if (element) {
      return element;
    }

    const fallback = document.getElementById(anchorId);
    return fallback instanceof HTMLElement ? fallback : null;
  }

  private getAnchorElements(anchorId: string): HTMLElement[] {
    if (!anchorId || typeof document === "undefined") {
      return [];
    }

    const selectors = [
      `[data-writersroom-anchor="${anchorId}"]`,
      `[data-wr-anchor="${anchorId}"]`,
      `#${anchorId}`
    ];

    const seen = new Set<HTMLElement>();
    const results: HTMLElement[] = [];

    for (const selector of selectors) {
      const matches = document.querySelectorAll(selector);
      matches.forEach((candidate) => {
        if (!(candidate instanceof HTMLElement)) {
          return;
        }
        if (seen.has(candidate)) {
          return;
        }
        seen.add(candidate);
        results.push(candidate);
      });
    }

    return results;
  }

  private isElementVisible(element: HTMLElement): boolean {
    if (typeof window === "undefined" || typeof document === "undefined") {
      return true;
    }

    const rect = element.getBoundingClientRect();
    if (!Number.isFinite(rect.top) || !Number.isFinite(rect.bottom)) {
      return false;
    }

    const container = this.findScrollableAncestor(element, null);
    if (container) {
      const bounds = container.getBoundingClientRect();
      return rect.top >= bounds.top && rect.bottom <= bounds.bottom;
    }

    const viewportHeight = window.innerHeight || document.documentElement?.clientHeight || 0;
    if (viewportHeight === 0) {
      return true;
    }

    return rect.top >= 0 && rect.bottom <= viewportHeight;
  }

  private isAnyAnchorVisible(elements: HTMLElement[]): boolean {
    if (!elements.length) {
      return false;
    }

    return elements.some((element) => this.isElementVisible(element));
  }

  private setActiveHighlight(
    anchorId: string | null,
    options?: HighlightActivationOptions
  ): void {
    this.clearHighlightRetry();

    document
      .querySelectorAll(".writersroom-highlight-active")
      .forEach((el) => el.classList.remove("writersroom-highlight-active"));

    if (!anchorId) {
      return;
    }

    const effectiveIndex =
      options?.editIndex ??
      this.activeEditIndex ??
      null;

    const attempt = options?.attempts ?? 0;
    const maxAttempts = 5;
    const shouldScroll = options?.scroll ?? false;
    const origin = options?.origin ?? "highlight";

    const anchorElements = this.getAnchorElements(anchorId);
    const primaryTarget =
      anchorElements.find((element) => {
        const bound = element.dataset?.wrBound;
        return typeof bound === "string" && bound !== "editor";
      }) ??
      anchorElements.find((element) => element.dataset?.wrBound === "editor") ??
      anchorElements[0] ??
      null;

    const datasetIndex = Number(primaryTarget?.dataset?.wrIndex);
    const resolvedIndex = Number.isFinite(datasetIndex)
      ? datasetIndex
      : effectiveIndex;

    this.scrollEditorsToAnchor(
      primaryTarget ?? null,
      anchorId,
      resolvedIndex ?? null,
      shouldScroll,
      origin
    );

    if (!primaryTarget) {
      if (attempt < maxAttempts && typeof window !== "undefined") {
        this.highlightRetryHandle = window.setTimeout(() => {
          this.highlightRetryHandle = null;
          this.setActiveHighlight(anchorId, {
            scroll: options?.scroll,
            attempts: attempt + 1,
            editIndex: effectiveIndex,
            origin: options?.origin
          });
        }, 180);
      }
      return;
    }

    for (const element of anchorElements) {
      element.classList.add("writersroom-highlight-active");
    }

    // Add pulse animation for jump-to actions (accessibility enhancement)
    const shouldPulse = shouldScroll && (origin === "sidebar" || origin === "highlight");
    if (shouldPulse && typeof window !== "undefined") {
      for (const element of anchorElements) {
        element.classList.add("writersroom-highlight-pulse");
      }
      
      // Remove pulse class after animation completes (1s duration)
      window.setTimeout(() => {
        for (const element of anchorElements) {
          element.classList.remove("writersroom-highlight-pulse");
        }
      }, 1000);
    }

    if (
      shouldScroll &&
      attempt < maxAttempts &&
      typeof window !== "undefined" &&
      !this.isAnyAnchorVisible(anchorElements)
    ) {
      const delay = shouldScroll ? 240 : 120;
      this.highlightRetryHandle = window.setTimeout(() => {
        this.highlightRetryHandle = null;
        const refreshedElements = this.getAnchorElements(anchorId);
        if (!this.isAnyAnchorVisible(refreshedElements)) {
          this.setActiveHighlight(anchorId, {
            scroll: options?.scroll,
            attempts: attempt + 1,
            editIndex: effectiveIndex,
            origin: options?.origin
          });
        }
      }, delay);
    }

    const focusTarget =
      anchorElements.find((element) => element.dataset?.wrBound !== "editor") ??
      primaryTarget;

    if (!focusTarget) {
      return;
    }

    try {
      focusTarget.focus({ preventScroll: !shouldScroll });
    } catch {
      focusTarget.focus();
    }
  }

  private scrollEditorsToAnchor(
    target: HTMLElement | null,
    anchorId: string,
    editIndex: number | null,
    shouldScroll: boolean,
    origin: SelectionOrigin = "highlight"
  ): void {
    const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
    let resolvedIndex = editIndex;
    const payload = this.activePayload;

    if (resolvedIndex === null && payload) {
      const match = this.findEditByAnchor(payload, anchorId);
      if (match) {
        resolvedIndex = match.index;
      }
    }

    const resolvedEdit =
      resolvedIndex !== null && payload
        ? payload.edits[resolvedIndex] ?? null
        : null;

    let lineNumber = Number(target?.dataset?.wrLine);
    if (!Number.isFinite(lineNumber) && resolvedEdit) {
      lineNumber = resolvedEdit.line;
    }

    if (!Number.isFinite(lineNumber)) {
      const legacy = anchorId.match(/^writersroom-line-(\d+)-edit-(\d+)$/);
      if (legacy) {
        const parsed = Number(legacy[1]);
        if (Number.isFinite(parsed)) {
          lineNumber = parsed;
        }
      }
    }

    if (markdownView && Number.isFinite(lineNumber)) {
      // Set the active leaf to focus the editor
      const leaves = this.app.workspace.getLeavesOfType("markdown");
      const leaf = leaves.find(l => l.view === markdownView);
      if (leaf && typeof this.app.workspace.setActiveLeaf === "function") {
        this.app.workspace.setActiveLeaf(leaf, { focus: true });
      }

      const editorAny = markdownView.editor as unknown as {
        getLine?: (line: number) => string;
        scrollIntoView?: (
          range: { from: { line: number; ch: number }; to: { line: number; ch: number } },
          center?: boolean
        ) => void;
        focus?: () => void;
        cm?: {
          state?: { doc?: { line?: (line: number) => { from: number; length: number } | undefined } };
          dispatch?: (input: unknown) => void;
          scrollIntoView?: (pos: number, opts?: { y?: "center" | "start" | "end"; x?: "center" | "start" | "end" }) => void;
        };
      };

      const editorLine = Math.max(0, Math.floor(lineNumber - 1));
      let column = 0;

      // For sidebar clicks, always position cursor at line start
      // For editor clicks (highlight origin), keep cursor where user clicked
      if (origin === "sidebar") {
        // Position at line start for sidebar clicks
        column = 0;
      } else {
        // For highlight origin (editor clicks), try to find the specific position
        const lineText =
          typeof editorAny.getLine === "function"
            ? editorAny.getLine(editorLine)
            : undefined;

        const candidateValues = new Set<string>();
        const addCandidate = (value: string | null | undefined) => {
          if (typeof value !== "string") {
            return;
          }
          if (!value.length) {
            return;
          }
          candidateValues.add(value);
          const trimmed = value.trim();
          if (trimmed && trimmed !== value) {
            candidateValues.add(trimmed);
          }
          const collapsed = value.replace(/\s+/g, " ").trim();
          if (collapsed && !candidateValues.has(collapsed)) {
            candidateValues.add(collapsed);
          }
        };

        addCandidate(target?.dataset?.wrMatch);
        addCandidate(target?.textContent ?? "");
        addCandidate(target?.dataset?.wrOriginal);
        addCandidate(target?.dataset?.wrOutput);
        if (resolvedEdit) {
          addCandidate(resolvedEdit.original_text);
          if (typeof resolvedEdit.output === "string") {
            addCandidate(resolvedEdit.output);
          }
        }

        if (typeof lineText === "string" && candidateValues.size > 0) {
          for (const candidate of candidateValues) {
            const index = lineText.indexOf(candidate);
            if (index !== -1) {
              column = index;
              break;
            }
          }
        }
      }

      const position = { line: editorLine, ch: Math.max(0, column) };

      try {
        markdownView.editor.setCursor(position);

        if (typeof editorAny.scrollIntoView === "function") {
          editorAny.scrollIntoView({ from: position, to: position }, true);
        }

        const cmView = editorAny.cm;
        if (cmView) {
          try {
            const docLine =
              cmView.state?.doc?.line?.(Math.max(1, editorLine + 1)) ?? null;
            if (docLine) {
              const offset = Math.min(docLine.length, Math.max(0, column));
              const pos = docLine.from + offset;
              if (typeof cmView.scrollIntoView === "function") {
                cmView.scrollIntoView(pos, { y: shouldScroll ? "center" : "start" });
              }

              const transaction: Record<string, unknown> = {
                selection: { anchor: pos }
              };

              const cmModules = resolveCodeMirrorModules();
              if (cmModules) {
                try {
                  const { EditorView } = cmModules.view;
                  transaction.effects = [
                    EditorView.scrollIntoView(pos, { y: shouldScroll ? "center" : "start" })
                  ];
                } catch (effectError) {
                  this.logWarn("Failed to create CodeMirror scroll effect.", {
                    anchorId,
                    error: effectError
                  });
                }
              }

              cmView.dispatch?.(transaction as unknown);
            }
          } catch (cmError) {
            this.logWarn("Failed to scroll CodeMirror view for highlight.", {
              anchorId,
              error: cmError
            });
          }
        }

        if (typeof editorAny.focus === "function") {
          editorAny.focus();
        }
      } catch (error) {
        this.logWarn("Failed to position editor cursor for highlight.", {
          anchorId,
          line: position.line,
          column: position.ch,
          error
        });
      }
    }

    this.scrollPreviewAnchor(anchorId, target, shouldScroll);
    this.refreshEditorHighlights();
  }

  private scrollPreviewAnchor(
    anchorId: string,
    existingTarget?: HTMLElement | null,
    smooth = true
  ): boolean {
    if (!anchorId || typeof document === "undefined") {
      return false;
    }

    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    const previewContainer = activeView?.previewMode?.containerEl ?? null;

    let target = existingTarget ?? null;

    if (!target && previewContainer) {
      target = this.findAnchorInRoot(previewContainer, anchorId);
    }

    if (!target) {
      target = this.resolveAnchorElement(anchorId);
    }

    if (!target) {
      return false;
    }

    const scrollContainer = this.findScrollableAncestor(target, previewContainer);
    const behavior = smooth ? "smooth" : "auto";

    if (scrollContainer) {
      const containerRect = scrollContainer.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const offset = targetRect.top - containerRect.top - containerRect.height / 2;

      if (typeof scrollContainer.scrollBy === "function") {
        scrollContainer.scrollBy({ top: offset, left: 0, behavior });
      } else if (typeof scrollContainer.scrollTo === "function") {
        scrollContainer.scrollTo({
          top: scrollContainer.scrollTop + offset,
          left: scrollContainer.scrollLeft,
          behavior
        });
      } else {
        scrollContainer.scrollTop += offset;
      }

      return true;
    }

    if (typeof target.scrollIntoView === "function") {
      target.scrollIntoView({ behavior, block: "center" });
      return true;
    }

    return false;
  }

  private findScrollableAncestor(
    target: HTMLElement,
    boundary?: HTMLElement | null
  ): HTMLElement | null {
    if (typeof window === "undefined") {
      return null;
    }

    let current: HTMLElement | null = target.parentElement;
    while (current) {
      if (boundary && !boundary.contains(current)) {
        break;
      }

      const style = window.getComputedStyle(current);
      const overflowY = style.overflowY;

      if ((overflowY === "auto" || overflowY === "scroll") && current.scrollHeight > current.clientHeight) {
        return current;
      }

      if (current === boundary) {
        break;
      }

      current = current.parentElement;
    }

    return null;
  }

  private clearHighlightRetry(): void {
    if (this.highlightRetryHandle !== null && typeof window !== "undefined") {
      window.clearTimeout(this.highlightRetryHandle);
      this.highlightRetryHandle = null;
    }
  }

  async requestAiEditsForActiveFile(
    origin: SelectionOrigin,
    sourcePath?: string
  ): Promise<void> {
    const targetFile = sourcePath
      ? this.getFileByPath(sourcePath)
      : this.app.workspace.getActiveFile();

    if (!targetFile) {
      new Notice("Open a note before asking the Writers for edits.");
      return;
    }

    await this.requestAiEditsForFile(targetFile, origin);
  }

  private getFileByPath(path: string): TFile | null {
    const abstract = this.getVault().getAbstractFileByPath(path);
    return this.isTFile(abstract) ? abstract : null;
  }

  private setRequestState(requesting: boolean): void {
    if (this.requestInProgress === requesting) {
      return;
    }

    this.requestInProgress = requesting;
    if (!requesting) {
      this.cancelRequestProgressTimer();
    }
    this.sidebarView?.setRequestState(requesting);
    if (requesting) {
      this.emitProgressUpdate();
    }
  }

  private startRequestProgress(sourcePath: string, initialMessage: string): void {
    this.cancelRequestProgressTimer();
    this.requestProgressSource = sourcePath;
    this.requestProgressEntries = [{ message: initialMessage, tone: "active" }];
    this.requestProgressActiveLabel = initialMessage;
    this.requestProgressMessageIndex = -1;
    this.emitProgressUpdate();
  }

  private advanceRequestProgress(message: string): void {
    const previousLabel = this.requestProgressActiveLabel;
    this.mutateActiveProgressEntry((entry) => {
      if (previousLabel) {
        entry.message = previousLabel;
      }
      entry.tone = "success";
    });
    this.requestProgressEntries.push({ message, tone: "active" });
    if (this.requestProgressEntries.length > 8) {
      this.requestProgressEntries = this.requestProgressEntries.slice(-8);
    }
    this.requestProgressActiveLabel = message;
    this.requestProgressMessageIndex = -1;
    this.emitProgressUpdate();
  }

  private updateActiveProgressMessage(message: string): void {
    let updated = false;
    const base = this.requestProgressActiveLabel;
    const composite = base ? `${base} - ${message}` : message;
    
    for (let index = this.requestProgressEntries.length - 1; index >= 0; index -= 1) {
      const entry = this.requestProgressEntries[index];
      if (entry.tone === "active") {
        entry.message = composite;
        updated = true;
        break;
      }
    }

    if (!updated) {
      this.requestProgressEntries.push({ message: composite, tone: "active" });
      this.requestProgressActiveLabel = base ?? message;
    }

    if (this.requestProgressEntries.length > 8) {
      this.requestProgressEntries = this.requestProgressEntries.slice(-8);
    }

    this.emitProgressUpdate();
  }

  private mutateActiveProgressEntry(mutator: (entry: SidebarProgressEntry) => void): void {
    for (let index = this.requestProgressEntries.length - 1; index >= 0; index -= 1) {
      const entry = this.requestProgressEntries[index];
      if (entry.tone === "active") {
        mutator(entry);
        return;
      }
    }
  }

  private completeRequestProgress(message?: string): void {
    this.cancelRequestProgressTimer();
    const base = this.requestProgressActiveLabel;
    this.mutateActiveProgressEntry((entry) => {
      if (base) {
        entry.message = base;
      }
      entry.tone = "success";
    });
    this.requestProgressActiveLabel = null;
    if (message) {
      this.requestProgressEntries.push({ message, tone: "success" });
      if (this.requestProgressEntries.length > 8) {
        this.requestProgressEntries = this.requestProgressEntries.slice(-8);
      }
    }
    this.emitProgressUpdate();
  }

  private failRequestProgress(message: string): void {
    this.cancelRequestProgressTimer();
    const base = this.requestProgressActiveLabel;
    this.mutateActiveProgressEntry((entry) => {
      entry.tone = "error";
      if (base) {
        entry.message = base;
      }
    });
    this.requestProgressActiveLabel = null;
    this.requestProgressEntries.push({ message, tone: "error" });
    if (this.requestProgressEntries.length > 8) {
      this.requestProgressEntries = this.requestProgressEntries.slice(-8);
    }
    this.emitProgressUpdate();
  }

  private resetRequestProgress(): void {
    this.cancelRequestProgressTimer();
    this.requestProgressEntries = [];
    this.requestProgressSource = null;
    this.requestProgressMessageIndex = -1;
    this.requestProgressActiveLabel = null;
    this.emitProgressUpdate();
  }

  private scheduleRequestProgressTicker(): void {
    // No longer needed - progress comes from model's reasoning stream
  }

  private cancelRequestProgressTimer(): void {
    if (this.requestProgressTimer !== null && typeof window !== "undefined") {
      window.clearTimeout(this.requestProgressTimer);
      this.requestProgressTimer = null;
    }
  }

  private getProgressEntriesForSource(sourcePath: string | null): SidebarProgressEntry[] {
    if (!sourcePath || this.requestProgressSource !== sourcePath) {
      return [];
    }

    return this.requestProgressEntries.map((entry) => ({ ...entry }));
  }

  private emitProgressUpdate(): void {
    if (!this.sidebarView) {
      return;
    }

    const sourcePath = this.activeSourcePath ?? this.requestProgressSource;
    const progressLog = this.getProgressEntriesForSource(sourcePath);

    this.sidebarView.setState({
      sourcePath: sourcePath ?? null,
      payload: this.activePayload,
      selectedAnchorId: this.activeAnchorId,
      progressLog
    });
  }

  private async clearOutstandingEditsBeforeRequest(
    sourcePath: string
  ): Promise<boolean> {
    const payload = await this.getEditPayloadForSource(sourcePath);
    if (!payload || payload.edits.length === 0) {
      return true;
    }

    const warningMessage =
      "Requesting new Writers Room edits will delete the existing suggestions for this note. Continue?";

    let proceed = true;
    if (typeof window !== "undefined" && typeof window.confirm === "function") {
      proceed = window.confirm(warningMessage);
    } else {
      this.logWarn("Confirmation prompt unavailable; clearing outstanding edits automatically.", {
        sourcePath,
        existingEdits: payload.edits.length
      });
    }

    if (!proceed) {
      new Notice("Cancelled asking the Writers.");
      return false;
    }

    const persisted = this.persistedEdits.get(sourcePath);
    const editsPath = persisted?.editsPath ?? this.getEditsPathForSource(sourcePath);

    this.removePersistedEdit(sourcePath, { cacheValue: null });

    if (editsPath) {
      await this.deleteFileIfExists(editsPath);
    }

    void this.refreshSidebarForActiveFile();
    new Notice("Previous Writers Room edits deleted.");
    return true;
  }

  private async requestAiEditsForFile(
    file: TFile,
    origin: SelectionOrigin
  ): Promise<void> {
    if (this.requestInProgress) {
      new Notice("Already asking the Writers. Please wait.");
      return;
    }

    const apiKey = this.getResolvedApiKey();
    if (!apiKey) {
      new Notice("Add your OpenAI API key in Writers Room settings first.");
      return;
    }

    const editsPath = this.getEditsPathForSource(file.path);
    if (!editsPath) {
      new Notice("Could not determine where to store Writers Room edits for this note.");
      return;
    }

    let noteContents: string;
    try {
      noteContents = await this.getVault().read(file);
    } catch (error) {
      this.logError("Failed to read note before requesting AI edits.", error);
      new Notice("Failed to read the note contents. See console for details.");
      return;
    }

    if (!noteContents.trim()) {
      new Notice("The current note is empty. Add some content before asking the Writers.");
      return;
    }

    // Check word count limit
    const wordCount = noteContents.trim().split(/\s+/).length;
    if (wordCount > 4000) {
      new Notice(`Your note is too long (${wordCount} words). Please limit to 4000 words or less.`);
      return;
    }

    this.activeSourcePath = file.path;
    this.activeAnchorId = null;
    this.activeEditIndex = null;
    this.activePayload = null;

    const cleared = await this.clearOutstandingEditsBeforeRequest(file.path);
    if (!cleared) {
      return;
    }

    this.resetRequestProgress();

    await this.ensureSidebar({
      sourcePath: file.path,
      payload: null,
      selectedAnchorId: null
    });

    this.setRequestState(true);
    this.startRequestProgress(file.path, "The Writers are reviewing your work. This can take up to five minutes…");
    const loadingNotice = new Notice("Asking the Writers…", 0);

    // Play request start audicon for accessibility
    this.audiconPlayer?.play("request-start");

    try {
      const systemPrompt = `You are "editor", a line-level prose editor specializing in precise sentence improvements for fiction writing. Your mission is to make *small, targeted* enhancements to rhythm, flow, sensory detail, and impact, while avoiding full rewrites or changing the original meaning.

IMPORTANT: Use your reasoning/thinking process to narrate your editorial thought process as you work. Share brief observations about what you notice (rhythm issues, sensory opportunities, pacing concerns) as you read through the text. This helps the writer understand your editorial perspective.

Begin with a concise checklist (3-7 bullets) outlining the sub-tasks you will perform before editing. Keep checklist items conceptual, not implementation-level.

---

### EDITING RULES
- Examine the input text line by line; each line should be treated as a distinct editing unit—even if it contains multiple sentences or is blank. Do not edit blank lines.
- Suggest only the *smallest possible* changes needed to improve rhythm, pacing, vividness, or flow.
- After making edits, validate that each change enhances the intended aspect (flow, rhythm, sensory, or punch) in 1-2 lines and be ready to self-correct if the validation fails.
- Categorize each edit by one of the following:
  1. **flow** — smoothness and clarity of sentences
  2. **rhythm** — pacing and variation in sentence/phrase length
  3. **sensory** — imagery, tangible physical details
  4. **punch** — emotional impact or added emphasis

- Create a summary of the edits and the piece itself as if you were a seasoned editor working with a novelist. All responses should include exactly one summary item.
- Output edits in **normalized JSON** format as detailed below.

FIELD GUIDELINES
- \`line\`: Input line number corresponding to the edit.
- \`type\`:
  - "addition": only provide newly inserted text
  - "replacement": rewrite the existing snippet in full with the improved phrasing
  - "star": mark exemplary text worth celebrating
  - "subtraction": output must be null (for removed text)
  - "annotation": no text is added or deleted; output is a brief bracketed comment or suggestion
- \`category\`: one of "flow", "rhythm", "sensory", or "punch"
- \`original_text\`: a snippet (phrase or sentence) of the affected text for context
- \`output\`:
  - If type = "addition": only the text being inserted
  - If type = "replacement": the revised text that should replace the original snippet
  - If type = "star": a concise note explaining why the passage shines (optional if the highlight speaks for itself)
  - If type = "subtraction": must be null
  - If type = "annotation": a succinct bracketed comment, e.g., [RHYTHM: try varying sentence length.]

Malformed, empty, or non-line-separated input should result in a JSON object with an empty \`edits\` array and a \`summary\` explaining the issue. Treat the whole input as a single line (\`line: 1\`) if lines are not separable.

TASK
Analyze the text below and return your JSON of edits. Do not include commentary or output outside the JSON. Your output must always have a \`summary\` with a brief review by the "editor-in-chief."

OUTPUT: A valid JSON object with these fields:
- \`edits\`: Array of edit objects, each containing:
  - \`agent\` (string, always "editor")
  - \`line\` (integer, starting at 1)
  - \`type\` ("addition", "replacement", "star", "subtraction", or "annotation")
  - \`category\` ("flow", "rhythm", "sensory", or "punch")
  - \`original_text\` (string, as found in input)
  - \`output\` (string or null, as appropriate)
- \`summary\`: (string) Concise review from the "editor-in-chief" evaluating the result (always required)

Malformed or blank input example:
\`\`\`json
{
  "edits": [],
  "summary": "Input was malformed or blank; no edits performed."
}
\`\`\``;

      const fetchImpl: typeof fetch | null =
        typeof fetch !== "undefined"
          ? fetch
          : typeof window !== "undefined" && typeof window.fetch === "function"
            ? window.fetch.bind(window)
            : null;

      if (!fetchImpl) {
        throw new Error("Fetch API is unavailable in this environment.");
      }

      this.advanceRequestProgress("Processing... please be patient, this may take several minutes…");
      const response = await fetchImpl("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: "gpt-5",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: noteContents }
          ],
          stream: true,
          stream_options: {
            include_usage: true
          }
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenAI request failed (${response.status}): ${errorText.slice(0, 500)}`);
      }

      if (!response.body) {
        throw new Error("OpenAI response did not include a readable stream.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let completion = "";
      let buffer = "";
      let lastReasoningUpdate = Date.now();
      let lastProgressUpdate = Date.now();
      const reasoningThrottleMs = 300;
      const progressUpdateMs = 1000; // Update progress every second
      let accumulatedReasoning = "";
      let hasReceivedAnyData = false;
      let tokensReceived = 0;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }

          hasReceivedAnyData = true;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed === "data: [DONE]") {
              continue;
            }

            if (!trimmed.startsWith("data: ")) {
              continue;
            }

            const jsonStr = trimmed.slice(6);
            try {
              const chunk = JSON.parse(jsonStr) as {
                choices?: Array<{
                  delta?: {
                    content?: string;
                    reasoning_content?: string;
                  };
                  finish_reason?: string | null;
                }>;
                usage?: {
                  prompt_tokens?: number;
                  completion_tokens?: number;
                  total_tokens?: number;
                };
              };

              // Check for usage information (sent in final chunk when include_usage is true)
              if (chunk.usage?.completion_tokens) {
                tokensReceived = chunk.usage.completion_tokens;
              }

              const delta = chunk.choices?.[0]?.delta;
              if (!delta) {
                continue;
              }

              if (delta.content) {
                completion += delta.content;
                // Estimate tokens as we go (roughly 4 characters per token)
                tokensReceived = Math.floor(completion.length / 4);
              }

              if (delta.reasoning_content) {
                accumulatedReasoning += delta.reasoning_content;
                const now = Date.now();
                if (now - lastReasoningUpdate >= reasoningThrottleMs) {
                  const reasoning = accumulatedReasoning.trim();
                  if (reasoning.length > 0) {
                    // Extract the most recent sentence or clause for display
                    const sentences = reasoning.split(/[.!?]\s+/);
                    const latestSentence = sentences[sentences.length - 1] || reasoning;
                    const display = latestSentence.length > 120
                      ? `${latestSentence.slice(0, 117)}...`
                      : latestSentence;
                    this.updateActiveProgressMessage(display);
                    lastReasoningUpdate = now;
                  }
                }
              }
            } catch (parseError) {
              this.logWarn("Failed to parse streaming chunk.", { line: trimmed, error: parseError });
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      this.advanceRequestProgress("Almost done…");

      if (typeof completion !== "string" || completion.trim().length === 0) {
        throw new Error("OpenAI response did not include text content.");
      }

      const jsonText = this.extractJsonFromResponse(completion);
      if (!jsonText) {
        throw new Error("OpenAI response did not include a JSON payload.");
      }

    this.advanceRequestProgress("Finalizing your edits…");

    const payload = this.parseAiPayload(jsonText);

      await this.ensureFolder("edits");
      await this.writeFile(editsPath, JSON.stringify(payload, null, 2) + "\n");

      await this.persistEditsForSource(file.path, payload, { editsPath });
      this.editCachePromises.delete(file.path);
      this.activeSourcePath = file.path;
      this.activePayload = payload;

      this.logInfo("Writers Room edits generated.", {
        file: file.path,
        edits: payload.edits.length
      });

      const editsCount = payload.edits.length;
      const progressCompletionMessage =
        editsCount > 0
          ? `Writers delivered ${editsCount} edit${editsCount === 1 ? "" : "s"}.`
          : "Writers responded without new edits.";

      this.completeRequestProgress(progressCompletionMessage);

      // Play request complete audicon for accessibility
      this.audiconPlayer?.play("request-complete");

      if (editsCount > 0) {
        const firstAnchor = this.getAnchorForEdit(payload.edits[0], 0);
        await this.selectEdit(file.path, firstAnchor, origin);
        new Notice(`Writers provided ${editsCount} edit${editsCount === 1 ? "" : "s"}.`);
      } else {
        await this.refreshSidebarForActiveFile();
        new Notice("Writers responded without specific edits.");
      }
    } catch (error) {
      this.logError("AI edit request failed.", error);
      const message = error instanceof Error ? error.message : "Unknown error occurred.";
      const progressMessage = message.length > 160 ? `${message.slice(0, 157)}...` : message;
      this.failRequestProgress(`The Writers encountered an error: ${progressMessage}`);
      
      // Play request error audicon for accessibility
      this.audiconPlayer?.play("request-error");
      
      new Notice(`Failed to fetch Writers Room edits: ${message}`);
    } finally {
      loadingNotice.hide();
      this.setRequestState(false);
    }
  }

  private extractJsonFromResponse(content: string): string | null {
    const fenced = content.match(/```json\s*([\s\S]*?)```/i);
    if (fenced && fenced[1]) {
      return fenced[1].trim();
    }

    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      return content.slice(start, end + 1).trim();
    }

    return null;
  }

  private parseAiPayload(jsonText: string): EditPayload {
    let raw: unknown;
    try {
      raw = JSON.parse(jsonText);
    } catch (error) {
      this.logError("Failed to parse JSON returned by OpenAI.", error, {
        snippet: jsonText.slice(0, 500)
      });
      throw new Error("OpenAI response was not valid JSON.");
    }

    const normalized = this.normalizeAiPayload(raw);
    return parseEditPayload(normalized);
  }

  private normalizeAiPayload(raw: unknown): unknown {
    if (Array.isArray(raw)) {
      this.logWarn("AI payload wrapped in array; using first element.", {
        length: raw.length
      });
      raw = raw[0] ?? {};
    }

    if (!raw || typeof raw !== "object") {
      return raw;
    }

    const record = { ...(raw as Record<string, unknown>) };

    if ("summary" in record && typeof record.summary !== "string") {
      this.logWarn("Coercing summary to string.", { summary: record.summary });
      record.summary = record.summary == null ? "" : String(record.summary);
    }

    if (!("summary" in record) || typeof record.summary !== "string" || record.summary.trim().length === 0) {
      this.logWarn("Applying fallback summary for AI payload.");
      record.summary = "Editors provided automated revision suggestions.";
    }

    const editsRaw = record.edits;
    let editsArray: unknown[] = [];

    if (Array.isArray(editsRaw)) {
      editsArray = editsRaw;
    } else if (editsRaw && typeof editsRaw === "object") {
      this.logWarn("Coercing edits object into array.");
      editsArray = Object.values(editsRaw as Record<string, unknown>);
    } else if (editsRaw != null) {
      this.logWarn("Edits payload not array; ignoring invalid value.", {
        edits: editsRaw
      });
    }

    record.edits = editsArray
      .map((entry, index) => this.normalizeAiEdit(entry, index))
      .filter((value): value is Record<string, unknown> => value !== null);

    return record;
  }

  private normalizeAiEdit(entry: unknown, index: number): Record<string, unknown> | null {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      this.logWarn("Dropping malformed edit entry.", { index, entry });
      return null;
    }

    const record = { ...(entry as Record<string, unknown>) };

    if (typeof record.agent !== "string" || record.agent.trim().length === 0) {
      this.logWarn("Setting missing agent to 'editor'.", { index, agent: record.agent });
      record.agent = "editor";
    } else if (record.agent.trim().toLowerCase() !== "editor") {
      this.logWarn("Normalizing agent value to 'editor'.", { index, agent: record.agent });
      record.agent = "editor";
    }

    const typeLookup: Record<string, string> = {
      addition: "addition",
      add: "addition",
      suggestion: "addition",
      subtraction: "subtraction",
      remove: "subtraction",
      deletion: "subtraction",
      annotation: "annotation",
      comment: "annotation",
      note: "annotation",
      replacement: "replacement",
      replace: "replacement",
      rewrite: "replacement",
      reword: "replacement",
      revision: "replacement",
      star: "star",
      highlight: "star",
      stellar: "star",
      shoutout: "star",
      praise: "star"
    };

    if (typeof record.type === "string") {
      const normalized = record.type.toLowerCase().trim();
      record.type = typeLookup[normalized] ?? normalized;
    }

    const categoryLookup: Record<string, string> = {
      flow: "flow",
      pacing: "flow",
      rhythm: "rhythm",
      cadence: "rhythm",
      sensory: "sensory",
      imagery: "sensory",
      punch: "punch",
      impact: "punch"
    };

    if (typeof record.category === "string") {
      const normalized = record.category.toLowerCase().trim();
      record.category = categoryLookup[normalized] ?? normalized;
    }

    if (!("original_text" in record) || typeof record.original_text !== "string") {
      if (record.original_text == null) {
        this.logWarn("Dropping edit without original_text.", { index });
        return null;
      }
      this.logWarn("Coercing original_text to string.", {
        index,
        original_text: record.original_text
      });
      record.original_text = String(record.original_text);
    }

    if (record.output == null) {
      record.output = null;
    } else if (typeof record.output !== "string") {
      if (Array.isArray(record.output)) {
        this.logWarn("Flattening array output into string.", { index });
        record.output = record.output
          .map((value) => (typeof value === "string" ? value : String(value ?? "")))
          .join("\n");
      } else if (typeof record.output === "object" && record.output !== null && "text" in record.output) {
        const value = (record.output as { text?: string }).text;
        record.output = typeof value === "string" ? value : String(value ?? "");
      } else {
        this.logWarn("Coercing non-string output to string.", { index, output: record.output });
        record.output = String(record.output);
      }
    }

    if (typeof record.line !== "number" || !Number.isInteger(record.line)) {
      const coerced = Number(record.line);
      if (Number.isFinite(coerced)) {
        this.logWarn("Coercing non-integer line value to integer.", { index, line: record.line });
        record.line = Math.max(1, Math.trunc(coerced));
      } else {
        this.logWarn("Dropping edit with invalid line number.", { index, line: record.line });
        return null;
      }
    }

    if (typeof record.line !== "number" || !Number.isInteger(record.line) || record.line < 1) {
      this.logWarn("Dropping edit with unresolved line number.", { index, line: record.line });
      return null;
    }

    if (typeof record.original_text === "string") {
      record.original_text = record.original_text.trimEnd();
    }

    if (typeof record.output === "string") {
      record.output = record.output.trimEnd();
    }

    return record;
  }

  private async openSidebarForActiveFile(): Promise<void> {
    const sourcePath = this.app.workspace.getActiveFile()?.path ?? null;
    const payload = sourcePath
      ? await this.getEditPayloadForSource(sourcePath)
      : null;

    await this.ensureSidebar({
      sourcePath,
      payload,
      selectedAnchorId: this.activeAnchorId
    });
  }

  private async refreshSidebarForActiveFile(): Promise<void> {
    if (!this.sidebarView) {
      return;
    }

    try {
      const payload = this.activeSourcePath
        ? await this.getEditPayloadForSource(this.activeSourcePath)
        : null;

      this.activePayload = payload;
      this.sidebarView.setState({
        sourcePath: this.activeSourcePath,
        payload,
        selectedAnchorId: this.activeAnchorId,
        progressLog: this.getProgressEntriesForSource(this.activeSourcePath)
      });

      this.sidebarView.updateSelection(this.activeAnchorId);
      this.refreshEditorHighlights();
    } catch (error) {
      this.logError("Failed to refresh Writers Room sidebar.", error);
    }
  }

  registerSidebar(view: WritersRoomSidebarView): void {
    this.sidebarView = view;
    view.setRequestState(this.requestInProgress);
    void this.refreshSidebarForActiveFile();
  }

  unregisterSidebar(view: WritersRoomSidebarView): void {
    if (this.sidebarView === view) {
      this.sidebarView = null;
    }
  }

  private ensureEditAnchor(edit: EditEntry, index: number): string {
    const existing =
      typeof edit.anchor === "string" && edit.anchor.trim().length > 0
        ? edit.anchor.trim()
        : "";

    if (existing) {
      return existing;
    }

    const generated = createEditAnchorId(
      {
        line: edit.line,
        type: edit.type,
        category: edit.category,
        original_text: edit.original_text,
        output: edit.output,
        anchor: null
      },
      index
    );

    (edit as { anchor: string }).anchor = generated;
    return generated;
  }

  getAnchorForEdit(edit: EditEntry, index: number): string {
    return this.ensureEditAnchor(edit, index);
  }

  private findEditByAnchor(
    payload: EditPayload | null,
    anchorId: string
  ): { edit: EditEntry; index: number } | null {
    if (!payload || !anchorId) {
      return null;
    }

    const trimmed = anchorId.trim();
    for (let index = 0; index < payload.edits.length; index++) {
      const edit = payload.edits[index];
      const candidate = this.ensureEditAnchor(edit, index);
      if (candidate === trimmed) {
        return { edit, index };
      }
    }

    const legacy = trimmed.match(/^writersroom-line-(\d+)-edit-(\d+)$/);
    if (legacy) {
      const legacyIndex = Number(legacy[2]);
      if (
        Number.isFinite(legacyIndex) &&
        legacyIndex >= 0 &&
        legacyIndex < payload.edits.length
      ) {
        const edit = payload.edits[legacyIndex];
        return { edit, index: legacyIndex };
      }
    }

    return null;
  }

  private getHighlightClasses(edit: EditEntry): string[] {
    return [
      "writersroom-highlight",
      `writersroom-type-${edit.type}`,
      `writersroom-category-${edit.category}`
    ];
  }

  private async getEditPayloadForSource(
    sourcePath: string
  ): Promise<EditPayload | null> {
    if (this.editCache.has(sourcePath)) {
      return this.editCache.get(sourcePath) ?? null;
    }

    let pending = this.editCachePromises.get(sourcePath);
    if (!pending) {
      pending = this.loadEditPayloadForSource(sourcePath);
      this.editCachePromises.set(sourcePath, pending);
    }

    const payload = await pending;
    this.editCachePromises.delete(sourcePath);
    this.editCache.set(sourcePath, payload);
    return payload;
  }

  private async loadEditPayloadForSource(
    sourcePath: string
  ): Promise<EditPayload | null> {
    const editsPath = this.getEditsPathForSource(sourcePath);
    if (!editsPath) {
      return null;
    }

    try {
      const adapter = this.getVault().adapter;
      const exists = await adapter.exists(editsPath);
      if (!exists) {
        return null;
      }

      const contents = await adapter.read(editsPath);
      const payload = parseEditPayloadFromString(contents);
      const normalized = JSON.stringify(payload, null, 2) + "\n";
      if (normalized !== contents) {
        await this.writeFile(editsPath, normalized);
      }
      await this.persistEditsForSource(sourcePath, payload, { editsPath });
      return payload;
    } catch (error) {
      console.error(
        `[WritersRoom] Failed to load edits for ${sourcePath}:`,
        error
      );
      return null;
    }
  }

  private getEditsPathForSource(sourcePath: string): string | null {
    const fileName = sourcePath.split("/").pop();
    if (!fileName) {
      return null;
    }

    const baseName = fileName.replace(/\.md$/i, "");
    const slug = this.slugify(baseName);
    if (!slug) {
      return null;
    }

    return `edits/${slug}-edits.json`;
  }

  private slugify(value: string): string {
    return value
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase();
  }

  private injectStyles(): void {
    if (typeof document === "undefined") {
      return;
    }

    // Remove existing style if present
    if (this.styleEl?.parentElement) {
      this.styleEl.parentElement.removeChild(this.styleEl);
      this.styleEl = null;
    }

    const style = document.createElement("style");
    style.setAttribute("data-writersroom-style", "true");
    style.textContent = buildWritersRoomCss(this.settings.colorScheme);
    document.head.appendChild(style);
    this.styleEl = style;
  }

  updateStyles(): void {
    // Force re-injection of styles with current color scheme
    if (this.styleEl?.parentElement) {
      this.styleEl.parentElement.removeChild(this.styleEl);
      this.styleEl = null;
    }
    this.injectStyles();
  }

  private async onVaultModify(file: TFile): Promise<void> {
    if (this.isEditsJsonPath(file.path)) {
      await this.syncPersistedEditFromJson(file.path);
      if (this.activeSourcePath) {
        void this.refreshSidebarForActiveFile();
      }
      return;
    }

    if (file.extension === "md") {
      this.editCache.delete(file.path);
      this.editCachePromises.delete(file.path);
      if (file.path === this.activeSourcePath) {
        void this.refreshSidebarForActiveFile();
      }
    }
  }

  private onVaultDelete(file: TFile): void {
    if (this.isEditsJsonPath(file.path)) {
      const sourcePath = this.findSourcePathByEditsPath(file.path);
      if (sourcePath) {
        this.removePersistedEdit(sourcePath);
        if (this.activeSourcePath === sourcePath) {
          this.activeAnchorId = null;
          this.activePayload = null;
          this.activeEditIndex = null;
          void this.refreshSidebarForActiveFile();
        }
      }
      return;
    }

    if (file.extension === "md") {
      this.removePersistedEdit(file.path);
      if (this.activeSourcePath === file.path) {
        this.activeSourcePath = null;
        this.activeAnchorId = null;
        this.activePayload = null;
        this.activeEditIndex = null;
        void this.refreshSidebarForActiveFile();
      }
    }
  }

  private onVaultRename(file: TFile, oldPath: string): void {
    if (this.isEditsJsonPath(file.path)) {
      const sourcePath = this.findSourcePathByEditsPath(oldPath);
      if (sourcePath) {
        const entry = this.persistedEdits.get(sourcePath);
        if (entry) {
          entry.editsPath = file.path;
          entry.updatedAt = Date.now();
          entry.hash = this.computePayloadHash(entry.payload);
          if (this.activeSourcePath === sourcePath) {
            this.activePayload = entry.payload;
            void this.refreshSidebarForActiveFile();
            this.refreshEditorHighlights();
          }
          this.persistStateSafely();
        }
      }
      return;
    }

    if (file.extension === "md") {
      const entry = this.persistedEdits.get(oldPath);
      if (entry) {
        this.persistedEdits.delete(oldPath);
        const newEditsPath = this.getEditsPathForSource(file.path) ?? entry.editsPath;
        this.persistedEdits.set(file.path, {
          payload: entry.payload,
          editsPath: newEditsPath,
          updatedAt: Date.now(),
          hash: this.computePayloadHash(entry.payload)
        });
        this.editCache.delete(oldPath);
        this.editCache.set(file.path, entry.payload);
        this.editCachePromises.delete(oldPath);
        this.editCachePromises.delete(file.path);
        if (this.activeSourcePath === oldPath) {
          this.activeSourcePath = file.path;
          this.activePayload = entry.payload;
        }
        this.persistStateSafely();
      } else {
        this.editCache.delete(oldPath);
        this.editCachePromises.delete(oldPath);
      }

      if (this.activeSourcePath === file.path) {
        void this.refreshSidebarForActiveFile();
      }
    }
  }

  private async syncPersistedEditFromJson(editsPath: string): Promise<void> {
    const sourcePath = this.findSourcePathByEditsPath(editsPath);
    if (!sourcePath) {
      return;
    }

    try {
      const contents = await this.getVault().adapter.read(editsPath);
      const payload = parseEditPayloadFromString(contents);
      await this.persistEditsForSource(sourcePath, payload);
    } catch (error) {
      this.logError("Failed to sync Writers Room edits from JSON file.", error, {
        editsPath
      });
    }
  }

  async loadTestFixtures() {
    const adapter = this.app.vault.adapter;
    const pluginFolder = this.manifest.dir ?? this.manifest.id;
    if (!pluginFolder) {
      this.logError("Plugin manifest does not include a directory identifier.", this.manifest);
      new Notice("Failed to load fixtures: plugin directory unknown. See console for details.");
      return;
    }

    const pluginDir = [".obsidian", "plugins", pluginFolder].join("/");
    const storyPath = `${pluginDir}/tests/three-little-pigs.md`;
    const editsPath = `${pluginDir}/tests/three-little-pigs-edits.json`;

    this.logInfo("Attempting to load demo fixtures from plugin bundle.", {
      storyPath,
      editsPath
    });

    let storyExists: boolean;
    let editsExists: boolean;
    try {
      [storyExists, editsExists] = await Promise.all([
        adapter.exists(storyPath),
        adapter.exists(editsPath)
      ]);
    } catch (error) {
      this.logError("Failed while checking for demo fixture files.", error);
      new Notice("Failed to load fixtures: could not query demo files. See console for details.");
      return;
    }

    if (!storyExists || !editsExists) {
      this.logWarn("Demo fixture files are missing.", {
        storyPath,
        storyExists,
        editsPath,
        editsExists
      });
      new Notice("Failed to load fixtures: demo files not found. See console for details.");
      return;
    }

    try {
      const [storyContent, editsRaw] = await Promise.all([
        adapter.read(storyPath),
        adapter.read(editsPath)
      ]);

      this.logInfo("Demo fixtures read successfully. Validating edit payload.");
      const parsedEdits = parseEditPayloadFromString(editsRaw);

      const storyVaultPath = "WritersRoom Tests/Three Little Pigs.md";
      const editsVaultPath = "edits/three-little-pigs-edits.json";

      this.logInfo("Ensuring target folders exist.", {
        storyVaultPath,
        editsVaultPath
      });
      await this.ensureFolder("WritersRoom Tests");
      await this.ensureFolder("edits");

      this.logInfo("Writing demo fixtures into the vault.");
      await this.writeFile(storyVaultPath, storyContent.trimEnd() + "\n");
      await this.writeFile(
        editsVaultPath,
        JSON.stringify(parsedEdits, null, 2) + "\n"
      );

      this.logInfo("Demo fixtures loaded successfully.");
      new Notice("Writers Room test fixtures loaded.");
    } catch (error) {
      this.logError("Unexpected error while loading demo fixtures.", error);
      const message =
        error instanceof ValidationError
          ? error.message
          : error instanceof Error
            ? error.message
            : "Unknown error occurred.";
      new Notice(`Failed to load fixtures: ${message}`);
    }
  }

  async loadSettings() {
    const stored = await this.loadData<unknown>();
    const { settings, edits } = this.resolveStoredData(stored);

    this.settings = settings;
    this.persistedEdits.clear();
    this.editCache.clear();
    this.editCachePromises.clear();

    for (const [sourcePath, record] of Object.entries(edits)) {
      const normalized = this.normalizePersistedEntry(sourcePath, record);
      if (normalized) {
        this.persistedEdits.set(sourcePath, normalized);
        this.editCache.set(sourcePath, normalized.payload);
      }
    }
  }

  async saveSettings() {
    await this.persistState();
    this.sidebarView?.setRequestState(this.requestInProgress);
  }
}

export function buildWritersRoomCss(colorScheme: ColorScheme = "default"): string {
  const colors = COLOR_SCHEMES[colorScheme];
  
  return `
      /* Keyframe animations */
      @keyframes writersroom-highlight-pulse {
        0% {
          transform: scale(1);
          filter: brightness(1);
        }
        50% {
          transform: scale(1.02);
          filter: brightness(1.3);
        }
        100% {
          transform: scale(1);
          filter: brightness(1);
        }
      }

      @keyframes writersroom-token-glow {
        0% {
          box-shadow: 0 3px 10px rgba(255, 230, 180, 0.25);
        }
        50% {
          box-shadow: 0 6px 20px rgba(255, 230, 180, 0.4);
        }
        100% {
          box-shadow: 0 3px 10px rgba(255, 230, 180, 0.25);
        }
      }

      @keyframes writersroom-progress-pulse {
        0% {
          opacity: 0.55;
          transform: scale(0.9);
        }
        50% {
          opacity: 1;
          transform: scale(1);
        }
        100% {
          opacity: 0.55;
          transform: scale(0.9);
        }
      }

      /* Edit mode line decoration styles - applied to entire .cm-line elements */
      .cm-line.writersroom-highlight {
        background-color: rgba(255, 235, 59, 0.15);
        cursor: pointer;
        transition: background-color 0.2s ease;
        border-left: 3px solid transparent;
        padding-left: 4px;
      }

      .cm-line.writersroom-highlight[data-wr-type="addition"] {
        background-color: ${colors.addition.bg};
        border-left-color: ${colors.addition.border};
      }

      .cm-line.writersroom-highlight[data-wr-type="replacement"] {
        background-color: ${colors.replacement.bg};
        border-left-color: ${colors.replacement.border};
      }

      .cm-line.writersroom-highlight[data-wr-type="subtraction"] {
        background-color: ${colors.subtraction.bg};
        border-left-color: ${colors.subtraction.border};
      }

      .cm-line.writersroom-highlight[data-wr-type="annotation"] {
        background-color: ${colors.annotation.bg};
        border-left-color: ${colors.annotation.border};
      }

      .cm-line.writersroom-highlight[data-wr-type="star"] {
        background-color: ${colors.star.bg};
        border-left-color: ${colors.star.border};
      }

      .cm-line.writersroom-highlight:hover {
        background-color: ${colors.hover};
      }

      .cm-line.writersroom-highlight-active {
        background-color: ${colors.active.bg};
        border-left-color: ${colors.active.border};
        border-left-width: 4px;
        padding-left: 3px;
      }

      /* Pulse animation for jump-to accessibility */
      .cm-line.writersroom-highlight-pulse {
        animation: writersroom-highlight-pulse 1s ease-out;
      }

      /* Preview mode highlights (keep existing for reading mode) */
      span.writersroom-highlight {
        background-color: rgba(255, 235, 59, 0.2);
        cursor: pointer;
        transition: background-color 0.2s ease;
        text-decoration: inherit;
        display: inline;
      }

      span.writersroom-highlight[data-wr-type="addition"] {
        background-color: ${colors.addition.bg};
      }

      span.writersroom-highlight[data-wr-type="replacement"] {
        background-color: ${colors.replacement.bg};
      }

      span.writersroom-highlight[data-wr-type="subtraction"] {
        background-color: ${colors.subtraction.bg};
      }

      span.writersroom-highlight[data-wr-type="annotation"] {
        background-color: ${colors.annotation.bg};
      }

      span.writersroom-highlight[data-wr-type="star"] {
        background-color: ${colors.star.bg};
      }

      span.writersroom-highlight:hover {
        background-color: ${colors.hover};
      }

      span.writersroom-highlight-active {
        background-color: ${colors.active.bg};
        outline: 2px solid ${colors.active.border};
        outline-offset: -2px;
      }

      /* Pulse animation for jump-to accessibility (preview mode) */
      span.writersroom-highlight-pulse {
        animation: writersroom-highlight-pulse 1s ease-out;
      }

      .writersroom-highlight-block,
      span.writersroom-highlight-block {
        display: block;
        width: 100%;
        box-sizing: border-box;
        margin: 0.1rem 0;
        padding: 0.05rem 0.1rem;
      }

      .writersroom-sidebar {
        display: flex;
        flex-direction: column;
        height: 100%;
      }

      .writersroom-sidebar-header {
        padding: 0.75rem 0.9rem 0.5rem;
        border-bottom: 1px solid var(--divider-color);
      }

      .writersroom-sidebar-header-top {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.5rem;
      }

      .writersroom-sidebar-title {
        font-weight: 600;
        margin-bottom: 0;
      }

      .writersroom-sidebar-button {
        background-color: var(--interactive-accent);
        color: var(--text-on-accent, #fff);
        border: none;
        border-radius: 4px;
        padding: 0.35rem 0.75rem;
        font-size: 0.8em;
        font-weight: 500;
        cursor: pointer;
        transition: opacity 0.2s ease;
      }

      .writersroom-sidebar-button:hover:not(:disabled) {
        opacity: 0.85;
      }

      .writersroom-sidebar-button:disabled {
        opacity: 0.55;
        cursor: default;
      }

      .writersroom-sidebar-summary {
        font-size: 0.85em;
        color: var(--text-muted);
        white-space: pre-wrap;
      }

      .writersroom-token-wrapper {
        padding: 0.45rem 0.9rem 0.2rem;
      }

      .writersroom-token-ticker {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        background: linear-gradient(115deg, rgba(255, 230, 180, 0.32), rgba(255, 255, 255, 0.05));
        border: 1px solid var(--background-modifier-border);
        border-radius: 8px;
        padding: 0.55rem 0.8rem;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
        transition: transform 0.2s ease, box-shadow 0.2s ease;
      }

      .writersroom-token-ticker:not(.is-complete) {
        animation: writersroom-token-glow 2.6s ease-in-out infinite;
      }

      .writersroom-token-ticker.is-complete {
        box-shadow: 0 6px 18px rgba(46, 204, 113, 0.28);
      }

      .writersroom-token-ticker:not(.is-complete):hover {
        transform: translateY(-1px);
        box-shadow: 0 6px 16px rgba(0, 0, 0, 0.12);
      }

      .writersroom-token-badge {
        font-family: var(--font-monospace);
        font-size: 0.82em;
        letter-spacing: 0.08em;
        padding: 0.25rem 0.45rem;
        border-radius: 4px;
        background: var(--background-modifier-form-field);
        color: var(--text-accent);
        text-transform: uppercase;
      }

      .writersroom-token-content {
        display: flex;
        flex-direction: column;
        gap: 0.15rem;
      }

      .writersroom-token-count {
        font-size: 1.7em;
        font-weight: 700;
        color: var(--text-normal);
        line-height: 1;
      }

      .writersroom-token-label {
        font-size: 0.78em;
        color: var(--text-muted);
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }

      .writersroom-sidebar-progress {
        margin: 0.65rem 0.9rem 0.2rem;
        padding: 0.55rem 0.65rem;
        border: 1px solid var(--background-modifier-border);
        border-radius: 6px;
        background: var(--background-secondary);
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
        font-size: 0.78em;
      }

      .writersroom-sidebar-progress-line {
        display: flex;
        align-items: center;
        gap: 0.55rem;
      }

      .writersroom-sidebar-progress-dot {
        width: 0.55rem;
        height: 0.55rem;
        border-radius: 50%;
        background: var(--text-muted);
        flex-shrink: 0;
      }

      .writersroom-sidebar-progress-line.is-active .writersroom-sidebar-progress-dot {
        background: var(--interactive-accent);
        animation: writersroom-progress-pulse 1.6s ease-in-out infinite;
      }

      .writersroom-sidebar-progress-line.is-success .writersroom-sidebar-progress-dot {
        background: var(--interactive-success, #2ecc71);
      }

      .writersroom-sidebar-progress-line.is-error .writersroom-sidebar-progress-dot {
        background: var(--color-red, #e74c3c);
      }

      .writersroom-sidebar-progress-text {
        flex: 1;
        color: var(--text-muted);
        line-height: 1.4;
      }

      .writersroom-sidebar-list {
        flex: 1;
        overflow-y: auto;
        padding: 0.4rem 0;
      }

      .writersroom-sidebar-item {
        display: flex;
        gap: 0.75rem;
        align-items: flex-start;
        padding: 0.55rem 0.9rem;
        border-left: 3px solid transparent;
        cursor: pointer;
        transition: background-color 0.2s ease, border-color 0.2s ease;
      }

      .writersroom-sidebar-item-icon {
        flex: 0 0 auto;
        font-size: 1.1em;
        line-height: 1;
        margin-top: 0.15rem;
      }

      .writersroom-sidebar-item-content {
        flex: 1 1 auto;
        min-width: 0;
      }

      .writersroom-sidebar-item:hover {
        background-color: var(--background-modifier-hover);
      }

      .writersroom-sidebar-item.is-selected {
        border-left-color: var(--interactive-accent);
        background-color: var(--background-modifier-hover);
      }
      
      .writersroom-sidebar-item.is-collapsed {
        opacity: 0.6;
        transition: opacity 0.2s ease;
      }
      
      .writersroom-sidebar-item.is-collapsed:hover {
        opacity: 0.8;
      }
      
      .writersroom-sidebar-item-collapsed-hint {
        font-size: 0.75em;
        color: var(--text-muted);
        font-style: italic;
        margin-top: 0.25rem;
      }

      .writersroom-sidebar-item-heading {
        font-weight: 500;
        margin-bottom: 0.25rem;
      }

      .writersroom-sidebar-item-meta {
        font-size: 0.75em;
        color: var(--text-muted);
        margin-bottom: 0.35rem;
        text-transform: capitalize;
      }

      .writersroom-sidebar-item-original {
        font-size: 0.8em;
        color: var(--text-muted);
        white-space: pre-wrap;
        margin-bottom: 0.35rem;
      }

      .writersroom-sidebar-item-snippet {
        font-size: 0.85em;
        color: var(--text-normal);
        white-space: pre-wrap;
        margin-top: 0.25rem;
      }

      .writersroom-sidebar-item-output {
        font-weight: 500;
        color: var(--text-normal);
      }

      .writersroom-sidebar-annotation-text {
        font-style: italic;
        color: var(--text-accent);
        background-color: var(--background-modifier-form-field);
        padding: 0.4rem 0.5rem;
        border-radius: 4px;
        border-left: 3px solid var(--text-accent);
      }

      .writersroom-sidebar-star-text {
        font-style: italic;
        color: var(--text-muted);
        background-color: rgba(255, 215, 0, 0.18);
        padding: 0.4rem 0.5rem;
        border-radius: 4px;
        border-left: 3px solid rgba(255, 193, 7, 0.8);
      }
      
      .writersroom-sidebar-item-annotation {
        font-size: 0.8em;
        color: var(--text-accent);
        background-color: var(--background-modifier-form-field);
        padding: 0.4rem 0.5rem;
        border-radius: 4px;
        margin-top: 0.35rem;
        border-left: 3px solid var(--text-accent);
        font-style: italic;
      }
      
      .writersroom-sidebar-item-annotation-box {
        background: linear-gradient(135deg, 
          rgba(100, 150, 255, 0.08) 0%, 
          rgba(80, 120, 255, 0.06) 100%);
        border: 1px solid rgba(100, 150, 255, 0.25);
        border-left: 3px solid rgba(100, 150, 255, 0.6);
        border-radius: 6px;
        padding: 0.6rem 0.7rem;
        margin: 0.5rem 0;
        position: relative;
      }
      
      .writersroom-sidebar-item-annotation-label {
        font-size: 0.75em;
        font-weight: 600;
        color: var(--text-accent);
        margin-bottom: 0.3rem;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        opacity: 0.9;
      }
      
      .writersroom-sidebar-item-annotation-text {
        font-size: 0.85em;
        color: var(--text-normal);
        line-height: 1.5;
        font-style: italic;
      }
      
      .writersroom-annotation-formatted {
        display: block;
      }
      
      .writersroom-annotation-list-item {
        display: flex;
        align-items: flex-start;
        margin: 0.4rem 0;
        gap: 0.5rem;
      }
      
      .writersroom-annotation-number {
        color: var(--text-accent);
        font-weight: 600;
        flex-shrink: 0;
        min-width: 1.5rem;
      }
      
      .writersroom-annotation-content {
        flex: 1;
        line-height: 1.4;
      }
      
      .writersroom-annotation-text-block {
        margin: 0.4rem 0;
        line-height: 1.4;
      }

      .writersroom-sidebar-item-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 0.35rem;
        margin-top: 0.45rem;
        pointer-events: auto;
      }

      .writersroom-sidebar-action-btn {
        background: var(--interactive-accent);
        color: var(--text-on-accent, #fff);
        border: none;
        border-radius: 4px;
        padding: 0.25rem 0.6rem;
        font-size: 0.75em;
        font-weight: 500;
        cursor: pointer;
        transition: opacity 0.2s ease;
      }

      .writersroom-sidebar-action-btn:hover:not(:disabled) {
        opacity: 0.85;
      }

      .writersroom-sidebar-action-btn:disabled {
        opacity: 0.55;
        cursor: default;
      }

      .writersroom-sidebar-empty {
        padding: 1rem 0.9rem;
        color: var(--text-muted);
      }
    `;
}

class WritersRoomSidebarView extends ItemView {
  private plugin: WritersRoomPlugin;
  private state: SidebarState = {
    sourcePath: null,
    payload: null,
    selectedAnchorId: null,
    progressLog: []
  };
  private requestButton: HTMLButtonElement | null = null;
  private isRequesting = false;
  private collapsedEdits = new Set<string>(); // Track which edits are collapsed by anchor ID

  constructor(leaf: WorkspaceLeaf, plugin: WritersRoomPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.containerEl.addClass("writersroom-sidebar");
  }

  getViewType(): string {
    return WR_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Writers Room";
  }

  getIcon(): string {
    return "pen-tool";
  }

  onOpen(): void {
    this.plugin.registerSidebar(this);
    this.render();
  }

  onClose(): void {
    this.plugin.unregisterSidebar(this);
    this.collapsedEdits.clear();
    this.state = {
      sourcePath: null,
      payload: null,
      selectedAnchorId: null,
      progressLog: []
    };
    this.requestButton = null;
  }

  setState(state: SidebarState): void {
    const sourceChanged = this.state.sourcePath !== state.sourcePath;
    
    this.state = {
      sourcePath: state.sourcePath ?? null,
      payload: state.payload ?? null,
      selectedAnchorId: state.selectedAnchorId ?? null,
      progressLog: state.progressLog
        ? state.progressLog.map((entry) => ({ ...entry }))
        : []
    };
    
    // Clear collapsed state when switching to a different document
    if (sourceChanged) {
      this.collapsedEdits.clear();
    }
    
    this.render();
  }

  setRequestState(requesting: boolean): void {
    this.isRequesting = requesting;
    this.applyRequestState();
  }

  private formatAnnotationText(text: string): HTMLElement {
    const container = createDiv({ cls: "writersroom-annotation-formatted" });
    
    // Check if text contains numbered list patterns like "1)", "2)", etc.
    const hasNumberedList = /\d+\)\s/.test(text);
    
    if (hasNumberedList) {
      // Split on numbered items while preserving the numbers
      const items = text.split(/(?=\d+\)\s)/);
      
      items.forEach((item, index) => {
        const trimmed = item.trim();
        if (!trimmed) return;
        
        // Check if this starts with a number
        const match = trimmed.match(/^(\d+)\)\s+(.+)/s);
        if (match) {
          const itemEl = container.createDiv({ cls: "writersroom-annotation-list-item" });
          itemEl.createEl("span", { cls: "writersroom-annotation-number", text: `${match[1]})` });
          itemEl.createEl("span", { cls: "writersroom-annotation-content", text: match[2].trim() });
        } else {
          // Text before the list or between items
          container.createDiv({ cls: "writersroom-annotation-text-block", text: trimmed });
        }
      });
    } else {
      // No list formatting needed, just render as text
      container.textContent = text;
    }
    
    return container;
  }

  updateSelection(anchorId: string | null): void {
    this.state.selectedAnchorId = anchorId ?? null;
    this.applySelection();
  }

  private render(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("writersroom-sidebar");

    const header = containerEl.createDiv({
      cls: "writersroom-sidebar-header"
    });

    const headerTop = header.createDiv({
      cls: "writersroom-sidebar-header-top"
    });

    const fileLabel =
      this.state.sourcePath?.split("/").pop() ?? "No document selected";
    headerTop.createEl("div", {
      cls: "writersroom-sidebar-title",
      text: fileLabel
    });

    const askButton = headerTop.createEl("button", {
      cls: "writersroom-sidebar-button",
      text: "Ask the writers"
    });

    askButton.addEventListener("click", (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (this.isRequesting || !this.state.sourcePath) {
        return;
      }
      void this.plugin.requestAiEditsForActiveFile(
        "sidebar",
        this.state.sourcePath
      );
    });

    this.requestButton = askButton;
    this.applyRequestState();

    if (this.state.payload?.summary) {
      header.createEl("div", {
        cls: "writersroom-sidebar-summary",
        text: this.state.payload.summary
      });
    }

    const edits = this.state.payload?.edits ?? [];
    const progressEntries = this.state.progressLog ?? [];
    
    // Only show progress tracker when there's an active request or recent error, and no edits available yet
    const shouldShowProgress = progressEntries.length > 0 && (this.isRequesting || edits.length === 0);
    
    if (shouldShowProgress) {
      const progressEl = containerEl.createDiv({
        cls: "writersroom-sidebar-progress"
      });
      progressEl.setAttribute("role", "status");
      progressEl.setAttribute("aria-live", "polite");
      progressEl.setAttribute("aria-busy", this.isRequesting ? "true" : "false");

      progressEntries.forEach((entry) => {
        const lineEl = progressEl.createDiv({
          cls: "writersroom-sidebar-progress-line"
        });

        if (entry.tone === "active") {
          lineEl.addClass("is-active");
        } else if (entry.tone === "success") {
          lineEl.addClass("is-success");
        } else if (entry.tone === "error") {
          lineEl.addClass("is-error");
        }

        lineEl.createDiv({ cls: "writersroom-sidebar-progress-dot" });

        lineEl.createDiv({
          cls: "writersroom-sidebar-progress-text",
          text: entry.message
        });
      });
    }

    const listEl = containerEl.createDiv({
      cls: "writersroom-sidebar-list"
    });
    if (!this.state.payload || edits.length === 0) {
      listEl.createEl("div", {
        cls: "writersroom-sidebar-empty",
        text: this.state.sourcePath
          ? "No edits available for this note."
          : "Open a note to view Writers Room edits."
      });
      return;
    }

    const previewText = (value: string): string =>
      value.length > 160 ? `${value.slice(0, 157).trimEnd()}…` : value;

    edits.forEach((edit, index) => {
      const anchorId = this.plugin.getAnchorForEdit(edit, index);
      const isSelected = this.state.selectedAnchorId === anchorId;
      const isCollapsed = this.collapsedEdits.has(anchorId);
      
      const itemEl = listEl.createDiv({
        cls: "writersroom-sidebar-item",
        attr: { "data-anchor-id": anchorId }
      });

      if (isSelected) {
        itemEl.addClass("is-selected");
      }
      
      if (isCollapsed) {
        itemEl.addClass("is-collapsed");
      }

      itemEl.createDiv({
        cls: "writersroom-sidebar-item-icon",
        text: this.getEditTypeIcon(edit.type)
      });

      const contentEl = itemEl.createDiv({
        cls: "writersroom-sidebar-item-content"
      });

      contentEl.createEl("div", {
        cls: "writersroom-sidebar-item-heading",
        text: edit.type
      });

      // If collapsed, only show heading and stop
      if (isCollapsed) {
        contentEl.createEl("div", {
          cls: "writersroom-sidebar-item-collapsed-hint",
          text: "Click to expand"
        });
      } else {
        // Full expanded view
        contentEl.createEl("div", {
          cls: "writersroom-sidebar-item-meta",
          text: `Category: ${edit.category}`
        });

        const outputText = typeof edit.output === "string" ? edit.output : null;

        if (edit.type === "annotation") {
          // For annotations, show the original text as context
          contentEl.createEl("div", {
            cls: "writersroom-sidebar-item-original",
            text: previewText(edit.original_text)
          });
          // Show the annotation comment in full (never truncate editorial comments)
          if (outputText) {
            const formattedAnnotation = this.formatAnnotationText(outputText);
            formattedAnnotation.addClass("writersroom-sidebar-item-snippet");
            formattedAnnotation.addClass("writersroom-sidebar-annotation-text");
            contentEl.appendChild(formattedAnnotation);
          } else {
            // Show placeholder for legacy annotations without output text
            contentEl.createEl("div", {
              cls: "writersroom-sidebar-item-snippet writersroom-sidebar-annotation-text",
              text: "(Annotation comment not available - request new edits to see comments)"
            });
          }
        } else if (edit.type === "star") {
          contentEl.createEl("div", {
            cls: "writersroom-sidebar-item-original",
            text: previewText(edit.original_text)
          });

          // Show star comments in full (never truncate editorial praise)
          if (outputText) {
            const formattedStar = this.formatAnnotationText(outputText);
            formattedStar.addClass("writersroom-sidebar-item-snippet");
            formattedStar.addClass("writersroom-sidebar-star-text");
            contentEl.appendChild(formattedStar);
          }
        } else {
          // For additions, replacements, and subtractions, show original snippet
          contentEl.createEl("div", {
            cls: "writersroom-sidebar-item-original",
            text: previewText(edit.original_text)
          });
          
          // If this edit has a merged annotation, show it prominently BEFORE the output
          if (edit.annotation) {
            const annotationBox = contentEl.createEl("div", {
              cls: "writersroom-sidebar-item-annotation-box"
            });
            annotationBox.createEl("div", {
              cls: "writersroom-sidebar-item-annotation-label",
              text: "💭 Writer's note:"
            });
            const formattedAnnotation = this.formatAnnotationText(edit.annotation);
            formattedAnnotation.addClass("writersroom-sidebar-item-annotation-text");
            annotationBox.appendChild(formattedAnnotation);
          }
          
          // Show the suggested revision if available
          if (outputText) {
            contentEl.createEl("div", {
              cls: "writersroom-sidebar-item-snippet writersroom-sidebar-item-output",
              text: previewText(outputText)
            });
          }
        }

        const actions: SidebarAction[] = [];
        const sourcePath = this.state.sourcePath;

        if (sourcePath) {
          const canApply =
            edit.type === "subtraction" ||
            ((edit.type === "addition" || edit.type === "replacement") &&
              typeof edit.output === "string" &&
              edit.output.length > 0);

          if (canApply) {
            actions.push({
              label: "Apply",
              title: "Apply this suggestion to the note",
              onClick: () =>
                this.plugin.applySidebarEdit(sourcePath, anchorId)
            });
          }

          actions.push({
            label: "Jump to",
            title: "Scroll note to this edit",
            onClick: () =>
              this.plugin.jumpToAnchor(sourcePath, anchorId)
          });

          actions.push({
            label: "Resolve",
            title: "Remove this edit from the list",
            onClick: () =>
              this.plugin.resolveSidebarEdit(sourcePath, anchorId)
          });
        }

        this.renderActions(contentEl, actions);
      }

      itemEl.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!this.state.sourcePath) {
          return;
        }
        
        // When selecting an edit, collapse all others
        if (this.state.selectedAnchorId !== anchorId) {
          // Collapse all edits except the one being selected
          edits.forEach((e, i) => {
            const eAnchorId = this.plugin.getAnchorForEdit(e, i);
            if (eAnchorId !== anchorId) {
              this.collapsedEdits.add(eAnchorId);
            } else {
              this.collapsedEdits.delete(eAnchorId);
            }
          });
        } else {
          // If clicking the already-selected item, expand all
          this.collapsedEdits.clear();
        }
        
        // handleSidebarSelection will trigger a re-render via setState
        void this.plugin.handleSidebarSelection(
          this.state.sourcePath,
          anchorId
        );
      });
    });

    this.applySelection();
  }

  private getEditTypeIcon(type: EditEntry["type"]): string {
    switch (type) {
      case "addition":
        return "➕";
      case "replacement":
        return "🔁";
      case "star":
        return "⭐";
      case "subtraction":
        return "❌";
      case "annotation":
        return "💬";
      default:
        return "?";
    }
  }

  private renderActions(container: HTMLElement, actions: SidebarAction[]): void {
    if (!actions.length) {
      return;
    }

    const actionsEl = container.createDiv({
      cls: "writersroom-sidebar-item-actions"
    });
    actionsEl.style.pointerEvents = "auto";

    for (const action of actions) {
      const buttonEl = actionsEl.createEl("button", {
        cls: "writersroom-sidebar-action-btn",
        text: action.label
      });

      if (action.title) {
        buttonEl.setAttribute("title", action.title);
      }

      if (action.disabled) {
        buttonEl.setAttribute("disabled", "true");
      }

      buttonEl.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (action.disabled) {
          return;
        }
        const result = action.onClick();
        if (result instanceof Promise) {
          void result.catch((error) => {
            console.warn("[WritersRoom] Sidebar action rejected.", error);
          });
        }
      });
    }
  }

  private applySelection(): void {
    const items = this.containerEl.querySelectorAll<HTMLElement>(
      ".writersroom-sidebar-item"
    );

    items.forEach((el) => el.classList.remove("is-selected"));

    if (!this.state.selectedAnchorId) {
      return;
    }

    const activeItem = this.containerEl.querySelector<HTMLElement>(
      `.writersroom-sidebar-item[data-anchor-id="${this.state.selectedAnchorId}"]`
    );

    if (activeItem) {
      activeItem.classList.add("is-selected");
      activeItem.scrollIntoView({ block: "nearest" });
    }
  }

  private applyRequestState(): void {
    if (!this.requestButton) {
      return;
    }

    const apiKeyMissing = !this.plugin.hasResolvedApiKey();
    const disabled = this.isRequesting || !this.state.sourcePath || apiKeyMissing;
    if (disabled) {
      this.requestButton.setAttribute("disabled", "true");
    } else {
      this.requestButton.removeAttribute("disabled");
    }

    this.requestButton.removeAttribute("title");
    if (apiKeyMissing) {
      this.requestButton.setAttribute(
        "title",
        "Add your OpenAI API key in settings or set the WRITERSROOM_API_KEY environment variable to enable this action."
      );
    } else if (this.plugin.isUsingEnvironmentApiKey()) {
      this.requestButton.setAttribute(
        "title",
        "Using key from WRITERSROOM_API_KEY environment variable."
      );
    }

    this.requestButton.textContent = this.isRequesting
      ? "Asking…"
      : "Ask the writers";

    this.requestButton.setAttribute(
      "aria-busy",
      this.isRequesting ? "true" : "false"
    );

    const progressEl = this.containerEl.querySelector<HTMLElement>(".writersroom-sidebar-progress");
    if (progressEl) {
      progressEl.setAttribute("aria-busy", this.isRequesting ? "true" : "false");
    }
  }
}

class WritersRoomSettingTab extends PluginSettingTab {
  plugin: WritersRoomPlugin;

  constructor(app: App, plugin: WritersRoomPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Writers Room Settings" });

    const envOverrideActive = this.plugin.isUsingEnvironmentApiKey();
    const apiKeyDescription =
      "Store the secret key used when calling the OpenAI API. Set the WRITERSROOM_API_KEY environment variable to override this value." +
      (envOverrideActive ? " (Environment override detected.)" : "");

    new Setting(containerEl)
      .setName("OpenAI API Key")
      .setDesc(apiKeyDescription)
      .addText((text: TextComponent) => {
        text
          .setPlaceholder("sk-...")
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (value: string) => {
            this.plugin.settings.apiKey = value.trim();
            await this.plugin.saveSettings();
          });
        text.inputEl.type = "password";
      });

    const colorSchemeDropdownSetting = new Setting(containerEl)
      .setName("Highlight Color Scheme")
      .setDesc(
        "Choose a color scheme for edit highlights. Different schemes improve visibility and accessibility for different visual needs."
      );

    // Create dropdown manually since addDropdown is not in type definitions
    const colorDropdown = document.createElement("select");
    colorDropdown.classList.add("dropdown");
    colorDropdown.style.width = "100%";
    
    const schemes: Array<{ value: ColorScheme; label: string }> = [
      { value: "default", label: "Default" },
      { value: "high-contrast", label: "High Contrast" },
      { value: "colorblind-friendly", label: "Colorblind Friendly" },
      { value: "muted", label: "Muted (Low Eye Strain)" },
      { value: "warm", label: "Warm Tones" },
      { value: "cool", label: "Cool Tones" }
    ];

    schemes.forEach(({ value, label }) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      if (value === this.plugin.settings.colorScheme) {
        option.selected = true;
      }
      colorDropdown.appendChild(option);
    });

    colorDropdown.addEventListener("change", async () => {
      this.plugin.settings.colorScheme = colorDropdown.value as ColorScheme;
      await this.plugin.saveSettings();
      this.plugin.updateStyles();
      this.plugin.refreshEditorHighlights();
    });

    (colorSchemeDropdownSetting as any).controlEl.appendChild(colorDropdown);

    const audibleFeedbackSetting = new Setting(containerEl)
      .setName("Audible Feedback")
      .setDesc(
        "Play short audio cues (audicons) when performing actions like selecting, applying, or dismissing edits. Helpful for screen reader users and those who prefer audio feedback."
      );

    const audibleToggle = document.createElement("input");
    audibleToggle.type = "checkbox";
    audibleToggle.checked = this.plugin.settings.audibleFeedback;
    audibleToggle.addEventListener("change", async () => {
      this.plugin.settings.audibleFeedback = audibleToggle.checked;
      this.plugin.audiconPlayer?.setEnabled(audibleToggle.checked);
      await this.plugin.saveSettings();
    });
    (audibleFeedbackSetting as any).controlEl.appendChild(audibleToggle);

    new Setting(containerEl)
      .setName("Load demo data")
      .setDesc("Create sample story and edits in your vault for testing.")
      .addButton((button) => {
        button.setButtonText("Load test");
        button.setCta();
        button.onClick(async () => {
          await this.plugin.loadTestFixtures();
        });
      });
  }
}
