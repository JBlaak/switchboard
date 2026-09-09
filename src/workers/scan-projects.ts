/**
 * The scan worker.
 *
 * Runs on its own thread with nothing but the filesystem and the domain's
 * transcript parser — no database, no Electron, no ports. It reports progress
 * as it goes and posts one result at the end; the adapter that starts it
 * (infrastructure/worker/worker-project-scanner.ts) turns that into a promise.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { NodeFileSystem } from '../infrastructure/fs/node-file-system';
import { FileTranscriptStore } from '../infrastructure/fs/transcript-store';
import type { FolderScan, Session } from '../domain/session/session';
import type { ScanProgress, ScanResult } from '../infrastructure/worker/worker-project-scanner';

const port = parentPort;
if (!port) throw new Error('scan-projects must be run as a worker thread');

const { projectsDir } = workerData as { projectsDir: string };
const transcripts = new FileTranscriptStore(new NodeFileSystem(), projectsDir);

/** How often a progress tick is posted, in folders. */
const PROGRESS_EVERY = 5;

function scanFolder(folder: string): FolderScan | null {
  const resolved = transcripts.resolveProjectPath(folder);
  if (!resolved) return null;
  const { projectPath, cwd } = resolved;

  const sessions: Session[] = [];
  for (const sessionId of transcripts.listSessionIds(folder)) {
    const session = transcripts.readSession(folder, sessionId, projectPath);
    if (session) sessions.push(session);
  }

  // The cwd has to travel with the scan: a cold start writes each folder's gate
  // with a current mtime, so reconcile() never revisits it to fill the cwd in.
  return {
    folder,
    projectPath,
    cwd,
    sessions,
    indexMtimeMs: transcripts.folderIndexMtimeMs(folder),
  };
}

try {
  const folders = transcripts.listFolders();
  const results: FolderScan[] = [];

  for (let i = 0; i < folders.length; i++) {
    if (i % PROGRESS_EVERY === 0 || i === folders.length - 1) {
      port.postMessage({
        type: 'progress',
        text: `Scanning projects (${i + 1}/${folders.length})…`,
      } satisfies ScanProgress);
    }
    const result = scanFolder(folders[i]);
    if (result) results.push(result);
  }

  port.postMessage({ ok: true, results } satisfies ScanResult);
} catch (err) {
  port.postMessage({ ok: false, error: (err as Error).message } satisfies ScanResult);
}
