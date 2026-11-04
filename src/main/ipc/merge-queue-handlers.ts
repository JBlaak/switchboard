/**
 * The merge queue's buttons (#315): Nudge, Fix in session, Retry and Opt in,
 * and the errand sessions Nudge and Fix start. Every request is checked for
 * shape here; what it may do is the queue errand service's to say.
 */
import {INVOKE} from '../../ipc/channels';
import type {FailureKind} from '../../domain/project/merge-queue';
import type {FixRequest, NudgeRequest} from '../../domain/project/queue-errands';
import type {Container} from '../composition-root';
import type {IpcRegistrar} from './support/registrar';

const FAILURE_KINDS: readonly FailureKind[] = [
    'ci',
    'conflict',
    'changes-requested',
    'unresolved-thread',
    'merge-refused',
    'other',
];

export function registerMergeQueueHandlers(ipc: IpcRegistrar, app: Container): void {
    ipc.handle(INVOKE.queueNudge, (request: NudgeRequest) => {
        const {repository, pr, reviewer, message} = request ?? ({} as Partial<NudgeRequest>);
        if (!isText(repository) || !isPr(pr) || !isText(reviewer) || !isText(message)) {
            return {ok: false, reason: 'Not a request to nudge a reviewer'};
        }
        return app.queueErrands.nudge({
            repository,
            pr: {number: pr.number, title: pr.title, url: pr.url},
            reviewer,
            message,
        });
    });
    ipc.handle(INVOKE.queueForgetNudge, (repository: string, number: number, reviewer: string) => {
        if (isText(repository) && isNumber(number) && isText(reviewer)) {
            app.queueErrands.forgetNudge(repository, number, reviewer);
        }
    });
    ipc.handle(INVOKE.queueSettleNudges, (repository: string, held: {number: number; reviewer: string}[]) => {
        if (!isText(repository) || !Array.isArray(held)) return;
        app.queueErrands.settleNudges(
            repository,
            held.filter((entry) => isNumber(entry?.number) && isText(entry?.reviewer)),
        );
    });
    ipc.handle(INVOKE.queueFix, (request: FixRequest) => {
        const {repository, projectPath, pr, failure} = request ?? ({} as Partial<FixRequest>);
        if (
            !isText(repository) ||
            !isText(projectPath) ||
            !isPr(pr) ||
            typeof pr.headRef !== 'string' ||
            !failure ||
            !FAILURE_KINDS.includes(failure.kind) ||
            typeof failure.reason !== 'string'
        ) {
            return {ok: false, reason: 'Not a request to fix a PR that left the queue'};
        }
        return app.queueErrands.fix({
            repository,
            projectPath,
            pr: {
                number: pr.number,
                title: pr.title,
                url: pr.url,
                headRef: pr.headRef,
                ...(isText(pr.baseRef) ? {baseRef: pr.baseRef} : {}),
            },
            failure: {
                kind: failure.kind,
                reason: failure.reason,
                checkName: isText(failure.checkName) ? failure.checkName : null,
                checkRunUrl: isText(failure.checkRunUrl) ? failure.checkRunUrl : null,
            },
        });
    });
    ipc.handle(INVOKE.queueRetry, (repository: string, number: number) =>
        isText(repository) && isNumber(number)
            ? app.queueErrands.retry(repository, number)
            : {ok: false, reason: 'Not a PR to retry'},
    );
    ipc.handle(INVOKE.queueOptIn, (repository: string, number: number) =>
        isText(repository) && isNumber(number)
            ? app.queueErrands.optIn(repository, number)
            : {ok: false, reason: 'Not a PR to opt in'},
    );
    ipc.handle(INVOKE.queueErrandStarted, (errandId: string, sessionId: string) =>
        isText(errandId) && isText(sessionId)
            ? app.queueErrands.started(errandId, sessionId)
            : {ok: false, reason: 'Not an errand and its session'},
    );
    ipc.handle(INVOKE.queueErrandAbandoned, (errandId: string) =>
        isText(errandId) ? app.queueErrands.abandon(errandId) : {ok: false, reason: 'Not an errand'},
    );
    ipc.handle(INVOKE.queueErrands, (repository?: string) =>
        app.queueErrands.errands(isText(repository) ? repository : undefined),
    );
}

function isText(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0;
}

function isNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isPr(
    value: unknown,
): value is {number: number; title: string; url: string; headRef?: unknown; baseRef?: unknown} {
    if (typeof value !== 'object' || value === null) return false;
    const pr = value as Record<string, unknown>;
    return isNumber(pr.number) && typeof pr.title === 'string' && isText(pr.url);
}
