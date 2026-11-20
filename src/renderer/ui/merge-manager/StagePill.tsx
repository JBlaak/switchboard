/** A landed PR's stage pill, in the shared stage words' colours (`.pp-stage.is-landed-*`). */
import type {JSX} from 'react';
import {rowStageLabel, type PageRow} from '../../../domain/merge-manager/page';

export function StagePill({row}: {row: PageRow}): JSX.Element {
    return (
        <span
            className={'pp-stage is-landed-' + row.stage.kind + (row.words.tone === 'error' ? ' is-error' : '')}
            title={row.words.title}>
            <i aria-hidden="true" />
            {rowStageLabel(row)}
        </span>
    );
}
