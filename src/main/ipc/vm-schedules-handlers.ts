/**
 * Where a project's schedules run (#276 stage 5, Q18): the Schedules line on
 * a local project's page and on its copy's, and the hand-off dialog's
 * "Run this project's schedules on the VM".
 *
 * Every call goes to the `VmSchedules` façade. Until the composition root
 * builds it, `where` answers null, so no page shows the line and the dialog
 * shows no checkbox; moving them fails with a message.
 */
import {INVOKE} from '../../ipc/channels';
import {isRemoteProjectPath} from '../../domain/project/remote-target';
import type {VmSchedules} from '../../application/services/vm-schedules';
import type {Container} from '../composition-root';
import type {IpcRegistrar} from './support/registrar';

/** The façade, until the composition root builds one; a call before then fails with this. */
function schedulesOf(app: Container): VmSchedules {
    if (!app.vmSchedules) throw new Error('Moving schedules isn’t available in this build');
    return app.vmSchedules;
}

export function registerVmSchedulesHandlers(ipc: IpcRegistrar, app: Container): void {
    ipc.handle(INVOKE.vmSchedulesWhere, async (projectPath: unknown) => {
        if (typeof projectPath !== 'string' || projectPath === '' || !app.vmSchedules) return null;
        return app.vmSchedules.where(projectPath);
    });

    ipc.handle(INVOKE.vmSchedulesRunOn, (localPath: unknown, copyPath: unknown) => {
        if (typeof localPath !== 'string' || localPath === '' || isRemoteProjectPath(localPath))
            throw new Error('Not a local project');
        if (copyPath !== null && (typeof copyPath !== 'string' || !isRemoteProjectPath(copyPath)))
            throw new Error('Not a copy on a VM');
        return schedulesOf(app).runOn(localPath, copyPath);
    });
}
