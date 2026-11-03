/**
 * The note a file dropped on a VM session's terminal brings (#276 stage 5):
 * "Uploading 2 files to the VM…" while it uploads, and the error when it
 * fails. A finished upload takes the note away; its paths are typed into the
 * terminal. A newer drop replaces the note.
 *
 * The events are declared here rather than in `events.ts`, like the archive
 * Undo's, so the vocabulary stays in one file.
 */
import type {RendererEvent} from './events';

export type DropUploadEvent =
    /** A drop on a VM session started uploading; `id` tells this drop's later events apart. */
    | {type: 'dropUploadStarted'; id: number; text: string}
    /** It uploaded: its paths are typed, and the note goes. */
    | {type: 'dropUploadFinished'; id: number}
    | {type: 'dropUploadFailed'; id: number; error: string}
    /** The note was put away, or its error timed out. */
    | {type: 'dropUploadClosed'; id: number};

export interface DropUpload {
    readonly id: number;
    readonly phase: 'uploading' | 'failed';
    readonly text: string;
}

export interface DropUploadState {
    readonly upload: DropUpload | null;
}

export const initialDropUploadState: DropUploadState = {upload: null};

export function dropUploadReducer(state: DropUploadState, event: RendererEvent): DropUploadState {
    switch (event.type) {
        case 'dropUploadStarted':
            return {upload: {id: event.id, phase: 'uploading', text: event.text}};
        case 'dropUploadFinished':
        case 'dropUploadClosed':
            return state.upload?.id === event.id ? {upload: null} : state;
        case 'dropUploadFailed':
            return state.upload?.id === event.id ? {upload: {id: event.id, phase: 'failed', text: event.error}} : state;
        default:
            return state;
    }
}
