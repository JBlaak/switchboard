/**
 * A test rebase in a bare clone (#435): whether a waiting PR's branch rebases
 * cleanly onto its trunk, without pushing, checking out or touching any
 * working tree, exactly what the merge queue does to find conflicts.
 *
 * Each repository gets a bare clone of its own under `directory`, made on
 * first use; each test fetches just the trunk and the branch into it. Then:
 *
 * 1. `git replay --ref-action=print --onto <trunk> <trunk>..<branch>` replays
 *    the branch commit by commit, as a rebase would, and prints the refs it
 *    would move instead of moving them (exit 0 clean, 1 conflict). A git
 *    whose `replay` predates `--ref-action` prints them anyway, so it is
 *    tried without the flag; `replay` is experimental, so anything else it
 *    answers falls through to:
 * 2. `git merge-tree --write-tree --name-only <trunk> <branch>`, one merge
 *    rather than a rebase (exit 0 clean, 1 conflict), which also names the
 *    conflicting files. It is asked for the file list after a replay found a
 *    conflict, too.
 *
 * Neither writes anything but objects into the bare clone. Fetches run as
 * writes (`GitRunner`'s tool environment, no credential prompt), so they use
 * the user's own git credentials, as a fetch in their checkout would.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {TestRebase, TestRebaseAnswer} from '../../application/ports/test-rebase';
import type {GitRunner} from './git-runner';

/** How long a fetch may take: a first one brings the trunk's whole history. */
const FETCH_TIMEOUT_MS = 5 * 60_000;
/** How long a replay or a merge-tree may take. */
const TEST_TIMEOUT_MS = 60_000;

/** `owner/repo`, both parts in GitHub's own alphabet. */
const REPO = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/;

export interface GitTestRebaseOptions {
    git: Pick<GitRunner, 'git'>;
    /** Where the bare clones live, one per repository. */
    directory: string;
    /** The URL a repository is fetched from; GitHub over HTTPS by default. */
    originUrl?: (repository: string) => string;
}

export class GitTestRebase implements TestRebase {
    constructor(private readonly options: GitTestRebaseOptions) {}

    public async conflicts(repository: string, trunk: string, branch: string): Promise<TestRebaseAnswer | null> {
        const parts = REPO.exec(repository);
        if (!parts || !isBranchName(trunk) || !isBranchName(branch)) return null;
        const clone = await this.clone(parts[1], parts[2], repository);
        if (!clone) return null;

        const theirs = `refs/remotes/origin/${trunk}`;
        const ours = `refs/remotes/origin/${branch}`;
        const fetched = await this.git(
            clone,
            [
                'fetch',
                '--quiet',
                '--no-tags',
                '--force',
                'origin',
                `refs/heads/${trunk}:${theirs}`,
                `refs/heads/${branch}:${ours}`,
            ],
            FETCH_TIMEOUT_MS,
            true,
        );
        if (fetched.code !== 0) return null;

        const replayed = await this.replay(clone, theirs, ours);
        if (replayed === false) return {conflict: false, files: []};
        const merged = await this.mergeTree(clone, theirs, ours);
        if (replayed === true) return {conflict: true, files: merged?.files ?? []};
        return merged;
    }

    /** Whether replaying the branch onto the trunk conflicts; null when `replay` could not say. */
    private async replay(clone: string, trunk: string, branch: string): Promise<boolean | null> {
        const range = ['--onto', trunk, `${trunk}..${branch}`];
        let run = await this.git(clone, ['replay', '--ref-action=print', ...range], TEST_TIMEOUT_MS);
        if (run.code === 129 || (run.code !== 0 && run.code !== 1 && /ref-action/.test(run.stderr))) {
            run = await this.git(clone, ['replay', ...range], TEST_TIMEOUT_MS);
        }
        // A git without `replay` exits 1 too, saying it has no such command.
        if (/not a git command/i.test(run.stderr)) return null;
        if (run.code === 0) return false;
        if (run.code === 1) return true;
        return null;
    }

    /** Whether merging the branch into the trunk conflicts, and in which files; null when it could not say. */
    private async mergeTree(clone: string, trunk: string, branch: string): Promise<TestRebaseAnswer | null> {
        const run = await this.git(
            clone,
            ['merge-tree', '--write-tree', '--name-only', '--no-messages', trunk, branch],
            TEST_TIMEOUT_MS,
        );
        if (run.code === 0) return {conflict: false, files: []};
        if (run.code !== 1) return null;
        // The tree's id, then one conflicting file per line.
        const files = run.stdout
            .split('\n')
            .slice(1)
            .filter((line) => line.trim() !== '');
        return {conflict: true, files: [...new Set(files)]};
    }

    /** The repository's bare clone, made on first use; null when it cannot be. */
    private async clone(owner: string, name: string, repository: string): Promise<string | null> {
        const dir = path.join(this.options.directory, owner.toLowerCase(), `${name.toLowerCase()}.git`);
        if (fs.existsSync(path.join(dir, 'HEAD'))) return dir;
        try {
            await fs.promises.mkdir(dir, {recursive: true});
        } catch {
            return null;
        }
        const url = this.options.originUrl?.(repository) ?? `https://github.com/${repository}.git`;
        const init = await this.git(dir, ['init', '--quiet', '--bare'], TEST_TIMEOUT_MS, true);
        const remote =
            init.code === 0 ? await this.git(dir, ['remote', 'add', 'origin', url], TEST_TIMEOUT_MS, true) : init;
        if (remote.code === 0) return dir;
        await fs.promises.rm(dir, {recursive: true, force: true}).catch(() => undefined);
        return null;
    }

    private async git(
        cwd: string,
        args: readonly string[],
        timeoutMs: number,
        write = false,
    ): Promise<{code: number | null; stdout: string; stderr: string}> {
        const run = await this.options.git.git(cwd, args, {timeoutMs, write});
        return {code: run.code, stdout: run.stdout.toString('utf8'), stderr: run.stderr};
    }
}

/** A branch name git takes as given: no option, no range, no ref syntax. */
function isBranchName(name: string): boolean {
    return (
        name.length > 0 &&
        !name.startsWith('-') &&
        !name.includes('..') &&
        !/[\s~^:?*[\\]/.test(name) &&
        !name.endsWith('.lock') &&
        !name.endsWith('/')
    );
}
