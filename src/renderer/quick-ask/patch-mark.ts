/**
 * The face Patch wears as the Quick Ask mark, in place of the lightning bolt.
 *
 * Patch smiles while you type, looks up while Patch routes, saves or takes a
 * capture back, looks down at the choices when it is not sure where the text
 * belongs, and beams once something was started or saved.
 */
import type {QuickAskPhase} from '../state/quick-ask-slice';

export type PatchMarkFace = 'smile' | 'thinking' | 'unsure' | 'happy';

export function patchMarkFace(phase: QuickAskPhase): PatchMarkFace {
    switch (phase) {
        case 'waiting':
        case 'saving':
        case 'undoing':
            return 'thinking';
        case 'choosing':
            return 'unsure';
        case 'started':
        case 'saved':
            return 'happy';
        case 'editing':
        case 'undone':
            return 'smile';
    }
}
