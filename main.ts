import {
  App,
  MarkdownPostProcessorContext,
  ItemView,
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

interface SidebarState {
  sourcePath: string | null;
  payload: EditPayload | null;
  selectedAnchorId?: string | null;
}

type SelectionOrigin = "highlight" | "sidebar" | "external";

interface HighlightActivationOptions {
  scroll?: boolean;
  attempts?: number;
}

interface WritersRoomSettings {
  apiKey: string;
}

const DEFAULT_SETTINGS: WritersRoomSettings = {
  apiKey: ""
};

export default class WritersRoomPlugin extends Plugin {
  settings: WritersRoomSettings = DEFAULT_SETTINGS;
  private editCache = new Map<string, EditPayload | null>();
  private editCachePromises = new Map<string, Promise<EditPayload | null>>();
  private styleEl: HTMLStyleElement | null = null;
  private sidebarView: WritersRoomSidebarView | null = null;
  private activeSourcePath: string | null = null;
  private activeAnchorId: string | null = null;
  private highlightRetryHandle: number | null = null;

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

  private logInfo(message: string, ...details: unknown[]): void {
    this.log("info", message, ...details);
  }

  private logWarn(message: string, ...details: unknown[]): void {
    this.log("warn", message, ...details);
  }

  private logError(message: string, ...details: unknown[]): void {
    this.log("error", message, ...details);
  }

  async onload() {
    await this.loadSettings();

    this.activeSourcePath = this.app.workspace.getActiveFile()?.path ?? null;

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
          this.handleFileChange(file);
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (file instanceof TFile) {
          this.handleFileChange(file);
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("rename", (file) => {
        if (file instanceof TFile) {
          this.handleFileChange(file);
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
      if (trimmed.length > 0 && trimmed !== item.edit.original_text) {
        targets.push(trimmed);
      }

      let anchorEl: HTMLElement | null = null;
      for (const needle of targets) {
        if (!needle) {
          continue;
        }
        anchorEl = this.wrapMatchInElement(element, needle, options);
        if (anchorEl) {
          break;
        }
      }

      if (anchorEl) {
        anchorEl.dataset.wrSource = context.sourcePath;
        anchorEl.dataset.wrIndex = String(item.index);
        anchorEl.dataset.wrLine = String(item.edit.line);
        anchorEl.dataset.wrType = item.edit.type;
        anchorEl.dataset.wrCategory = item.edit.category;
        anchorEl.dataset.wrAnchor = item.anchorId;
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
        console.debug(
          `[WritersRoom] Unable to highlight text for edit at line ${
            item.edit.line
          } in ${context.sourcePath}.`
        );
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

    if (options.id && element.querySelector(`#${options.id}`)) {
      return element.querySelector(`#${options.id}`) as HTMLElement;
    }

    const doc = element.ownerDocument ?? document;
    const walker = doc.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let currentNode = walker.nextNode();

    while (currentNode) {
      const textNode = currentNode as Text;
      const value = textNode.nodeValue;

      if (value) {
        const matchIndex = value.indexOf(needle);
        if (matchIndex !== -1) {
          const target =
            matchIndex === 0 ? textNode : textNode.splitText(matchIndex);
          target.splitText(needle.length);

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

          const parent = target.parentNode;
          if (parent) {
            parent.replaceChild(wrapper, target);
            wrapper.appendChild(target);
            return wrapper;
          }

          return null;
        }
      }

      currentNode = walker.nextNode();
    }

    return null;
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

    const view = await this.ensureSidebar({
      sourcePath,
      payload,
      selectedAnchorId: anchorId
    });

    view.updateSelection(anchorId);

    const shouldScroll = origin !== "highlight";
    this.setActiveHighlight(anchorId, {
      scroll: shouldScroll,
      attempts: 0
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

    if (!target) {
      const attempts = options?.attempts ?? 0;
      if (attempts < 5 && typeof window !== "undefined") {
        this.highlightRetryHandle = window.setTimeout(() => {
          this.setActiveHighlight(anchorId, {
            scroll: options?.scroll,
            attempts: attempts + 1
          });
        }, 180);
      }
      return;
    }

    target.classList.add("writersroom-highlight-active");

    if (options?.scroll) {
      target.scrollIntoView({ behavior: "smooth", block: "center" });
    }

    try {
      target.focus({ preventScroll: !options?.scroll });
    } catch {
      target.focus();
    }
  }

  private clearHighlightRetry(): void {
    if (this.highlightRetryHandle !== null && typeof window !== "undefined") {
      window.clearTimeout(this.highlightRetryHandle);
      this.highlightRetryHandle = null;
    }
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
      return parseEditPayloadFromString(contents);
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

      .writersroom-sidebar {
        display: flex;
        flex-direction: column;
        height: 100%;
      }

      .writersroom-sidebar-header {
        padding: 0.75rem 0.9rem 0.5rem;
        border-bottom: 1px solid var(--divider-color);
      }

      .writersroom-sidebar-title {
        font-weight: 600;
        margin-bottom: 0.35rem;
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
        padding: 0.55rem 0.9rem;
        border-left: 3px solid transparent;
        cursor: pointer;
        transition: background-color 0.2s ease, border-color 0.2s ease;
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

      .writersroom-sidebar-item-snippet {
        font-size: 0.85em;
        color: var(--text-normal);
        white-space: pre-wrap;
      }

      .writersroom-sidebar-empty {
        padding: 1rem 0.9rem;
        color: var(--text-muted);
      }
    `;

    document.head.appendChild(style);
    this.styleEl = style;
  }

  private handleFileChange(file: TFile): void {
    if (file.extension === "json" && file.path.startsWith("edits/")) {
      this.clearEditCache();
      void this.refreshSidebarForActiveFile();
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

  private clearEditCache(): void {
    this.editCache.clear();
    this.editCachePromises.clear();
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
    const storedData = await this.loadData<WritersRoomSettings>();
    this.settings = { ...DEFAULT_SETTINGS, ...storedData };
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

class WritersRoomSidebarView extends ItemView {
  private plugin: WritersRoomPlugin;
  private state: SidebarState = {
    sourcePath: null,
    payload: null,
    selectedAnchorId: null
  };

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
  }

  setState(state: SidebarState): void {
    this.state = {
      sourcePath: state.sourcePath ?? null,
      payload: state.payload ?? null,
      selectedAnchorId: state.selectedAnchorId ?? null
    };
    this.render();
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

    const fileLabel =
      this.state.sourcePath?.split("/").pop() ?? "No document selected";
    header.createEl("div", {
      cls: "writersroom-sidebar-title",
      text: fileLabel
    });

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

    edits.forEach((edit, index) => {
      const anchorId = this.plugin.buildAnchorId(edit.line, index);
      const itemEl = listEl.createDiv({
        cls: "writersroom-sidebar-item",
        attr: { "data-anchor-id": anchorId }
      });

      if (this.state.selectedAnchorId === anchorId) {
        itemEl.addClass("is-selected");
      }

      itemEl.createEl("div", {
        cls: "writersroom-sidebar-item-heading",
        text: `Line ${edit.line} · ${edit.type}`
      });

      itemEl.createEl("div", {
        cls: "writersroom-sidebar-item-meta",
        text: `Category: ${edit.category}`
      });

      const snippetSource = edit.output ?? edit.original_text;
      const snippet =
        snippetSource.length > 160
          ? `${snippetSource.slice(0, 157).trimEnd()}…`
          : snippetSource;

      itemEl.createEl("div", {
        cls: "writersroom-sidebar-item-snippet",
        text: snippet
      });

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

    new Setting(containerEl)
      .setName("OpenAI API Key")
      .setDesc("Store the secret key used when calling the OpenAI API.")
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
