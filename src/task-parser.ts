// Matches: optional indent, "- [x/X/ ]", whitespace, rest of line
const TASK_REGEX = /^(\s*-\s+\[)([xX ])\]\s+(.+)$/;
const UID_REGEX = /<!--\s*caldav-uid:([\w-]+)\s*-->/;
const DUE_DATE_REGEX = /📅\s*(\d{4}-\d{2}-\d{2})/;

export interface ParsedTask {
  lineIndex: number;
  raw: string;
  completed: boolean;
  title: string;
  uid: string | null;
  dueDate: string | null;
  syncTag: string;
}

/**
 * Parse all tasks in the content that include any of the given syncTags.
 */
export function parseTasks(content: string, syncTags: string[]): ParsedTask[] {
  const lines = content.split("\n");
  const tasks: ParsedTask[] = [];
  const configuredTags = syncTags.filter(Boolean);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = TASK_REGEX.exec(line);
    if (!match) continue;

    const fullTaskText = match[3];
    const syncTag = findMatchingTag(fullTaskText, configuredTags);
    if (!syncTag) continue;

    const completed = match[2].toLowerCase() === "x";
    const uidMatch = UID_REGEX.exec(fullTaskText);
    const uid = uidMatch ? uidMatch[1] : null;
    const dueDateMatch = DUE_DATE_REGEX.exec(fullTaskText);
    const dueDate = dueDateMatch ? dueDateMatch[1] : null;

    // Extract title: remove UID comment, sync tag, due date, and trailing whitespace
    let title = fullTaskText
      .replace(UID_REGEX, "")
      .replace(buildTagRegex(syncTag), "")
      .replace(DUE_DATE_REGEX, "")
      .trim();

    tasks.push({
      lineIndex: i,
      raw: line,
      completed,
      title,
      uid,
      dueDate,
      syncTag,
    });
  }

  return tasks;
}

function findMatchingTag(text: string, syncTags: string[]): string | null {
  const tags = extractTags(text);
  for (const syncTag of syncTags) {
    if (tags.has(syncTag)) return syncTag;
  }
  return null;
}

function extractTags(text: string): Set<string> {
  const matches = text.match(/#[^\s#]+/g) ?? [];
  return new Set(matches);
}

function buildTagRegex(tag: string): RegExp {
  return new RegExp(`(^|\\s)${escapeRegExp(tag)}(?=\\s|$)`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build the full task line with a UID comment appended.
 * Preserves existing indentation.
 */
export function buildLineWithUid(task: ParsedTask, uid: string, syncTag: string): string {
  const marker = task.completed ? "x" : " ";
  const indent = task.raw.match(/^(\s*)/)?.[1] ?? "";
  const duePart = task.dueDate ? ` 📅 ${task.dueDate}` : "";
  return `${indent}- [${marker}] ${task.title}${duePart} ${syncTag} <!-- caldav-uid:${uid} -->`;
}

/**
 * Build the full task line with updated completion state.
 * Preserves UID comment if present.
 */
export function buildLineWithCompletion(
  task: ParsedTask,
  completed: boolean,
  syncTag: string,
  uid?: string,
  dueDate?: string | null
): string {
  const marker = completed ? "x" : " ";
  const indent = task.raw.match(/^(\s*)/)?.[1] ?? "";
  const uidPart = uid ? ` <!-- caldav-uid:${uid} -->` : task.uid ? ` <!-- caldav-uid:${task.uid} -->` : "";
  const resolvedDue = dueDate !== undefined ? dueDate : task.dueDate;
  const duePart = resolvedDue ? ` 📅 ${resolvedDue}` : "";
  return `${indent}- [${marker}] ${task.title}${duePart} ${syncTag}${uidPart}`;
}

/**
 * Apply line patches (lineIndex -> newLine) to content and return updated content.
 */
export function applyLinePatch(content: string, patches: Map<number, string>): string {
  if (patches.size === 0) return content;
  const lines = content.split("\n");
  for (const [idx, newLine] of patches) {
    lines[idx] = newLine;
  }
  return lines.join("\n");
}
