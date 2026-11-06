/**
 * The claude.ai artifacts a session published or pointed you at (#340).
 *
 * There is no record of "this session published that page" other than the
 * conversation itself, so this reads it the way a person would: the Artifact
 * tool's result says where it published ("Published … at <url>", "Created a
 * new Artifact at <url>", "Updated the Artifact at <url>"), and Claude's own
 * replies carry the link it gave you.
 *
 * Only those two places count. A tool result is mostly other text: a type
 * listing names a dozen artifact types, `gh issue view` an issue's design
 * link, and none of those are the session's. Your own messages are left out
 * for the same reason: a link you pasted is what you brought, not what the
 * session made.
 */
import {toolResultText, transcriptBlocks} from './support/transcript-blocks';

/** An artifact a transcript links to. */
export interface ArtifactRef {
    /** The id in its URL: `claude.ai/artifact/<id>` or `claude.ai/code/artifact/<id>`. */
    id: string;
    /** The URL as the session gave it, without query or fragment. */
    url: string;
    /** The title the Artifact call gave it, when one did; null otherwise. */
    title: string | null;
}

const ARTIFACT_URL = /https:\/\/claude\.ai\/(?:code\/)?artifact\/([A-Za-z0-9][A-Za-z0-9-]*)/g;

/** The phrases an Artifact tool result names the artifact it wrote with. */
const PUBLISHED_AT =
    /(?:Created a new Artifact|Updated the Artifact|Published\b[^\n]*?)\s+at\s+(https:\/\/claude\.ai\/(?:code\/)?artifact\/([A-Za-z0-9][A-Za-z0-9-]*))/g;

/** The claude.ai artifact URLs in a piece of text, in order. */
export function artifactUrlsInText(text: string): Array<{url: string; id: string}> {
    return [...text.matchAll(ARTIFACT_URL)].map((match) => ({url: match[0], id: match[1]}));
}

/** The artifacts an Artifact tool result says it published, created or updated, in order. */
export function publishedArtifactsInResult(text: string): Array<{url: string; id: string}> {
    return [...text.matchAll(PUBLISHED_AT)].map((match) => ({url: match[1], id: match[2]}));
}

/**
 * The artifacts a transcript links to, in the order they first appear, once
 * each (by id): the ones a tool result says were published, and the ones in
 * Claude's replies.
 *
 * A title comes from the tool call whose result named the artifact, when
 * that call carried one (an artifact created from a type is named that way);
 * a later call's title replaces an earlier one, since a rename is newer.
 */
export function artifactsInTranscript(lines: readonly string[]): ArtifactRef[] {
    const found = new Map<string, ArtifactRef>();
    const titles = new Map<string, string>();
    const add = (ref: {url: string; id: string}, title: string | null) => {
        const known = found.get(ref.id);
        if (!known) found.set(ref.id, {id: ref.id, url: ref.url, title});
        else if (title) known.title = title;
    };

    for (const block of transcriptBlocks(lines)) {
        if (block.role === 'assistant' && block.type === 'text' && typeof block.text === 'string') {
            for (const ref of artifactUrlsInText(block.text)) add(ref, null);
        } else if (block.role === 'assistant' && block.type === 'tool_use' && typeof block.id === 'string') {
            const title = (block.input as {title?: unknown} | null | undefined)?.title;
            if (typeof title === 'string' && title.trim()) titles.set(block.id, title.trim());
        } else if (block.role === 'user' && block.type === 'tool_result' && block.is_error !== true) {
            const title = typeof block.tool_use_id === 'string' ? (titles.get(block.tool_use_id) ?? null) : null;
            for (const ref of publishedArtifactsInResult(toolResultText(block.content))) add(ref, title);
        }
    }
    return [...found.values()];
}
