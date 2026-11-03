/**
 * "Uploading 2 files to the VM…", while files dropped on a VM session's
 * terminal go up (#276 stage 5), and the error when they don't: nothing is
 * typed then. It floats at the foot of the main area with the Undo toast, and
 * leaves the focus in the terminal. The error stays a few seconds, longer
 * while the pointer is over it.
 */
import {useEffect, useState} from 'react';
import type {JSX} from 'react';
import {dispatch} from '../../state/app-store';
import {useStore} from '../use-store';

/** How long an upload's error stays up. */
export const DROP_ERROR_MS = 8000;

export function DropUploadToast(): JSX.Element | null {
    const upload = useStore((state) => state.dropUpload.upload);
    const [hovered, setHovered] = useState(false);
    const failed = upload?.phase === 'failed' ? upload.id : null;

    useEffect(() => {
        if (failed === null || hovered) return;
        const timer = setTimeout(() => dispatch({type: 'dropUploadClosed', id: failed}), DROP_ERROR_MS);
        return () => clearTimeout(timer);
    }, [failed, hovered]);

    if (!upload) return null;
    const isError = upload.phase === 'failed';

    return (
        <div
            key={upload.id}
            className={'archive-undo drop-upload' + (isError ? ' is-error' : '')}
            role={isError ? 'alert' : 'status'}
            data-testid="drop-upload"
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}>
            <span className="drop-upload-text">{upload.text}</span>
            {isError && (
                <button
                    type="button"
                    className="archive-undo-close"
                    aria-label="Dismiss"
                    onClick={() => dispatch({type: 'dropUploadClosed', id: upload.id})}>
                    ✕
                </button>
            )}
        </div>
    );
}
