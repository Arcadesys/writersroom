declare module "obsidian" {
  export interface App {
    vault: Vault;
    workspace: Workspace;
  }

  export interface Workspace {
    on(event: string, callback: (file: TFile | null) => void): EventRef;
    getActiveFile(): TFile | null;
    openLinkText?(path: string, sourcePath: string, newLeaf?: boolean): Promise<void>;
    getLeavesOfType(viewType: string): WorkspaceLeaf[];
    getRightLeaf(replace?: boolean): WorkspaceLeaf | null;
    revealLeaf(leaf: WorkspaceLeaf): Promise<void>;
    getActiveViewOfType<T extends ItemView>(view: new (...args: any[]) => T): T | null;
  }

  export class WorkspaceLeaf {
    view: ItemView;
    setViewState(state: { type: string; active?: boolean }): Promise<void>;
  }

  export class ItemView {
    containerEl: HTMLElement;
    constructor(leaf: WorkspaceLeaf);
    getViewType(): string;
    getDisplayText(): string;
  }

  export class MarkdownView extends ItemView {
    editor: Editor;
    file: TFile;
    previewMode: MarkdownPreviewRenderer;
  }

  export class MarkdownPreviewRenderer {
    containerEl: HTMLElement;
  }

  export interface Editor {
    setCursor(pos: EditorPosition): void;
    scrollIntoView(range: { from: EditorPosition; to: EditorPosition }, center?: boolean): void;
  }

  export interface EditorPosition {
    line: number;
    ch: number;
  }

  export interface MarkdownSectionInformation {
    lineStart: number;
    lineEnd: number;
  }

  export interface MarkdownPostProcessorContext {
    sourcePath: string;
    getSectionInfo(element: HTMLElement): MarkdownSectionInformation | null;
  }

  export interface EventRef {}

  interface SettingContainerEl extends HTMLElement {
    empty(): void;
    createEl<K extends keyof HTMLElementTagNameMap>(
      tag: K,
      attrs?: { text?: string }
    ): HTMLElementTagNameMap[K];
  }

  export class TAbstractFile {}

  export class TFile extends TAbstractFile {
    path: string;
    basename: string;
    extension: string;
  }

  export class TFolder extends TAbstractFile {
    path: string;
    name: string;
  }

  export interface DataAdapter {
    exists(path: string): Promise<boolean>;
    read(path: string): Promise<string>;
    write(path: string, data: string): Promise<void>;
    mkdir(path: string): Promise<void>;
    getBasePath?(): string;
  }

  export interface Vault {
    adapter: DataAdapter;
    getAbstractFileByPath(path: string): TAbstractFile | null;
    create(path: string, data: string): Promise<TFile>;
    createFolder(path: string): Promise<TFolder>;
    modify(file: TFile, data: string): Promise<void>;
    read(file: TFile): Promise<string>;
    on(event: string, callback: (file: TAbstractFile) => void): EventRef;
  }

  export interface Command {
    id: string;
    name: string;
    callback?: () => void;
    checkCallback?: (checking: boolean) => boolean;
  }

  export interface PluginManifest {
    dir?: string;
    id: string;
    name: string;
    version: string;
  }

  export class Notice {
    constructor(message: string, timeout?: number);
    hide(): void;
  }

  export class Plugin {
    app: App;
    manifest: PluginManifest;
    addCommand(command: Command): void;
    addSettingTab(tab: PluginSettingTab): void;
    registerView(type: string, callback: (leaf: WorkspaceLeaf) => ItemView): void;
    registerEvent(eventRef: EventRef): void;
    registerMarkdownPostProcessor(
      processor: (element: HTMLElement, context: MarkdownPostProcessorContext) => void | Promise<void>
    ): void;
    loadData<T>(): Promise<T | undefined>;
    saveData(data: unknown): Promise<void>;
  }

  export class PluginSettingTab {
    app: App;
    containerEl: SettingContainerEl;
    constructor(app: App, plugin: Plugin);
    display(): void;
  }

  export class Setting {
    constructor(containerEl: SettingContainerEl);
    setName(name: string): Setting;
    setDesc(description: string | DocumentFragment): Setting;
    addText(cb: (component: TextComponent) => Setting | void): Setting;
    addButton(cb: (component: ButtonComponent) => Setting | void): Setting;
  }

  export class ButtonComponent {
    setButtonText(text: string): ButtonComponent;
    setCta(): ButtonComponent;
    onClick(callback: (evt: MouseEvent) => void | Promise<void>): ButtonComponent;
  }

  export class TextComponent {
    inputEl: HTMLInputElement;
    setPlaceholder(placeholder: string): TextComponent;
    setValue(value: string): TextComponent;
    onChange(callback: (value: string) => void | Promise<void>): TextComponent;
  }
}
