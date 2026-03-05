import { requestUrl, RequestUrlResponse } from "obsidian";
import type { CalDAVSyncSettings } from "./settings";

export class CalDAVAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalDAVAuthError";
  }
}

export class CalDAVConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalDAVConflictError";
  }
}

export class CalDAVNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalDAVNetworkError";
  }
}

export interface VTodoData {
  uid: string;
  summary: string;
  completed: boolean;
  dueDate?: string | null; // YYYY-MM-DD
  url?: string; // obsidian:// URI
}

function escapeICalText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

function buildVCalendar(data: VTodoData): string {
  const now = new Date();
  const dtstamp =
    now.getUTCFullYear().toString() +
    String(now.getUTCMonth() + 1).padStart(2, "0") +
    String(now.getUTCDate()).padStart(2, "0") +
    "T" +
    String(now.getUTCHours()).padStart(2, "0") +
    String(now.getUTCMinutes()).padStart(2, "0") +
    String(now.getUTCSeconds()).padStart(2, "0") +
    "Z";

  const status = data.completed ? "COMPLETED" : "NEEDS-ACTION";
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//ObsidianCalDAVSync//EN",
    "BEGIN:VTODO",
    `UID:${data.uid}`,
    `DTSTAMP:${dtstamp}`,
    `SUMMARY:${escapeICalText(data.summary)}`,
    `STATUS:${status}`,
  ];
  if (data.dueDate) {
    const compact = data.dueDate.replace(/-/g, "");
    lines.push(`DUE;VALUE=DATE:${compact}`);
  }
  if (data.url) {
    lines.push(`URL:${data.url}`);
  }
  lines.push("END:VTODO", "END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

function parseICalDate(value: string): string | null {
  // Accepts: 20240315 or 20240315T000000Z → returns YYYY-MM-DD
  const compact = value.replace(/T.*$/, "").trim();
  if (!/^\d{8}$/.test(compact)) return null;
  return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
}

function parseVCalendar(icsContent: string): VTodoData | null {
  const lines = icsContent.split(/\r?\n/);
  let uid = "";
  let summary = "";
  let status = "NEEDS-ACTION";
  let dueDate: string | null = null;
  let inVTodo = false;

  for (const line of lines) {
    if (line === "BEGIN:VTODO") {
      inVTodo = true;
      continue;
    }
    if (line === "END:VTODO") {
      inVTodo = false;
      continue;
    }
    if (!inVTodo) continue;

    if (line.startsWith("UID:")) {
      uid = line.slice(4).trim();
    } else if (line.startsWith("SUMMARY:")) {
      summary = line
        .slice(8)
        .replace(/\\n/g, "\n")
        .replace(/\\,/g, ",")
        .replace(/\\;/g, ";")
        .replace(/\\\\/g, "\\")
        .trim();
    } else if (line.startsWith("STATUS:")) {
      status = line.slice(7).trim();
    } else if (line.startsWith("DUE")) {
      // DUE;VALUE=DATE:20240315 or DUE:20240315T000000Z
      const val = line.replace(/^DUE[^:]*:/, "");
      dueDate = parseICalDate(val);
    }
  }

  if (!uid) return null;

  return {
    uid,
    summary,
    completed: status === "COMPLETED",
    dueDate,
  };
}

export class CalDAVClient {
  private initialized = false;
  private calendarUrl: string = "";
  private authHeader: string = "";

  async initialize(settings: CalDAVSyncSettings): Promise<void> {
    this.initialized = false;
    if (!settings.serverUrl || !settings.username || !settings.password) {
      return;
    }

    // Ensure server URL has trailing slash
    this.calendarUrl = settings.serverUrl.endsWith("/")
      ? settings.serverUrl
      : settings.serverUrl + "/";

    this.authHeader = "Basic " + btoa(`${settings.username}:${settings.password}`);

    // Verify connectivity with a PROPFIND
    try {
      const response = await requestUrl({
        url: this.calendarUrl,
        method: "PROPFIND",
        headers: {
          Authorization: this.authHeader,
          Depth: "0",
          "Content-Type": "application/xml",
        },
        body: `<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/></D:prop></D:propfind>`,
        throw: false,
      });

      if (response.status === 401 || response.status === 403) {
        throw new CalDAVAuthError(`Authentication failed: ${response.status}`);
      }
      // 207 Multi-Status is expected; also accept 200
      if (response.status !== 200 && response.status !== 207) {
        throw new CalDAVNetworkError(`Server check failed: ${response.status}`);
      }
    } catch (err) {
      if (err instanceof CalDAVAuthError || err instanceof CalDAVNetworkError) throw err;
      throw new CalDAVNetworkError(`Failed to reach CalDAV server: ${err}`);
    }

    this.initialized = true;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  private todoUrl(uid: string): string {
    return `${this.calendarUrl}${uid}.ics`;
  }

  async createVTodo(data: VTodoData): Promise<void> {
    if (!this.initialized) throw new CalDAVNetworkError("Client not initialized");

    const icsContent = buildVCalendar(data);
    const url = this.todoUrl(data.uid);

    const response = await requestUrl({
      url,
      method: "PUT",
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "If-None-Match": "*",
        Authorization: this.authHeader,
      },
      body: icsContent,
      throw: false,
    });

    if (response.status === 401 || response.status === 403) {
      throw new CalDAVAuthError(`Authentication failed: ${response.status}`);
    }
    if (response.status !== 200 && response.status !== 201 && response.status !== 204) {
      throw new CalDAVNetworkError(`Failed to create VTODO: ${response.status}`);
    }
  }

  async fetchVTodo(uid: string): Promise<{ data: VTodoData; etag: string } | null> {
    if (!this.initialized) throw new CalDAVNetworkError("Client not initialized");

    const url = this.todoUrl(uid);

    let response: RequestUrlResponse;
    try {
      response = await requestUrl({
        url,
        method: "GET",
        headers: {
          Authorization: this.authHeader,
        },
        throw: false,
      });
    } catch (err) {
      throw new CalDAVNetworkError(`Network error fetching VTODO: ${err}`);
    }

    if (response.status === 404) return null;
    if (response.status === 401 || response.status === 403) {
      throw new CalDAVAuthError(`Authentication failed: ${response.status}`);
    }
    if (response.status < 200 || response.status >= 300) {
      throw new CalDAVNetworkError(`Failed to fetch VTODO: ${response.status}`);
    }

    const icsContent = response.text;
    const etag = response.headers["etag"] ?? "";
    const data = parseVCalendar(icsContent);
    if (!data) return null;

    return { data, etag };
  }

  async updateVTodo(data: VTodoData, etag: string): Promise<void> {
    if (!this.initialized) throw new CalDAVNetworkError("Client not initialized");

    const icsContent = buildVCalendar(data);
    const url = this.todoUrl(data.uid);

    const response = await requestUrl({
      url,
      method: "PUT",
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "If-Match": etag,
        Authorization: this.authHeader,
      },
      body: icsContent,
      throw: false,
    });

    if (response.status === 412) {
      throw new CalDAVConflictError("Precondition Failed (ETag mismatch)");
    }
    if (response.status === 401 || response.status === 403) {
      throw new CalDAVAuthError(`Authentication failed: ${response.status}`);
    }
    if (response.status !== 200 && response.status !== 201 && response.status !== 204) {
      throw new CalDAVNetworkError(`Failed to update VTODO: ${response.status}`);
    }
  }

  async deleteVTodo(uid: string, etag: string): Promise<void> {
    if (!this.initialized) throw new CalDAVNetworkError("Client not initialized");

    const url = this.todoUrl(uid);

    const response = await requestUrl({
      url,
      method: "DELETE",
      headers: {
        "If-Match": etag,
        Authorization: this.authHeader,
      },
      throw: false,
    });

    if (response.status !== 200 && response.status !== 204 && response.status !== 404) {
      throw new CalDAVNetworkError(`Failed to delete VTODO: ${response.status}`);
    }
  }
}
