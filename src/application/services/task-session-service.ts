/**
 * Starting a session from a BlaakTasks task (#244), up to the launch: which
 * repository it starts in, the worktree it gets there, and its first prompt.
 *
 * The repository is the one asked for, else the one the task is linked to,
 * else the one Ask Patch picks from the task's title and brief. Only a
 * confident pick starts at once; any other answer goes back to the renderer,
 * which offers the suggestions or the picker and asks again with a project.
 *
 * Like an issue start, this only prepares: the renderer starts Claude in the
 * worktree, because a session's row is the renderer's to make.
 */
import type { RouteCandidate, RouteRequest, RouteResult } from '../../domain/ask/model';
import type { ExistingBranchChoice } from '../../domain/project/branch-worktree';
import { isRemoteProjectPath } from '../../domain/project/remote-target';
import {
  taskBranchName, taskContinuePrompt, taskRouteText, taskSessionPrompt,
  type TaskSessionPreparation, type TaskStartInput,
} from '../../domain/tasks/start';
import { BranchWorktrees, type BranchSessionCandidate, type BranchWorktreesDeps } from './branch-worktrees';

export interface TaskSessionServiceDeps extends BranchWorktreesDeps<BranchSessionCandidate> {
  /** The project the task was last started or linked in; null when it has none yet. */
  repoOf(taskId: string): string | null;
  /** The projects Ask Patch may route to (`routeCandidates`). */
  candidates(): RouteCandidate[] | Promise<RouteCandidate[]>;
  /** Ask Patch's routing call. */
  router: { route(request: RouteRequest): Promise<RouteResult> };
}

export interface TaskSessionOptions {
  /** The project to start in, which skips the linked repo and routing. */
  projectPath?: string;
  /** What to do when the task's branch exists already; without it, the refusal. */
  existing?: ExistingBranchChoice;
}

export class TaskSessionService {
  readonly #worktrees: BranchWorktrees;

  constructor(private readonly deps: TaskSessionServiceDeps) {
    this.#worktrees = new BranchWorktrees(deps);
  }

  /** The worktree and prompt of a new session on `task`, or why there is none yet. */
  async prepare(task: TaskStartInput, { projectPath, existing }: TaskSessionOptions = {}): Promise<TaskSessionPreparation> {
    let project = projectPath ?? this.deps.repoOf(task.id);
    if (!project) {
      const routed = await this.deps.router.route({ text: taskRouteText(task), candidates: await this.deps.candidates() });
      // Patch's rewritten prompt is not used: the task's handoff is the prompt.
      if (routed.kind === 'unsure') return { kind: 'unsure', candidates: routed.candidates };
      if (routed.kind !== 'confident') return routed;
      project = routed.projectPath;
    }

    if (isRemoteProjectPath(project)) return failed('A session on a task can only start in a local project');
    const root = await this.deps.git.mainCheckout(project);
    if (!root) return failed('Not a git repository: ' + project);

    const made = await this.#worktrees.prepare({ root, branch: taskBranchName(task.title), existing });
    if (!made.ok) {
      return made.existing
        ? { kind: 'existing', projectPath: root, reason: made.reason, existing: made.existing }
        : failed(made.reason);
    }
    return {
      kind: 'ready',
      projectPath: root,
      worktreePath: made.worktreePath,
      branch: made.branch,
      prompt: made.reused ? taskContinuePrompt(task) : taskSessionPrompt(task),
      ...(made.warnings.length ? { warning: made.warnings.join(' ') } : {}),
    };
  }
}

function failed(reason: string): TaskSessionPreparation {
  return { kind: 'failed', reason };
}
