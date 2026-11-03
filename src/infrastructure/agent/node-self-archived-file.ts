/**
 * The self-archive record on the VM (#308), behind the SelfArchivedFile port.
 *
 * Mode 0600 like the agent's other files, and written atomically: the agent
 * may be stopped at any moment (an upgrade, a reboot), and a torn file would
 * lose every session the Mac has not caught up on yet.
 */
import fs from 'node:fs';

import {SELF_ARCHIVED_FILE} from '../../domain/agent/layout';
import type {SelfArchivedFile} from '../../application/services/agent-host/hook-forwarder';
import {writeFileAtomic} from './atomic-write';
import {expandHome} from './home-path';

export class NodeSelfArchivedFile implements SelfArchivedFile {
    constructor(private readonly path: string = expandHome(SELF_ARCHIVED_FILE)) {}

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
