/**
 * Registering IPC handlers, without `ipcMain` reaching the feature modules.
 *
 * Each handler module takes one of these instead of importing Electron, which
 * is what lets a module's channel wiring be exercised with a fake. The wrapper
 * also does the one thing every handler used to do by hand: turn a thrown error
 * into the `{ error }` envelope the renderer expects, rather than letting it
 * cross the boundary as a rejected invoke with a mangled stack.
 */
import { ipcMain } from 'electron';
import type { Logger } from '../../application/ports/logger';

/** A request the renderer waits for an answer to. */
export type InvokeHandler = (...args: never[]) => unknown;
/** A message the renderer does not wait on. */
export type SendHandler = (...args: never[]) => void;

export interface IpcRegistrar {
  handle(channel: string, handler: InvokeHandler): void;
  on(channel: string, handler: SendHandler): void;
}

export function createRegistrar(log: Logger): IpcRegistrar {
  return {
    handle(channel, handler) {
      ipcMain.handle(channel, async (_event, ...args) => {
        try {
          return await (handler as (...a: unknown[]) => unknown)(...args);
        } catch (err) {
          log.error(`[ipc] ${channel} failed:`, (err as Error).message);
          return { ok: false, error: (err as Error).message };
        }
      });
    },
    on(channel, handler) {
      ipcMain.on(channel, (_event, ...args) => {
        try {
          (handler as (...a: unknown[]) => void)(...args);
        } catch (err) {
          log.error(`[ipc] ${channel} failed:`, (err as Error).message);
        }
      });
    },
  };
}
