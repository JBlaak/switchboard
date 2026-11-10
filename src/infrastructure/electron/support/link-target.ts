/**
 * Where a link the renderer tried to follow goes: a pull request into the
 * app's own diff viewer (when the window has one), any other web page to the
 * browser, anything else nowhere.
 */
import {parsePullRequestUrl} from '../../../domain/session-work/pull-request-link';

export type LinkTarget = 'pull-request' | 'browser' | null;

/** `pullRequests`: the window shows PR links itself rather than in the browser. */
export function linkTarget(url: string, pullRequests: boolean): LinkTarget {
    if (!/^https?:\/\//i.test(url)) return null;
    if (pullRequests && parsePullRequestUrl(url)) return 'pull-request';
    return 'browser';
}
