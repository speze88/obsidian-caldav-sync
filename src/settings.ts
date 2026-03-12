import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type CalDAVSyncPlugin from "./main";
import { CalDAVClient, CalDAVAuthError } from "./caldav-client";

export interface CalDAVCalendarSettings {
  id: string;
  name: string;
  username: string;
  password: string;
  serverUrl: string;
  syncTag: string;
}

export interface CalDAVSyncSettings {
  calendars: CalDAVCalendarSettings[];
  username?: string;
  password?: string;
  serverUrl?: string;
  syncTag?: string;
}

export const DEFAULT_SETTINGS: CalDAVSyncSettings = {
  calendars: [],
};

export function createCalendarSettings(): CalDAVCalendarSettings {
  return {
    id: `calendar-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: "",
    username: "",
    password: "",
    serverUrl: "",
    syncTag: "#caldav",
  };
}

export function normalizeSettings(data: unknown): CalDAVSyncSettings {
  const loaded = (data ?? {}) as Partial<CalDAVSyncSettings>;
  const legacyUsername = loaded.username ?? "";
  const legacyPassword = loaded.password ?? "";
  const calendars = Array.isArray(loaded.calendars)
    ? loaded.calendars
        .filter((calendar): calendar is Partial<CalDAVCalendarSettings> => {
          return Boolean(calendar) && typeof calendar === "object";
        })
        .map((calendar) => ({
          id: calendar.id ?? createCalendarSettings().id,
          name: calendar.name ?? "",
          username: calendar.username ?? legacyUsername,
          password: calendar.password ?? legacyPassword,
          serverUrl: calendar.serverUrl ?? "",
          syncTag: (calendar.syncTag ?? "#caldav").startsWith("#")
            ? (calendar.syncTag ?? "#caldav")
            : `#${calendar.syncTag ?? "caldav"}`,
        }))
    : [];

  if (calendars.length === 0 && loaded.serverUrl) {
    calendars.push({
      id: createCalendarSettings().id,
      name: "Standard",
      username: legacyUsername,
      password: legacyPassword,
      serverUrl: loaded.serverUrl,
      syncTag: (loaded.syncTag ?? "#caldav").startsWith("#")
        ? (loaded.syncTag ?? "#caldav")
        : `#${loaded.syncTag ?? "caldav"}`,
    });
  }

  return {
    calendars,
  };
}

function normalizeSyncTag(value: string): string {
  return value.startsWith("#") ? value : `#${value}`;
}

