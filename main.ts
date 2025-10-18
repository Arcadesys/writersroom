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

import {
  EditEntry,
  EditPayload,
  ValidationError,
  parseEditPayload,
  parseEditPayloadFromString
} from "./editParser";

const WR_VIEW_TYPE = "writersroom-sidebar";

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

interface WritersRoomSettings {
  apiKey: string;
}

const DEFAULT_SETTINGS: WritersRoomSettings = {
  apiKey: ""
};

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
    this.registerHighlighting();
    this.registerVaultListeners();
    this.registerWorkspaceListeners();

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

    const target = document.querySelector(
      `[data-writersroom-anchor="${anchorId}"]`
    ) as HTMLElement | null;

    const effectiveIndex =
      options?.editIndex ??
      this.activeEditIndex ??
      null;

    if (!target) {
      if (options?.scroll) {
        this.scrollPreviewAnchor(anchorId, null, true);
      }
      const attempts = options?.attempts ?? 0;
      if (attempts < 5 && typeof window !== "undefined") {
        this.highlightRetryHandle = window.setTimeout(() => {
          this.setActiveHighlight(anchorId, {
            scroll: options?.scroll,
            attempts: attempts + 1,
            editIndex: effectiveIndex
          });
        }, 180);
      }
      return;
    }

    const indexFromDataset = Number(target.dataset.wrIndex);
    const resolvedIndex = Number.isFinite(indexFromDataset)
      ? indexFromDataset
      : effectiveIndex;

    target.classList.add("writersroom-highlight-active");

    const smoothScroll = options?.scroll ?? false;
    this.scrollEditorsToAnchor(
      target,
      anchorId,
      resolvedIndex ?? null,
      smoothScroll
    );

    if (options?.scroll) {
      target.scrollIntoView({ behavior: "smooth", block: "center" });
    }

    try {
      target.focus({ preventScroll: !options?.scroll });
    } catch {
      target.focus();
    }
  }

  private scrollEditorsToAnchor(
    target: HTMLElement,
    anchorId: string,
    editIndex: number | null,
    smooth: boolean
  ): void {
    const editorView = this.app.workspace.getActiveViewOfType(MarkdownView);
    let lineNumber = Number(target.dataset.wrLine);

    if (!Number.isFinite(lineNumber) && editIndex !== null && this.activePayload) {
      const edit = this.activePayload.edits[editIndex];
      if (edit) {
        lineNumber = edit.line;
      }
    }

    if (editorView && Number.isFinite(lineNumber)) {
      const leaf = editorView.leaf;
      if (leaf && typeof this.app.workspace.setActiveLeaf === "function") {
        this.app.workspace.setActiveLeaf(leaf, { focus: true });
      }

      const editorAny = editorView.editor as unknown as {
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

      const edit =
        editIndex !== null && this.activePayload
          ? this.activePayload.edits[editIndex] ?? null
          : null;

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

      addCandidate(target.dataset.wrMatch);
      addCandidate(target.textContent ?? "");
      addCandidate(target.dataset.wrOriginal);
      addCandidate(target.dataset.wrOutput);
      if (edit) {
        addCandidate(edit.original_text);
        if (typeof edit.output === "string") {
          addCandidate(edit.output);
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
        editorView.editor.setCursor(position);

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
                cmView.scrollIntoView(pos, { y: "center" });
              }
              cmView.dispatch?.({ selection: { anchor: pos } } as unknown);
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

    this.scrollPreviewAnchor(anchorId, target, smooth);
  }

  private scrollPreviewAnchor(
    anchorId: string,
    existingTarget?: HTMLElement | null,
    smooth = true
  ): void {
    if (!anchorId || typeof document === "undefined") {
      return;
    }

    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    const previewContainer = activeView?.previewMode?.containerEl ?? null;
    const selector = `[data-writersroom-anchor="${anchorId}"]`;

    let target = existingTarget ?? null;

    if (!target && previewContainer) {
      target = (previewContainer.querySelector(selector) as HTMLElement | null) ??
        (previewContainer.querySelector(`#${anchorId}`) as HTMLElement | null);
    }

    if (!target) {
      target = (document.querySelector(selector) as HTMLElement | null) ??
        (document.getElementById(anchorId) as HTMLElement | null);
    }

    if (!target) {
      return;
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

      return;
    }

    if (typeof target.scrollIntoView === "function") {
      target.scrollIntoView({ behavior, block: "center" });
    }
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
      const instructions =
        "You are the Writers Room editorial board. Review the markdown document provided and return a JSON object with a 'summary' and an 'edits' array. " +
        "Each edit must include agent 'editor', a 1-based line number, type of 'addition', 'subtraction', or 'annotation', category of 'flow', 'rhythm', 'sensory', or 'punch', the original_text from the source, and output which may be a revised string or null for annotations. " +
        "Respond with valid JSON only. Do not include commentary outside the JSON object.";

      const userPrompt = `Title: ${file.basename}\n\nMarkdown:\n\n${noteContents}`;

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
          model: "gpt-4o-mini",
          temperature: 0.3,
          messages: [
            { role: "system", content: instructions },
            { role: "user", content: userPrompt }
          ]
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenAI request failed (${response.status}): ${errorText.slice(0, 500)}`);
      }

      const json = await response.json() as {
        choices?: Array<{
          message?: { content?: string | Array<{ text?: string }> };
        }>;
      };

      let completion = json.choices?.[0]?.message?.content ?? "";

      if (Array.isArray(completion)) {
        completion = completion
          .map((part: unknown) => {
            if (typeof part === "string") {
              return part;
            }
            if (part && typeof part === "object" && "text" in part) {
              const value = (part as { text?: string }).text;
              return typeof value === "string" ? value : "";
            }
            return "";
          })
          .join("\n");
      }

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
      note: "annotation"
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
    style.textContent = `
      .writersroom-highlight {
        background-color: rgba(255, 235, 59, 0.35);
        border-bottom: 2px solid rgba(255, 193, 7, 0.6);
        border-radius: 2px;
        padding: 0 0.1em;
        cursor: pointer;
        transition: box-shadow 0.2s ease, background-color 0.2s ease;
      }

      .writersroom-highlight[data-wr-type="addition"] {
        background-color: rgba(76, 175, 80, 0.25);
        border-bottom-color: rgba(76, 175, 80, 0.55);
      }

      .writersroom-highlight[data-wr-type="subtraction"] {
        background-color: rgba(244, 67, 54, 0.2);
        border-bottom-color: rgba(244, 67, 54, 0.5);
      }

      .writersroom-highlight[data-wr-type="annotation"] {
        background-color: rgba(63, 81, 181, 0.2);
        border-bottom-color: rgba(63, 81, 181, 0.45);
      }

      .writersroom-highlight:focus {
        outline: none;
        box-shadow: 0 0 0 2px rgba(255, 193, 7, 0.45);
      }

      .writersroom-highlight-active {
        box-shadow: 0 0 0 2px rgba(255, 193, 7, 0.75),
          inset 0 0 0 1px rgba(255, 255, 255, 0.6);
      }

      .writersroom-highlight-block {
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

      contentEl.createEl("div", {
        cls: "writersroom-sidebar-item-original",
        text: previewText(edit.original_text)
      });

      if (edit.output) {
        contentEl.createEl("div", {
          cls: "writersroom-sidebar-item-snippet",
          text: previewText(edit.output)
        });
      }

      const actions: SidebarAction[] = [];
      if (this.state.sourcePath) {
        actions.push({
          label: "Jump to",
          title: "Scroll note to this edit",
          onClick: () =>
            this.plugin.jumpToAnchor(this.state.sourcePath as string, anchorId)
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
