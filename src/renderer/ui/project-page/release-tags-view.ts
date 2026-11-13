/**
 * The line under Releases are tagged in a project's settings (#412): what
 * the project's tags say, so "Detected" is not a guess you have to trust.
 */
import {RELEASE_TAG_WINDOW_DAYS} from '../../../domain/settings/inbox-settings';
import type {ReleaseTagsView} from '../../../application/services/inbox-settings-service';

/** `tags` is undefined while main is asked, null when it could not answer. */
export function releaseTagsHelp(tags: ReleaseTagsView | null | undefined): string {
    if (tags === undefined) return 'Reading its tags…';
    if (tags === null) return 'Its tags could not be read.';
    if (tags.repository === null) return 'It has no GitHub repository, so its tags cannot be read.';
    if (tags.detected === null) return `The tags of ${tags.repository} could not be read from GitHub.`;
    if (tags.latestTagAt === null) return `Detected as not tagged: ${tags.repository} has no tags.`;
    const day = new Date(tags.latestTagAt).toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
    });
    return tags.detected
        ? `Detected as tagged: its newest tag is from ${day}, within the last ${RELEASE_TAG_WINDOW_DAYS} days.`
        : `Detected as not tagged: its newest tag is from ${day}, more than ${RELEASE_TAG_WINDOW_DAYS} days ago.`;
}
