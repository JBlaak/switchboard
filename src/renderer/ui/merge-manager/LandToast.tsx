/**
 * The toast a Land it brings (#436): "Landed #432 · 2nd in switchboard's
 * lane", with Open Merge manager (#439) and Undo (Unland), or why it did not
 * land. It floats at the foot
 * of the main area with the archive's Undo (`MainFloats` in `Root`), and the
 * timer waits while the pointer is over it.
 */
import {useEffect, useState} from 'react';
import type {JSX} from 'react';
import {useStore} from '../use-store';
import {closeLandToast, undoLand} from './land-actions';
import {openMergeManager} from './page-actions';
import {landedKey} from '../../../domain/merge-manager/model';

/** How long the toast stays up. */
export const LAND_TOAST_MS = 6000;

export function LandToast(): JSX.Element | null {
    const toast = useStore((state) => state.mergeManager.toast);
    const [hovered, setHovered] = useState(false);
    const id = toast?.id ?? null;

    useEffect(() => {
        if (id === null || hovered) return;
        const timer = setTimeout(() => closeLandToast(id), LAND_TOAST_MS);
        return () => clearTimeout(timer);
    }, [id, hovered]);

    if (!toast) return null;

    return (
        <div
            key={toast.id}
            className={'land-toast is-' + toast.kind}
            role="status"
            data-testid="land-toast"
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}>
            <span className="land-toast-text">{toast.text}</span>
            {toast.kind === 'landed' && (
                <button
                    type="button"
                    className="sw-btn land-toast-btn"
                    onClick={() => {
                        closeLandToast(toast.id);
                        openMergeManager(landedKey(toast.repository, toast.number));
                    }}>
                    Open Merge manager
                </button>
            )}
            {toast.kind === 'landed' && (
                <button type="button" className="sw-btn land-toast-btn" onClick={undoLand}>
                    Undo
                </button>
            )}
            <button
                type="button"
                className="land-toast-close"
                aria-label="Dismiss"
                onClick={() => closeLandToast(toast.id)}>
                ✕
            </button>
        </div>
    );
}
