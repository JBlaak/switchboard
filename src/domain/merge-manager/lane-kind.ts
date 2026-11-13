/**
 * Which kind of lane a repository has (#434): a queue lane when its default
 * branch runs MoveLab's merge-queue Action, a Switchboard lane otherwise.
 *
 * Read from the workflow files, not from the PRs: a queue repository whose
 * open PRs carry no queue label yet is still a queue repository, and the
 * Switchboard lane must never take over a PR the queue would merge. The
 * Action is used as a step (`uses: MoveLab-Studio/merge-queue@v1`) or through
 * its reusable trigger workflow (`uses: MoveLab-Studio/merge-queue/.github/…`).
 */
import type {LaneKind, WorkflowFile} from './model';

/** The merge-queue Action's repository, as a `uses:` line names it. */
export const QUEUE_ACTION = 'MoveLab-Studio/merge-queue';

const USES_QUEUE = new RegExp(String.raw`^\s*(?:-\s*)?uses:\s*["']?${QUEUE_ACTION.replace('/', '\\/')}(?:@|\/)`, 'im');

/** A workflow file is YAML; only `.yml` and `.yaml` ones run. */
const WORKFLOW_FILE = /\.ya?ml$/i;

export function laneKindOf(workflows: readonly WorkflowFile[]): LaneKind {
    const queue = workflows.some((file) => WORKFLOW_FILE.test(file.name) && USES_QUEUE.test(file.text));
    return queue ? 'queue' : 'switchboard';
}
