/**
 * The host settings file on the VM, behind the HostSettingsFile port.
 *
 * Mode 0600: the host instructions are the user's own text, and nobody else on
 * the VM needs to read them.
 */
import fs from 'node:fs';

import {HOST_SETTINGS_FILE} from '../../domain/agent/layout';
import type {HostSettingsFile} from '../../application/services/agent-host/host-config';
import {writeFileAtomic} from './atomic-write';
import {expandHome} from './home-path';

export class NodeHostSettingsFile implements HostSettingsFile {
    constructor(private readonly path: string = expandHome(HOST_SETTINGS_FILE)) {}

    public read(): string | null {
        try {
            return fs.readFileSync(this.path, 'utf8');
        } catch {
            return null;
        }
    }

    public write(text: string): void {
        writeFileAtomic(this.path, text, 0o600);
    }
}
