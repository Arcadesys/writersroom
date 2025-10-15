declare module "obsidian" {
  export interface App {}

  interface SettingContainerEl extends HTMLElement {
    empty(): void;
    createEl<K extends keyof HTMLElementTagNameMap>(
      tag: K,
      attrs?: { text?: string }
    ): HTMLElementTagNameMap[K];
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
  }

  export class TextComponent {
    inputEl: HTMLInputElement;
    setPlaceholder(placeholder: string): TextComponent;
    setValue(value: string): TextComponent;
    onChange(callback: (value: string) => void | Promise<void>): TextComponent;
  }
}
