/**
 * What the plan view's components take. The view knows nothing about the page
 * around it (W1, F2): its plans come in as props, what is hovered and selected
 * as `PlanUi`, and everything it does goes out through `PlanHandlers`.
 */
import type {IssueKey, Plan, PlanSummary} from '../../../../domain/plan/model';
import type {PlanLevelStart, PlanStart, SessionPlansAnswer} from '../../../state/plan-slice';
import type {HandoffHost} from '../../../../application/services/project-handoff';

/** The plan page's pin, which puts the plan at the top of the sidebar; the Plan tab has none. */
export interface PlanPinControl {
    readonly pinned: boolean;
    toggle(): void;
}

/** Where a stored copy on screen is: being refreshed, or main could not answer (`planRefresh`). */
export type PlanRefresh = 'refreshing' | 'failed';

/**
 * Which sessions own which issues (S1) and which of them run on this Mac now,
 * for the mark on each plan that has one (`runningOnPlan`).
 */
export interface PlanLiveSessions {
    /** `owner/repo#n` → the session that owns it. */
    readonly owners: Readonly<Record<string, string>>;
    /** The ids of the sessions whose terminal is alive. */
    readonly running: ReadonlySet<string>;
}

/** A session's plans (W2), or one plan given directly (F2). */
export type PlanData = {readonly sessionPlans: SessionPlansAnswer} | {readonly plan: Plan};

export interface PlanUi {
    /** The plan picked in the switcher; null is the first. */
    readonly chosen: IssueKey | null;
    readonly hovered: IssueKey | null;
    readonly selected: IssueKey | null;
}

export const NO_PLAN_UI: PlanUi = {chosen: null, hovered: null, selected: null};

export interface PlanHandlers {
    choose(plan: IssueKey): void;
    hover(issue: IssueKey | null): void;
    /** null closes the detail. */
    select(issue: IssueKey | null): void;
    /** ↑ (-1) and ↓ (1) in the detail (D4). */
    step(direction: 1 | -1): void;
    /** Open a GitHub page in the browser. */
    open(url: string): void;
    /** A plan picked from the repository's others (W2); absent where there are none to pick. */
    pickOther?(summary: PlanSummary): void;
    /** Back to the plans the view opened with, after picking another; absent when there is nowhere to go back to. */
    back?(): void;
}

/** The session that owns an issue (S1), as a node and the detail show it. */
export interface IssueSession {
    readonly id: string;
    readonly name: string;
    readonly working: boolean;
}

/**
 * What sessions can do for an issue (#125). Each is optional: absent, its
 * button and the node's session line show nothing, which is how the view is
 * drawn without a project to start sessions in.
 */
export interface IssueActions {
    /** The session that owns an issue (S1), or null. */
    sessionFor?(issue: IssueKey): IssueSession | null;
    /** Jump to session (A1). */
    jumpToSession?(sessionId: string): void;
    /**
     * Start session pressed on an issue (A2); a Locked one asks to confirm
     * first (A3), and so does any one while there are `vmHosts` to hand it off to.
     */
    startSession?(issue: IssueKey, plan: Plan): void;
    /** Confirm the start that is asking: here, or handed off to `vm`. */
    confirmStart?(plan: Plan, vm?: HandoffHost): void;
    /**
     * The VMs a start may be handed off to, which its confirmation offers
     * ("Do you want to hand this off to…?"); none for a project on a VM already.
     */
    readonly vmHosts?: readonly HandoffHost[];
    cancelStart?(): void;
    /**
     * Start again on an issue whose branch exists already: `replace` deletes its
     * worktree and branch first, `reuse` continues in them.
     */
    startAgain?(issue: IssueKey, plan: Plan, existing: 'replace' | 'reuse'): void;
    /** Where the start on the selected issue is. */
    readonly start?: PlanStart | null;
    /** Start level pressed on the current level (A1): asks to confirm `issues`, its Ready ones. */
    startLevel?(plan: Plan, level: number, issues: IssueKey[]): void;
    /** Confirm the level start that is asking: here, or handed off to `vm`. */
    confirmLevelStart?(plan: Plan, vm?: HandoffHost): void;
    /** Turn the confirmation down, or put the answer away. */
    cancelLevelStart?(): void;
    /** Where Start level is, for any plan; the view shows it for its own. */
    readonly levelStart?: PlanLevelStart | null;
}

export const NO_HANDLERS: PlanHandlers = {
    choose: () => {},
    hover: () => {},
    select: () => {},
    step: () => {},
    open: () => {},
};
