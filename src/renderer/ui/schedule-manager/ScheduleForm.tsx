/**
 * A schedule's settings as a form: the create form's review step and a
 * schedule's page both edit them with it.
 *
 * STUB from the contract commit: the create-form work replaces it.
 */
import type {JSX} from 'react';
import type {ScheduleSettings} from '../../../domain/schedule/manager';

export interface ScheduleFormProps {
    readonly value: ScheduleSettings;
    readonly onChange: (next: ScheduleSettings) => void;
    /** Why Claude picked that time, under the When row, for a draft. */
    readonly whenReason?: string | null;
    /** Whether the prompt is shown (the create form) or edited elsewhere (a schedule's page has its own prompt card). */
    readonly withPrompt: boolean;
}

export function ScheduleForm({value}: ScheduleFormProps): JSX.Element {
    return <div className="schedule-form">{value.name}</div>;
}
