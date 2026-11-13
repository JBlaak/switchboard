/**
 * Land it (#436), as each of its four places draws it: the button on your own
 * open PR, disabled with "Mark it ready for review first" on a draft, and,
 * once the PR is landed, its stage: "Landed · 2nd in switchboard ▾", whose
 * menu has Open in Merge manager (#439) and Unland.
 *
 * `LandItControl` is the markup from what it is given, so a test can draw it;
 * `LandIt` feeds it from the store.
 */
import {useEffect, useRef, useState} from 'react';
import type {JSX, MouseEvent} from 'react';
import {landOffer, landedPillText, type LandCandidate, type LandOffer} from '../../../domain/merge-manager/land-it';
import {landBusy, type LandAction} from '../../state/merge-manager-slice';
import {useStore} from '../use-store';
import {landPullRequest, unlandPullRequest} from './land-actions';
import {openMergeManager} from './page-actions';
import {landedKey} from '../../../domain/merge-manager/model';

export interface LandItProps {
    pr: LandCandidate;
    /** `sm` in the tight places: the tray and the project page's rows. */
    size?: 'sm';
}

/** Land it for `pr`, or its landed stage; nothing for a PR that is neither yours nor landed. */
export function LandIt({pr, size}: LandItProps): JSX.Element | null {
    const lanes = useStore((state) => state.mergeManager.state);
    const offer = landOffer(pr, lanes);
    const busy = useStore((state) => landBusy(state.mergeManager, pr.repository, pr.number));
    return (
        <LandItControl
            offer={offer}
            busy={busy}
            size={size}
            onLand={() => void landPullRequest(pr.repository, pr.number)}
            onUnland={() => void unlandPullRequest(pr.repository, pr.number)}
            onOpen={() => openMergeManager(landedKey(pr.repository, pr.number))}
        />
    );
}

export interface LandItControlProps {
    offer: LandOffer;
    busy: LandAction | null;
    size?: 'sm';
    onLand(): void;
    onUnland(): void;
    /** Open in Merge manager: its page, with this PR selected. */
    onOpen?(): void;
}

export function LandItControl({offer, busy, size, onLand, onUnland, onOpen}: LandItControlProps): JSX.Element | null {
    if (!offer) return null;
    const sized = size ? ' is-' + size : '';
    if (offer.kind === 'landed') {
        return (
            <LandedPill
                text={landedPillText(offer.landed)}
                sized={sized}
                busy={busy}
                onUnland={onUnland}
                onOpen={onOpen}
            />
        );
    }
    const draft = offer.kind === 'draft';
    return (
        <button
            type="button"
            className={'land-it' + sized}
            disabled={draft || busy !== null}
            title={draft ? offer.hint : 'Hand it to the Merge manager'}
            onClick={(e: MouseEvent) => {
                e.stopPropagation();
                onLand();
            }}>
            {busy === 'land' ? 'Landing…' : 'Land it'}
        </button>
    );
}

/** "● Landed · 2nd in switchboard ▾", and its menu. */
function LandedPill({
    text,
    sized,
    busy,
    onUnland,
    onOpen,
}: {
    text: string;
    sized: string;
    busy: LandAction | null;
    onUnland(): void;
    onOpen?(): void;
}): JSX.Element {
    const [open, setOpen] = useState(false);
    const host = useRef<HTMLSpanElement>(null);

    useEffect(() => {
        if (!open) return;
        const away = (e: Event): void => {
            if (!host.current?.contains(e.target as Node)) setOpen(false);
        };
        const escape = (e: KeyboardEvent): void => {
            if (e.key === 'Escape') setOpen(false);
        };
        document.addEventListener('mousedown', away, true);
        document.addEventListener('keydown', escape, true);
        return () => {
            document.removeEventListener('mousedown', away, true);
            document.removeEventListener('keydown', escape, true);
        };
    }, [open]);

    return (
        <span className="landed-pill-host" ref={host}>
            <button
                type="button"
                className={'landed-pill' + sized}
                aria-haspopup="menu"
                aria-expanded={open}
                disabled={busy !== null}
                onClick={(e: MouseEvent) => {
                    e.stopPropagation();
                    setOpen(!open);
                }}>
                <span className="landed-pill-dot" aria-hidden="true" />
                {busy === 'unland' ? 'Unlanding…' : text}
                <span className="landed-pill-caret" aria-hidden="true">
                    ▾
                </span>
            </button>
            {open && (
                <span className="landed-menu" role="menu">
                    {onOpen && (
                        <button
                            type="button"
                            role="menuitem"
                            className="landed-menu-item"
                            onClick={(e: MouseEvent) => {
                                e.stopPropagation();
                                setOpen(false);
                                onOpen();
                            }}>
                            Open in Merge manager
                            <span className="landed-menu-hint">⌘⇧L</span>
                        </button>
                    )}
                    <button
                        type="button"
                        role="menuitem"
                        className="landed-menu-item"
                        onClick={(e: MouseEvent) => {
                            e.stopPropagation();
                            setOpen(false);
                            onUnland();
                        }}>
                        Unland
                        <span className="landed-menu-hint">leaves running CI alone</span>
                    </button>
                </span>
            )}
        </span>
    );
}
