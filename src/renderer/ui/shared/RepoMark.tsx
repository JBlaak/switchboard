/**
 * A project's little coloured mark (`repoMark`): its initial on a square in
 * its own colour. Decoration only; the name beside it says which project.
 */
import type {JSX} from 'react';
import {repoMark} from './repo-mark';

export function RepoMark({name, size = 'normal'}: {name: string; size?: 'normal' | 'small'}): JSX.Element {
    const {initial, hue} = repoMark(name);
    return (
        <b className={'sw-repo-mark is-' + hue + (size === 'small' ? ' is-small' : '')} aria-hidden="true">
            {initial}
        </b>
    );
}
