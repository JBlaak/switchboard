import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import { getFolderIndexMtimeMs } from '../shared/folder-index-state.js';
import { deriveProjectPath } from '../shared/derive-project-path.js';
import { readSessionFile } from '../shared/read-session-file.js';
import type { FolderScan, Session } from '../shared/types.js';

/** What the worker posts back: progress ticks, then one terminal result. */
export type ScanProgress = { type: 'progress'; text: string };
export type ScanResult =
  | { ok: true; results: FolderScan[] }
  | { ok: false; error: string };
export type ScanMessage = ScanProgress | ScanResult;

const port = parentPort;
if (!port) throw new Error('scan-projects must be run as a worker thread');

const PROJECTS_DIR: string = (workerData as { projectsDir: string }).projectsDir;

function readFolderFromFilesystem(folder: string): FolderScan | null {
  const folderPath = path.join(PROJECTS_DIR, folder);
  const projectPath = deriveProjectPath(folderPath);
  if (!projectPath) return null;
  const sessions: Session[] = [];
  const indexMtimeMs = getFolderIndexMtimeMs(folderPath);

  try {
    const jsonlFiles = fs.readdirSync(folderPath).filter(f => f.endsWith('.jsonl'));
    for (const file of jsonlFiles) {
      const s = readSessionFile(path.join(folderPath, file), folder, projectPath);
      if (s) sessions.push(s);
    }
  } catch {}

  return { folder, projectPath, sessions, indexMtimeMs };
}

// Scan all folders
try {
  const folders = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name !== '.git')
    .map(d => d.name);

  const results: FolderScan[] = [];
  for (let i = 0; i < folders.length; i++) {
    if (i % 5 === 0 || i === folders.length - 1) {
      port.postMessage({ type: 'progress', text: `Scanning projects (${i + 1}/${folders.length})…` } satisfies ScanProgress);
    }
    const result = readFolderFromFilesystem(folders[i]);
    if (result) results.push(result);
  }
  port.postMessage({ ok: true, results } satisfies ScanResult);
} catch (err) {
  port.postMessage({ ok: false, error: (err as Error).message } satisfies ScanResult);
}
