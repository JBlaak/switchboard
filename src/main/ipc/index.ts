/**
 * Everything the renderer can ask for, registered in one call.
 *
 * The handlers are grouped by feature rather than by Electron primitive, so
 * adding a capability means one new module and one line here — which is the
 * whole point of the channel table these read their names from.
 */
import {createRegistrar} from './support/registrar';
import {registerContentHandlers} from './content-handlers';
import {registerHostHandlers} from './host-handlers';
import {registerProjectHandlers} from './project-handlers';
import {registerQuestionHandlers} from './question-handlers';
import {registerSessionHandlers} from './session-handlers';
import {registerSessionWorkHandlers} from './session-work-handlers';
import {registerSessionLinksHandlers} from './session-links-handlers';
import {registerIssueSessionHandlers} from './issue-session-handlers';
import {registerPlanHandlers} from './plan-handlers';
import {registerProjectOverviewHandlers} from './project-overview-handlers';
import {registerMergeQueueHandlers} from './merge-queue-handlers';
import {registerSettingsHandlers} from './settings-handlers';
import {registerSleepHandlers} from './sleep-handlers';
import {registerTerminalHandlers} from './terminal-handlers';
import {registerUpdateHandlers} from './update-handlers';
import {registerWeatherHandlers} from './weather-handlers';
import {registerAskHandlers} from './ask-handlers';
import {registerQuickAskHandlers} from './quick-ask-handlers';
import {registerHeadsUpHandlers} from './heads-up-handlers';
import {registerPhoneAccessHandlers} from './phone-access-handlers';
import {registerTasksHandlers} from './tasks-handlers';
import {registerAgentHandlers} from './agent-handlers';
import {registerHandoffHandlers} from './handoff-handlers';
import {registerSessionHandoffHandlers} from './session-handoff-handlers';
import {registerSessionBringBackHandlers} from './session-bring-back-handlers';
import {registerVmSchedulesHandlers} from './vm-schedules-handlers';
import {registerDroppedFilesHandlers} from './dropped-files-handlers';
import {registerVmRegistryHandlers} from './vm-registry-handlers';
import {registerWorkspaceHandlers} from './workspace-handlers';
import {registerBugsnagHandlers} from './bugsnag-handlers';
import {registerInboxHandlers} from './inbox-handlers';
import type {Container} from '../composition-root';

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
    registerSessionLinksHandlers(ipc, app);
    registerIssueSessionHandlers(ipc, app);
    registerPlanHandlers(ipc, app);
    registerProjectOverviewHandlers(ipc, app);
    registerMergeQueueHandlers(ipc, app);
    registerAskHandlers(ipc, app);
    registerQuickAskHandlers(ipc, app);
    registerHeadsUpHandlers(ipc, app);
    registerPhoneAccessHandlers(ipc, app);
    registerTasksHandlers(ipc, app);
    registerAgentHandlers(ipc, app);
    registerHandoffHandlers(ipc, app);
    registerSessionHandoffHandlers(ipc, app);
    registerSessionBringBackHandlers(ipc, app);
    registerVmSchedulesHandlers(ipc, app);
    registerDroppedFilesHandlers(ipc, app);
    registerVmRegistryHandlers(ipc, app);
    registerWorkspaceHandlers(ipc, app);
    registerBugsnagHandlers(ipc, app);
    registerInboxHandlers(ipc, app);
}
