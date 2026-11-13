/**
 * A record the agent keeps on the VM (#438), behind the RecordFile port: the
 * self-started sessions, the Merge manager's lane state.
 *
 * Mode 0600 like the agent's other files, and written atomically: the agent
 * may be stopped at any moment (an upgrade, a reboot), and a torn file would
 * lose what it was there to keep.
 */
import fs from 'node:fs';

import type {RecordFile} from '../../application/ports/record-file';
import {writeFileAtomic} from './atomic-write';
import {expandHome} from './home-path';

export class NodeRecordFile implements RecordFile {
    private readonly path: string;

    /** `file` may start with `$HOME`, as the layout's paths do. */
    constructor(file: string) {
        this.path = expandHome(file);
    }

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
