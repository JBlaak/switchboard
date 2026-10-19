/**
 * The pop-up's one store: the same small store the main window uses, over
 * the Quick Ask slice.
 */
import { createStore } from '../state/store';
import { initialQuickAskState, quickAskReducer } from '../state/quick-ask-slice';
import type { QuickAskEvent, QuickAskState } from '../state/quick-ask-slice';

export const store = createStore<QuickAskState, QuickAskEvent>(quickAskReducer, initialQuickAskState);

export const dispatch = store.dispatch;
export const getState = store.getState;
