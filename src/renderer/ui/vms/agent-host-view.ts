/**
 * What a VM's controls in Settings → VMs say (#276, #307), from the agent
 * host slice: Install agent or Update agent with its progress, and the setup
 * checks.
 *
 * Pure, so it is tested in node.
 */
import type {AgentTool, ToolCheck} from '../../../domain/agent/protocol';
import type {VmHostView} from '../../../application/services/vm-registry';
import type {InstallState} from '../../state/agent-host-slice';

export const INSTALL_HELP = 'Runs this host’s sessions with every Switchboard feature. Needs Linux with systemd.';

/** The install button and what shows under it. */
export interface InstallView {
    readonly label: string;
    readonly disabled: boolean;
    /** The progress lines, while it runs and after it stopped. */
    readonly lines: readonly string[];
    /** Why it failed; the button then says Retry. */
    readonly error: string | null;
}

/** `idle` is the label for a button that has not run: Install agent, or Update agent on a VM. */
export function installView(install: InstallState, idle = 'Install agent'): InstallView {
    switch (install.phase) {
        case 'idle':
            return {label: idle, disabled: false, lines: [], error: null};
        case 'running':
            return {
                label: idle === 'Update agent' ? 'Updating…' : 'Installing…',
                disabled: true,
                lines: install.lines,
                error: null,
            };
        case 'failed':
            return {label: 'Retry', disabled: false, lines: install.lines, error: install.error};
        case 'done':
            return {label: idle, disabled: false, lines: install.lines, error: null};
    }
}

/** Whether a VM offers Update agent: it has an agent, and it isn't the app's version. */
export function offersUpdate(vm: Pick<VmHostView, 'agent' | 'current'>): boolean {
    return vm.agent !== null && !vm.current;
}

/** One tool's row in the setup checks. */
export interface ToolLine {
    readonly tool: AgentTool;
    /** `ready` gets the green check. */
    readonly state: 'ready' | 'signed-out' | 'missing';
    readonly text: string;
}

const TOOL_ORDER: readonly AgentTool[] = ['claude', 'gh', 'git'];

/** The rows, in the order setup installs them, with a missing answer read as not installed. */
export function toolLines(tools: readonly ToolCheck[]): ToolLine[] {
    return TOOL_ORDER.map((tool) => toolLine(tools.find((check) => check.tool === tool) ?? {tool, installed: false}));
}

export function toolLine(check: ToolCheck): ToolLine {
    if (!check.installed) return {tool: check.tool, state: 'missing', text: 'Not installed'};
    const installed = check.version ? 'Installed, ' + check.version : 'Installed';
    // git has no login, so `loggedIn` is absent for it and it is ready once installed.
    if (check.loggedIn === false) return {tool: check.tool, state: 'signed-out', text: installed + ' · not signed in'};
    if (check.loggedIn === true) return {tool: check.tool, state: 'ready', text: installed + ' · signed in'};
    return {tool: check.tool, state: 'ready', text: installed};
}

/** Whether every tool is ready, so the checks can say setup is done. */
export function setupDone(tools: readonly ToolCheck[]): boolean {
    return toolLines(tools).every((line) => line.state === 'ready');
}