function findDuplicateSyncTags(calendars: CalDAVCalendarSettings[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const calendar of calendars) {
    if (!calendar.syncTag) continue;
    if (seen.has(calendar.syncTag)) {
      duplicates.add(calendar.syncTag);
      continue;
    }
    seen.add(calendar.syncTag);
  }

  return [...duplicates];
}

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
      text: "Credentials are stored in plaintext in your vault's plugin data folder. Do not sync your vault with untrusted or public cloud services.",
      cls: "caldav-sync-warning",
    });

    new Setting(containerEl).setName("Calendars").setHeading();
    containerEl.createEl("p", {
      text: "Each calendar has its own URL, credentials, and sync tag. Tasks are synced to the calendar whose tag appears on the task line.",
    });

    const duplicateTags = findDuplicateSyncTags(this.plugin.settings.calendars);
    if (duplicateTags.length > 0) {
      containerEl.createEl("p", {
        text: `Duplicate sync tags detected: ${duplicateTags.join(", ")}. Only the first calendar for each tag will be used until this is fixed.`,
        cls: "caldav-sync-warning",
      });
    }

    this.plugin.settings.calendars.forEach((calendar, index) => {
      new Setting(containerEl)
        .setName(calendar.name || `Calendar ${index + 1}`)
        .setHeading();

      new Setting(containerEl)
        .setName("Name")
        .setDesc("Optional label for this calendar")
        .addText((text) =>
          text.setValue(calendar.name).onChange(async (value) => {
            calendar.name = value;
            await this.plugin.saveSettings();
          })
        );

      new Setting(containerEl)
        .setName("Server URL")
        .setDesc(
          "Full CalDAV calendar URL, e.g. https://mail.example.com/SOGo/dav/user@domain/Calendar/personal/"
        )
        .addText((text) =>
          text
            .setPlaceholder("https://mail.example.com/SOGo/dav/user/Calendar/personal/")
            .setValue(calendar.serverUrl)
            .onChange(async (value) => {
              calendar.serverUrl = value;
              await this.plugin.saveSettings();
            })
        );

      new Setting(containerEl)
        .setName("Username")
        .setDesc("Username for this calendar, typically your full email address")
        .addText((text) =>
          text
            .setPlaceholder("Email address")
            .setValue(calendar.username)
            .onChange(async (value) => {
              calendar.username = value;
              await this.plugin.saveSettings();
            })
        );

      new Setting(containerEl)
        .setName("Password")
        .setDesc("Password for this calendar")
        .addText((text) => {
          text
            .setPlaceholder("Password")
            .setValue(calendar.password)
            .onChange(async (value) => {
              calendar.password = value;
              await this.plugin.saveSettings();
            });
          text.inputEl.type = "password";
        });

      new Setting(containerEl)
        .setName("Tag")
        .setDesc("Tasks with this tag are synced to this calendar")
        .addText((text) =>
          text
            .setPlaceholder("#caldav")
            .setValue(calendar.syncTag)
            .onChange(async (value) => {
              const normalizedTag = normalizeSyncTag(value);
              const duplicate = this.plugin.settings.calendars.find(
                (entry) => entry.id !== calendar.id && entry.syncTag === normalizedTag
              );

              if (duplicate) {
                text.inputEl.value = calendar.syncTag;
                new Notice(
                  `Sync tag "${normalizedTag}" is already used by "${duplicate.name || "another calendar"}". Tags must be unique.`,
                  6000
                );
                return;
              }

              calendar.syncTag = normalizedTag;
              await this.plugin.saveSettings();
            })
        );

      new Setting(containerEl)
        .setName("Connection")
        .setDesc("Check this calendar URL with this calendar's credentials.")
        .addButton((btn) =>
          btn.setButtonText("Test connection").onClick(async () => {
            btn.setButtonText("Testing…");
            btn.setDisabled(true);
            const result = await this.testCalendarConnection(calendar);
            btn.setDisabled(false);
            if (result === "ok") {
              btn.setButtonText("Connected");
              new Notice("Connected successfully.", 4000);
            } else if (result === "auth") {
              btn.setButtonText("Test connection");
              new Notice("Authentication failed. Check your credentials.", 6000);
            } else {
              btn.setButtonText("Test connection");
              new Notice("Could not connect to the server.", 6000);
            }
          })
        )
        .addExtraButton((btn) =>
          btn.setIcon("trash").setTooltip("Remove calendar").onClick(async () => {
            this.plugin.settings.calendars = this.plugin.settings.calendars.filter(
              (entry) => entry.id !== calendar.id
            );
            await this.plugin.saveSettings();
            this.display();
          })
        );
    });

    new Setting(containerEl)
      .setName("Add calendar")
      .setDesc("Create another tag-to-calendar mapping")
      .addButton((btn) =>
        btn.setButtonText("Add calendar").onClick(async () => {
          this.plugin.settings.calendars.push(createCalendarSettings());
          await this.plugin.saveSettings();
          this.display();
        })
      );
  }

  private async testCalendarConnection(
    calendar: CalDAVCalendarSettings
  ): Promise<"ok" | "auth" | "error"> {
    try {
      const client = new CalDAVClient();
      await client.initialize({
        serverUrl: calendar.serverUrl,
        username: calendar.username,
        password: calendar.password,
      });
      return client.isInitialized() ? "ok" : "error";
    } catch (err) {
      if (err instanceof CalDAVAuthError) return "auth";
      return "error";
    }
  }
}
