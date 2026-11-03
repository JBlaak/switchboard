/**
 * OmniDiff's command line behind the StructuralDiffer port.
 *
 * Each refinement writes the two texts to a temporary directory of its own,
 * as `before/<name>` and `after/<name>` (OmniDiff picks the language from the
 * file's name), runs `omnidiff --mode json --minimal` on them and parses what
 * it prints. The directory is gone again however the run ends.
 *
 * `--minimal` fixes the output: without it OmniDiff reads its render options
 * from the user's saved config. It also writes that config on its first run,
 * so it runs with HOME and every XDG directory pointed inside the temporary
 * directory, never at the user's own.
 *
 * A failure of any kind (no binary, a crash, a timeout, output too large or
 * not understood) is null: the diff is then drawn by its lines, as before.
 */
import {execFile} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {refinementFromOmnidiff, type FileRefinement} from '../../domain/session-work/refinement';
import type {Logger} from '../../application/ports/logger';
import type {StructuralDiffer} from '../../application/ports/structural-differ';

/** A file takes 5–150 ms; this is for a hung process. */
const TIMEOUT_MS = 5_000;

/** A refinement of the largest file the page asks about is far below this. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/** How many OmniDiffs run at once; the rest wait their turn. */
const MAX_CONCURRENT = 4;

export interface OmnidiffDifferDeps {
    /** The `omnidiff` executable. */
    binary: string;
    log: Logger;
    /** Where the temporary directories go; the system's by default. */
    tempDir?: string;
    timeoutMs?: number;
    maxOutputBytes?: number;
    maxConcurrent?: number;
}

export class OmnidiffDiffer implements StructuralDiffer {
    private running = 0;
    private readonly waiting: Array<() => void> = [];

    constructor(private readonly deps: OmnidiffDifferDeps) {}

    public async refine(filePath: string, before: string, after: string): Promise<FileRefinement | null> {
        await this.slot();
        try {
            return await this.run(filePath, before, after);
        } catch (err) {
            this.deps.log.warn('[omnidiff] could not refine', filePath, (err as Error).message);
            return null;
        } finally {
            this.release();
        }
    }

    private async run(filePath: string, before: string, after: string): Promise<FileRefinement | null> {
        const dir = await fs.mkdtemp(path.join(this.deps.tempDir ?? os.tmpdir(), 'switchboard-omnidiff-'));
        try {
            const name = fileName(filePath);
            const beforePath = path.join(dir, 'before', name);
            const afterPath = path.join(dir, 'after', name);
            const home = path.join(dir, 'home');
            await Promise.all(['before', 'after', 'home'].map((sub) => fs.mkdir(path.join(dir, sub))));
            await Promise.all([fs.writeFile(beforePath, before), fs.writeFile(afterPath, after)]);

            const stdout = await this.omnidiff(filePath, [beforePath, afterPath], {
                PATH: process.env.PATH ?? '/usr/bin:/bin',
                HOME: home,
                XDG_CONFIG_HOME: path.join(home, '.config'),
                XDG_CACHE_HOME: path.join(home, '.cache'),
                XDG_DATA_HOME: path.join(home, '.local', 'share'),
                XDG_STATE_HOME: path.join(home, '.local', 'state'),
                NO_COLOR: '1',
            });
            if (stdout === null) return null;

            let json: unknown;
            try {
                json = JSON.parse(stdout);
            } catch {
                this.deps.log.debug('[omnidiff] output is not JSON for', filePath);
                return null;
            }
            const refinement = refinementFromOmnidiff(json, before, after);
            if (!refinement) this.deps.log.debug('[omnidiff] output not understood for', filePath);
            return refinement;
        } finally {
            await fs.rm(dir, {recursive: true, force: true}).catch((err: Error) => {
                this.deps.log.warn('[omnidiff] could not remove', dir, err.message);
            });
        }
    }

    /** OmniDiff's stdout, or null when it did not succeed. */
    private omnidiff(filePath: string, files: string[], env: NodeJS.ProcessEnv): Promise<string | null> {
        const {binary, log} = this.deps;
        return new Promise((resolve) => {
            execFile(
                binary,
                ['--mode', 'json', '--minimal', ...files],
                {
                    env,
                    timeout: this.deps.timeoutMs ?? TIMEOUT_MS,
                    killSignal: 'SIGKILL',
                    maxBuffer: this.deps.maxOutputBytes ?? MAX_OUTPUT_BYTES,
                    encoding: 'utf8',
                },
                (err, stdout, stderr) => {
                    if (!err) {
                        resolve(stdout);
                        return;
                    }
                    const failure = err as Error & {killed?: boolean; code?: unknown};
                    if (failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
                        log.debug('[omnidiff] output too large for', filePath);
                    } else if (failure.killed) log.warn('[omnidiff] timed out or was killed on', filePath);
                    else log.debug('[omnidiff] failed on', filePath, String(failure.code), stderr.trim().slice(0, 500));
                    resolve(null);
                },
            );
        });
    }

    private slot(): Promise<void> {
        if (this.running < (this.deps.maxConcurrent ?? MAX_CONCURRENT)) {
            this.running++;
            return Promise.resolve();
        }
        // The slot is handed over by `release`, so `running` stays counted.
        return new Promise((resolve) => this.waiting.push(resolve));
    }

    private release(): void {
        const next = this.waiting.shift();
        if (next) next();
        else this.running--;
    }
}

/** The file's own name, which picks OmniDiff's language; a name that could not be one is replaced. */
function fileName(filePath: string): string {
    const name = filePath.split('/').pop() ?? '';
    return name === '' || name === '.' || name === '..' ? 'file' : name;
}
