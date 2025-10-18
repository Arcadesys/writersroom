export class App {
  vault = {
    adapter: {
      exists: async () => false,
      read: async () => "",
      write: async () => {},
      mkdir: async () => {}
    },
    getAbstractFileByPath: () => null,
    create: async () => ({}),
    createFolder: async () => ({}),
    modify: async () => {},
    read: async () => "",
    on: () => ({})
  };

  workspace = {
    on: () => ({}) as unknown,
    getActiveFile: () => null,
    openLinkText: async () => {},
    getLeavesOfType: () => [] as unknown[],
    getRightLeaf: () => null,
    revealLeaf: async () => {},
    setActiveLeaf: () => {},
    getActiveViewOfType: () => null
  };
}

export class ItemView {
  containerEl: any = {
    addClass: () => {},
    empty: () => {},
    createDiv: () => ({
      addClass: () => {},
      createDiv: () => ({}),
      createEl: () => ({}),
      setAttribute: () => {}
    }),
    createEl: () => ({})
  };

  constructor(public leaf: WorkspaceLeaf) {
    this.leaf = leaf;
  }

  getViewType(): string {
    return "";
  }

  getDisplayText(): string {
    return "";
  }
}

export class MarkdownView extends ItemView {
  editor: any = {};
  previewMode: any = { containerEl: null };
  file: TFile = new TFile();
}

export class WorkspaceLeaf {}

export class MarkdownPreviewRenderer {
  containerEl: any = null;
}

export class TAbstractFile {}

export class TFile extends TAbstractFile {
  path = "";
  basename = "";
  extension = "md";
}

export class Vault {
  adapter = {
    exists: async () => false,
    read: async () => "",
    write: async () => {},
    mkdir: async () => {}
  };

  getAbstractFileByPath = () => null;
  create = async () => new TFile();
  createFolder = async () => ({});
  modify = async () => {};
  read = async () => "";
  on = () => ({});
}

export class Notice {
  constructor(_message: string, _timeout?: number) {}
  hide(): void {}
}

export class PluginSettingTab {
  containerEl: any = {
    empty: () => {},
    createEl: () => ({})
  };
  constructor(public app: App, public plugin: Plugin) {
    this.app = app;
    this.plugin = plugin;
  }
  display(): void {}
}

export class Setting {
  constructor(_containerEl: any) {}
  setName() {
    return this;
  }
  setDesc() {
    return this;
  }
  addText() {
    return this;
  }
  addButton() {
    return this;
  }
}

export class TextComponent {
  inputEl = { type: "" };
  setPlaceholder() {
    return this;
  }
  setValue() {
    return this;
  }
  onChange() {
    return this;
  }
}

export class Plugin {
  app: App;
  manifest = { id: "writersroom-test", name: "Writers Room Test", version: "0.0.0" };

  constructor() {
    this.app = new App();
  }

  addCommand(): void {}
  addSettingTab(): void {}
  registerView(): void {}
  registerEvent(): void {}
  registerMarkdownPostProcessor(): void {}
  registerEditorExtension(): void {}
  loadData(): Promise<unknown> {
    return Promise.resolve(undefined);
  }
  saveData(): Promise<void> {
    return Promise.resolve();
  }
}

export class Workspace {}

export class MarkdownPostProcessorContext {}

export class EventRef {}

export class Editor {
  setCursor(): void {}
  scrollIntoView(): void {}
  getLine(): string {
    return "";
  }
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
}
