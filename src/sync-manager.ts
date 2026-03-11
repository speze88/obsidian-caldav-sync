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
import type { CalDAVCalendarSettings, CalDAVSyncSettings } from "./settings";

export class SyncManager {
  private settings: CalDAVSyncSettings;
  private clients = new Map<string, CalDAVClient>();

  constructor(settings: CalDAVSyncSettings) {
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
    const calendarsByTag = this.getCalendarsByTag();
    if (calendarsByTag.size === 0) return false;

    const content = await app.vault.read(file);
    const tasks = parseTasks(content, [...calendarsByTag.keys()]);
    const noteUrl = this.obsidianUrl(app, file);

    if (tasks.length === 0) return false;

    const patches = new Map<number, string>();
    const errors: string[] = [];

    for (const task of tasks) {
      const calendar = calendarsByTag.get(task.syncTag);
      if (!calendar) continue;

      try {
        const client = await this.getClient(calendar);
        if (!task.uid) {
          // New task: create on server and write UID back
          const uid = uuidv4();
          await client.createVTodo({
            uid,
            summary: task.title,
            completed: task.completed,
            dueDate: task.dueDate,
            url: noteUrl,
          });
          patches.set(task.lineIndex, buildLineWithUid(task, uid, task.syncTag));
        } else {
          // Existing task: fetch remote state and reconcile
          let remote = await client.fetchVTodo(task.uid);

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
            patchLine = buildLineWithCompletion(task, true, task.syncTag);
          }

          // 3. Title differs → remote wins, pull title update
          if (task.title !== remote.data.summary) {
            const updatedTask = { ...task, title: remote.data.summary };
            const completed = patchLine ? true : task.completed;
            patchLine = buildLineWithCompletion(
              updatedTask,
              completed,
              task.syncTag,
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
                task.syncTag,
                task.uid,
                remoteDue
              );
            }
          }

          if (needsServerUpdate) {
            await this.updateWithRetry(client, updatedData, remote.etag);
          }

          if (patchLine !== null) {
            patches.set(task.lineIndex, patchLine);
          }
        }
      } catch (err) {
        if (err instanceof CalDAVAuthError) {
          errors.push(`Auth error for "${calendar.name || calendar.syncTag}": ${err.message}`);
          break; // No point continuing if auth is broken
        } else if (err instanceof CalDAVNetworkError) {
          errors.push(
            `Network error syncing "${task.title}" to "${calendar.name || calendar.syncTag}": ${err.message}`
          );
        } else {
          errors.push(
            `Error syncing "${task.title}" to "${calendar.name || calendar.syncTag}": ${err}`
          );
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

  getSyncTags(): string[] {
    return this.settings.calendars
      .map((calendar) => calendar.syncTag)
      .filter((tag, index, all) => Boolean(tag) && all.indexOf(tag) === index);
  }

  private getCalendarsByTag(): Map<string, CalDAVCalendarSettings> {
    const calendars = new Map<string, CalDAVCalendarSettings>();
    for (const calendar of this.settings.calendars) {
      if (!calendar.serverUrl || !calendar.syncTag) continue;
      if (!calendars.has(calendar.syncTag)) {
        calendars.set(calendar.syncTag, calendar);
      }
    }
    return calendars;
  }

  private async getClient(calendar: CalDAVCalendarSettings): Promise<CalDAVClient> {
    const cacheKey = calendar.id;
    const cached = this.clients.get(cacheKey);
    if (cached?.isInitialized()) return cached;

    const client = new CalDAVClient();
    await client.initialize({
      serverUrl: calendar.serverUrl,
      username: calendar.username,
      password: calendar.password,
    });
    if (!client.isInitialized()) {
      throw new CalDAVNetworkError(
        `Calendar "${calendar.name || calendar.syncTag}" is not fully configured.`
      );
    }
    this.clients.set(cacheKey, client);
    return client;
  }

  private async updateWithRetry(
    client: CalDAVClient,
    data: Parameters<CalDAVClient["updateVTodo"]>[0],
    etag: string
  ): Promise<void> {
    try {
      await client.updateVTodo(data, etag);
    } catch (err) {
      if (err instanceof CalDAVConflictError) {
        // 412: re-fetch ETag and retry once
        const remote = await client.fetchVTodo(data.uid);
        if (!remote) return;
        await client.updateVTodo(data, remote.etag);
      } else {
        throw err;
      }
    }
  }
}
