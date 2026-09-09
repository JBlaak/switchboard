/**
 * Everything the renderer can ask for, registered in one call.
 *
 * The handlers are grouped by feature rather than by Electron primitive, so
 * adding a capability means one new module and one line here — which is the
 * whole point of the channel table these read their names from.
 */
import { createRegistrar } from './registrar';
import { registerContentHandlers } from './content-handlers';
import { registerHostHandlers } from './host-handlers';
import { registerProjectHandlers } from './project-handlers';
import { registerSessionHandlers } from './session-handlers';
import { registerSettingsHandlers } from './settings-handlers';
import { registerTerminalHandlers } from './terminal-handlers';
import type { Container } from '../composition-root';

export function registerIpcHandlers(app: Container): void {
  const ipc = createRegistrar(app.log);
  registerProjectHandlers(ipc, app);
  registerSessionHandlers(ipc, app);
  registerTerminalHandlers(ipc, app);
  registerContentHandlers(ipc, app);
  registerSettingsHandlers(ipc, app);
  registerHostHandlers(ipc, app);
}
