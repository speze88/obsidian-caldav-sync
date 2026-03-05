// Matches: optional indent, "- [x/X/ ]", whitespace, rest of line
const TASK_REGEX = /^(\s*-\s+\[)([xX ])\]\s+(.+)$/;
const UID_REGEX = /<!--\s*caldav-uid:([\w-]+)\s*-->/;

export interface ParsedTask {
  lineIndex: number;
  raw: string;
  completed: boolean;
  title: string;
  uid: string | null;
}

/**
 * Parse all tasks in the content that include the given syncTag.
 */
export function parseTasks(content: string, syncTag: string): ParsedTask[] {
  const lines = content.split("\n");
  const tasks: ParsedTask[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = TASK_REGEX.exec(line);
    if (!match) continue;

    const fullTaskText = match[3];
    // Only include tasks that have the sync tag
    if (!fullTaskText.includes(syncTag)) continue;

    const completed = match[2].toLowerCase() === "x";
    const uidMatch = UID_REGEX.exec(fullTaskText);
    const uid = uidMatch ? uidMatch[1] : null;

    // Extract title: remove UID comment, sync tag, and trailing whitespace
    let title = fullTaskText
      .replace(UID_REGEX, "")
      .replace(syncTag, "")
      .trim();

    tasks.push({
      lineIndex: i,
      raw: line,
      completed,
      title,
      uid,
    });
  }

  return tasks;
}

/**
 * Build the full task line with a UID comment appended.
 * Preserves existing indentation.
 */
export function buildLineWithUid(task: ParsedTask, uid: string, syncTag: string): string {
  const marker = task.completed ? "x" : " ";
  const indent = task.raw.match(/^(\s*)/)?.[1] ?? "";
  return `${indent}- [${marker}] ${task.title} ${syncTag} <!-- caldav-uid:${uid} -->`;
}

/**
 * Build the full task line with updated completion state.
 * Preserves UID comment if present.
 */
export function buildLineWithCompletion(
  task: ParsedTask,
  completed: boolean,
  syncTag: string,
  uid?: string
): string {
  const marker = completed ? "x" : " ";
  const indent = task.raw.match(/^(\s*)/)?.[1] ?? "";
  const uidPart = uid ? ` <!-- caldav-uid:${uid} -->` : task.uid ? ` <!-- caldav-uid:${task.uid} -->` : "";
  return `${indent}- [${marker}] ${task.title} ${syncTag}${uidPart}`;
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
