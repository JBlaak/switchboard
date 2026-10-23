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
import { registerQuestionHandlers } from './question-handlers';
import { registerSessionHandlers } from './session-handlers';
import { registerSessionWorkHandlers } from './session-work-handlers';
import { registerIssueSessionHandlers } from './issue-session-handlers';
import { registerPlanHandlers } from './plan-handlers';
import { registerProjectOverviewHandlers } from './project-overview-handlers';
import { registerSettingsHandlers } from './settings-handlers';
import { registerSleepHandlers } from './sleep-handlers';
import { registerTerminalHandlers } from './terminal-handlers';
import { registerUpdateHandlers } from './update-handlers';
import { registerWeatherHandlers } from './weather-handlers';
import { registerAskHandlers } from './ask-handlers';
import { registerQuickAskHandlers } from './quick-ask-handlers';
import { registerPhoneAccessHandlers } from './phone-access-handlers';
import type { Container } from '../composition-root';

export function registerIpcHandlers(app: Container): void {
  const ipc = createRegistrar(app.log);
  registerProjectHandlers(ipc, app);
  registerSessionHandlers(ipc, app);
  registerTerminalHandlers(ipc, app);
  registerQuestionHandlers(ipc, app);
  registerContentHandlers(ipc, app);
  registerSettingsHandlers(ipc, app);
  registerHostHandlers(ipc, app);
  registerWeatherHandlers(ipc, app);
  registerSleepHandlers(ipc, app);
  registerUpdateHandlers(ipc, app);
  registerSessionWorkHandlers(ipc, app);
  registerIssueSessionHandlers(ipc, app);
  registerPlanHandlers(ipc, app);
  registerProjectOverviewHandlers(ipc, app);
  registerAskHandlers(ipc, app);
  registerQuickAskHandlers(ipc, app);
  registerPhoneAccessHandlers(ipc, app);
}
