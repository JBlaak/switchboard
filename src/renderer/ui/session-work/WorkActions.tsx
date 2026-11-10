/**
 * The selected item's one button beside its title: Open on GitHub, for a PR.
 *
 * The buttons that handed an item to Claude (Ship it, Rebase, Fix CI, Fix
 * comments, Open a new PR, Create a pull request) are gone until they are
 * redesigned.
 */
import type {JSX} from 'react';
import {openOnGitHub} from './actions';
import type {SessionWorkItem} from '../../../domain/session-work/model';

export function ActionRow({item}: {item: SessionWorkItem}): JSX.Element | null {
    if (item.kind !== 'pr') return null;
    const {url} = item.pr;
    return (
        <div className="sw-actions" role="group" aria-label="Actions">
            <button type="button" className="sw-btn" title={url} onClick={() => openOnGitHub(url)}>
                Open on GitHub
            </button>
        </div>
    );
}
