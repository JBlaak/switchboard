/**
 * The VM user's Claude config folder, behind the ClaudeConfigDir port.
 *
 * Rooted where the CLI itself looks (`CLAUDE_CONFIG_DIR`, else `~/.claude`), so
 * the config copy lands where sessions read it and the credentials check
 * looks where `claude login` wrote.
 *
 * Every path is resolved and refused unless it stays inside the root. The part
 * above already checked it with `isSafeConfigPath`; this is the second lock on
 * the same door, in the one place that touches the disk.
 */
import fs from 'node:fs';
import path from 'node:path';

import type {ClaudeConfigDir} from '../../application/services/agent-host/host-config';
import {claudeConfigDir} from '../claude-cli/support/credentials';
import {writeFileAtomic} from './atomic-write';

export class NodeClaudeConfigDir implements ClaudeConfigDir {
    private readonly root: string;

    constructor(root: string = claudeConfigDir()) {
        this.root = path.resolve(root);
    }

    public exists(relativePath: string): boolean {
        return fs.existsSync(this.resolve(relativePath));
    }

    public write(relativePath: string, content: Uint8Array, mode: number): void {
        writeFileAtomic(this.resolve(relativePath), content, mode);
    }

    public remove(relativePath: string): void {
        // Files only: a stale path from an earlier copy is a file it wrote.
        fs.rmSync(this.resolve(relativePath), {force: true});
    }

    private resolve(relativePath: string): string {
        const target = path.resolve(this.root, relativePath);
        if (!target.startsWith(this.root + path.sep)) throw new Error(`outside ${this.root}: ${relativePath}`);
        return target;
    }
}
