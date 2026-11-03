/**
 * Settings → VMs (#307): the registered VMs, each opening to its controls,
 * and Add a VM. Registering a VM is like pairing a phone: it is done here,
 * not by adding a remote project first.
 *
 * A card of the settings form like the others, but not part of its Save:
 * every control here acts at once, through main, and draws what main
 * answers (`state/vms-slice`, and `state/agent-host-slice` for each VM's
 * controls).
 *
 * What each part says is `vms-copy` and `agent-host-view`; what it does is
 * `actions` and `agent-actions`.
 */
import {useState} from 'react';
import type {FormEvent, JSX} from 'react';
import {useStore} from '../use-store';
import {AppField} from '../settings/SettingsField';
import {vmFailureIn, vmHostsIn} from '../../state/vms-slice';
import {hostViewIn} from '../../state/agent-host-slice';
import {addVm, toggleVm, VMS_SECTION_ID, vmRowId} from './actions';
import {addressLine, agentLine, connectionLine} from './vms-copy';
import {VmControls} from './VmControls';
import {ServerIcon} from './icons';
import type {VmHostView} from './vm-api';

export function VmsSection(): JSX.Element {
    const hosts = useStore((s) => vmHostsIn(s.vms));
    const open = useStore((s) => s.vms.open);

    return (
        <div className="settings-section vm-section" id={VMS_SECTION_ID}>
            <div className="settings-section-title">VMs</div>

            <div className="settings-field vm-list-field">
                <div className="settings-field-info">
                    <span className="settings-label">Registered VMs</span>
                    <div className="settings-description">
                        Machines that run sessions through a Switchboard agent. Projects handed off to one, and folders
                        added on it, show in the sidebar.
                    </div>
                    {hosts.length === 0 ? (
                        <div className="settings-description vm-empty">No VM is registered yet.</div>
                    ) : (
                        <ul className="vm-list" aria-label="Registered VMs">
                            {hosts.map((vm) => (
                                <VmRow key={vm.key} vm={vm} open={open === vm.key} />
                            ))}
                        </ul>
                    )}
                </div>
            </div>

            <AddVm />
        </div>
    );
}

function VmRow({vm, open}: {vm: VmHostView; open: boolean}): JSX.Element {
    const install = useStore((s) => hostViewIn(s.agentHost, vm.key).install);
    const agent = agentLine(vm, install);
    const connection = connectionLine(vm);
    const address = addressLine(vm);
    return (
        <li className={'vm-row' + (open ? ' is-open' : '')} id={vmRowId(vm.key)}>
            <button type="button" className="vm-row-head" aria-expanded={open} onClick={() => toggleVm(vm.key)}>
                <span className="vm-row-icon">
                    <ServerIcon size={20} strokeWidth={1.6} />
                </span>
                <span className="vm-row-text">
                    <span className="vm-row-name">{vm.label}</span>
                    <span className="vm-row-line">
                        {address && <span className="vm-row-address">{address} · </span>}
                        <span className={'vm-agent is-' + agent.tone}>{agent.text}</span>
                        {connection && (
                            <>
                                {' · '}
                                <span className={connection.connected ? 'pa-connected' : 'vm-offline'}>
                                    {connection.text}
                                </span>
                            </>
                        )}
                    </span>
                </span>
                <span className="vm-row-chevron" aria-hidden="true">
                    {open ? '▾' : '▸'}
                </span>
            </button>
            {open && <VmControls vm={vm} />}
        </li>
    );
}

const EMPTY = {user: '', host: '', port: '', name: ''};

/** Add a VM: its user, host and port, and a name if you like. */
function AddVm(): JSX.Element {
    const [adding, setAdding] = useState(false);
    const [input, setInput] = useState(EMPTY);
    const [busy, setBusy] = useState(false);
    const failure = useStore((s) => vmFailureIn(s.vms, 'add'));

    if (!adding) {
        return (
            <AppField
                label="Add a VM"
                description="Its address over ssh. Installing its Switchboard agent comes next, from its row.">
                <button type="button" className="pa-btn" onClick={() => setAdding(true)}>
                    Add a VM…
                </button>
            </AppField>
        );
    }

    const field = (name: keyof typeof EMPTY) => ({
        value: input[name],
        onChange: (e: {currentTarget: HTMLInputElement}) => {
            const value = e.currentTarget.value;
            setInput((before) => ({...before, [name]: value}));
        },
    });

    const submit = async (e: FormEvent): Promise<void> => {
        e.preventDefault();
        setBusy(true);
        const added = await addVm(input);
        setBusy(false);
        if (added) {
            setInput(EMPTY);
            setAdding(false);
        }
    };

    return (
        <form className="settings-field vm-add" onSubmit={(e) => void submit(e)}>
            <div className="settings-field-info">
                <span className="settings-label">Add a VM</span>
                <div className="vm-add-fields">
                    <label className="vm-add-field">
                        <span>User</span>
                        <input
                            type="text"
                            className="settings-input"
                            id="sv-vm-add-user"
                            placeholder="dev"
                            spellCheck={false}
                            autoFocus
                            {...field('user')}
                        />
                    </label>
                    <span className="vm-add-at" aria-hidden="true">
                        @
                    </span>
                    <label className="vm-add-field is-host">
                        <span>Host</span>
                        <input
                            type="text"
                            className="settings-input"
                            id="sv-vm-add-host"
                            placeholder="devbox.local"
                            spellCheck={false}
                            {...field('host')}
                        />
                    </label>
                    <label className="vm-add-field is-port">
                        <span>Port</span>
                        <input
                            type="text"
                            inputMode="numeric"
                            className="settings-input"
                            id="sv-vm-add-port"
                            placeholder="22"
                            spellCheck={false}
                            {...field('port')}
                        />
                    </label>
                    <label className="vm-add-field is-name">
                        <span>Name (optional)</span>
                        <input
                            type="text"
                            className="settings-input"
                            id="sv-vm-add-name"
                            placeholder="Dev VM"
                            spellCheck={false}
                            {...field('name')}
                        />
                    </label>
                </div>
                {failure !== null && (
                    <div className="pa-error vm-add-error" role="alert">
                        {failure}
                    </div>
                )}
                <div className="vm-add-actions">
                    <button type="submit" className="pa-btn vm-btn-primary" disabled={busy}>
                        {busy ? 'Adding…' : 'Add VM'}
                    </button>
                    <button
                        type="button"
                        className="pa-btn"
                        onClick={() => {
                            setAdding(false);
                            setInput(EMPTY);
                        }}>
                        Cancel
                    </button>
                </div>
            </div>
        </form>
    );
}
