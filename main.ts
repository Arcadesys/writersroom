import {
  App,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TextComponent,
  TAbstractFile,
  TFile,
  Vault
} from "obsidian";
import { readFile } from "fs/promises";
import { join } from "path";

import { parseEditPayloadFromString } from "./editParser";

interface WritersRoomSettings {
  apiKey: string;
}

const DEFAULT_SETTINGS: WritersRoomSettings = {
  apiKey: ""
};

export default class WritersRoomPlugin extends Plugin {
  settings: WritersRoomSettings = DEFAULT_SETTINGS;

  async onload() {
    await this.loadSettings();

    this.addSettingTab(new WritersRoomSettingTab(this.app, this));

    this.addCommand({
      id: "writers-room-test-command",
      name: "Test Writers Room setup",
      callback: () => {
        new Notice("Writers Room plugin initialized.");
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

  async loadTestFixtures() {
    const testsDir = join(__dirname, "tests");
    const storyPath = join(testsDir, "three-little-pigs.md");
    const editsPath = join(testsDir, "three-little-pigs-edits.json");

    try {
      const [storyContent, editsRaw] = await Promise.all([
        readFile(storyPath, "utf8"),
        readFile(editsPath, "utf8")
      ]);

      const parsedEdits = parseEditPayloadFromString(editsRaw);

      const storyVaultPath = "WritersRoom Tests/Three Little Pigs.md";
      const editsVaultPath = "edits/three-little-pigs-edits.json";

      await this.ensureFolder("WritersRoom Tests");
      await this.ensureFolder("edits");

      await this.writeFile(storyVaultPath, storyContent.trimEnd() + "\n");
      await this.writeFile(
        editsVaultPath,
        JSON.stringify(parsedEdits, null, 2) + "\n"
      );

      new Notice("Writers Room test fixtures loaded.");
    } catch (error) {
      console.error(error);
      const message =
        error instanceof Error ? error.message : "Unknown error occurred.";
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
