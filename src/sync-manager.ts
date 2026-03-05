import { App, Notice, TFile } from "obsidian";
import { v4 as uuidv4 } from "uuid";
import {
  CalDAVClient,
  CalDAVAuthError,
  CalDAVConflictError,
  CalDAVNetworkError,
} from "./caldav-client";
import {
  parseTasks,
  buildLineWithUid,
  buildLineWithCompletion,
  applyLinePatch,
} from "./task-parser";
import type { CalDAVSyncSettings } from "./settings";

export class SyncManager {
  private client: CalDAVClient;
  private settings: CalDAVSyncSettings;

  constructor(client: CalDAVClient, settings: CalDAVSyncSettings) {
    this.client = client;
    this.settings = settings;
  }

  /**
   * Sync all tagged tasks in a file.
   * Returns true if the file content was modified (patch applied).
   */
  async syncFile(file: TFile, app: App): Promise<boolean> {
    if (!this.client.isInitialized()) return false;

    const content = await app.vault.read(file);
    const tasks = parseTasks(content, this.settings.syncTag);

    if (tasks.length === 0) return false;

    const patches = new Map<number, string>();
    const errors: string[] = [];

    for (const task of tasks) {
      try {
        if (!task.uid) {
          // New task: create on server and write UID back
          const uid = uuidv4();
          await this.client.createVTodo({
            uid,
            summary: task.title,
            completed: task.completed,
          });
          patches.set(task.lineIndex, buildLineWithUid(task, uid, this.settings.syncTag));
        } else {
          // Existing task: fetch remote state and reconcile
          let remote = await this.client.fetchVTodo(task.uid);

          if (!remote) {
            // Remote 404: log warning, leave local unchanged
            console.warn(`[CalDAV Sync] VTODO not found on server: ${task.uid}`);
            continue;
          }

          let patchLine: string | null = null;

          // Conflict resolution rules:
          // 1. Local [x], remote NEEDS-ACTION → local wins, push COMPLETED
          if (task.completed && !remote.data.completed) {
            const updated = { ...remote.data, completed: true };
            await this.updateWithRetry(updated, remote.etag);
          }
          // 2. Local [ ], remote COMPLETED → remote wins, pull [x]
          else if (!task.completed && remote.data.completed) {
            patchLine = buildLineWithCompletion(task, true, this.settings.syncTag);
          }

          // 3. Title differs → remote wins, pull title update
          if (task.title !== remote.data.summary) {
            // Re-fetch if we just updated (etag may have changed)
            if (task.completed && !remote.data.completed) {
              remote = await this.client.fetchVTodo(task.uid);
              if (!remote) continue;
            }
            const updatedTask = { ...task, title: remote.data.summary };
            const completed = patchLine
              ? true // already applying completion from remote
              : task.completed;
            patchLine = buildLineWithCompletion(
              updatedTask,
              completed,
              this.settings.syncTag,
              task.uid
            );
          }

          // Also push title change if local title differs and remote was NOT the one that changed it
          // (handled above — remote always wins on title in v1)

          if (patchLine !== null) {
            patches.set(task.lineIndex, patchLine);
          }
        }
      } catch (err) {
        if (err instanceof CalDAVAuthError) {
          errors.push(`Auth error: ${err.message}`);
          break; // No point continuing if auth is broken
        } else if (err instanceof CalDAVNetworkError) {
          errors.push(`Network error syncing "${task.title}": ${err.message}`);
        } else {
          errors.push(`Error syncing "${task.title}": ${err}`);
        }
      }
    }

    if (errors.length > 0) {
      new Notice(`CalDAV Sync errors:\n${errors.join("\n")}`, 8000);
    }

    if (patches.size === 0) return false;

    const newContent = applyLinePatch(content, patches);
    await app.vault.modify(file, newContent);
    return true;
  }

  private async updateWithRetry(
    data: Parameters<CalDAVClient["updateVTodo"]>[0],
    etag: string
  ): Promise<void> {
    try {
      await this.client.updateVTodo(data, etag);
    } catch (err) {
      if (err instanceof CalDAVConflictError) {
        // 412: re-fetch ETag and retry once
        const remote = await this.client.fetchVTodo(data.uid);
        if (!remote) return;
        await this.client.updateVTodo(data, remote.etag);
      } else {
        throw err;
      }
    }
  }
}
