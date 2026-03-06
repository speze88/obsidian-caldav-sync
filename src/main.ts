import { Notice, Plugin, TFile } from "obsidian";
import {
  CalDAVSyncSettings,
  CalDAVSyncSettingTab,
  DEFAULT_SETTINGS,
} from "./settings";
import { CalDAVClient, CalDAVAuthError } from "./caldav-client";
import { SyncManager } from "./sync-manager";

export default class CalDAVSyncPlugin extends Plugin {
  settings: CalDAVSyncSettings = DEFAULT_SETTINGS;
  private client: CalDAVClient = new CalDAVClient();
  private syncManager: SyncManager | null = null;
  // Re-entrancy guard: tracks files currently being written by the plugin
  private writingFiles = new Set<string>();

  async onload() {
    await this.loadSettings();
    await this.initializeClient();

    this.addSettingTab(new CalDAVSyncSettingTab(this.app, this));

    this.addRibbonIcon("refresh-cw", "Sync CalDAV Tasks", async () => {
      await this.syncAll();
    });

    this.addCommand({
      id: "sync-caldav-tasks",
      name: "Sync all CalDAV tasks",
      callback: async () => {
        await this.syncAll();
      },
    });

    this.app.workspace.onLayoutReady(async () => {
      await this.syncAll();
    });

    this.registerEvent(
      this.app.vault.on("modify", async (file) => {
        if (!(file instanceof TFile)) return;
        if (file.extension !== "md") return;

        // Skip if this modify was triggered by our own write
        if (this.writingFiles.has(file.path)) return;

        if (!this.syncManager) return;

        try {
          this.writingFiles.add(file.path);
          const modified = await this.syncManager.syncFile(file, this.app);
          if (!modified) {
            this.writingFiles.delete(file.path);
          } else {
            // vault.modify will trigger another modify event; the guard above will skip it.
            // We clear the guard after a short delay to allow the event to fire and be skipped.
            setTimeout(() => {
              this.writingFiles.delete(file.path);
            }, 500);
          }
        } catch (err) {
          this.writingFiles.delete(file.path);
          console.error("[CalDAV Sync] Unexpected error:", err);
          new Notice(`CalDAV Sync: unexpected error — ${err}`, 5000);
        }
      })
    );
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
    await this.initializeClient();
  }

  private async syncAll() {
    if (!this.syncManager) {
      new Notice("CalDAV Sync: not connected to server.", 4000);
      return;
    }

    const files = this.app.vault.getMarkdownFiles();
    let synced = 0;

    for (const file of files) {
      const content = await this.app.vault.read(file);
      if (!content.includes(this.settings.syncTag)) continue;

      try {
        this.writingFiles.add(file.path);
        const modified = await this.syncManager.syncFile(file, this.app);
        if (modified) {
          synced++;
          setTimeout(() => this.writingFiles.delete(file.path), 500);
        } else {
          this.writingFiles.delete(file.path);
        }
      } catch (err) {
        this.writingFiles.delete(file.path);
        console.error("[CalDAV Sync] Error syncing file:", file.path, err);
      }
    }

    new Notice(`CalDAV Sync: sync complete${synced > 0 ? ` (${synced} file${synced > 1 ? "s" : ""} updated)` : ""}`, 4000);
  }

  private async initializeClient() {
    try {
      await this.client.initialize(this.settings);
      if (this.client.isInitialized()) {
        this.syncManager = new SyncManager(this.client, this.settings);
      } else {
        this.syncManager = null;
      }
    } catch (err) {
      this.syncManager = null;
      if (err instanceof CalDAVAuthError) {
        new Notice(`CalDAV Sync: authentication failed. Check your credentials.`, 8000);
      } else {
        new Notice(`CalDAV Sync: could not connect to server — ${err}`, 8000);
      }
    }
  }
}
