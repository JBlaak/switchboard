import fs from 'node:fs';
import path from 'node:path';
import type { Session } from './types.js';

/** A message body as it appears in a transcript — string, or a content block list. */
interface JsonlMessage {
  role?: string;
  content?: string | Array<{ text?: string }>;
}

/** One line of a Claude CLI `.jsonl` transcript. Every field is best-effort. */
interface JsonlEntry {
  type?: string;
  role?: string;
  timestamp?: string;
  slug?: string;
  customTitle?: string;
  aiTitle?: string;
  message?: string | JsonlMessage;
}

/** Pull the displayable text out of an entry, whatever shape its message took. */
function entryText(msg: JsonlEntry['message']): string {
  if (typeof msg === 'string') return msg;
  if (typeof msg?.content === 'string') return msg.content;
  if (Array.isArray(msg?.content)) return msg.content[0]?.text ?? '';
  return '';
}

/** Parse a single .jsonl file into a session object (or null if invalid) */
export function readSessionFile(filePath: string, folder: string, projectPath: string): Session | null {
  const sessionId = path.basename(filePath, '.jsonl');
  try {
    const stat = fs.statSync(filePath);
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    let summary = '';
    let messageCount = 0;
    let textContent = '';
    let slug: string | null = null;
    let customTitle: string | null = null;
    let aiTitle: string | null = null;
    // Real conversation time bounds. Resuming a session appends untimestamped
    // bookkeeping records (last-prompt, mode, ai-title, …) which bump the file's
    // mtime without any actual activity, so mtime can't be the displayed time.
    let firstTimestamp: string | null = null;
    let lastTimestamp: string | null = null;
    for (const line of lines) {
      const entry = JSON.parse(line) as JsonlEntry;
      if (entry.timestamp) {
        // ISO-8601 UTC strings — lexicographic comparison is chronological
        if (!firstTimestamp || entry.timestamp < firstTimestamp) firstTimestamp = entry.timestamp;
        if (!lastTimestamp || entry.timestamp > lastTimestamp) lastTimestamp = entry.timestamp;
      }
      if (entry.slug && !slug) slug = entry.slug;
      if (entry.type === 'custom-title' && entry.customTitle) {
        customTitle = entry.customTitle;
      }
      if (entry.type === 'ai-title' && entry.aiTitle) {
        aiTitle = entry.aiTitle;
      }
      if (entry.type === 'user' || entry.type === 'assistant' ||
          (entry.type === 'message' && (entry.role === 'user' || entry.role === 'assistant'))) {
        messageCount++;
      }
      const text = entryText(entry.message);
      if (!summary && (entry.type === 'user' || (entry.type === 'message' && entry.role === 'user'))) {
        // Skip local command messages (! prefix) — use the next real user message
        if (text && !/<bash-input>|<bash-stdout>|<local-command-caveat>/.test(text)) {
          // Use scheduled task name if present
          const taskMatch = text.match(/<scheduled-task\s+name="([^"]+)"/);
          summary = taskMatch ? 'Scheduled: ' + taskMatch[1] : text.slice(0, 120);
        }
      }
      if (text && textContent.length < 8000) {
        textContent += text.slice(0, 500) + '\n';
      }
    }
    if (!summary || messageCount < 1) return null;
    return {
      sessionId, folder, projectPath,
      summary, firstPrompt: summary,
      // created/modified are display+sort values from message timestamps;
      // fileMtime is the cache-invalidation key (compared against stat.mtime
      // in refreshFolder). Old transcripts without timestamps fall back to stat.
      created: firstTimestamp || stat.birthtime.toISOString(),
      modified: lastTimestamp || stat.mtime.toISOString(),
      fileMtime: stat.mtime.toISOString(),
      messageCount, textContent, slug, customTitle, aiTitle,
    };
  } catch {
    return null;
  }
}
