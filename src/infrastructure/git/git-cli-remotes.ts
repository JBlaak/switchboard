/**
 * `git remote get-url origin` behind the GitRemotes port.
 *
 * Asking git rather than reading `.git/config` is what makes a worktree work:
 * its `.git` is a file pointing back at the main checkout, and git follows it.
 *
 * Without a runner it asks the Mac's own git, as it always has; given one (a
 * VM's, #276 stage 4) it asks git wherever that runner runs it. The answer is
 * a URL, not a path, so nothing needs translating on the way back.
 */
import {execFile} from 'node:child_process';
import type {GitRemotes} from '../../application/ports/git-remotes';
import type {GitRunner} from './git-runner';

const TIMEOUT_MS = 5_000;

export class GitCliRemotes implements GitRemotes {
    constructor(private readonly runner?: Pick<GitRunner, 'git'>) {}

    public async originUrl(projectPath: string): Promise<string | null> {
        if (this.runner) {
            const run = await this.runner.git(projectPath, ['remote', 'get-url', 'origin'], {timeoutMs: TIMEOUT_MS});
            return run.code === 0 ? run.stdout.toString('utf8').trim() || null : null;
        }
        return new Promise((resolve) => {
            execFile('git', ['-C', projectPath, 'remote', 'get-url', 'origin'], {timeout: TIMEOUT_MS}, (err, stdout) =>
                resolve(err ? null : stdout.trim() || null),
            );
        });
    }
}
