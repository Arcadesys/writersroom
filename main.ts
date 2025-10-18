import {
  App,
  MarkdownPostProcessorContext,
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
  parseEditPayload,
  parseEditPayloadFromString
} from "./editParser";

const WR_VIEW_TYPE = "writersroom-sidebar";

// Settings interface and defaults (moved here for facet)
interface WritersRoomSettings {
  apiKey: string;
}

const DEFAULT_SETTINGS: WritersRoomSettings = {
  apiKey: ""
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

// ViewPlugin for viewport-optimized rendering
class WritersRoomViewPlugin implements CMPluginValue {
  decorations: CMDecorationSet;

  constructor(view: CMEditorView) {
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

// Create the ViewPlugin with decorations spec
const writersRoomViewPlugin = ViewPlugin.fromClass(WritersRoomViewPlugin, {
  decorations: (plugin) => plugin.decorations
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

  for (const spec of sorted) {
    if (!(Number.isFinite(spec.from) && Number.isFinite(spec.to))) {
      console.warn("[WritersRoom] Skipping invalid decoration range", spec);
      continue;
    }

    // Use Decoration.mark() for inline text highlighting
    // This highlights the actual text content with better visual clarity
    const decoration = Decoration.mark({
      class: spec.className,
      attributes: spec.attributes
    });
    
    console.info("[WritersRoom] Creating mark decoration from", spec.from, "to", spec.to, "with class", spec.className);
    
    // Mark decorations need both from and to positions
    builder.add(spec.from, spec.to, decoration);
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

interface SidebarState {
  sourcePath: string | null;
  payload: EditPayload | null;
  selectedAnchorId?: string | null;
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
        apiKey: typeof settingsRaw.apiKey === "string" ? settingsRaw.apiKey : DEFAULT_SETTINGS.apiKey
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

  private removePersistedEdit(sourcePath: string): void {
    const removed = this.persistedEdits.delete(sourcePath);
    this.editCache.delete(sourcePath);
    this.editCachePromises.delete(sourcePath);
    if (removed) {
      this.persistStateSafely();
    }
    if (this.activeSourcePath === sourcePath) {
      this.activePayload = null;
      this.activeEditIndex = null;
      this.activeAnchorId = null;
      this.refreshEditorHighlights();
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

    // Register click handler for both preview and edit mode highlights
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

  onunload(): void {
    if (this.styleEl?.parentElement) {
      this.styleEl.parentElement.removeChild(this.styleEl);
    }
    this.styleEl = null;
    this.clearHighlightRetry();
    this.clearEditorHighlights();
    this.clearEditCache();
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
      anchorId: this.buildAnchorId(edit.line, index)
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
          wrSource: context.sourcePath
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

  private refreshEditorHighlights(): void {
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

    const totalLines = doc.lines;

    payload.edits.forEach((edit, index) => {
      const anchorId = this.buildAnchorId(edit.line, index);
      const classList = [...this.getHighlightClasses(edit)];
      if (activeAnchorId === anchorId) {
        classList.push("writersroom-highlight-active");
      }

      // Validate line number
      const lineNumber = Math.max(1, edit.line);
      if (lineNumber > totalLines) {
        this.logWarn(
          `Edit references line ${lineNumber} but document only has ${totalLines} lines. Skipping.`
        );
        return;
      }

      let lineInfo: { from: number; to: number; text: string } | null = null;
      
      try {
        const docLine = doc.line(lineNumber);
        if (docLine) {
          lineInfo = {
            from: docLine.from,
            to: docLine.to,
            text: docLine.text || ""
          };
        }
      } catch (error) {
        this.logWarn(`Failed to get line ${lineNumber} for highlight`, error);
        return;
      }

      // Skip empty lines - mark decorations require non-zero ranges with content
      if (!lineInfo || lineInfo.from >= lineInfo.to || lineInfo.text.trim().length === 0) {
        this.logInfo(
          `Skipping line ${lineNumber} - empty or no content to highlight`
        );
        return;
      }

      const attributes: Record<string, string> = {
        "data-writersroom-anchor": anchorId,
        "data-wr-source": sourcePath,
        "data-wr-index": String(index),
        "data-wr-line": String(edit.line),
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

      specs.push({
        from: lineInfo.from,
        to: lineInfo.to,
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
      
      // Clear stale edits automatically
      // This happens when the file has been modified significantly since edits were saved
      if (this.activeSourcePath === sourcePath) {
        this.activePayload = null;
      }
      this.persistedEdits.delete(sourcePath);
      void this.saveData({
        settings: this.settings,
        edits: Object.fromEntries(this.persistedEdits)
      });
      void this.refreshSidebarForActiveFile();
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

  private async handleAnchorClick(
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

    const anchorInfo = this.parseAnchorId(anchorId);
    if (!anchorInfo) {
      this.logWarn("Ignoring resolve request with invalid anchor identifier.", {
        anchorId
      });
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

    if (anchorInfo.index < 0 || anchorInfo.index >= payload.edits.length) {
      this.logWarn("Resolve requested for edit outside payload bounds.", {
        index: anchorInfo.index,
        total: payload.edits.length
      });
      return;
    }

    const updatedEdits = payload.edits.slice();
    updatedEdits.splice(anchorInfo.index, 1);

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
        const activeInfo = this.parseAnchorId(this.activeAnchorId);
        if (activeInfo && activeInfo.index > anchorInfo.index) {
          const adjustedIndex = activeInfo.index - 1;
          const nextEdit = updatedPayload.edits[adjustedIndex];
          if (nextEdit) {
            this.activeAnchorId = this.buildAnchorId(
              nextEdit.line,
              adjustedIndex
            );
            this.activeEditIndex = adjustedIndex;
          } else {
            this.activeAnchorId = null;
            this.activeEditIndex = null;
          }
        }
      }

      this.activePayload = updatedPayload;
      this.setActiveHighlight(this.activeAnchorId, {
        scroll: false,
        editIndex: this.activeEditIndex
      });
    }

    await this.refreshSidebarForActiveFile();
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

    const anchorInfo = this.parseAnchorId(anchorId);
    const editIndex = anchorInfo?.index ?? null;
    this.activeEditIndex = editIndex;

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
      editIndex
    });
  }

  private async ensureSidebar(
    state: SidebarState
  ): Promise<WritersRoomSidebarView> {
    const view = await this.ensureSidebarView();
    view.setState(state);
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
      shouldScroll
    );

    if (!primaryTarget) {
      if (attempt < maxAttempts && typeof window !== "undefined") {
        this.highlightRetryHandle = window.setTimeout(() => {
          this.highlightRetryHandle = null;
          this.setActiveHighlight(anchorId, {
            scroll: options?.scroll,
            attempts: attempt + 1,
            editIndex: effectiveIndex
          });
        }, 180);
      }
      return;
    }

    for (const element of anchorElements) {
      element.classList.add("writersroom-highlight-active");
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
            editIndex: effectiveIndex
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
    shouldScroll: boolean
  ): void {
    const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
    const anchorInfo = this.parseAnchorId(anchorId);
    let resolvedIndex = editIndex;
    if (resolvedIndex === null && anchorInfo?.index != null) {
      resolvedIndex = anchorInfo.index;
    }

    const payload = this.activePayload;
    const resolvedEdit =
      resolvedIndex !== null && payload
        ? payload.edits[resolvedIndex] ?? null
        : null;

    let lineNumber = Number(target?.dataset?.wrLine);
    if (!Number.isFinite(lineNumber) && resolvedEdit) {
      lineNumber = resolvedEdit.line;
    }
    if (!Number.isFinite(lineNumber) && anchorInfo?.line) {
      lineNumber = anchorInfo.line;
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
    this.sidebarView?.setRequestState(requesting);
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

    this.setRequestState(true);
    const loadingNotice = new Notice("Asking the Writers…", 0);

    try {
      const systemPrompt = `You are "editor", a line-level prose editor specializing in precise sentence improvements for fiction writing. Your mission is to make *small, targeted* enhancements to rhythm, flow, sensory detail, and impact, while avoiding full rewrites or changing the original meaning.

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
          ]
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenAI request failed (${response.status}): ${errorText.slice(0, 500)}`);
      }

      const parsed = await response.json() as {
        choices?: Array<{
          message?: { content?: string };
        }>;
      };

      const completion = parsed.choices?.[0]?.message?.content ?? "";

      if (typeof completion !== "string" || completion.trim().length === 0) {
        throw new Error("OpenAI response did not include text content.");
      }

      const jsonText = this.extractJsonFromResponse(completion);
      if (!jsonText) {
        throw new Error("OpenAI response did not include a JSON payload.");
      }

  const payload = this.parseAiPayload(jsonText);

      await this.ensureFolder("edits");
      await this.writeFile(editsPath, JSON.stringify(payload, null, 2) + "\n");

      await this.persistEditsForSource(file.path, payload, { editsPath });
      this.editCachePromises.delete(file.path);
      this.activeSourcePath = file.path;

      this.logInfo("Writers Room edits generated.", {
        file: file.path,
        edits: payload.edits.length
      });

      if (payload.edits.length > 0) {
        const firstAnchor = this.buildAnchorId(payload.edits[0].line, 0);
        await this.selectEdit(file.path, firstAnchor, origin);
        new Notice(`Writers provided ${payload.edits.length} edit${payload.edits.length === 1 ? "" : "s"}.`);
      } else {
        await this.refreshSidebarForActiveFile();
        new Notice("Writers responded without specific edits.");
      }
    } catch (error) {
      this.logError("AI edit request failed.", error);
      const message = error instanceof Error ? error.message : "Unknown error occurred.";
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
        selectedAnchorId: this.activeAnchorId
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

  buildAnchorId(line: number, index: number): string {
    return `writersroom-line-${line}-edit-${index}`;
  }

  private parseAnchorId(anchorId: string): { line: number; index: number } | null {
    const match = anchorId.match(/^writersroom-line-(\d+)-edit-(\d+)$/);
    if (!match) {
      return null;
    }

    const line = Number(match[1]);
    const index = Number(match[2]);

    if (!Number.isFinite(line) || !Number.isFinite(index)) {
      return null;
    }

    return { line, index };
  }

  private injectStyles(): void {
    if (this.styleEl || typeof document === "undefined") {
      return;
    }

    const style = document.createElement("style");
    style.setAttribute("data-writersroom-style", "true");
    style.textContent = buildWritersRoomCss();
    document.head.appendChild(style);
    this.styleEl = style;
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

export function buildWritersRoomCss(): string {
  return `
      /* Inline mark decoration styles for edit mode */
      .writersroom-highlight {
        background-color: rgba(255, 235, 59, 0.15);
        cursor: pointer;
        transition: background-color 0.2s ease;
        border-radius: 2px;
        padding: 1px 2px;
      }

      .writersroom-highlight[data-wr-type="addition"] {
        background-color: rgba(76, 175, 80, 0.15);
      }

      .writersroom-highlight[data-wr-type="replacement"] {
        background-color: rgba(255, 152, 0, 0.15);
      }

      .writersroom-highlight[data-wr-type="subtraction"] {
        background-color: rgba(244, 67, 54, 0.12);
      }

      .writersroom-highlight[data-wr-type="annotation"] {
        background-color: rgba(63, 81, 181, 0.12);
      }

      .writersroom-highlight[data-wr-type="star"] {
        background-color: rgba(255, 215, 0, 0.18);
      }

      .writersroom-highlight:hover {
        background-color: rgba(255, 193, 7, 0.25);
      }

      .writersroom-highlight-active {
        background-color: rgba(255, 193, 7, 0.3);
        border-left: 3px solid rgba(255, 193, 7, 0.8);
        padding-left: 4px;
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
        background-color: rgba(76, 175, 80, 0.2);
      }

      span.writersroom-highlight[data-wr-type="replacement"] {
        background-color: rgba(255, 152, 0, 0.2);
      }

      span.writersroom-highlight[data-wr-type="subtraction"] {
        background-color: rgba(244, 67, 54, 0.15);
      }

      span.writersroom-highlight[data-wr-type="annotation"] {
        background-color: rgba(63, 81, 181, 0.15);
      }

      span.writersroom-highlight[data-wr-type="star"] {
        background-color: rgba(255, 215, 0, 0.25);
      }

      .writersroom-highlight:hover,
      span.writersroom-highlight:hover {
        background-color: rgba(255, 193, 7, 0.3);
      }

      .writersroom-highlight-active,
      span.writersroom-highlight-active {
        background-color: rgba(255, 193, 7, 0.35);
        outline: 2px solid rgba(255, 193, 7, 0.6);
        outline-offset: -2px;
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
    selectedAnchorId: null
  };
  private requestButton: HTMLButtonElement | null = null;
  private isRequesting = false;

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
    this.state = {
      sourcePath: null,
      payload: null,
      selectedAnchorId: null
    };
    this.requestButton = null;
  }

  setState(state: SidebarState): void {
    this.state = {
      sourcePath: state.sourcePath ?? null,
      payload: state.payload ?? null,
      selectedAnchorId: state.selectedAnchorId ?? null
    };
    this.render();
  }

  setRequestState(requesting: boolean): void {
    this.isRequesting = requesting;
    this.applyRequestState();
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

    const listEl = containerEl.createDiv({
      cls: "writersroom-sidebar-list"
    });

    const edits = this.state.payload?.edits ?? [];
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
      const anchorId = this.plugin.buildAnchorId(edit.line, index);
      const itemEl = listEl.createDiv({
        cls: "writersroom-sidebar-item",
        attr: { "data-anchor-id": anchorId }
      });

      if (this.state.selectedAnchorId === anchorId) {
        itemEl.addClass("is-selected");
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
        text: `Line ${edit.line} · ${edit.type}`
      });

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
        // Show the annotation comment if available
        if (outputText) {
          contentEl.createEl("div", {
            cls: "writersroom-sidebar-item-snippet writersroom-sidebar-annotation-text",
            text: previewText(outputText)
          });
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

        if (outputText) {
          contentEl.createEl("div", {
            cls: "writersroom-sidebar-item-snippet writersroom-sidebar-star-text",
            text: previewText(outputText)
          });
        }
      } else {
        // For additions, replacements, and subtractions, show original snippet
        contentEl.createEl("div", {
          cls: "writersroom-sidebar-item-original",
          text: previewText(edit.original_text)
        });
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

      itemEl.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!this.state.sourcePath) {
          return;
        }
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
