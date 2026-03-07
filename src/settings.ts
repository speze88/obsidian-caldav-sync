import { App, PluginSettingTab, Setting } from "obsidian";
import type CalDAVSyncPlugin from "./main";

export interface CalDAVSyncSettings {
  serverUrl: string;
  username: string;
  password: string;
  syncTag: string;
}

export const DEFAULT_SETTINGS: CalDAVSyncSettings = {
  serverUrl: "",
  username: "",
  password: "",
  syncTag: "#caldav",
};

export class CalDAVSyncSettingTab extends PluginSettingTab {
  plugin: CalDAVSyncPlugin;

  constructor(app: App, plugin: CalDAVSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("p", {
      text: "⚠ Credentials are stored in plaintext in your vault's plugin data folder. Do not sync your vault with untrusted or public cloud services.",
      cls: "caldav-sync-warning",
    });

    new Setting(containerEl)
      .setName("Server URL")
      .setDesc(
        "Full CalDAV calendar URL, e.g. https://mail.example.com/SOGo/dav/user@domain/Calendar/personal/"
      )
      .addText((text) =>
        text
          .setPlaceholder("https://mail.example.com/SOGo/dav/user/Calendar/personal/")
          .setValue(this.plugin.settings.serverUrl)
          .onChange(async (value) => {
            this.plugin.settings.serverUrl = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Username")
      .setDesc("Your CalDAV username (typically your full email address for mailcow)")
      .addText((text) =>
        text
          .setPlaceholder("user@example.com")
          .setValue(this.plugin.settings.username)
          .onChange(async (value) => {
            this.plugin.settings.username = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Password")
      .setDesc("Your CalDAV password")
      .addText((text) => {
        text
          .setPlaceholder("password")
          .setValue(this.plugin.settings.password)
          .onChange(async (value) => {
            this.plugin.settings.password = value;
            await this.plugin.saveSettings();
          });
        text.inputEl.type = "password";
      });

    new Setting(containerEl)
      .setName("Sync tag")
      .setDesc("Tag used to identify tasks for CalDAV sync")
      .addText((text) =>
        text
          .setPlaceholder("#caldav")
          .setValue(this.plugin.settings.syncTag)
          .onChange(async (value) => {
            this.plugin.settings.syncTag = value.startsWith("#") ? value : `#${value}`;
            await this.plugin.saveSettings();
          })
      );
  }
}
