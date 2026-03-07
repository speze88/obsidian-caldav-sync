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
  private obsidianUrl(app: App, file: TFile): string {
    const vault = encodeURIComponent(app.vault.getName());
    const filePath = encodeURIComponent(file.path.replace(/\.md$/, ""));
    return `obsidian://open?vault=${vault}&file=${filePath}`;
  }

  async syncFile(file: TFile, app: App): Promise<boolean> {
    if (!this.client.isInitialized()) return false;

    const content = await app.vault.read(file);
    const tasks = parseTasks(content, this.settings.syncTag);
    const noteUrl = this.obsidianUrl(app, file);

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
            dueDate: task.dueDate,
            url: noteUrl,
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
          let needsServerUpdate = false;
          let updatedData = { ...remote.data, url: noteUrl };

          // Conflict resolution rules:
          // 1. Local [x], remote NEEDS-ACTION → local wins, push COMPLETED
          if (task.completed && !remote.data.completed) {
            updatedData.completed = true;
            needsServerUpdate = true;
          }
          // 2. Local [ ], remote COMPLETED → remote wins, pull [x]
          else if (!task.completed && remote.data.completed) {
            patchLine = buildLineWithCompletion(task, true, this.settings.syncTag);
          }

          // 3. Title differs → remote wins, pull title update
          if (task.title !== remote.data.summary) {
            const updatedTask = { ...task, title: remote.data.summary };
            const completed = patchLine ? true : task.completed;
            patchLine = buildLineWithCompletion(
              updatedTask,
              completed,
              this.settings.syncTag,
              task.uid
            );
          }

          // 4. Due date: local wins → push to server; remote-only due date → pull to local
          const localDue = task.dueDate ?? null;
          const remoteDue = remote.data.dueDate ?? null;
          if (localDue !== remoteDue) {
            if (localDue !== null) {
              // Local has due date (or changed it) → push to server
              updatedData.dueDate = localDue;
              needsServerUpdate = true;
            } else {
              // Remote has due date, local doesn't → pull to local
              const baseTask = patchLine
                ? { ...task, title: remote.data.summary }
                : task;
              const completed = patchLine ? (remote.data.completed || task.completed) : task.completed;
              patchLine = buildLineWithCompletion(
                baseTask,
                completed,
                this.settings.syncTag,
                task.uid,
                remoteDue
              );
            }
          }

          if (needsServerUpdate) {
            await this.updateWithRetry(updatedData, remote.etag);
          }

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
    await app.vault.process(file, () => newContent);
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
