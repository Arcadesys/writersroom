declare module "obsidian" {
  export interface App {
    vault: Vault;
  }

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
  }

  export interface Command {
    id: string;
    name: string;
    callback: () => void;
  }

  export class Notice {
    constructor(message: string, timeout?: number);
  }

  export class Plugin {
    app: App;
    addCommand(command: Command): void;
    addSettingTab(tab: PluginSettingTab): void;
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
