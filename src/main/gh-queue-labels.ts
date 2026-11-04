/**
 * The merge queue's two label writes (#315) through the user's own `gh`, as
 * `gh pr edit --add-label` / `--remove-label`.
 *
 * A stand-in: `GitHubCli` gains `addLabel` and `removeLabel` on the branch
 * that reads the queue, and once it has them the composition root hands the
 * queue errand service `github` itself and this file goes.
 */
import type {QueueLabelWriter} from '../application/services/queue-errand-service';
import type {GitHubWrite} from '../application/ports/github-cli';
import type {GhResult, GhRunner} from '../infrastructure/github/gh-cli';

export function ghQueueLabels(run: GhRunner): QueueLabelWriter {
    const edit = async (repo: string, number: number, flag: string, label: string): Promise<GitHubWrite> =>
        answer(await run(['pr', 'edit', String(number), '--repo', repo, flag, label]));
    return {
        addLabel: (repo, number, label) => edit(repo, number, '--add-label', label),
        removeLabel: (repo, number, label) => edit(repo, number, '--remove-label', label),
    };
}

function answer(result: GhResult): GitHubWrite {
    if (result.missing) return {ok: false, reason: 'gh is not installed'};
    if (result.code === 0) return {ok: true};
    const stderr = result.stderr.trim().split('\n').pop()?.replace(/^gh: /, '');
    return {ok: false, reason: stderr || 'GitHub did not answer'};
}
