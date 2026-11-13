/**
 * Fixed reads for the Merge manager's tests (#434): one PR as the lane read
 * sees it, a lane read, and a landed PR.
 */
import {landedKey} from '../../src/domain/merge-manager/model';
import type {
    LandedPullRequest,
    LanePullRequestRead,
    LaneRead,
    LaneStage,
    TrunkRules,
} from '../../src/domain/merge-manager/model';

export const ME = 'joris';
export const REPO = 'movelab/connect';
export const NOW = Date.parse('2026-11-13T12:00:00Z');
export const MIN = 60_000;

export const NO_RULES: TrunkRules = {
    requiredChecks: [],
    approvalLostOnPush: false,
    mergeMethods: null,
    linearHistory: false,
};
export const RULES: TrunkRules = {...NO_RULES, requiredChecks: ['Unit tests']};

/** My open, approved PR on main, up to date with green checks. */
export function prRead(number: number, overrides: Partial<LanePullRequestRead> = {}): LanePullRequestRead {
    return {
        id: `PR_${number}`,
        repository: REPO,
        number,
        title: `PR ${number}`,
        url: `https://github.com/${REPO}/pull/${number}`,
        author: ME,
        state: 'open',
        mergedAt: null,
        draft: false,
        headRef: `branch-${number}`,
        headOid: `oid-${number}`,
        baseRef: 'main',
        labels: [],
        automerge: null,
        review: 'approved',
        approvedBy: ['ben'],
        requestedReviewers: [],
        unresolvedThreads: 0,
        mergeState: 'clean',
        checks: [{name: 'Unit tests', state: 'passed', startedAt: NOW - 10 * MIN}],
        runs: [{id: 1000 + number, state: 'finished'}],
        ...overrides,
    };
}

export function laneRead(pullRequests: LanePullRequestRead[], rules: TrunkRules = RULES): LaneRead {
    return {
        repository: REPO,
        viewer: ME,
        trunk: 'main',
        trunkOid: 'trunk-1',
        rules,
        mergeMethods: ['squash', 'merge'],
        pullRequests,
    };
}

/** A PR landed `minutesAgo` before NOW, at `stage`. */
export function landedPr(
    number: number,
    minutesAgo: number,
    lane: LandedPullRequest['lane'] = 'switchboard',
    stage: LaneStage = {kind: 'waiting', willConflict: false, position: null},
    overrides: Partial<LandedPullRequest> = {},
): LandedPullRequest {
    return {
        key: landedKey(REPO, number),
        repository: REPO,
        number,
        title: `PR ${number}`,
        url: `https://github.com/${REPO}/pull/${number}`,
        headRef: `branch-${number}`,
        lane,
        landedAt: NOW - minutesAgo * MIN,
        stage,
        setAside: null,
        errand: null,
        ...overrides,
    };
}

export const HEAD: LaneStage = {kind: 'head', step: 'merging'};
