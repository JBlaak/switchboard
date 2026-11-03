/**
 * The Mac's `~/.claude`, as the global config copy reads it (#276, #283).
 *
 * Symlinks are followed, because a skill is often a link to the checkout it is
 * developed in; a link that leads back to a folder already being walked is
 * skipped, so a loop cannot walk forever. Folders the copy never sends
 * (`.git`, `node_modules`, …) are not walked at all.
 */
import fs from 'node:fs';
import path from 'node:path';

import {isExcludedName} from '../../domain/agent/config-copy';
import type {ConfigEntry} from '../../domain/agent/config-copy';
import type {ClaudeConfigSource} from '../../application/ports/claude-config';

export class NodeClaudeConfigSource implements ClaudeConfigSource {
    constructor(
        private readonly root: string,
        public readonly homeDir: string,
    ) {}

    public list(folder: string): ConfigEntry[] {
        const entries: ConfigEntry[] = [];
        const start = path.join(this.root, folder);
        const walk = (absolute: string, relative: string, seen: Set<string>) => {
            let real: string;
            try {
                real = fs.realpathSync(absolute);
            } catch {
                return;
            }
            if (seen.has(real)) return;
            const inner = new Set(seen).add(real);
            let names: string[];
            try {
                names = fs.readdirSync(absolute);
            } catch {
                return;
            }
            for (const name of names) {
                if (isExcludedName(name)) continue;
                const childAbsolute = path.join(absolute, name);
                const childRelative = relative ? `${relative}/${name}` : name;
                let stat: fs.Stats;
                try {
                    stat = fs.statSync(childAbsolute);
                } catch {
                    continue;
                }
                if (stat.isDirectory()) walk(childAbsolute, childRelative, inner);
                else if (stat.isFile()) entries.push(entryOf(childRelative, stat));
            }
        };
        walk(start, folder.replace(/\/+$/, ''), new Set());
        return entries;
    }

    public stat(relative: string): ConfigEntry | null {
        try {
            const stat = fs.statSync(path.join(this.root, relative));
            return stat.isFile() ? entryOf(relative, stat) : null;
        } catch {
            return null;
        }
    }

    public read(relative: string): Uint8Array {
        return fs.readFileSync(path.join(this.root, relative));
    }
}

function entryOf(relative: string, stat: fs.Stats): ConfigEntry {
    return {path: relative, size: stat.size, mode: stat.mode & 0o777, mtimeMs: stat.mtimeMs};
}
