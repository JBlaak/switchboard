/**
 * The agent's log, to stderr, which systemd puts in the journal (#276).
 *
 * Each line starts with an sd-daemon priority prefix (`<3>` error … `<7>`
 * debug). journald reads it as the line's level and strips it, so
 * `journalctl --user -u switchboard-agent -p warning` filters as it should.
 * Run by hand the prefixes simply show.
 */
import {format} from 'node:util';

import type {Logger} from '../application/ports/logger';

const PRIORITY = {error: 3, warn: 4, info: 6, debug: 7} as const;

export function stderrLogger(write: (line: string) => void = (line) => process.stderr.write(line)): Logger {
    const at =
        (level: keyof typeof PRIORITY) =>
        (message: string, ...args: unknown[]) =>
            write(`<${PRIORITY[level]}>${format(message, ...args)}\n`);
    return {debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error')};
}
