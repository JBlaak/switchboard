/**
 * Land it (#436), as each of its four places draws it: the button on your own
 * open PR, which launches the rocket once the PR is landed, disabled with
 * "Mark it ready for review first" on a draft, and, once the PR is landed, its stage: "Landed · 2nd in switchboard ▾", whose
 * menu has Open in Merge manager (#439) and Unland. While it lands the button
 * keeps its width and spins; after a failed land it offers Try again, with why
 * as its tooltip.
 *
 * `LandItControl` is the markup from what it is given, so a test can draw it;
 * `LandIt` feeds it from the store.
 */
import {useEffect, useRef, useState} from 'react';
import type {JSX, MouseEvent} from 'react';
import {landOffer, landedPillText, type LandCandidate, type LandOffer} from '../../../domain/merge-manager/land-it';
import {landBusy, landFailure, type LandAction} from '../../state/merge-manager-slice';
import {useStore} from '../use-store';
import {landPullRequest, unlandPullRequest} from './land-actions';
import {rocketFrom} from '../../lib/motion/rocket';
import {openMergeManager} from './page-actions';
import {landedKey} from '../../../domain/merge-manager/model';

export interface LandItProps {
    pr: LandCandidate;
    /** `sm` in the tight places: the tray and the project page's rows. */
    size?: 'sm';
    /** The landed pill without its lane's name ("Landed · 2nd"), which its tooltip keeps: the session tray's status line. */
    short?: boolean;
    /**
     * Where the rocket takes off instead of the button, or null for no rocket:
     * the session's row in the sidebar, for the header's and the tray's Land it.
     */
    launchFrom?(): Element | null;
}

/** Land it for `pr`, or its landed stage; nothing for a PR that is neither yours nor landed. */
export function LandIt({pr, size, short, launchFrom}: LandItProps): JSX.Element | null {
    const lanes = useStore((state) => state.mergeManager.state);
    const offer = landOffer(pr, lanes);
    const busy = useStore((state) => landBusy(state.mergeManager, pr.repository, pr.number));
    const failure = useStore((state) => landFailure(state.mergeManager, pr.repository, pr.number));
    return (
        <LandItControl
            offer={offer}
            busy={busy}
            failure={failure}
            size={size}
            short={short}
            onLand={(button) => void landPullRequest(pr.repository, pr.number, rocketFrom(button, launchFrom))}
            onUnland={() => void unlandPullRequest(pr.repository, pr.number)}
            onOpen={() => openMergeManager(landedKey(pr.repository, pr.number))}
        />
    );
}

export interface LandItControlProps {
    offer: LandOffer;
    busy: LandAction | null;
    /** Why the last Land it failed: the button then says Try again. */
    failure?: string | null;
    size?: 'sm';
    short?: boolean;
    /** `from` is the button, for the rocket. */
    onLand(from: Element): void;
    onUnland(): void;
    /** Open in Merge manager: its page, with this PR selected. */
    onOpen?(): void;
}

export function LandItControl({
    offer,
    busy,
    failure,
    size,
    short,
    onLand,
    onUnland,
    onOpen,
}: LandItControlProps): JSX.Element | null {
    if (!offer) return null;
    const sized = size ? ' is-' + size : '';
    if (offer.kind === 'landed') {
        const full = landedPillText(offer.landed, offer.lane);
        return (
            <LandedPill
                text={short ? landedPillText(offer.landed, offer.lane, true) : full}
                title={full}
                sized={sized}
                busy={busy}
                onUnland={onUnland}
                onOpen={onOpen}
            />
        );
    }
    const draft = offer.kind === 'draft';
    const landing = busy === 'land';
    const retry = !draft && !landing && !!failure;
    return (
        <button
            type="button"
            className={'land-it' + sized + (landing ? ' is-busy' : '')}
            disabled={draft || busy !== null}
            aria-busy={landing || undefined}
            title={draft ? offer.hint : retry ? `Could not land: ${failure}` : 'Hand it to the Merge manager'}
            onClick={(e: MouseEvent) => {
                e.stopPropagation();
                onLand(e.currentTarget);
            }}>
            {landing && <span className="land-it-spinner" aria-hidden="true" />}
            {landing ? 'Landing' : retry ? 'Try again' : 'Land it'}
        </button>
    );
}

/** "● Landed · 2nd in switchboard ▾", and its menu. */
function LandedPill({
    text,
    title,
    sized,
    busy,
    onUnland,
    onOpen,
}: {
    text: string;
    /** The whole stage, when `text` is the short one. */
    title: string;
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
                title={title !== text ? title : undefined}
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
