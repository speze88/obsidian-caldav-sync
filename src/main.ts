import { Notice, Plugin, TFile } from "obsidian";
import { CalDAVSyncSettings, CalDAVSyncSettingTab, normalizeSettings } from "./settings";
import { SyncManager } from "./sync-manager";

export default class CalDAVSyncPlugin extends Plugin {
  settings!: CalDAVSyncSettings;
  private syncManager: SyncManager = new SyncManager({ calendars: [] });
  // Re-entrancy guard: tracks files currently being written by the plugin
  private writingFiles = new Set<string>();

  async onload() {
    await this.loadSettings();

    this.addSettingTab(new CalDAVSyncSettingTab(this.app, this));

    this.addRibbonIcon("refresh-cw", "Sync tasks", async () => {
      await this.syncAll();
    });

    this.addCommand({
      id: "sync-caldav-tasks",
      name: "Sync all tasks",
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
    this.settings = normalizeSettings(await this.loadData());
    this.syncManager = new SyncManager(this.settings);
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.syncManager = new SyncManager(this.settings);
  }

  private async syncAll() {
    const syncTags = this.syncManager.getSyncTags();
    if (syncTags.length === 0) {
      new Notice("CalDAV: no calendars configured.", 4000);
      return;
    }

    const files = this.app.vault.getMarkdownFiles();
    let synced = 0;

    for (const file of files) {
      const content = await this.app.vault.read(file);
      if (!syncTags.some((tag) => content.includes(tag))) continue;

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
}
