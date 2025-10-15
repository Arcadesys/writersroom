import {
  App,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TextComponent
} from "obsidian";

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
  }
}
