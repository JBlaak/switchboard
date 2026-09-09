/**
 * The cold-start scan, on a worker thread.
 *
 * A first launch with years of history parses tens of thousands of transcripts.
 * On the main thread that freezes the window before it has painted, so the work
 * goes to a worker and the port's promise resolves when it lands.
 *
 * The worker exiting without a message is its own case: a segfault or an OOM in
 * the native layer fires neither `message` nor `error`, and without handling
 * `exit` the promise would never settle and the session list would stay empty
 * for the life of the process.
 */
import { Worker } from 'node:worker_threads';
import type { FolderScan } from '../../domain/session/session';
import type { ProjectScanner } from '../../application/ports/project-scanner';
import type { Logger } from '../../application/ports/logger';

/** What the worker posts back: progress ticks, then one terminal result. */
export type ScanProgress = { type: 'progress'; text: string };
export type ScanResult =
  | { ok: true; results: FolderScan[] }
  | { ok: false; error: string };
export type ScanMessage = ScanProgress | ScanResult;

export interface WorkerProjectScannerDeps {
  /** Absolute path to the built worker bundle. */
  workerPath: string;
  projectsDir: string;
  log: Logger;
}

export class WorkerProjectScanner implements ProjectScanner {
  constructor(private readonly deps: WorkerProjectScannerDeps) {}

  scan(onProgress: (text: string) => void): Promise<FolderScan[]> {
    const { workerPath, projectsDir, log } = this.deps;

    return new Promise<FolderScan[]>((resolve, reject) => {
      const worker = new Worker(workerPath, { workerData: { projectsDir } });
      let settled = false;

      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        fn();
      };

      worker.on('message', (message: ScanMessage) => {
        if ('type' in message) {
          onProgress(message.text);
          return;
        }
        settle(() => message.ok
          ? resolve(message.results)
          : reject(new Error(message.error)));
      });

      worker.on('error', (err: Error) => {
        settle(() => reject(err));
      });

      worker.on('exit', (code: number) => {
        settle(() => {
          log.error(`[scanner] worker exited unexpectedly (code ${code})`);
          reject(new Error('the scan worker exited unexpectedly'));
        });
      });
    });
  }
}
